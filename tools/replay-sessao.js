// tools/replay-sessao.js
//
// Teste da overlay sem o jogo: reproduz uma sessao gravada pelo Cubic Racing
// Analyser (pasta sessoes\<sessao>) e manda para o servidor pela mesma ponte
// TCP do listener.ps1, no mesmo formato do AMS2. O servidor e as overlays nao
// sabem a diferenca.
//
//   node tools/replay-sessao.js [pasta da sessao] [opcoes]
//
// Opcoes:
//   --sessao=N     qual sessao da pasta (sessao_n do sessao.json). Padrao: a ultima corrida.
//   --vel=X        velocidade (1 = tempo real, 4 = 4x mais rapido). Padrao 1.
//   --inicio=S     comeca S segundos depois da largada.
//   --porta=P      porta da ponte (BRIDGE_PORT). Padrao 5607.
//   --loop         recomeca quando acaba.
//
// O que vem da gravacao: posicao na pista (distancia, X/Z), velocidade, volta,
// posicao oficial do jogo, modo de box e o tempo oficial de volta dos rivais.
// O que e estimado aqui: tempos de setor (pista dividida em tercos, a gravacao
// nao tem os limites reais), a posicao do jogador (a que falta entre as dos
// rivais) e a bandeirada. Nomes vem do rivais.json da pasta, que e a lista do
// fim da gravacao: carros que nao estao nela aparecem como "Piloto N".

const fs = require("fs");
const path = require("path");
const net = require("net");

const PADRAO = path.join(
  process.env.LOCALAPPDATA || "",
  "Cubic Racing Analyser",
  "sessoes",
  "20261102_222105_Chevrolet_Cruze_Stock_Car_2019_CuritibaInternacional"
);

// ---------- argumentos ----------
const args = process.argv.slice(2);
const opt = {};
let pasta = null;
for (const a of args) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) opt[m[1]] = m[2] === undefined ? true : m[2];
  else pasta = a;
}
pasta = pasta || PADRAO;
const VEL = Number(opt.vel) > 0 ? Number(opt.vel) : 1;
const PORTA = Number(opt.porta) || Number(process.env.BRIDGE_PORT) || 5607;
const HZ = 10;

// ---------- leitura ----------
function lerJson(arq) {
  return JSON.parse(fs.readFileSync(arq, "utf8").replace(/^﻿/, ""));
}

function lerCsv(arq) {
  if (!fs.existsSync(arq)) return [];
  const linhas = fs.readFileSync(arq, "utf8").split(/\r?\n/).filter(Boolean);
  const cab = linhas.shift().split(",");
  return linhas.map((l) => {
    const v = l.split(",");
    const o = {};
    cab.forEach((c, k) => (o[c] = v[k] === undefined || v[k] === "" ? null : Number(v[k])));
    return o;
  });
}

const sessao = lerJson(path.join(pasta, "sessao.json"));
const L = Number(sessao.comprimento_m) || 3000;
const nomes = {};
let slotJogador = null;
try {
  for (const r of lerJson(path.join(pasta, "rivais.json"))) {
    nomes[r.i] = { nome: r.nome, carro: r.carro, classe: r.classe };
    if (r.eu) slotJogador = r.i;
  }
} catch (_) {}

const voltasTodas = sessao.voltas || [];
let alvo = opt.sessao != null ? Number(opt.sessao) : null;
if (alvo == null) {
  const corridas = voltasTodas.filter((v) => v.sessao_tipo === 5);
  alvo = corridas.length ? corridas[corridas.length - 1].sessao_n : voltasTodas.length ? voltasTodas[voltasTodas.length - 1].sessao_n : null;
}
const voltas = voltasTodas.filter((v) => alvo == null || v.sessao_n === alvo);
if (!voltas.length) {
  console.error("Nenhuma volta encontrada para a sessao", alvo, "em", pasta);
  process.exit(1);
}
const tipoSessao = voltas[0].sessao_tipo || 5;
const ehCorrida = tipoSessao === 5;

// Linha do tempo unica: cada arquivo rivais_NNN/volta_NNN tem t desde o inicio
// da nossa volta NNN. A primeira volta da sessao pode comecar ainda na sessao
// anterior: quando t volta para tras dentro do arquivo, vale so o que vem depois.
function aposUltimoSalto(linhas) {
  let corte = 0;
  for (let k = 1; k < linhas.length; k++) if (linhas[k].t < linhas[k - 1].t - 0.5) corte = k;
  return linhas.slice(corte);
}

