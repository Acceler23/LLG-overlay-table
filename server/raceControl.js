// server/raceControl.js
// Direcao de prova no Le Mans Ultimate (aba LMU do painel, com senha).
// O botao de FCY manda uma mensagem no chat do jogo pela API local
// (POST /rest/chat/ com o texto puro: sai com o nome da conta deste PC) e
// marca o FCY nos dados que vao para as overlays (session.fcy).
// Depois da contagem (segundos para os pilotos reduzirem), quem passar de
// 60 km/h queima o FCY: cada trecho acima do limite vira uma infracao, com
// a duracao, a velocidade maxima e quanto tempo depois do fim da contagem
// comecou. Ao encerrar, a contagem da bandeira verde (fcyEnding + numeros no
// chat) mantem o FCY e o limite valendo ate a mensagem de bandeira verde.
// O botao de Safety Car manda a mensagem dele e deixa a tabela
// como no safety car do jogo (session.scOut). FCY e SC nao ficam ligados
// juntos: ligar um desliga o outro sem mandar a mensagem de bandeira verde.
// Com o SC, o botao de retardatarios manda o aviso e, 10 s depois, o nome de
// cada retardatario na fila (entre o SC e o lider) + "PODE ULTRAPASSAR".
// O safety car e um carro da sessao: por padrao o unico LMGTE; sem LMGTE ou
// com mais de um, o painel escolhe. Ele nao conta como lider nem no FCY.
// A senha da aba e fixa, a mesma para toda a liga; no codigo fica so o hash.
// Seguir o chat (opcional, sem senha): o app de outro PC le o chat do LMU e
// liga/desliga o FCY e o SC quando aparecem as mensagens deles, de qualquer
// um (quem abusar e punido por fora).

const crypto = require("crypto");
const { createIncidentWatch, markLmuYellow } = require("./incidents");
const { createGameIncidents } = require("./lmuIncidents");

const PORT = process.env.LMU_API_PORT || 6397;
const CHAT_URL = `http://127.0.0.1:${PORT}/rest/chat/`;
const MAX_MESSAGE = 200;
const FCY_LIMIT_KMH = 60;
const COUNTDOWN_MAX_S = 60;
const DEFAULT_COUNTDOWN_S = 20;
const CHAT_TICKS_FROM = 10; // a contagem no chat so manda os ultimos 10 s (FCY EM 15S, 5 s de pausa, FCY EM 10S...)
const DEFAULT_GREEN_S = 10; // contagem da bandeira verde ao encerrar o FCY
// senha fixa da aba LMU (scrypt com sal; o texto da senha nao fica no codigo)
const LMU_PASSWORD_HASH = "36b0138383bab716c9b0153fce39aa27:27f7ff95c3b305e9c6a2379bcfeaddb500477f44f70050ff1c4f50f6c6c248df";
const CHAT_POLL_MS = 1000;
const GAME_POLL_MS = 2000; // lista de incidentes do jogo
const REPLAY_MAX_KMH = 5; // acima disso, o proprio carro esta andando
const CHAT_IDLE_MS = 5000; // sem dados do LMU por esse tempo: para de ler o chat
// padroes de versoes anteriores (salvos no painel sem querer mudar)
const OLD_FCY_ON = ["FCY - FULL COURSE YELLOW", "FCY EM {s} SEGUNDOS - LIMITE 60 KM/H", "FCY EM {s}S"];
const OLD_FCY_GO = ["FCY"];
// {s} vira os segundos da contagem. fcyGo: no fim da contagem (o limite passa a valer)
const DEFAULT_MESSAGES = {
  fcyOn: "FCY EM {s}S - 60KMH",
  fcyOff: "BANDEIRA VERDE",
  fcyGo: "FCY - LIMITADOR DE BOX LIGADO",
  fcyEnding: "BANDEIRA VERDE EM {s} SEGUNDOS",
  fcyTick: "FCY {s}S", // contagem no chat depois de fcyOn
  greenTick: "VERDE {s}S", // contagem no chat depois de fcyEnding
  scOn: "SAFETY CAR NA PISTA",
  scOff: "SAFETY CAR NESSA VOLTA - PREPARAR PARA RELARGADA",
  scCatch: "PILOTOS PODEM ALCANÇAR O SAFETY CAR", // logo depois de scOn
  scWave: "RETARDATARIOS PODEM ULTRAPASSAR",
  scWaveDriver: "{nome} PODE ULTRAPASSAR", // um por retardatario, WAVE_DELAY_MS depois de scWave
};

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function checkPassword(password, stored) {
  if (!stored || typeof stored !== "string" || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const test = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
}

function cleanMessage(text, fallback) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE);
  return t || fallback;
}

