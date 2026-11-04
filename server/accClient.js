// server/accClient.js
// Assetto Corsa Competizione.
// O ACC nao expoe os adversarios pela Shared Memory (so o carro do jogador).
// A lista completa vem da "Broadcasting API" do proprio jogo: um protocolo
// UDP local, o mesmo usado pelas ferramentas de transmissao. Este modulo se
// registra nela, monta o mesmo payload que os listeners do AMS2/LMU mandam
// (position, pitMode, raceState, ...) e entrega para o servidor.
//
// A API precisa estar ligada no jogo. O arquivo e
//   Documentos\Assetto Corsa Competizione\Config\broadcasting.json
// com "updListenerPort" diferente de 0 (padrao 9000). O ACC le esse arquivo
// so ao abrir. A senha de conexao e lida do mesmo arquivo.

const dgram = require("dgram");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const PROTOCOL_VERSION = 4;
const UPDATE_INTERVAL_MS = 100; // de quanto em quanto tempo o jogo manda os carros
// REGRA DE OURO: nunca repetir um pedido antes de dar tempo de o jogo responder.
// O ACC le UM unico pedido a cada ~200 quadros (de 1,5 a 5 s, visto no log do
// jogo), e cada pedido de registro repetido cria um cliente duplicado la
// dentro. Mandar pedidos seguidos entope essa fila e a tabela demora MINUTOS
// para aparecer. Por isso: um pedido por vez, e so repete depois de um bom tempo.
const REQUEST_TIMEOUT_MS = 12000; // espera pela resposta antes de repetir um pedido
const UNKNOWN_RETRY_MS = 15000; // sem saber se ha sessao aberta: tenta de vez em quando
const SILENCE_MS = 3000; // sem pacotes por esse tempo: perdeu o contato
const CHECK_MS = 250; // de quanto em quanto tempo a situacao e reavaliada
const ENTRY_LIST_MIN_GAP_MS = 3000; // intervalo minimo entre dois pedidos da lista de inscritos
const EMIT_MIN_MS = 110; // no maximo ~9 atualizacoes por segundo para as overlays
const CAR_STALE_MS = 5000; // carro sem atualizacao por esse tempo sai da lista
const INT32_MAX = 2147483647;

// mensagens que chegam / que enviamos
const IN = { REGISTRATION: 1, REALTIME_UPDATE: 2, CAR_UPDATE: 3, ENTRY_LIST: 4, TRACK_DATA: 5, ENTRY_LIST_CAR: 6, EVENT: 7 };
const OUT = { REGISTER: 1, UNREGISTER: 9, REQUEST_ENTRY_LIST: 10, REQUEST_TRACK_DATA: 11 };

// Sessao do ACC -> mesmos codigos do AMS2 (1 treino, 3 classificacao,
// 4 volta de formacao, 5 corrida, 6 time attack)
function sessionState(type, phase) {
  if (type === 10) return phase === 2 || phase === 3 ? 4 : 5; // corrida (pre-formacao / formacao)
  if (type === 4 || type === 9) return 3; // classificacao, superpole
  if (type === 11 || type === 12 || type === 13) return 6; // hotlap, hotstint
  return 1; // treino (0) e o resto
}
const SESSION_LABELS = { 1: "TREINO LIVRE", 3: "CLASSIFICACAO", 4: "VOLTA DE FORMACAO", 5: "CORRIDA", 6: "TIME ATTACK" };