const rivais = new Map(); // slot -> amostras [{gt, dist, x, z, v, volta, pos, box, ult}]
const jogador = []; // amostras do nosso carro
let offset = 0;
for (let k = 0; k < voltas.length; k++) {
  const v = voltas[k];
  const nnn = String(v.numero).padStart(3, "0");
  let rv = lerCsv(path.join(pasta, `rivais_${nnn}.csv`));
  let eu = lerCsv(path.join(pasta, `volta_${nnn}.csv`));
  if (k === 0) {
    rv = aposUltimoSalto(rv);
    eu = aposUltimoSalto(eu);
  }
  for (const r of rv) {
    if (r.t == null || r.t < 0) continue;
    if (!rivais.has(r.i)) rivais.set(r.i, []);
    rivais.get(r.i).push({ gt: offset + r.t, dist: r.dist, x: r.x, z: r.z, v: r.v_jogo, volta: r.volta, pos: r.pos, box: r.box, ult: r.ult });
  }
  for (const q of eu) {
    jogador.push({
      gt: offset + q.t,
      dist: q.dist,
      x: q.x,
      z: q.z,
      v: q.vel_kmh,
      volta: k + 1,
      box: v.boxes && q.vel_kmh < 3 && k > 0 ? 2 : 0,
      ult: k > 0 ? Number(voltas[k - 1].tempo) || null : null,
      q,
    });
  }
  offset += Number(v.tempo) || 0;
}
for (const a of rivais.values()) a.sort((p, q) => p.gt - q.gt);
const DURACAO = offset;

// Volta da bandeirada: a maior volta completada por alguem quando a gravacao acaba
// (o lider cruza a linha e a gravacao segue ate o nosso carro terminar).
let voltasCorrida = Number(opt.voltas) || 0;
if (!voltasCorrida && ehCorrida) {
  voltasCorrida = voltas.length;
  for (const a of rivais.values()) voltasCorrida = Math.max(voltasCorrida, (a[a.length - 1].volta || 1) - 1);
}

// ---------- estado por carro ----------
function novoCarro(slot) {
  const n = nomes[slot] || {};
  return {
    slot,
    nome: slot === slotJogador ? n.nome || "Jogador" : n.nome || `Piloto ${slot}`,
    carro: n.carro || sessao.carro || "",
    classe: n.classe || sessao.classe || "",
    idx: 0,
    ultVolta: null,
    melhorVolta: null,
    inicioVolta: null, // gt em que a volta atual comecou
    setores: [null, null, null],
    melhoresSetores: [null, null, null],
    marcasSetor: [null, null], // gt ao cruzar 1/3 e 2/3
    voltaAnt: null,
    distAnt: null,
    vmax: 0,
    terminou: false,
  };
}

const carros = new Map();
for (const slot of rivais.keys()) if (slot !== slotJogador) carros.set(slot, novoCarro(slot));
const SLOT_EU = slotJogador != null ? slotJogador : 63;
carros.set(SLOT_EU, novoCarro(SLOT_EU));
const series = new Map([...rivais.entries()]);
series.set(SLOT_EU, jogador);

// amostra no instante gt, interpolando entre as duas mais proximas da mesma volta
function amostra(serie, c, gt) {
  while (c.idx + 1 < serie.length && serie[c.idx + 1].gt <= gt) c.idx++;
  const a = serie[c.idx];
  if (!a || a.gt > gt) return null;
  const b = serie[c.idx + 1];
  if (!b || b.volta !== a.volta || b.gt - a.gt > 2 || b.dist < a.dist) return a;
  const f = (gt - a.gt) / (b.gt - a.gt);
  const mix = (p, q) => (p == null || q == null ? p : p + (q - p) * f);
  return Object.assign({}, a, { dist: mix(a.dist, b.dist), x: mix(a.x, b.x), z: mix(a.z, b.z), v: mix(a.v, b.v) });
}

