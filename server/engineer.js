// server/engineer.js
//
// Engenheiro de pista do piloto, por voz (server/speech.js fala): o mesmo radio do
// Cubic Racing Analyser (app/src/radio.rs e textos_voz.rs), com as mesmas regras e
// frases, mais um spotter. So olha o carro em foco (isPlayer), que para quem pilota e
// o proprio carro.
//
// Engenheiro (igual ao Analyser):
//   - ao fechar a volta: tempo (primeira, melhor, igual a melhor, acima da melhor) ou
//     "volta invalida" (nao na volta de saida nem com passagem pelo box)
//   - em corrida, ao fechar a volta: posicoes ganhas ou perdidas, e o vizinho da frente e o
//     de tras quando a menos de 2 s ou se o intervalo mudou mais de 1 s (ate 15 s)
//   - bandeira amarela, vermelha, preta, preta e branca; batida forte; danos de 25, 50 e 75%
//   - carro parado a frente (60 a 700 m), com a distancia
//   - fim da corrida: posicao, melhor volta e o veredito; depois disso o radio se cala
// Spotter (novo, nao existe no Analyser): carro a esquerda, a direita, tres lado a lado e
// "livre", na hora, interrompendo o engenheiro. Pela posicao dos carros no mundo e pelo rumo
// do piloto (tirado do proprio movimento). AMS2 e LMU tem mundo "left-handed": o rumo
// atan2(dx, dz) crescendo e virar a direita (o mesmo do overlay/shared/gforce.js).
//
// Radio e spotter ligam e desligam cada um por si (tela Pilotar, botao Engenheiro); os dois
// comecam desligados. As frases podem ser reescritas, como no Analyser.

const { createGapTracker } = require("../overlay/shared/gaps");

const DEFAULTS = {
  on: false, // radio do engenheiro desligado ate o piloto ligar
  spotter: false, // spotter: liga e desliga sozinho, independente do radio
  laps: true, // tempo de volta
  rivals: true, // posicoes e vizinhos ao fechar a volta
  alerts: true, // bandeiras, batida, danos, carro parado
  result: true, // fim da corrida
  volume: 80,
  rate: 0, // -5 (devagar) a 5 (rapido)
  voice: "", // voz do Windows; vazio = a primeira em portugues
  phrases: {}, // frases reescritas pelo piloto (chave -> texto)
};

// As frases do Analyser (textos_voz.rs): chave, grupo, rotulo, texto padrao, variaveis
const PHRASES = [
  ["bandeira_amarela", "Bandeiras e acidentes", "Bandeira amarela", "Bandeira amarela.", []],
  ["bandeira_vermelha", "Bandeiras e acidentes", "Bandeira vermelha", "Bandeira vermelha. Corrida interrompida.", []],
  ["bandeira_preta", "Bandeiras e acidentes", "Bandeira preta", "Bandeira preta. Você foi chamado aos boxes.", []],
  ["bandeira_pb", "Bandeiras e acidentes", "Bandeira preta e branca", "Aviso de conduta. Bandeira preta e branca.", []],
  ["batida", "Bandeiras e acidentes", "Batida forte", "Batida forte. Confira os danos.", []],
  ["dano", "Bandeiras e acidentes", "Dano no carro", "Dano {parte}: {pct} por cento.", ["parte", "pct"]],
  ["parado_um", "Bandeiras e acidentes", "Um carro parado à frente", "Atenção, {nome} parado à frente, {metros} metros.", ["nome", "metros"]],
  ["parado_varios", "Bandeiras e acidentes", "Vários carros parados à frente", "Atenção, acidente à frente, {qtd} carros parados, {metros} metros.", ["qtd", "metros"]],
  ["volta_primeira", "Voltas", "Volta (sem referência)", "Volta {tempo}.", ["tempo"]],
  ["volta_melhor", "Voltas", "Melhor volta", "Melhor volta: {tempo}. {ganho} mais rápida.", ["tempo", "ganho"]],
  ["volta_igual", "Voltas", "Volta igual à melhor", "Volta {tempo}, igual à melhor.", ["tempo"]],
  ["volta_normal", "Voltas", "Volta mais lenta que a melhor", "Volta {tempo}, {diferenca} acima da melhor.", ["tempo", "diferenca"]],
  ["volta_invalida", "Voltas", "Volta inválida", "Volta inválida.", []],
  ["posicao_ganhou", "Rivais", "Ganhou posições", "Posição {pos}, ganhou {n} {posicoes} nesta volta.", ["pos", "n", "posicoes"]],
  ["posicao_perdeu", "Rivais", "Perdeu posições", "Posição {pos}, perdeu {n} {posicoes} nesta volta.", ["pos", "n", "posicoes"]],
  ["rival", "Rivais", "Rival vizinho", "{nome} {lado}, {gap} segundos{tendencia}.", ["nome", "lado", "gap", "tendencia"]],
  ["spot_esquerda", "Spotter", "Carro à esquerda", "Esquerda.", []],
  ["spot_direita", "Spotter", "Carro à direita", "Direita.", []],
  ["spot_tres", "Spotter", "Três lado a lado", "Três lado a lado.", []],
  ["spot_livre", "Spotter", "Livre", "Livre.", []],
];
const PHRASE_DEFAULT = Object.fromEntries(PHRASES.map(([k, , , t]) => [k, t]));