// Modelos de carro do ACC: id -> [nome, classe]
const CAR_MODELS = {
  0: ["Porsche 991 GT3 R", "GT3"], 1: ["Mercedes-AMG GT3", "GT3"], 2: ["Ferrari 488 GT3", "GT3"],
  3: ["Audi R8 LMS", "GT3"], 4: ["Lamborghini Huracan GT3", "GT3"], 5: ["McLaren 650S GT3", "GT3"],
  6: ["Nissan GT-R Nismo GT3", "GT3"], 7: ["BMW M6 GT3", "GT3"], 8: ["Bentley Continental GT3", "GT3"],
  9: ["Porsche 991 II GT3 Cup", "CUP"], 10: ["Nissan GT-R Nismo GT3", "GT3"], 11: ["Bentley Continental GT3", "GT3"],
  12: ["Aston Martin V12 Vantage GT3", "GT3"], 13: ["Lamborghini Gallardo R-EX", "GT3"], 14: ["Jaguar G3", "GT3"],
  15: ["Lexus RC F GT3", "GT3"], 16: ["Lamborghini Huracan GT3 Evo", "GT3"], 17: ["Honda NSX GT3", "GT3"],
  18: ["Lamborghini Huracan Super Trofeo", "ST"], 19: ["Audi R8 LMS Evo", "GT3"], 20: ["Aston Martin V8 Vantage GT3", "GT3"],
  21: ["Honda NSX GT3 Evo", "GT3"], 22: ["McLaren 720S GT3", "GT3"], 23: ["Porsche 911 II GT3 R", "GT3"],
  24: ["Ferrari 488 GT3 Evo", "GT3"], 25: ["Mercedes-AMG GT3 Evo", "GT3"], 26: ["Ferrari 488 Challenge Evo", "CHL"],
  27: ["BMW M2 CS Racing", "TCX"], 28: ["Porsche 992 GT3 Cup", "CUP"], 29: ["Lamborghini Huracan Super Trofeo Evo2", "ST"],
  30: ["BMW M4 GT3", "GT3"], 31: ["Audi R8 LMS GT3 Evo II", "GT3"], 32: ["Ferrari 296 GT3", "GT3"],
  33: ["Lamborghini Huracan GT3 Evo2", "GT3"], 34: ["Porsche 992 GT3 R", "GT3"], 35: ["McLaren 720S GT3 Evo", "GT3"],
  36: ["Ford Mustang GT3", "GT3"],
  50: ["Alpine A110 GT4", "GT4"], 51: ["Aston Martin V8 Vantage GT4", "GT4"], 52: ["Audi R8 LMS GT4", "GT4"],
  53: ["BMW M4 GT4", "GT4"], 55: ["Chevrolet Camaro GT4", "GT4"], 56: ["Ginetta G55 GT4", "GT4"],
  57: ["KTM X-Bow GT4", "GT4"], 58: ["Maserati MC GT4", "GT4"], 59: ["McLaren 570S GT4", "GT4"],
  60: ["Mercedes-AMG GT4", "GT4"], 61: ["Porsche 718 Cayman GT4", "GT4"],
  80: ["Audi R8 LMS GT2", "GT2"], 82: ["KTM X-Bow GT2", "GT2"], 83: ["Maserati MC20 GT2", "GT2"],
  84: ["Mercedes-AMG GT2", "GT2"], 85: ["Porsche 911 GT2 RS CS Evo", "GT2"], 86: ["Porsche 935", "GT2"],
};