let lider = null; // lider terminou?
function atualizarVoltas(c, s, gt) {
  if (c.voltaAnt != null && s.volta > c.voltaAnt) {
    // cruzou a linha
    const tempo = c.inicioVolta != null ? gt - c.inicioVolta : null;
    const oficial = s.ult > 0 ? s.ult : null;
    const t = oficial || (tempo > 20 ? tempo : null);
    if (t) {
      c.ultVolta = t;
      if (c.melhorVolta == null || t < c.melhorVolta) c.melhorVolta = t;
      if (c.marcasSetor[0] && c.marcasSetor[1] && c.inicioVolta != null) {
        const s3 = gt - c.marcasSetor[1];
        c.setores[2] = s3;
        if (!c.melhoresSetores[2] || s3 < c.melhoresSetores[2]) c.melhoresSetores[2] = s3;
      }
    }
    c.inicioVolta = gt;
    c.marcasSetor = [null, null];
    if (ehCorrida && s.volta - 1 >= voltasCorrida && (lider || s.pos === 1 || c.slot === SLOT_EU)) {
      c.terminou = true;
      lider = true;
    } else if (ehCorrida && lider) {
      c.terminou = true;
    }
  } else if (c.voltaAnt == null) {
    c.inicioVolta = s.dist < 50 ? gt : null;
  }
  // setores (tercos da pista)
  for (let k = 0; k < 2; k++) {
    const lim = (L * (k + 1)) / 3;
    if (c.distAnt != null && c.distAnt < lim && s.dist >= lim && s.volta === c.voltaAnt && !c.marcasSetor[k]) {
      c.marcasSetor[k] = gt;
      const ini = k === 0 ? c.inicioVolta : c.marcasSetor[0];
      if (ini != null) {
        const st = gt - ini;
        c.setores[k] = st;
        if (k === 0) c.setores[1] = c.setores[2] = null;
        if (!c.melhoresSetores[k] || st < c.melhoresSetores[k]) c.melhoresSetores[k] = st;
      }
    }
  }
  c.voltaAnt = s.volta;
  c.distAnt = s.dist;
}

const ms = (s) => (s > 0 ? Math.round(s * 1000) : null);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

function quadro(gt) {
  const lista = [];
  for (const [slot, c] of carros) {
    const s = amostra(series.get(slot), c, gt);
    if (!s) continue;
    if (!c.terminou) atualizarVoltas(c, s, gt);
    c.vmax = Math.max(c.vmax, s.v || 0);
    lista.push({ c, s });
  }
  // posicao: a oficial do jogo para os rivais; o jogador fica com a que falta
  const usadas = new Set(lista.filter((e) => e.c.slot !== SLOT_EU).map((e) => e.s.pos));
  const eu = lista.find((e) => e.c.slot === SLOT_EU);
  if (eu) {
    let falta = null;
    for (let p = 1; p <= lista.length; p++) if (!usadas.has(p)) { falta = p; break; }
    if (falta == null) {
      const td = (e) => (e.s.volta - 1) * L + e.s.dist;
      falta = 1 + lista.filter((e) => e !== eu && td(e) > td(eu)).length;
    }
    eu.s = Object.assign({}, eu.s, { pos: falta - 0.5 });
  }
  lista.sort((a, b) => (a.s.pos || 999) - (b.s.pos || 999));

  const standings = lista.map(({ c, s }, k) => {
    const lapsCompleted = Math.max(0, (s.volta || 1) - 1);
    const e = {
      slot: c.slot,
      position: k + 1,
      name: c.nome,
      carName: c.carro,
      carClass: c.classe,
      lapsCompleted,
      currentLap: s.volta || 1,
      lapDistance: r1(s.dist),
      worldX: r1(s.x),
      worldZ: r1(s.z),
      totalDistance: lapsCompleted * L + (s.dist || 0),
      lastLapMs: ms(c.ultVolta),
      fastestLapMs: ms(c.melhorVolta),
      speedKmh: r1(s.v),
      speedMs: Math.round(((s.v || 0) / 3.6) * 100) / 100,
      maxSpeedKmh: r1(c.vmax),
      isPlayer: c.slot === SLOT_EU,
      pitMode: s.box || 0,
      raceState: c.terminou ? 3 : 2,
      inRace: ehCorrida,
      sector1Ms: ms(c.setores[0]),
      sector2Ms: ms(c.setores[1]),
      sector3Ms: ms(c.setores[2]),
      currentSector: s.dist < L / 3 ? 1 : s.dist < (2 * L) / 3 ? 2 : 3,
      bestSector1Ms: ms(c.melhoresSetores[0]),
      bestSector2Ms: ms(c.melhoresSetores[1]),
      bestSector3Ms: ms(c.melhoresSetores[2]),
      flagColour: 0,
      flagReason: 0,
      causedYellow: false,
      lapInvalidated: false,
      penaltyType: null,
    };
    return e;
  });

  const q = eu && eu.s.q;
  const car = q
    ? {
        carName: sessao.carro,
        carClass: sessao.classe,
        throttle: q.acel,
        brake: q.freio,
        steering: q.volante,
        rpm: q.rpm,
        gear: q.marcha,
        speedMs: Math.round((q.vel_kmh / 3.6) * 100) / 100,
        speedKmh: q.vel_kmh,
        localAccel: [q.g_lat * 9.81, 0, -q.g_long * 9.81],
        tyreTemp: [q.pneu_DE, q.pneu_DD, q.pneu_TE, q.pneu_TD],
        suspTravel: [q.susp_DE, q.susp_DD, q.susp_TE, q.susp_TD],
        terrain: [q.piso_DE, q.piso_DD, q.piso_TE, q.piso_TD],
        aeroDamage: q.dano_aero,
        engineDamage: q.dano_motor,
        tyreCompound: sessao.compostos || [],
      }
    : {};

  return {
    game: "ams2",
    session: {
      state: tipoSessao,
      label: { 1: "TREINO LIVRE", 3: "CLASSIFICACAO", 5: "CORRIDA" }[tipoSessao] || "CORRIDA",
      timeRemainingSec: -1,
      lapsInEvent: ehCorrida ? voltasCorrida : 0,
      scOut: false,
      trackLocation: sessao.pista || "",
      trackVariation: sessao.variante || "",
      trackLength: r1(L),
      ambientTempC: r1(sessao.temp_ar),
      trackTempC: r1(sessao.temp_pista),
      rain: 0,
      sessionDurationMin: 0,
      additionalLaps: 0,
    },
    standings,
    car,
  };
}