// radio (radio.rs)
const GAP_PERTO_S = 2.0;
const GAP_MUDANCA_S = 1.0;
const GAP_MAX_S = 15.0;
const PARADO_MS = 3.0;
const PARADO_SEG = 1.5;
const PARADO_MIN_M = 60;
const PARADO_MAX_M = 700;
const ENTRE_PARADOS_S = 25;
const MINHA_VEL_MIN_MS = 20;
// mFlagColours / mHighestFlagColour do formato PC2
const BANDEIRA = { 5: "bandeira_vermelha", 6: "bandeira_amarela", 7: "bandeira_amarela", 8: "bandeira_pb", 10: "bandeira_preta" };
// mCrashState: 2 = batida forte, 4 = capotando
const BATIDAS = [2, 4];

// spotter
const CAR_LEN = 4.8; // metros em que dois carros lado a lado se sobrepoem
const SIDE_MIN = 0.8;
const SIDE_MAX = 5.5;
const SPOT_MIN_MS = 8; // parado ou muito lento: sem spotter (box, rodada)
const HOLD_IN = 2; // leituras seguidas para anunciar alguem do lado
const HOLD_OUT = 5; // leituras seguidas sem ninguem para dizer "livre" (~0,5 s)
const SPOT_GAP_MS = 1000; // intervalo minimo entre dois avisos do spotter (menos o tres lado a lado)
const LAT_SIGN = { ams2: 1, lmu: 1, acc: 1, ac: 1 }; // ACC e AC ainda nao conferidos

// "1,8" (a voz le virgula)
const num = (v, casas) => v.toFixed(casas).replace(".", ",");

// "2 minutos e 7,3" (a voz le melhor que "2:07.3")
function tempoFalado(s) {
  const min = Math.floor(s / 60);
  const seg = s - min * 60;
  return min === 0 ? `${num(seg, 1)} segundos` : `${min} minuto${min > 1 ? "s" : ""} e ${num(seg, 1)}`;
}