// Manda uma linha no chat do LMU. Erro se o jogo nao estiver aberto.
async function sendChat(text, fetchImpl = fetch) {
  const res = await fetchImpl(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: text,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`O jogo respondeu HTTP ${res.status}`);
}

// Le o chat do LMU: [{ message: "R Junior: texto", timestamp }]
async function fetchChat(fetchImpl = fetch) {
  const res = await fetchImpl(CHAT_URL, { signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(`O jogo respondeu HTTP ${res.status}`);
  const list = await res.json();
  return Array.isArray(list) ? list : [];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "R Junior: FCY EM 10 SEGUNDOS" -> { sender, text }
function splitChat(line) {
  const s = String(line || "");
  const i = s.indexOf(": ");
  return i > 0 ? { sender: s.slice(0, i).trim(), text: s.slice(i + 2).trim() } : { sender: "", text: s.trim() };
}

// A mensagem e de FCY ou de SC? Compara com os textos configurados, sem
// diferenciar maiusculas e espacos; o {s} da mensagem de ligar o FCY le os
// segundos da contagem.
// -> { kind: "fcy", on: true, seconds } | { kind: "fcy", on: false } |
//    { kind: "fcy", ending: true, seconds } (contagem da bandeira verde) |
//    { kind: "fcy", go: true } (fim da contagem) | { kind: "sc", on } | null
function matchMessage(text, messages) {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const t = norm(text);
  const same = (s) => !!norm(s) && t.toLowerCase() === norm(s).toLowerCase();
  // modelo com {s}: devolve os segundos (null se o modelo nao tiver {s})
  const tpl = (s) => {
    if (!norm(s)) return null;
    const m = t.match(new RegExp("^" + norm(s).split("{s}").map(escapeRe).join("(\\d{1,2})") + "$", "i"));
    return m ? { seconds: m[1] != null ? Number(m[1]) : null } : null;
  };
  const on = tpl(messages.fcyOn);
  if (on) return { kind: "fcy", on: true, seconds: on.seconds };
  const ending = tpl(messages.fcyEnding);
  if (ending) return { kind: "fcy", ending: true, seconds: ending.seconds };
  // contagens ("FCY 9S", "VERDE 9S"): so com {s}, senao seria qualquer "FCY"
  const fcyTick = String(messages.fcyTick || "").includes("{s}") ? tpl(messages.fcyTick) : null;
  if (fcyTick) return { kind: "fcy", on: true, seconds: fcyTick.seconds };
  const greenTick = String(messages.greenTick || "").includes("{s}") ? tpl(messages.greenTick) : null;
  if (greenTick) return { kind: "fcy", ending: true, seconds: greenTick.seconds };
  if (same(messages.fcyOff)) return { kind: "fcy", on: false };
  if (same(messages.fcyGo)) return { kind: "fcy", go: true };
  if (same(messages.scOn)) return { kind: "sc", on: true };
  if (same(messages.scOff)) return { kind: "sc", on: false };
  return null;
}

const speedKmh = (e) => (typeof e.speedKmh === "number" ? e.speedKmh : typeof e.speedMs === "number" ? e.speedMs * 3.6 : null);
// abandonou, desclassificado ou fora da corrida: nao conta
const outOfRace = (e) => e.raceState === 4 || e.raceState === 5 || e.raceState === 6;
// entrando, parado ou saindo do box
const inPit = (e) => {
  const phase = e.pit && e.pit.phase;
  return phase === "in" || phase === "out" || e.pitMode > 0; // listener-lmu.ps1: 1 entrando, 2 no box, 3 saindo, 4 garagem
};

const WAVE_DELAY_MS = 10000;

const isGte = (e) => /GTE/i.test(String((e && e.carClass) || ""));

// Carro do safety car: o escolhido no painel (se estiver na sessao) ou, no
// automatico, o unico LMGTE. -> { name, auto, problem }
function resolveScCar(standings, chosen) {
  const list = (standings || []).filter((e) => e && e.name);
  if (chosen && list.some((e) => e.name === chosen)) return { name: chosen, auto: false, problem: "" };
  const gte = list.filter(isGte);
  if (gte.length === 1) return { name: gte[0].name, auto: true, problem: "" };
  return { name: null, auto: true, problem: gte.length ? "mais de um LMGTE na sessão" : "nenhum LMGTE na sessão" };
}

// Retardatarios na fila do safety car: pelo menos uma volta atras do lider
// geral e fisicamente entre o carro do SC e o lider (a frente do lider e
// atras do SC; sem o carro do SC na pista, ate meia volta a frente do
// lider). Fora: o SC, quem esta no box ou fora da corrida. Ordem: da frente
// da fila (perto do SC) para tras.
function lappedInQueue(standings, trackLength, scName) {
  const L = Number(trackLength);
  if (!(L > 0)) return [];
  const cars = (standings || []).filter((e) => e && e.name && typeof e.totalDistance === "number" && !outOfRace(e) && !inPit(e));
  const scCar = scName ? cars.find((e) => e.name === scName) : null;
  const field = cars.filter((e) => e !== scCar);
  const leader = field.slice().sort((a, b) => (a.position || 999) - (b.position || 999))[0];
  if (!leader) return [];
  const lapPos = (e) => (typeof e.lapDistance === "number" ? e.lapDistance : e.totalDistance % L);
  const aheadOfLeader = (e) => (((lapPos(e) - lapPos(leader)) % L) + L) % L;
  const scAhead = scCar ? aheadOfLeader(scCar) : 0;
  const limit = scAhead > 0 && scAhead < L / 2 ? scAhead : L / 2;
  return field
    .filter((e) => e !== leader)
    .map((e) => ({ e, ahead: aheadOfLeader(e) }))
    .filter(({ e, ahead }) => ahead > 0 && ahead < limit && leader.totalDistance - e.totalDistance > L / 2)
    .sort((a, b) => b.ahead - a.ahead)
    .map(({ e }) => e);
}

function createRaceControl(settings, opts = {}) {
  const send = opts.sendChat || sendChat;
  const readChat = opts.fetchChat || fetchChat;
  const onChange = opts.onChange || (() => {});
  const now = opts.now || Date.now;
  const passwordHash = opts.passwordHash || LMU_PASSWORD_HASH;
  const waveDelayMs = opts.waveDelayMs != null ? opts.waveDelayMs : WAVE_DELAY_MS;
  // Acessos liberados (painel e tela de direcao): ficam salvos neste PC, so o
  // hash de cada um, ate "Bloquear a aba". Trocar a senha no codigo invalida todos.
  const MAX_TOKENS = 20;
  const tokenHash = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
  const passPrint = passwordHash.slice(0, 16);
  const savedTokens = settings.get("lmuTokens");
  const tokens = new Set(savedTokens && savedTokens.fp === passPrint && Array.isArray(savedTokens.list) ? savedTokens.list : []);
  const saveTokens = () => settings.set("lmuTokens", tokens.size ? { fp: passPrint, list: [...tokens] } : null);
  if (settings.get("lmuControlPass")) settings.set("lmuControlPass", null); // senha criada no painel (versao antiga)
  let fcy = false;
  let fcyBy = ""; // quem ligou: "painel" ou o nome de quem mandou no chat
  let sc = false; // safety car chamado pela direcao de prova
  let scBy = "";
  let lastLmu = null; // ultimos dados do LMU (fila do safety car)
  let waveTimer = null;
  let waveAt = 0; // quando sai a lista de retardatarios (0: nenhuma pendente)
  let waveLast = null; // ultima lista mandada: { names, at }
  const incidents = createIncidentWatch({ now }); // carro lento e ultrapassagem com SC/FCY
  const game = opts.gameIncidents || createGameIncidents(); // incidentes do jogo e replay
  let countdownEndAt = 0; // fim da contagem do FCY atual
  let greenAt = 0; // bandeira verde marcada (contagem para encerrar o FCY); 0: nenhuma
  let lmuSeenAt = 0; // ultimo dado do LMU (so le o chat com o jogo aberto)
  let chatLastTs = null; // ultima mensagem do chat ja vista (null: ainda nao leu)
  let chatBusy = false;
  let countdownTimers = []; // contagem mandada no chat (10, 9, ... 1, FCY)
  let sessionKey; // undefined: nenhum dado ainda
  let open = new Map(); // nome -> trecho acima do limite em andamento
  let breaches = []; // infracoes da sessao (todos os FCY dela)
  let fresh = []; // infracoes fechadas desde o ultimo apply (vao para o log)
  let fcyNumber = 0; // qual FCY da sessao

  // mensagem de ligar salva igual a um padrao antigo: usa o padrao atual
  const messages = () => {
    const saved = Object.assign({}, settings.get("lmuMessages") || {});
    if (OLD_FCY_ON.includes(saved.fcyOn)) delete saved.fcyOn;
    if (OLD_FCY_GO.includes(saved.fcyGo)) delete saved.fcyGo;
    return Object.assign({}, DEFAULT_MESSAGES, saved);
  };
  const countdownSec = () => {
    const v = Number(settings.get("lmuFcyCountdown"));
    return Number.isFinite(v) ? Math.max(0, Math.min(COUNTDOWN_MAX_S, Math.round(v))) : DEFAULT_COUNTDOWN_S;
  };
  const chatCountdown = () => settings.get("lmuChatCountdown") !== false; // padrao: manda
  const countdownLeft = () => (fcy ? Math.max(0, Math.ceil((countdownEndAt - now()) / 1000)) : 0);
  const greenSec = () => {
    const v = settings.get("lmuGreenCountdown");
    return v == null || !Number.isFinite(Number(v)) ? DEFAULT_GREEN_S : Math.max(0, Math.min(COUNTDOWN_MAX_S, Math.round(Number(v))));
  };
  const greenLeft = () => (fcy && greenAt ? Math.max(0, Math.ceil((greenAt - now()) / 1000)) : 0);

  // ao vivo: quem esta acima do limite agora
  function liveOver() {
    const t = now();
    return [...open.entries()].map(([name, o]) => ({ name, carNumber: o.carNumber, overMs: t - o.start, afterMs: o.start - countdownEndAt, maxKmh: o.maxKmh, live: true, fcy: fcyNumber, at: o.start, et: o.et }));
  }

  // seguir o FCY e o SC do chat (outro PC da direcao de prova manda a mensagem)
  const follow = () => ({ enabled: !!settings.get("lmuFollowChat") });

  const status = () => ({
    ok: true,
    fcy,
    fcyBy,
    sc,
    scBy,
    follow: follow(),
    countdownLeft: countdownLeft(),
    countdownSec: countdownSec(),
    greenLeft: greenLeft(),
    greenSec: greenSec(),
    chatCountdown: chatCountdown(),
    limitKmh: FCY_LIMIT_KMH,
    messages: messages(),
    breaches: breaches.concat(liveOver()),
    waveLeft: sc && waveAt ? Math.max(0, Math.ceil((waveAt - now()) / 1000)) : 0,
    waveLast,
    incidents: incidents.status(),
    gameIncidents: game.list(),
    replayActive: game.isReplayActive(),
    scCar: scCarInfo(),
  });

  function unlock(password) {
    if (!checkPassword(String(password || ""), passwordHash)) return { ok: false, error: "Senha errada" };
    const token = crypto.randomBytes(24).toString("hex");
    tokens.add(tokenHash(token));
    while (tokens.size > MAX_TOKENS) tokens.delete(tokens.values().next().value); // o mais antigo sai
    saveTokens();
    return Object.assign(status(), { token });
  }

  const allowed = (token) => !!token && tokens.has(tokenHash(token));

  // "Bloquear a aba": esquece este acesso
  function lock(token) {
    if (token && tokens.delete(tokenHash(token))) saveTokens();
    return { ok: true };
  }

  function setMessages(token, body) {
    if (!allowed(token)) return { ok: false, error: "Aba bloqueada" };
    const cur = messages();
    const next = {
      fcyOn: cleanMessage(body && body.fcyOn, cur.fcyOn),
      fcyOff: cleanMessage(body && body.fcyOff, cur.fcyOff),
      fcyGo: cleanMessage(body && body.fcyGo, cur.fcyGo),
      fcyEnding: cleanMessage(body && body.fcyEnding, cur.fcyEnding),
      fcyTick: cleanMessage(body && body.fcyTick, cur.fcyTick),
      greenTick: cleanMessage(body && body.greenTick, cur.greenTick),
      scOn: cleanMessage(body && body.scOn, cur.scOn),
      scOff: cleanMessage(body && body.scOff, cur.scOff),
      scCatch: cleanMessage(body && body.scCatch, cur.scCatch),
      scWave: cleanMessage(body && body.scWave, cur.scWave),
      scWaveDriver: cleanMessage(body && body.scWaveDriver, cur.scWaveDriver),
    };
    settings.set("lmuMessages", next);
    if (body && body.chatCountdown != null) settings.set("lmuChatCountdown", !!body.chatCountdown);
    if (body && body.countdownSec != null) {
      const s = Math.round(Number(body.countdownSec));
      settings.set("lmuFcyCountdown", Number.isFinite(s) ? Math.max(0, Math.min(COUNTDOWN_MAX_S, s)) : DEFAULT_COUNTDOWN_S);
    }
    if (body && body.greenSec != null) {
      const s = Math.round(Number(body.greenSec));
      settings.set("lmuGreenCountdown", Number.isFinite(s) ? Math.max(0, Math.min(COUNTDOWN_MAX_S, s)) : DEFAULT_GREEN_S);
    }
    return status();
  }

  function closeBreach(name, t) {
    const o = open.get(name);
    if (!o) return;
    open.delete(name);
    const b = { name, carNumber: o.carNumber, overMs: t - o.start, afterMs: o.start - countdownEndAt, maxKmh: o.maxKmh, fcy: fcyNumber, at: o.start, et: o.et };
    breaches.push(b);
    fresh.push(b);
  }

  function closeAll(t) {
    [...open.keys()].forEach((name) => closeBreach(name, t));
  }

  // liga/desliga o FCY: primeiro a mensagem no jogo; so marca na tabela se ela foi.
  // Encerrar com contagem da verde: o FCY so desliga no fim dela. Apertar de
  // novo durante a contagem encerra na hora.
  async function setFcy(token, on) {
    if (!allowed(token)) return { ok: false, error: "Aba bloqueada" };
    const m = messages();
    if (!on && fcy && !greenAt && greenSec() > 0) {
      const secs = greenSec();
      await send(m.fcyEnding.split("{s}").join(String(secs)));
      greenAt = now() + secs * 1000;
      runCountdown(secs, greenAt, m.fcyOff, () => turn(false), tickTemplate(m.greenTick));
      return status();
    }
    const secs = countdownSec();
    await send(on ? m.fcyOn.split("{s}").join(String(secs)) : m.fcyOff);
    if (turn(on, secs, "painel") && on && chatCountdown() && secs > 0) runCountdown(secs, countdownEndAt, m.fcyGo, null, tickTemplate(m.fcyTick));
    return status();
  }

  // modelo da contagem ("FCY {s}S"); sem {s}: so os numeros
  const tickTemplate = (tpl) => (String(tpl || "").includes("{s}") ? tpl : null);

  // Contagem no chat ate endAt: uma mensagem por segundo (se a opcao estiver
  // ligada) e, no fim, a mensagem final (FCY valendo, ou a bandeira verde).
  // Sem modelo: so o numero (10, 9, ...). Com modelo ({s} = segundos, "FCY 9S"):
  // os segundos do inicio ja foram na mensagem de abertura, entao comeca do seguinte.
  // Contagem maior que CHAT_TICKS_FROM: pausa ate faltarem esses segundos.
  // O outro PC que segue o chat acerta o relogio por essas mensagens.
  function runCountdown(secs, endAt, finalText, onEnd, tickTpl) {
    stopChatCountdown();
    const say = (text) => send(text).catch(() => {});
    const tick = (k) => (tickTpl ? tickTpl.split("{s}").join(String(k)) : String(k));
    const first = Math.min(tickTpl ? secs - 1 : secs, CHAT_TICKS_FROM);
    if (chatCountdown()) for (let k = first; k >= 1; k--) countdownTimers.push(setTimeout(() => fcy && say(tick(k)), Math.max(0, endAt - k * 1000 - now())));
    countdownTimers.push(
      setTimeout(() => {
        if (!fcy) return;
        say(finalText);
        if (onEnd) onEnd();
      }, Math.max(0, endAt - now()))
    );
  }

  function stopChatCountdown() {
    countdownTimers.forEach(clearTimeout);
    countdownTimers = [];
  }

  // liga/desliga o safety car: mensagem no jogo e a tabela como no SC do jogo
  async function setSc(token, on) {
    if (!allowed(token)) return { ok: false, error: "Aba bloqueada" };
    const m = messages();
    await send(on ? m.scOn : m.scOff);
    if (turnSc(on, "painel") && on) await send(m.scCatch).catch(() => {});
    return status();
  }

  // Retardatarios podem ultrapassar: o aviso agora e, 10 s depois, o nome de
  // quem estiver na fila do SC (um por mensagem).
  // carro do SC agora, e a lista de pilotos para o painel escolher
  function scCarInfo() {
    const list = lastLmu && Array.isArray(lastLmu.standings) ? lastLmu.standings.filter((e) => e && e.name) : [];
    const chosen = settings.get("lmuScCar") || "";
    return Object.assign(resolveScCar(list, chosen), {
      chosen,
      drivers: list
        .slice()
        .sort((a, b) => (a.position || 999) - (b.position || 999))
        .map((e) => ({ name: e.name, carClass: e.carClass || "", carNumber: e.carNumber || "" })),
    });
  }

  const scCarName = (standings) => resolveScCar(standings, settings.get("lmuScCar")).name;

  // escolha do painel: "" volta para o automatico (LMGTE)
  function setScCar(token, name) {
    if (!allowed(token)) return { ok: false, error: "Aba bloqueada" };
    settings.set("lmuScCar", String(name || "").trim() || null);
    return status();
  }

  async function waveBy(token) {
    if (!allowed(token)) return { ok: false, error: "Aba bloqueada" };
    if (!sc) return { ok: false, error: "Só com o Safety Car ligado" };
    const m = messages();
    await send(m.scWave);
    clearTimeout(waveTimer);
    waveAt = now() + waveDelayMs;
    waveTimer = setTimeout(async () => {
      waveAt = 0;
      if (!sc) return;
      const list = lastLmu ? lappedInQueue(lastLmu.standings, lastLmu.session && lastLmu.session.trackLength, scCarName(lastLmu.standings)) : [];
      waveLast = { names: list.map((e) => e.name), at: now() };
      for (const e of list) await send(m.scWaveDriver.split("{nome}").join(e.name)).catch(() => {});
    }, waveDelayMs);
    return status();
  }

  function turnSc(on, by) {
    if (!!on === sc) return false;
    if (on && fcy) turn(false); // FCY virou safety car
    sc = !!on;
    scBy = on ? by : "";
    if (!on) {
      clearTimeout(waveTimer);
      waveAt = 0;
    }
    if (on) waveLast = null;
    onChange();
    return true;
  }

  // liga/desliga o FCY aqui (botao do painel ou mensagem lida no chat)
  function turn(on, secs, by) {
    if (!!on === fcy) return false; // a propria mensagem voltando pelo chat: nada muda
    const t = now();
    if (on) {
      if (sc) turnSc(false); // safety car virou FCY
      fcyNumber++;
      countdownEndAt = t + secs * 1000;
      fcyBy = by;
    } else {
      greenAt = 0;
      stopChatCountdown();
      closeAll(t);
      fcyBy = "";
    }
    fcy = !!on;
    onChange(fcy);
    return true;
  }

  function setFollow(body) {
    const enabled = !!(body && body.enabled);
    settings.set("lmuFollowChat", enabled || null);
    settings.set("lmuChatSenders", null); // filtro antigo de contas: nao existe mais
    chatLastTs = null; // religou: o que ja esta no chat nao conta
    return status();
  }

  // Uma leitura do chat. A primeira so marca onde o chat esta (o historico
  // que vem ao entrar na sessao nao liga nem desliga nada).
  async function pollChat() {
    if (!follow().enabled || now() - lmuSeenAt > CHAT_IDLE_MS) {
      chatLastTs = null; // ao voltar, o que estiver no chat e historico
      return;
    }
    if (chatBusy) return;
    chatBusy = true;
    try {
      const list = await readChat();
      const latest = list.reduce((max, c) => Math.max(max, Number(c && c.timestamp) || 0), 0);
      if (chatLastTs === null) {
        chatLastTs = latest;
        return;
      }
      const fresh = list.filter((c) => c && Number(c.timestamp) > chatLastTs).sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
      chatLastTs = Math.max(chatLastTs, latest);
      fresh.forEach((c) => {
        const { sender, text } = splitChat(c.message);
        const match = matchMessage(text, messages());
        if (!match) return;
        if (match.kind === "sc") {
          turnSc(match.on, sender || "chat");
          return;
        }
        if (match.ending) {
          // contagem da bandeira verde: so mostra; quem desliga e a mensagem de verde
          if (fcy) greenAt = now() + (match.seconds != null ? match.seconds : greenSec()) * 1000; // "VERDE 7S" acerta o relogio
          return;
        }
        if (match.go) {
          // fim da contagem: acerta o relogio daqui (ou liga, se perdeu o inicio)
          if (fcy) countdownEndAt = Math.min(countdownEndAt, now());
          else turn(true, 0, sender || "chat");
          return;
        }
        // "FCY EM 7S" com o FCY ja ligado: acerta a contagem daqui
        if (match.on && fcy && match.seconds != null && countdownLeft() > 0) {
          countdownEndAt = now() + Math.min(COUNTDOWN_MAX_S, match.seconds) * 1000;
          return;
        }
        turn(match.on, match.seconds != null ? Math.min(COUNTDOWN_MAX_S, match.seconds) : countdownSec(), sender || "chat");
      });
    } catch (_) {
      // jogo fechando ou API indisponivel: tenta de novo na proxima
    } finally {
      chatBusy = false;
    }
  }

  if (opts.pollChat) setInterval(pollChat, CHAT_POLL_MS).unref();
  if (opts.pollChat) {
    setInterval(() => {
      if (now() - lmuSeenAt <= CHAT_IDLE_MS) game.poll();
    }, GAME_POLL_MS).unref();
  }

  // Leva o replay ao momento. Quem esta dirigindo nao entra no replay por engano.
  async function replayJump(token, et) {
    if (!allowed(token)) return { ok: false, error: "Aba bloqueada" };
    const time = Number(et);
    if (!Number.isFinite(time) || time < 0) return { ok: false, error: "Momento inválido" };
    const me = lastLmu && (lastLmu.standings || []).find((e) => e && e.isPlayer);
    const v = me ? speedKmh(me) : null;
    if (!game.isReplayActive() && v != null && v > REPLAY_MAX_KMH) return { ok: false, error: "Seu carro está andando: pare antes de abrir o replay" };
    await game.jump(time);
    return status();
  }

  async function replayExit(token) {
    if (!allowed(token)) return { ok: false, error: "Aba bloqueada" };
    await game.exit();
    return status();
  }

  // Marca o FCY nos dados do LMU e mede quem passa do limite.
  // Sessao nova (ou outro jogo): FCY desligado e lista de infracoes limpa.
  function apply(payload) {
    if (!payload || !payload.session) return payload;
    const t = now();
    const key = payload.game === "lmu" ? `${payload.session.state}|${payload.session.trackLocation || ""}` : null;
    if (key !== sessionKey) {
      const changed = sessionKey !== undefined; // FCY ligado antes do primeiro dado: fica
      sessionKey = key;
      if (changed) {
        incidents.reset();
        game.reset();
        open = new Map();
        breaches = [];
        fcyNumber = 0;
        if (fcy || sc) {
          fcy = sc = false;
          fcyBy = scBy = "";
          stopChatCountdown();
          onChange();
        }
      }
    }
    if (payload.game !== "lmu") return payload;
    lmuSeenAt = t;
    lastLmu = payload;
    markLmuYellow(payload);
    game.apply(payload);
    incidents.apply(payload, {
      under: fcy ? "FCY" : sc || payload.session.scOut ? "SC" : null,
      countdown: fcy && t < countdownEndAt, // ainda na contagem do FCY
      scName: scCarName(payload.standings),
      released: waveLast ? waveLast.names : [], // retardatarios liberados podem passar
    });

    if (fcy && t >= countdownEndAt) {
      const seen = new Set();
      const scName = scCarName(payload.standings); // o carro do SC nao queima o FCY
      (payload.standings || []).forEach((e) => {
        if (!e || !e.name || outOfRace(e) || e.name === scName) return;
        const v = speedKmh(e);
        if (v == null) return;
        seen.add(e.name);
        if (v > FCY_LIMIT_KMH) {
          const o = open.get(e.name);
          if (o) o.maxKmh = Math.max(o.maxKmh, v);
          else open.set(e.name, { start: t, maxKmh: v, carNumber: e.carNumber || "", et: payload.session.eventTime });
        } else {
          closeBreach(e.name, t);
        }
      });
      // saiu da lista (desconectou): fecha onde estava
      [...open.keys()].filter((n) => !seen.has(n)).forEach((n) => closeBreach(n, t));
    }

    payload.session.fcy = fcy;
    payload.session.scCall = sc; // safety car chamado no painel ou no chat
    if (sc) payload.session.scOut = true; // tabela, log e disputas como no SC do jogo
    payload.session.fcyCountdown = countdownLeft(); // segundos ate o limite valer (0: valendo)
    payload.session.fcyGreenIn = greenLeft(); // contagem da bandeira verde (0: nenhuma)
    payload.session.fcyBreaches = fresh; // so as que fecharam agora (o log registra cada uma uma vez)
    fresh = [];
    return payload;
  }

  return { status, unlock, allowed, lock, replayJump, replayExit, setMessages, setFcy, setSc, waveBy, setScCar, setFollow, pollChat, apply };
}

module.exports = { createRaceControl, hashPassword, checkPassword, sendChat, matchMessage, splitChat, lappedInQueue, resolveScCar, DEFAULT_MESSAGES, FCY_LIMIT_KMH };