// ---------- envio ----------
let sock = null;
let conectado = false;
function conectar() {
  sock = net.connect(PORTA, "127.0.0.1", () => {
    conectado = true;
    console.log(`Conectado a ponte na porta ${PORTA}.`);
  });
  sock.on("error", () => {});
  sock.on("close", () => {
    if (conectado) console.log("Ponte desconectada; tentando de novo...");
    conectado = false;
    setTimeout(conectar, 1000);
  });
}

function enviar(obj) {
  if (!conectado) return;
  const corpo = Buffer.from(JSON.stringify(obj), "utf8");
  const cab = Buffer.alloc(4);
  cab.writeUInt32BE(corpo.length, 0);
  sock.write(Buffer.concat([cab, corpo]));
}

function reiniciar() {
  for (const [slot, c] of carros) carros.set(slot, novoCarro(slot));
  lider = null;
}

const inicio = Number(opt.inicio) || 0;
let gt = inicio;
// avanca o estado ate o ponto de inicio sem mandar (tempos de volta corretos); no --demo, ate
// 60 s antes, que viram o aquecimento do exemplo
const AQ_DEMO = opt.demo ? Math.min(60, inicio) : 0;
for (let t = 0; t < inicio - AQ_DEMO; t += 1 / HZ) quadro(t);

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// --demo=arquivo.json.gz [--dur=30]: em vez de tocar, grava um trecho como dados de exemplo
// para o "Editar na tela" do piloto (server/demo.js). Nomes anonimizados: "Piloto 01"... e
// "Você" no carro do piloto. So os campos que as overlays do piloto usam, compactados.
if (opt.demo) {
  const zlib = require("zlib");
  const dur = Number(opt.dur) || 30;
  const COLS = ["slot", "position", "name", "carName", "carClass", "lapsCompleted", "currentLap", "lapDistance", "worldX", "worldZ", "totalDistance", "lastLapMs", "fastestLapMs", "speedKmh", "speedMs", "isPlayer", "pitMode", "raceState", "sector1Ms", "sector2Ms", "sector3Ms", "currentSector", "bestSector1Ms", "bestSector2Ms", "bestSector3Ms"];
  const anon = new Map();
  let n = 0;
  const nome = (e) => {
    if (e.isPlayer) return "Você";
    if (!anon.has(e.slot)) anon.set(e.slot, `Piloto ${String(++n).padStart(2, "0")}`);
    return anon.get(e.slot);
  };
  // combustivel: a gravacao tem o consumo de cada volta (sessao.json), nao o valor a cada instante;
  // no exemplo ele sai do consumo medio das voltas da corrida, descendo ao longo da volta
  const usos = voltas.map((v) => Number(v.combustivel_usado)).filter((u) => u > 0.5 && u < 20);
  const porVolta = usos.length ? usos.reduce((a, b) => a + b, 0) / usos.length : 3;
  // aquecimento: os ultimos 60 s antes do trecho, so a distancia de cada carro (5x por segundo).
  // A tabela usa isso para os intervalos ja aparecerem cheios a cada volta do loop (o intervalo
  // e por tempo: sem historico, o carro 16 s na frente ficaria com "–" por 16 s).
  const AQ = AQ_DEMO;
  const hist = { hz: 5, names: [], d: [] };
  for (let t = inicio - AQ, k = 0; t < inicio; t += 1 / HZ, k++) {
    const p = quadro(t);
    if (k % Math.round(HZ / hist.hz)) continue;
    const row = [];
    p.standings.filter((e) => !/safety/i.test(`${e.carClass} ${e.carName} ${e.name}`)).forEach((e) => {
      const nm = nome(e);
      let i = hist.names.indexOf(nm);
      if (i < 0) i = hist.names.push(nm) - 1;
      row[i] = Math.round(e.totalDistance * 10) / 10;
    });
    hist.d.push(row);
  }
  hist.d = hist.d.map((r) => hist.names.map((_, i) => (r[i] == null ? null : r[i])));
  const frames = [];
  for (let t = inicio; t < inicio + dur; t += 1 / HZ) {
    const p = quadro(t);
    const car = p.car || {};
    // o carro de seguranca fica de fora, como no listener do jogo; as posicoes se refazem sem ele
    const lista = p.standings.filter((e) => !/safety/i.test(`${e.carClass} ${e.carName} ${e.name}`));
    lista.forEach((e, k) => (e.position = k + 1));
    const me = lista.find((e) => e.isPlayer) || {};
    const fuel = Math.max(1, 60 - ((me.lapsCompleted || 0) + (me.lapDistance || 0) / L) * porVolta);
    frames.push({
      s: lista.map((e) => COLS.map((c) => (c === "name" ? nome(e) : e[c] === undefined ? null : e[c]))),
      // carro do piloto: acelerador, freio, volante, velocidade (m/s), aceleracao x e z (m/s2), combustivel (L)
      car: [car.throttle, car.brake, car.steering, car.speedMs, car.localAccel ? car.localAccel[0] : 0, car.localAccel ? car.localAccel[2] : 0, Math.round(fuel * 10) / 10],
    });
  }
  const out = { hz: HZ, session: quadro(inicio + dur).session, cols: COLS, frames, hist };
  fs.writeFileSync(opt.demo, zlib.gzipSync(JSON.stringify(out)));
  console.log(`Exemplo gravado: ${frames.length} quadros (${dur} s a partir de ${fmt(inicio)}), ${fs.statSync(opt.demo).size} bytes em ${opt.demo}`);
  process.exit(0);
}

console.log(`Sessao: ${path.basename(pasta)}`);
console.log(`Pista ${sessao.pista_nome || sessao.pista} (${Math.round(L)} m), ${carros.size} carros, ${voltas.length} voltas nossas, ${fmt(DURACAO)} de gravacao${ehCorrida ? `, corrida de ${voltasCorrida} voltas` : ""}.`);
console.log(`Velocidade ${VEL}x. Ctrl+C para parar.`);
conectar();

let ultimoLog = 0;
setInterval(() => {
  if (!conectado) return;
  gt += VEL / HZ;
  if (gt > DURACAO + 30) {
    if (!opt.loop) {
      console.log("Fim da gravacao.");
      process.exit(0);
    }
    reiniciar();
    gt = 0;
  }
  const pkt = quadro(Math.min(gt, DURACAO));
  enviar(pkt);
  if (gt - ultimoLog >= 30) {
    ultimoLog = gt;
    const l = pkt.standings[0];
    const eu = pkt.standings.find((e) => e.isPlayer);
    console.log(`[${fmt(gt)}] lider ${l ? l.name : "-"} V${l ? l.currentLap : "-"} | ${eu ? `${eu.name} P${eu.position}` : ""}`);
  }
}, 1000 / HZ);