// O nome de um piloto como a voz deve falar (radio.rs, nome_falado): sem etiquetas
// ("[PSR]", "(AM)"), sem prefixo de equipe ("HRE_"), sem numeros colados e sem
// MAIUSCULAS (a voz soletra). Sem nada que sobre, o nome cru.
function nomeFalado(bruto) {
  let semTags = "";
  let fundo = 0;
  for (const c of String(bruto || "")) {
    if ("[({<".includes(c)) fundo++;
    else if ("])}>".includes(c)) fundo = Math.max(0, fundo - 1);
    else if (fundo === 0) semTags += c;
  }
  let s = semTags.trim();
  const sep = s.search(/[_|-]/);
  if (sep >= 0) {
    const sigla = s.slice(0, sep);
    const resto = s.slice(sep + 1).trim();
    if (sigla.length >= 2 && sigla.length <= 5 && /^[A-Z0-9]+$/.test(sigla) && /\p{L}/u.test(resto)) s = resto;
  }
  const palavras = s
    .replace(/[^\p{L}\p{N}']/gu, " ")
    .split(/\s+/)
    .map((p) => {
      if ((p.match(/\p{L}/gu) || []).length >= 3) p = p.replace(/\d+$/, "");
      if (!p || !/\p{L}/u.test(p)) return null;
      const letras = p.match(/\p{L}/gu) || [];
      if (letras.every((c) => c === c.toUpperCase() && c !== c.toLowerCase()) && [...p].length > 3) return p[0].toUpperCase() + p.slice(1).toLowerCase();
      return p;
    })
    .filter(Boolean);
  return palavras.length ? palavras.join(" ") : String(bruto || "").trim();
}

function preencher(modelo, vars) {
  let s = modelo;
  Object.entries(vars || {}).forEach(([k, v]) => (s = s.split(`{${k}}`).join(String(v))));
  return s;
}

const isOut = (e) => e && e.raceState >= 4 && e.raceState <= 6;

// Voz: "win:Microsoft Daniel" (as novas do Windows) ou "sapi:..." (as classicas). A versao anterior
// guardava so o nome de uma classica ("Microsoft Maria Desktop"), que fala sintetizando ao mesmo
// tempo e picota num PC carregado: esse valor antigo vira o padrao (a Maria nova).
function voiceId(v) {
  const s = String(v || "").trim();
  return /^(win|sapi):/.test(s) ? s : "";
}

function createEngineer(opts) {
  const speak = (opts && opts.speak) || (() => {});
  const clock = (opts && opts.now) || Date.now;
  let cfg = Object.assign({}, DEFAULTS, (opts && opts.config) || {});
  cfg.phrases = Object.assign({}, cfg.phrases || {});
  cfg.voice = voiceId(cfg.voice);

  const frase = (chave, vars) => preencher((cfg.phrases[chave] && cfg.phrases[chave].trim()) || PHRASE_DEFAULT[chave] || "", vars);

  let st = null;
  let sessionKey = null;
  let me = null;

  function fresh() {
    return {
      gaps: createGapTracker(),
      lastLaps: null,
      lapInvalid: false,
      lapPitted: false,
      lapIsOut: true, // a primeira volta registrada e a de saida
      best: null, // melhor volta valida (s)
      posLap: null,
      gapLap: new Map(), // nome -> intervalo (s) quando a volta anterior fechou
      lapTimes: [],
      flagAnt: null,
      lastFlagAt: -1e9,
      crashAnt: 0,
      lastCrashAt: -1e9,
      damageSaid: [0, 0, 0],
      stopped: new Map(), // nome -> { since, warnedAt, pos, t, speed }
      closed: false, // fim da corrida: o radio se cala
      prevPos: null,
      heading: null,
      side: { left: 0, right: 0, clearLeft: 0, clearRight: 0, saidLeft: false, saidRight: false },
      lastSpotAt: -1e9,
    };
  }

  function say(text, urgent) {
    if (text) speak(text, !!urgent);
  }

  // ---------------------------------------------------------------- spotter
  function spotter(game, list, mine) {
    const s = st;
    const x = mine.worldX;
    const z = mine.worldZ;
    if (typeof x !== "number" || typeof z !== "number" || (x === 0 && z === 0)) return;
    if (s.prevPos) {
      const dx = x - s.prevPos.x;
      const dz = z - s.prevPos.z;
      if (Math.hypot(dx, dz) > 0.5) s.heading = Math.atan2(dx, dz);
    }
    s.prevPos = { x, z };
    if (!cfg.spotter) return;
    const fast = (mine.speedMs || 0) >= SPOT_MIN_MS && (mine.pitMode || 0) === 0;
    let left = false;
    let right = false;
    if (fast && s.heading != null) {
      const sign = LAT_SIGN[game] || 1;
      list.forEach((e) => {
        if (!e || e === mine || (e.pitMode || 0) !== 0 || typeof e.worldX !== "number") return;
        const rx = e.worldX - x;
        const rz = e.worldZ - z;
        const dist = Math.hypot(rx, rz);
        if (dist > 12) return;
        const rel = Math.atan2(rx, rz) - s.heading;
        const lon = dist * Math.cos(rel);
        const lat = sign * dist * Math.sin(rel); // positivo = a direita
        if (Math.abs(lon) > CAR_LEN || Math.abs(lat) < SIDE_MIN || Math.abs(lat) > SIDE_MAX) return;
        if (lat > 0) right = true;
        else left = true;
      });
    }
    const sd = s.side;
    sd.left = left ? sd.left + 1 : 0;
    sd.right = right ? sd.right + 1 : 0;
    sd.clearLeft = left ? 0 : sd.clearLeft + 1;
    sd.clearRight = right ? 0 : sd.clearRight + 1;
    // um carro na fronteira entre "do lado" e "livre" faria o spotter falar sem parar e cortar a
    // voz: entre dois avisos, pelo menos SPOT_GAP_MS (o tres lado a lado passa na frente)
    const t = clock();
    const newLeft = sd.left >= HOLD_IN && !sd.saidLeft;
    const newRight = sd.right >= HOLD_IN && !sd.saidRight;
    if (newLeft || newRight) {
      const tres = (newLeft || sd.saidLeft) && (newRight || sd.saidRight);
      if (!tres && t - s.lastSpotAt < SPOT_GAP_MS) return;
      if (newLeft) sd.saidLeft = true;
      if (newRight) sd.saidRight = true;
      s.lastSpotAt = t;
      say(frase(tres ? "spot_tres" : newLeft ? "spot_esquerda" : "spot_direita"), true);
      return;
    }
    const goneLeft = sd.saidLeft && sd.clearLeft >= HOLD_OUT;
    const goneRight = sd.saidRight && sd.clearRight >= HOLD_OUT;
    if (!goneLeft && !goneRight) return;
    const stillLeft = sd.saidLeft && !goneLeft;
    const stillRight = sd.saidRight && !goneRight;
    if (stillLeft || stillRight) {
      // saiu de um lado, o outro continua: sem "livre" ainda
      if (goneLeft) sd.saidLeft = false;
      if (goneRight) sd.saidRight = false;
      return;
    }
    // ninguem mais do lado: "livre", respeitando o intervalo (ate la, o lado fica marcado e espera)
    if (t - s.lastSpotAt < SPOT_GAP_MS) return;
    sd.saidLeft = false;
    sd.saidRight = false;
    s.lastSpotAt = t;
    say(frase("spot_livre"), true);
  }

  // ---------------------------------------------------------------- ao fechar a volta
  function lapDone(data, mine, race) {
    const s = st;
    const falas = [];
    const lapS = mine.lastLapMs > 0 ? mine.lastLapMs / 1000 : null;
    const valida = lapS != null && !s.lapInvalid && !s.lapIsOut && !s.lapPitted;
    if (cfg.laps && lapS != null) {
      if (valida) {
        const tempo = tempoFalado(lapS);
        if (s.best == null) falas.push(frase("volta_primeira", { tempo }));
        else if (Math.abs(lapS - s.best) < 0.05) falas.push(frase("volta_igual", { tempo }));
        else if (lapS < s.best) falas.push(frase("volta_melhor", { tempo, ganho: num(s.best - lapS, 1) }));
        else falas.push(frase("volta_normal", { tempo, diferenca: num(lapS - s.best, 1) }));
      } else if (s.lapInvalid && !s.lapIsOut && !s.lapPitted) {
        falas.push(frase("volta_invalida", {}));
      }
    }
    if (valida && (s.best == null || lapS < s.best)) s.best = lapS;
    if (valida) s.lapTimes.push(lapS);
    if (cfg.rivals) falas.push(...rivaisDaVolta(data, mine, race));
    if (falas.length) say(falas.join(" "));
  }

  function rivaisDaVolta(data, mine, race) {
    const s = st;
    const falas = [];
    if (race) {
      const pos = mine.position;
      if (s.posLap != null && pos > 0 && pos !== s.posLap) {
        const n = Math.abs(pos - s.posLap);
        falas.push(frase(pos < s.posLap ? "posicao_ganhou" : "posicao_perdeu", { pos, n, posicoes: n > 1 ? "posições" : "posição" }));
      }
      if (pos > 0) s.posLap = pos;
    }
    // vizinho mais proximo a frente e atras, pelo tempo (shared/gaps.js), entre quem esta na pista
    const len = Number(data.session && data.session.trackLength) || 0;
    const outros = data.standings.filter((e) => e && e !== mine && !isOut(e) && (e.pitMode || 0) === 0);
    let frente = null;
    let tras = null;
    outros.forEach((e) => {
      const ahead = (e.totalDistance || 0) > (mine.totalDistance || 0);
      const g = ahead ? s.gaps.gap(mine.name, e.name, len) : s.gaps.gap(e.name, mine.name, len);
      if (!g || g.laps || !(g.sec > 0)) return;
      if (ahead && (!frente || g.sec < frente.sec)) frente = { e, sec: g.sec };
      if (!ahead && (!tras || g.sec < tras.sec)) tras = { e, sec: g.sec };
    });
    [
      [frente, "à frente"],
      [tras, "atrás"],
    ].forEach(([v, lado]) => {
      if (!v) return;
      const antes = s.gapLap.has(v.e.name) ? s.gapLap.get(v.e.name) : null;
      const variacao = antes == null ? null : antes - v.sec; // positivo: o intervalo diminuiu
      const mudou = variacao != null && Math.abs(variacao) > GAP_MUDANCA_S && v.sec < GAP_MAX_S;
      if (v.sec >= GAP_PERTO_S && !mudou) return;
      let tendencia = "";
      if (variacao != null && Math.abs(variacao) >= 0.3) tendencia = `, ${variacao > 0 ? "chegando" : "se afastando"} ${num(Math.abs(variacao), 1)} nesta volta`;
      falas.push(frase("rival", { nome: nomeFalado(v.e.name), lado, gap: num(v.sec, 1), tendencia }));
    });
    // so os vizinhos guardam o intervalo da volta
    s.gapLap = new Map([frente, tras].filter(Boolean).map((v) => [v.e.name, v.sec]));
    return falas;
  }

  // ---------------------------------------------------------------- avisos ao vivo
  function avisos(data, mine, t) {
    const s = st;
    const falas = [];
    const f = typeof mine.flagColour === "number" ? mine.flagColour : null;
    if (f !== s.flagAnt && t - s.lastFlagAt > 5000 && BANDEIRA[f]) {
      falas.push(frase(BANDEIRA[f], {}));
      s.lastFlagAt = t;
    }
    s.flagAnt = f;
    // batida e danos: so da telemetria do proprio carro (data.car, AMS2)
    const car = data.car;
    const carIsMine = car && typeof car.speedMs === "number" && typeof mine.speedMs === "number" && Math.abs(car.speedMs - mine.speedMs) < Math.max(2, mine.speedMs * 0.12);
    if (carIsMine) {
      const crash = Number(car.crashState) || 0;
      if (crash !== s.crashAnt && BATIDAS.includes(crash) && t - s.lastCrashAt > 10000) {
        falas.push(frase("batida", {}));
        s.lastCrashAt = t;
      }
      s.crashAnt = crash;
      const arr = (a) => (Array.isArray(a) ? a.filter((v) => typeof v === "number") : []);
      const susp = Math.max(0, ...arr(car.suspDamage), ...arr(car.brakeDamage));
      [
        ["aerodinâmico", Number(car.aeroDamage) || 0],
        ["no motor", Number(car.engineDamage) || 0],
        ["na suspensão ou nos freios", susp],
      ].forEach(([parte, v], k) => {
        const faixa = Math.min(3, Math.floor(Math.max(0, Math.min(1, v)) * 4));
        if (faixa > s.damageSaid[k] && faixa >= 1) falas.push(frase("dano", { parte, pct: faixa * 25 }));
        s.damageSaid[k] = Math.max(s.damageSaid[k], faixa);
      });
    }
    falas.push(...parados(data, mine, t));
    return falas;
  }

  // carro parado na pista a frente: um ou mais, uma vez a cada tanto
  function parados(data, mine, t) {
    const s = st;
    const len = Number(data.session && data.session.trackLength) || 0;
    if ((mine.speedMs || 0) < MINHA_VEL_MIN_MS || !(len > 0)) {
      s.stopped.forEach((r) => (r.since = null));
      return [];
    }
    const myD = ((mine.lapDistance || 0) % len + len) % len;
    const found = [];
    data.standings.forEach((e) => {
      if (!e || e === mine || isOut(e) || (e.pitMode || 0) !== 0) return;
      const r = s.stopped.get(e.name) || { since: null, warnedAt: -1e9 };
      s.stopped.set(e.name, r);
      if ((e.speedMs || 0) < PARADO_MS) {
        if (r.since == null) r.since = t;
        const metros = (((e.lapDistance || 0) - myD) % len + len) % len;
        if (t - r.since >= PARADO_SEG * 1000 && metros >= PARADO_MIN_M && metros <= PARADO_MAX_M) found.push({ e, metros, r });
      } else {
        r.since = null;
      }
    });
    if (!found.length || !found.some((p) => t - p.r.warnedAt > ENTRE_PARADOS_S * 1000)) return [];
    found.forEach((p) => (p.r.warnedAt = t));
    const metros = Math.round(Math.min(...found.map((p) => p.metros)) / 10) * 10;
    return [found.length === 1 ? frase("parado_um", { nome: nomeFalado(found[0].e.name), metros }) : frase("parado_varios", { qtd: found.length, metros })];
  }

  // ---------------------------------------------------------------- fim da corrida
  function resultado(data, mine) {
    const s = st;
    if (isOut(mine)) return mine.raceState === 4 ? "Você foi desqualificado. Foi mal." : "Corrida encerrada sem a bandeira. Foi mal.";
    const n = data.standings.length;
    const pos = mine.position;
    const f = [`Bandeira quadriculada. Você terminou na posição ${pos} de ${n}.`];
    if (s.best != null) f.push(`Melhor volta ${tempoFalado(s.best)}.`);
    const g = mine.startPosition;
    if (g > 0 && pos > 0 && pos < g) f.push(`Foi bem: ganhou ${g - pos} posições desde a largada.`);
    else if (g > 0 && pos === g && pos <= 3) f.push("Foi bem: manteve o pódio.");
    else if (g > 0 && pos === g) f.push("Resultado neutro: manteve a posição de largada.");
    else if (g > 0 && pos > g) f.push(`Foi mal: perdeu ${pos - g} posições desde a largada.`);
    else if (pos > 0 && pos <= Math.ceil(n / 3)) f.push("Foi bem: entre os primeiros.");
    else if (pos > 0) f.push("Foi mal: atrás do pelotão da frente.");
    return f.join(" ");
  }

  // ---------------------------------------------------------------- a cada leitura
  function update(data) {
    if ((!cfg.on && !cfg.spotter) || !data || !Array.isArray(data.standings)) return;
    const sess = data.session || {};
    const key = `${data.game}|${sess.state}|${sess.trackLocation || ""}|${sess.trackVariation || ""}`;
    const list = data.standings;
    const mine = list.find((e) => e && e.isPlayer);
    if (!mine) return;
    if (key !== sessionKey || mine.name !== me) {
      sessionKey = key;
      me = mine.name;
      st = fresh();
    }
    const s = st;
    const t = clock();
    s.gaps.update(list, data.ts || t);
    spotter(data.game, list, mine);
    if (!cfg.on || s.closed) return; // so o spotter ligado: o radio fica quieto
    const race = Number(sess.state) === 5;

    // fim da corrida: o resultado, e o radio se cala
    if (race && (mine.raceState === 3 || isOut(mine))) {
      s.closed = true;
      if (cfg.result) say(resultado(data, mine));
      return;
    }
    if (mine.lapInvalidated) s.lapInvalid = true;
    if ((mine.pitMode || 0) !== 0) s.lapPitted = true;
    const laps = Number(mine.lapsCompleted) || 0;
    if (s.lastLaps != null && laps === s.lastLaps + 1) {
      lapDone(data, mine, race);
      s.lapInvalid = !!mine.lapInvalidated;
      s.lapPitted = (mine.pitMode || 0) !== 0;
      s.lapIsOut = false;
    }
    s.lastLaps = laps;

    if (cfg.alerts) {
      const falas = avisos(data, mine, t);
      if (falas.length) say(falas.join(" "));
    }
  }

  function configure(patch) {
    const p = patch || {};
    Object.keys(DEFAULTS).forEach((k) => {
      if (p[k] === undefined) return;
      if (k === "phrases") {
        const next = {};
        Object.entries(p.phrases || {}).forEach(([key, text]) => {
          if (PHRASE_DEFAULT[key] != null && typeof text === "string" && text.trim()) next[key] = text.slice(0, 300);
        });
        cfg.phrases = next;
      } else if (typeof DEFAULTS[k] === "boolean") cfg[k] = !!p[k];
      else if (typeof DEFAULTS[k] === "number") cfg[k] = Math.max(k === "rate" ? -5 : 0, Math.min(k === "rate" ? 5 : 100, Number(p[k]) || 0));
      else cfg[k] = k === "voice" ? voiceId(p[k]) : String(p[k] || "");
    });
    if (!cfg.on && !cfg.spotter) {
      st = null;
      sessionKey = null;
    }
    return config();
  }

  function config() {
    return Object.assign({}, cfg, { phrases: Object.assign({}, cfg.phrases) });
  }

  // o texto de exemplo de uma frase (botao Testar do painel)
  function sample(key) {
    const ex = { tempo: "1 minuto e 58,2", ganho: "0,4", diferenca: "0,8", parte: "no motor", pct: 50, nome: "Senna", metros: 250, qtd: 3, pos: 2, n: 1, posicoes: "posição", lado: "atrás", gap: "1,8", tendencia: ", chegando 0,6 nesta volta" };
    return frase(key, ex);
  }

  return { update, configure, config, sample };
}

module.exports = { createEngineer, DEFAULTS, PHRASES, tempoFalado, nomeFalado };
