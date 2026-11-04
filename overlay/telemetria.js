// overlay/telemetria.js
// Telemetria do carro do piloto, rolando como o grafico ao vivo do Cubic Racing Analyser.
// AMS2: data.car (acelerador, freio, volante) quando o carro em foco e o do proprio piloto.
// LMU: acelerador e freio do carro do piloto na lista (o jogo nao informa o volante).
// Legenda e volante ligam e desligam pelo painel (comando overlay.setTelemetry); a escolha fica
// guardada nesta pagina (localStorage).

const WS_URL = `ws://${location.hostname}:${location.port || 8080}/ws`;
const BASE_WIDTH = 460;
const WINDOW_MS = 8000; // segundos visiveis no grafico
const STALE_MS = 2000;
const FPS = 30;

const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");
const tm = document.getElementById("tm");
let samples = []; // { t, thr, brk, str }
let lastAt = 0;
let dpr = 1;

function fitToWindow() {
  const zoom = Math.max(0.3, window.innerWidth / BASE_WIDTH);
  document.documentElement.style.zoom = String(zoom);
  // canvas na resolucao real da tela (nitido em qualquer tamanho)
  dpr = (window.devicePixelRatio || 1) * zoom;
  canvas.width = Math.round(460 * dpr);
  canvas.height = Math.round(150 * dpr);
}
window.addEventListener("resize", fitToWindow);
fitToWindow();

// opcoes: legenda e volante (guardadas nesta pagina)
const CFG_KEY = "telemetriaCfg";
let cfg = { legend: true, steering: true, fuel: true };
try {
  cfg = Object.assign(cfg, JSON.parse(localStorage.getItem(CFG_KEY) || "{}"));
} catch (_) {}
function applyCfg(next, save) {
  if (next) {
    if (typeof next.legend === "boolean") cfg.legend = next.legend;
    if (typeof next.steering === "boolean") cfg.steering = next.steering;
    if (typeof next.fuel === "boolean") cfg.fuel = next.fuel;
  }
  document.getElementById("legend").hidden = !cfg.legend;
  document.getElementById("legendStr").hidden = !cfg.steering;
  if (!cfg.fuel) document.getElementById("fuel").hidden = true;
  if (save) {
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    } catch (_) {}
  }
}
applyCfg();

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// o que vem de cada leitura: do carro (AMS2) ou da linha do piloto na lista (LMU)
function read(data) {
  const list = Array.isArray(data.standings) ? data.standings : [];
  const me = list.find((e) => e && e.isPlayer);
  const car = data.car || {};
  // a telemetria completa (data.car) e do carro do jogador; vale se for o carro em foco
  const carIsMe = me && num(car.speedMs) != null && num(me.speedMs) != null && Math.abs(car.speedMs - me.speedMs) < Math.max(2, me.speedMs * 0.12);
  if (carIsMe || (!me && num(car.throttle) != null)) {
    return { thr: num(car.throttle), brk: num(car.brake), str: num(car.steering) };
  }
  if (me && (num(me.throttle) != null || num(me.brake) != null)) {
    return { thr: num(me.throttle), brk: num(me.brake), str: null };
  }
  return null;
}

// ---- combustivel por volta (da linha do piloto: o AMS2 informa o do proprio carro, o LMU o de todos)
// Consumo de cada volta = combustivel no inicio dela - no fim. Volta com abastecimento (o tanque
// subiu) nao conta. Mostra o que tem no tanque, para quantas voltas da (pela media) e o consumo.
const fuel = { name: null, laps: null, atLapStart: null, uses: [] };
const fmt1 = (v) => v.toFixed(1).replace(".", ",");
function trackFuel(data) {
  const box = document.getElementById("fuel");
  const list = Array.isArray(data.standings) ? data.standings : [];
  const me = list.find((e) => e && e.isPlayer);
  if (!cfg.fuel || !me || typeof me.fuelL !== "number") {
    box.hidden = true;
    return;
  }
  if (me.name !== fuel.name) Object.assign(fuel, { name: me.name, laps: null, atLapStart: null, uses: [] });
  const laps = Number(me.lapsCompleted) || 0;
  if (fuel.atLapStart != null && me.fuelL > fuel.atLapStart + 0.5) fuel.atLapStart = me.fuelL; // abasteceu
  if (fuel.laps != null && laps === fuel.laps + 1 && fuel.atLapStart != null) {
    const used = fuel.atLapStart - me.fuelL;
    if (used > 0.05 && used < 50 && (me.pitMode || 0) === 0) {
      fuel.uses.push(used);
      if (fuel.uses.length > 5) fuel.uses.shift();
    }
  }
  if (fuel.laps == null || laps !== fuel.laps) fuel.atLapStart = me.fuelL;
  fuel.laps = laps;
  box.hidden = false;
  const avg = fuel.uses.length ? fuel.uses.reduce((a, b) => a + b, 0) / fuel.uses.length : null;
  const lapsLeft = avg ? me.fuelL / avg : null;
  document.getElementById("fuelNow").textContent = `${fmt1(me.fuelL)} L` + (lapsLeft != null ? ` · ${fmt1(lapsLeft)} voltas` : "");
  document.getElementById("fuelLap").textContent = fuel.uses.length ? `última ${fmt1(fuel.uses[fuel.uses.length - 1])} · média ${fmt1(avg)} L/volta` : "consumo depois de uma volta";
  box.className = "fuel" + (lapsLeft != null && lapsLeft < 2 ? " crit" : lapsLeft != null && lapsLeft < 4 ? " low" : "");
}