// ---------------------------------------------------------------- leitura binaria
class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  u8() { return this.buf.readUInt8(this.pos++); }
  u16() { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  i32() { const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  f32() { const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
  str() {
    const len = this.u16();
    const s = this.buf.toString("utf8", this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
  // volta: tempo, carro, piloto, parciais e marcadores
  lap() {
    const ms = this.i32();
    this.u16(); // carIndex
    this.u16(); // driverIndex
    const count = this.u8();
    const splits = [];
    for (let i = 0; i < count; i++) {
      const s = this.i32();
      splits.push(s === INT32_MAX || s <= 0 ? null : s);
    }
    const invalid = this.u8() > 0;
    const validForBest = this.u8() > 0;
    const outLap = this.u8() > 0;
    const inLap = this.u8() > 0;
    while (splits.length < 3) splits.push(null);
    return { ms: ms === INT32_MAX || ms <= 0 ? null : ms, splits, invalid, validForBest, outLap, inLap };
  }
}

function writeString(text) {
  const body = Buffer.from(String(text || ""), "utf8");
  const head = Buffer.alloc(2);
  head.writeUInt16LE(body.length, 0);
  return Buffer.concat([head, body]);
}

function int32(value) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(value, 0);
  return b;
}

// ---------------------------------------------------------------- configuracao do jogo
let documentsDir = null;
function findDocuments() {
  if (documentsDir) return documentsDir;
  try {
    // a pasta Documentos pode estar redirecionada (OneDrive, outro disco)
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", "[Environment]::GetFolderPath('MyDocuments')"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
    }).trim();
    if (out) documentsDir = out;
  } catch (_) {}
  if (!documentsDir) documentsDir = path.join(os.homedir(), "Documents");
  return documentsDir;
}

// { port, password } ou null se a API estiver desligada / arquivo ausente
function readGameConfig() {
  const file = path.join(findDocuments(), "Assetto Corsa Competizione", "Config", "broadcasting.json");
  try {
    const raw = fs.readFileSync(file);
    // o jogo grava em UTF-16; aceita UTF-8 tambem
    const text = raw.length > 1 && raw[1] === 0 ? raw.toString("utf16le") : raw.toString("utf8");
    const cfg = JSON.parse(text.replace(/^﻿/, ""));
    const port = Number(cfg.updListenerPort || cfg.udpListenerPort);
    if (!port) return { file, port: 0, password: "" };
    return { file, port, password: String(cfg.connectionPassword || "") };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- cliente
// options (so para testes): { port, password } no lugar do arquivo do jogo
function startAccClient(onPayload, options) {
  const fixedConfig = options && options.port ? { file: "(teste)", port: options.port, password: options.password || "" } : null;
  const socket = dgram.createSocket("udp4");
  let config = null;
  let connectionId = null;
  let lastPacketAt = 0;
  let lastRegisterAt = 0;
  let entryRequestAt = 0;
  let entryPending = false;
  let trackRequestAt = 0;
  let warnedDisabled = false;
  let announced = false;
  let inContact = false;
  let lastEmitAt = 0;
  // conexoes que o jogo abriu para nos desde que a API foi iniciada (ver REGISTRATION)
  const myIds = new Set();
  // O jogo esta numa sessao? true/false vem do listener.ps1, que le o estado
  // do ACC na Shared Memory; null = ninguem informou ainda.
  let gameLive = null;

  const entries = new Map(); // carIndex -> dados fixos (equipe, numero, pilotos, modelo)
  const cars = new Map(); // carIndex -> ultima atualizacao em tempo real
  let track = { name: "", meters: 0 };
  let session = null;
  // corrida encerrada: quem ja recebeu a bandeirada
  let overSince = null; // { key, lastLaps, winner, lapsAtFlag, finishOrder, finishLaps } (ver emit)
  const maxSpeed = new Map();
  let maxSpeedKey = null;
  // carIndex -> { behindLine, wrapped, last }: ver carProgress()
  const progress = new Map();

  // Quanto o carro ja andou na corrida, em voltas (ex: 3.25 = um quarto da 4a
  // volta). E com isso que a posicao e calculada ao vivo, sem esperar o jogo.
  // Na largada os carros estao ANTES da linha, com a posicao na volta perto
  // de 1 e nenhuma volta completa; sem corrigir, pareceriam estar quase uma
  // volta a frente de quem ja cruzou a linha. Por isso, quem e visto antes da
  // linha na largada vale "menos uma volta" ate cruza-la.
  function trackProgress(carIndex, laps, spline) {
    let st = progress.get(carIndex);
    if (!st) {
      const atStart = session && sessionState(session.sessionType, session.phase) >= 4 && (session.phase < 5 || session.elapsedMs < 20000);
      st = { behindLine: !!atStart && laps === 0 && spline > 0.5, wrapped: false, last: spline };
      progress.set(carIndex, st);
    }
    if (st.last - spline > 0.5) st.wrapped = true; // cruzou a linha
    st.last = spline;
  }

  function carProgress(c) {
    const st = progress.get(c.carIndex);
    const spline = Math.max(0, Math.min(1, c.spline));
    return c.laps + spline - (st && st.behindLine && !st.wrapped ? 1 : 0);
  }

  function send(buf) {
    if (!config || !config.port) return;
    socket.send(buf, config.port, "127.0.0.1", () => {});
  }

  function register() {
    lastRegisterAt = Date.now();
    config = fixedConfig || readGameConfig();
    if (!config) return; // jogo nunca foi aberto nesta maquina
    if (!config.port) {
      if (!warnedDisabled) {
        warnedDisabled = true;
        console.log(`ACC: a API de transmissao esta desligada. Defina "updListenerPort": 9000 em ${config.file} e reabra o jogo.`);
      }
      return;
    }
    send(
      Buffer.concat([
        Buffer.from([OUT.REGISTER, PROTOCOL_VERSION]),
        writeString("LLG Overlay"),
        writeString(config.password),
        int32(UPDATE_INTERVAL_MS),
        writeString(""), // sem senha de comando: so leitura
      ])
    );
  }

  // Lista de inscritos (nomes, equipes, carros). Um pedido por vez.
  function requestEntryList() {
    const now = Date.now();
    if (connectionId === null) return;
    if (entryPending && now - entryRequestAt < REQUEST_TIMEOUT_MS) return; // ainda esperando a resposta
    if (now - entryRequestAt < ENTRY_LIST_MIN_GAP_MS) return;
    entryRequestAt = now;
    entryPending = true;
    send(Buffer.concat([Buffer.from([OUT.REQUEST_ENTRY_LIST]), int32(connectionId)]));
  }

  // Dados da pista (nome e comprimento). Repete so se a resposta nao vier.
  function requestTrackData() {
    const now = Date.now();
    if (connectionId === null || track.meters) return;
    if (now - trackRequestAt < REQUEST_TIMEOUT_MS) return;
    trackRequestAt = now;
    send(Buffer.concat([Buffer.from([OUT.REQUEST_TRACK_DATA]), int32(connectionId)]));
  }

  function resetSessionData() {
    cars.clear();
    progress.clear();
    overSince = null;
  }

  function onMessage(buf) {
    lastPacketAt = Date.now();
    const r = new Reader(buf);
    const type = r.u8();

    if (type === IN.REGISTRATION) {
      const id = r.i32();
      const ok = r.u8() > 0;
      r.u8(); // somente leitura
      const error = r.str();
      if (!ok) {
        console.log("ACC: registro recusado:", error || "(sem mensagem)");
        connectionId = null;
        return;
      }
      // Cada registro aceito vira um cliente no jogo, e TODOS mandam os dados
      // para a nossa porta. Um registro repetido (o primeiro demorou a ser
      // lido, ou o jogo ficou um tempo calado) deixa clientes sobrando, e os
      // dados passam a chegar em dobro ou triplo. Por isso, ao receber uma
      // conexao nova, as anteriores sao canceladas.
      // Os ids recomecam do 1 quando o jogo reinicia a API (sessao nova): um
      // id menor que os conhecidos significa que os antigos ja nao existem,
      // e cancela-los poderia derrubar a conexao de outro programa.
      if (Array.from(myIds).some((old) => old > id)) myIds.clear();
      myIds.forEach((old) => {
        if (old !== id) send(Buffer.concat([Buffer.from([OUT.UNREGISTER]), int32(old)]));
      });
      myIds.clear();
      myIds.add(id);
      connectionId = id;
      inContact = true;
      if (!announced) {
        announced = true;
        console.log("ACC: conectado a API de transmissao do jogo.");
      }
      // os dois pedidos vao juntos; o jogo atende um em cada leitura
      entryRequestAt = 0;
      entryPending = false;
      trackRequestAt = 0;
      track = { name: "", meters: 0 };
      requestEntryList();
      requestTrackData();
    } else if (type === IN.ENTRY_LIST) {
      r.i32(); // connectionId
      entryPending = false;
      const count = r.u16();
      const present = new Set();
      for (let i = 0; i < count; i++) present.add(r.u16());
      // quem saiu da sessao some das listas
      Array.from(entries.keys()).forEach((k) => { if (!present.has(k)) entries.delete(k); });
      Array.from(cars.keys()).forEach((k) => { if (!present.has(k)) cars.delete(k); });
    } else if (type === IN.ENTRY_LIST_CAR) {
      const carIndex = r.u16();
      const model = r.u8();
      const teamName = r.str();
      const raceNumber = r.i32();
      const cupCategory = r.u8();
      const currentDriver = r.u8();
      r.u16(); // nacionalidade
      const count = r.u8();
      const drivers = [];
      for (let i = 0; i < count; i++) {
        const first = r.str();
        const last = r.str();
        const short = r.str();
        r.u8(); // categoria
        r.u16(); // nacionalidade
        drivers.push({ name: `${first} ${last}`.trim() || short, short });
      }
      entries.set(carIndex, { model, teamName, raceNumber, cupCategory, currentDriver, drivers });
    } else if (type === IN.TRACK_DATA) {
      r.i32(); // connectionId
      const name = r.str();
      r.i32(); // id
      const meters = r.i32();
      track = { name, meters };
    } else if (type === IN.CAR_UPDATE) {
      const carIndex = r.u16();
      const driverIndex = r.u16();
      r.u8(); // quantidade de pilotos
      r.u8(); // marcha
      const worldX = r.f32(); // posicao X no mundo
      const worldZ = r.f32(); // posicao Y no mundo (o outro eixo horizontal; aqui chamado de Z, como nos outros jogos)
      r.f32(); // direcao
      const location = r.u8(); // 1 pista, 2 pit lane, 3 entrada do box, 4 saida do box
      const kmh = r.u16();
      const position = r.u16();
      r.u16(); // posicao na categoria
      r.u16(); // posicao na pista
      const spline = r.f32(); // 0..1 ao longo da volta
      const laps = r.u16();
      r.i32(); // delta para a melhor volta
      const best = r.lap();
      const last = r.lap();
      const current = r.lap();
      cars.set(carIndex, { carIndex, driverIndex, location, kmh, worldX, worldZ, position, spline, laps, best, last, current, at: Date.now() });
      trackProgress(carIndex, laps, spline);
      if (!entries.has(carIndex)) requestEntryList(); // carro novo: pede a lista de novo
    } else if (type === IN.REALTIME_UPDATE) {
      r.u16(); // indice do evento
      const sessionIndex = r.u16();
      const sessionType = r.u8();
      const phase = r.u8();
      const elapsedMs = r.f32(); // tempo de sessao decorrido (ms)
      const remainingMs = r.f32(); // tempo restante da sessao (ms)
      const focused = r.i32();
      r.str(); // conjunto de cameras
      r.str(); // camera
      r.str(); // pagina do HUD
      const key = `${sessionIndex}|${sessionType}`;
      if (!session || session.key !== key) resetSessionData();
      session = { key, sessionType, phase, elapsedMs, remainingMs, focused };
      emit();
    }
    // IN.EVENT (acidentes, melhores voltas): nao usado
  }

  function emit() {
    if (!session) return;
    const now = Date.now();
    if (now - lastEmitAt < EMIT_MIN_MS) return; // nao inunda as overlays
    lastEmitAt = now;
    const state = sessionState(session.sessionType, session.phase);
    const isRace = state === 5;
    const trackLength = track.meters || 0;

    // velocidade maxima vale por sessao
    if (maxSpeedKey !== `${session.key}|${track.name}`) {
      maxSpeedKey = `${session.key}|${track.name}`;
      maxSpeed.clear();
    }

    const live = Array.from(cars.values()).filter((c) => now - c.at < CAR_STALE_MS && entries.has(c.carIndex));

    // Bandeirada: o jogo nao marca quem terminou, e a corrida e por tempo.
    // A fase "encerrada" (6) comeca quando o TEMPO zera, com todos ainda na
    // pista. A bandeirada e dada no momento em que o carro que esta LIDERANDO
    // cruza a linha depois disso. Quem cruza a linha sem estar na lideranca
    // (inclusive quem vira lider depois, com a parada dos outros) continua
    // correndo. Dada a bandeirada, cada carro termina quando cruza a linha.
    // O lider e quem mais andou: a posicao oficial do jogo demora a atualizar.
    if (isRace && session.phase >= 6) {
      if (!overSince || overSince.key !== session.key) {
        overSince = { key: session.key, lastLaps: new Map(), winner: null, lapsAtFlag: null, finishOrder: new Map(), finishLaps: new Map() };
      }
      if (overSince.winner === null) {
        let leader = null;
        live.forEach((c) => {
          if (!leader || carProgress(c) > carProgress(leader)) leader = c;
        });
        const before = leader ? overSince.lastLaps.get(leader.carIndex) : undefined;
        if (leader && before !== undefined && leader.laps > before) {
          // o lider acabou de cruzar a linha: bandeirada
          overSince.winner = leader.carIndex;
          overSince.lapsAtFlag = new Map(live.map((c) => [c.carIndex, c.laps]));
        }
      }
      live.forEach((c) => {
        overSince.lastLaps.set(c.carIndex, c.laps);
        // carro que so apareceu depois da bandeirada: termina na proxima passagem
        if (overSince.lapsAtFlag && !overSince.lapsAtFlag.has(c.carIndex)) overSince.lapsAtFlag.set(c.carIndex, c.laps);
      });
    } else {
      overSince = null;
    }

    // Quem ja recebeu a bandeirada, na ordem em que cruzou a linha.
    const finishedCars = new Set();
    if (overSince && overSince.winner !== null) {
      live.forEach((c) => {
        const atFlag = overSince.lapsAtFlag.get(c.carIndex);
        if (c.carIndex !== overSince.winner && !(atFlag !== undefined && c.laps > atFlag)) return;
        finishedCars.add(c.carIndex);
        if (!overSince.finishOrder.has(c.carIndex)) {
          overSince.finishOrder.set(c.carIndex, overSince.finishOrder.size + 1);
          overSince.finishLaps.set(c.carIndex, c.laps);
        }
      });
    }

    // Posicao ao vivo: o jogo so atualiza a posicao oficial de tempos em
    // tempos (e ela chega a piscar no instante da bandeirada). Em corrida, a
    // ordem e calculada aqui pela distancia percorrida, entao uma
    // ultrapassagem aparece na hora. Quem ja terminou fica congelado com as
    // voltas que completou, na ordem de chegada: a frente de quem tem menos
    // voltas e de quem ainda esta na mesma volta. Em treino e classificacao a
    // ordem e por melhor volta, e a do jogo ja serve.
    let livePosition = null;
    if (isRace && session.phase >= 5) {
      const rank = (c) => (finishedCars.has(c.carIndex) ? overSince.finishLaps.get(c.carIndex) : carProgress(c));
      const order = (c) => (finishedCars.has(c.carIndex) ? overSince.finishOrder.get(c.carIndex) : Infinity);
      livePosition = new Map();
      live
        .slice()
        .sort((x, y) => rank(y) - rank(x) || order(x) - order(y) || x.position - y.position)
        .forEach((c, i) => livePosition.set(c.carIndex, i + 1));
    }

    const standings = live.map((c) => {
      const entry = entries.get(c.carIndex);
      const driver = entry.drivers[c.driverIndex] || entry.drivers[entry.currentDriver] || entry.drivers[0] || { name: `#${entry.raceNumber}` };
      const model = CAR_MODELS[entry.model] || [`Carro ${entry.model}`, "GT3"];
      const speedKmh = c.kmh;
      const best = Math.max(maxSpeed.get(c.carIndex) || 0, speedKmh);
      maxSpeed.set(c.carIndex, best);

      // box: mesmos codigos do AMS2 (1 entrando, 2 no pit lane, 3 saindo)
      const pitMode = c.location === 3 ? 1 : c.location === 2 ? 2 : c.location === 4 ? 3 : 0;

      const finished = finishedCars.has(c.carIndex);

      // parciais: a volta atual traz os setores ja fechados; o 3o so existe na
      // ultima volta. Com o carro no 3o setor o S3 antigo nao e enviado.
      const cur = c.current.splits;
      const currentSector = cur[0] == null ? 0 : cur[1] == null ? 1 : 2;
      return {
        slot: c.carIndex,
        position: livePosition ? livePosition.get(c.carIndex) : c.position,
        name: driver.name,
        carName: model[0],
        carClass: model[1],
        teamName: entry.teamName || "",
        carNumber: String(entry.raceNumber),
        lapsCompleted: c.laps,
        currentLap: c.laps + 1,
        totalDistance: carProgress(c) * trackLength,
        lastLapMs: c.last.ms,
        fastestLapMs: c.best.ms,
        speedKmh,
        speedMs: Math.round((speedKmh / 3.6) * 100) / 100,
        worldX: Math.round(c.worldX * 10) / 10,
        worldZ: Math.round(c.worldZ * 10) / 10,
        maxSpeedKmh: best,
        isPlayer: c.carIndex === session.focused, // carro em foco na camera do jogo
        pitMode,
        raceState: finished ? 3 : 2,
        inRace: isRace,
        sector1Ms: cur[0],
        sector2Ms: cur[1],
        sector3Ms: currentSector !== 2 ? c.last.splits[2] : null,
        currentSector,
        bestSector1Ms: c.best.splits[0],
        bestSector2Ms: c.best.splits[1],
        bestSector3Ms: c.best.splits[2],
        causedYellow: false,
        lapInvalidated: c.current.invalid,
      };
    });
    standings.sort((a, b) => a.position - b.position);

    onPayload({
      game: "acc",
      session: {
        state: standings.length ? state : 0,
        label: SESSION_LABELS[state],
        timeRemainingSec: Math.max(0, Math.round((session.remainingMs || 0) / 1000)),
        lapsInEvent: 0, // corridas do ACC sao por tempo
        scOut: false,
        trackLocation: track.name,
        trackVariation: "",
        trackLength,
      },
      standings,
    });
  }

  socket.on("message", (buf) => {
    try {
      onMessage(buf);
    } catch (err) {
      // pacote inesperado (versao nova do jogo?): ignora este e segue
    }
  });
  // no Windows, mandar UDP para uma porta fechada (jogo fechado) gera erro no socket
  socket.on("error", () => {});
  socket.bind(0, "127.0.0.1");

  // Sem contato com o jogo: limpa a tabela uma vez (as overlays nao ficam
  // mostrando a ultima sessao). A lista de inscritos fica guardada: se o jogo
  // voltar a mandar dados para a mesma conexao, os nomes aparecem na hora.
  function lostContact() {
    if (!inContact && !cars.size) return;
    inContact = false;
    announced = false;
    resetSessionData();
    session = null;
    onPayload({
      game: "acc",
      session: { state: 0, label: null, timeRemainingSec: 0, lapsInEvent: 0, scOut: false, trackLocation: track.name, trackVariation: "", trackLength: track.meters || 0 },
      standings: [],
    });
  }

  const timer = setInterval(() => {
    const now = Date.now();
    const silent = now - lastPacketAt > SILENCE_MS;
    if (!silent) {
      // em contato: so repete pedidos cuja resposta nao veio a tempo
      if (entryPending) requestEntryList();
      requestTrackData();
      return;
    }
    lostContact();
    if (gameLive === false) return; // jogo no menu ou fechado: nao adianta pedir
    const wait = gameLive === true ? REQUEST_TIMEOUT_MS : UNKNOWN_RETRY_MS;
    if (now - lastRegisterAt >= wait) register();
  }, CHECK_MS);
  register();

  // O listener.ps1 avisa quando o ACC entra ou sai de uma sessao. Ao entrar,
  // o registro e pedido na hora (uma vez), em vez de esperar a proxima tentativa.
  function setGameLive(live) {
    const value = !!live;
    if (value === gameLive) return;
    const wasLive = gameLive;
    gameLive = value;
    // Ao entrar numa sessao sem estar recebendo dados, pede o registro ja no
    // proximo ciclo. Ao sair, nada e desfeito aqui: se os dados pararem, o
    // ciclo acima percebe pelo silencio; se continuarem, a conexao segue valendo.
    if (value && wasLive !== null && Date.now() - lastPacketAt > SILENCE_MS) lastRegisterAt = 0;
  }

  // Avisa o jogo que estamos saindo. Sem isso o ACC continua mandando dados
  // para uma porta que nao existe mais ate desistir sozinho.
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    myIds.forEach((id) => send(Buffer.concat([Buffer.from([OUT.UNREGISTER]), int32(id)])));
    setTimeout(() => {
      try {
        socket.close();
      } catch (_) {}
    }, 100);
  }

  return { stop, setGameLive };
}

module.exports = { startAccClient, readGameConfig, sessionState, CAR_MODELS };