// ---- na pista ou nao: a overlay so aparece com o carro do piloto na pista (fora do menu,
// da garagem e do box). No modo de edicao (barrinha do app) ela aparece para ser posicionada.
let onTrack = false;
let myCarSpeed = null; // velocidade do carro do piloto na ultima lista: confere o pacote rapido
let lastTelAt = 0; // pacote rapido (~30x por segundo) chegando: a lista nao precisa dar amostras
function updateVisibility() {
  const editing = !!document.getElementById("llgEditBar");
  tm.hidden = !(onTrack || editing);
}
setInterval(updateVisibility, 300);

function pushSample(thr, brk, str) {
  const now = Date.now();
  lastAt = now;
  samples.push({ t: now, thr, brk, str });
  samples = samples.filter((s) => now - s.t <= WINDOW_MS + 500);
}

// demo: dados de exemplo do "Editar na tela" (server/demo.js); nao contam como "na pista"
let demoAt = 0;
function onStandings(data, demo) {
  if (demo) demoAt = Date.now();
  // tocando o exemplo: a lista vazia do jogo no menu (1x por segundo) nao apaga os valores
  else if (Date.now() - demoAt < 500 && !(data && Array.isArray(data.standings) && data.standings.length)) return;
  trackFuel(data || {});
  const list = Array.isArray(data && data.standings) ? data.standings : [];
  const me = list.find((e) => e && e.isPlayer);
  if (!demo) onTrack = !!me && (me.pitMode || 0) === 0;
  myCarSpeed = me && num(me.speedMs) != null ? me.speedMs : null;
  updateVisibility();
  if (Date.now() - lastTelAt < 500) return; // o pacote rapido ja esta desenhando
  const r = read(data || {});
  if (r) pushSample(r.thr, r.brk, r.str);
}

// pacote rapido do AMS2 (so do carro do jogador): vale se for o carro em foco
function onTel(t) {
  if (!t || num(t.thr) == null) return;
  if (myCarSpeed != null && num(t.spd) != null && Math.abs(t.spd - myCarSpeed) >= Math.max(2, myCarSpeed * 0.12)) return;
  lastTelAt = Date.now();
  pushSample(num(t.thr), num(t.brk), num(t.str));
}

function draw() {
  const now = Date.now();
  const stale = now - lastAt > STALE_MS;
  tm.classList.toggle("stale", stale);
  const W = canvas.width;
  const H = canvas.height;
  const pad = 6 * dpr;
  ctx.clearRect(0, 0, W, H);
  // grade: 0, 50% e 100%
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1 * dpr;
  [0, 0.5, 1].forEach((f) => {
    const y = pad + (H - 2 * pad) * (1 - f);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  });
  if (!samples.length) return;
  samples.sort((a, b) => a.t - b.t); // fora de ordem viraria um risco atravessando o grafico
  const end = stale ? lastAt : now;
  const x = (t) => W - ((end - t) / WINDOW_MS) * W;
  const y = (v) => pad + (H - 2 * pad) * (1 - v);
  const line = (key, color, map, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width * dpr;
    ctx.lineJoin = "round";
    ctx.beginPath();
    let started = false;
    samples.forEach((s) => {
      const v = s[key];
      if (v == null) {
        started = false;
        return;
      }
      const px = x(s.t);
      const py = y(map(v));
      if (!started) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
      started = true;
    });
    // o valor mais novo vai ate a borda: o pedal de agora aparece na hora, sem esperar a proxima leitura
    const last = samples[samples.length - 1];
    if (started && last && last[key] != null && !stale) ctx.lineTo(W, y(map(last[key])));
    ctx.stroke();
  };
  // volante: centro = reto; para cima = esquerda (-1..1 vira 0..1)
  if (cfg.steering) line("str", "rgba(53,224,255,0.85)", (v) => 0.5 - Math.max(-1, Math.min(1, v)) / 2, 1.5);
  line("brk", "#ff5a5a", (v) => Math.max(0, Math.min(1, v)), 2.5);
  line("thr", "#3ddc84", (v) => Math.max(0, Math.min(1, v)), 2.5);
}

let lastDraw = 0;
function loop(t) {
  if (t - lastDraw >= 1000 / FPS - 2) {
    lastDraw = t;
    draw();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// O servidor manda a "versao" dos arquivos ao conectar e de tempos em tempos; mudou, recarrega
let overlayBuildId = null;
function connect() {
  const socket = new WebSocket(WS_URL);
  socket.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    const editingNow = !!document.getElementById("llgEditBar");
    if (msg.type === "tel") onTel(msg.data);
    else if (msg.type === "standings") onStandings(msg.data);
    // dados de exemplo: so na janela do piloto em edicao (as do OBS ignoram)
    else if (msg.type === "demo" && editingNow) onStandings(msg.data, true);
    else if (msg.type === "demoTel" && editingNow) onTel(msg.data);
    else if (msg.type === "overlayCommand" && msg.name === "overlay.setTelemetry") applyCfg(msg.payload, true);
    else if (msg.type === "hello" && msg.buildId) {
      if (overlayBuildId === null) overlayBuildId = msg.buildId;
      else if (msg.buildId !== overlayBuildId) location.reload();
    }
  });
  socket.addEventListener("close", () => setTimeout(connect, 500));
}
connect();
