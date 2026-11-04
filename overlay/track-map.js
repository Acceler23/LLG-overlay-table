// overlay/track-map.js
// Mapa da pista com os carros (o clima fica no rodape da tabela de tempos).
// O tracado vem do servidor (server/trackMap.js, aprendido com as posicoes dos
// carros e salvo). Cada carro e desenhado pela distancia que ja percorreu na
// volta, em cima do tracado medio: mesmo rodando ou fora da pista, ele aparece
// no ponto da pista em que esta.

const WS_URL = `ws://${location.hostname}:${location.port || 8080}/ws`;
const BASE_WIDTH = 420; // largura do desenho em px (track-map.css)
const MAP_W = 420;
const MAP_H = 400;
const PAD = 26;

let map = null; // { points, length, ready, coverage }
let toScreen = null; // [x, z] do mundo -> [x, y] da tela
let standings = [];
let session = null;
let game = "ams2";

const SVG_NS = "http://www.w3.org/2000/svg";

// ---- tracado ----
function setMap(next) {
  map = next && next.points && next.points.length > 10 ? next : null;
  toScreen = null;
  if (!map) {
    // pista nova ainda sem mapa: apaga o desenho da anterior (senao ele fica na
    // tela, com os carros de outra pista "andando" por cima quando o novo chegar)
    ["tmOutline", "tmLine"].forEach((id) => document.getElementById(id).setAttribute("d", ""));
    ["x1", "y1", "x2", "y2"].forEach((a) => document.getElementById("tmStart").setAttribute(a, "0"));
    return;
  }
  const xs = map.points.map((p) => p[0]);
  const zs = map.points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const scale = Math.min((MAP_W - 2 * PAD) / (maxX - minX || 1), (MAP_H - 2 * PAD) / (maxZ - minZ || 1));
  const offX = (MAP_W - (maxX - minX) * scale) / 2;
  const offY = (MAP_H - (maxZ - minZ) * scale) / 2;
  // o Z do mundo cresce para o "norte": na tela ele vai para cima (senao o mapa sai espelhado)
  toScreen = (x, z) => [offX + (x - minX) * scale, offY + (maxZ - z) * scale];
  // mapa pronto: a volta inteira, fechada. Aprendendo: so os trechos que os carros ja
  // percorreram (map.runs), para nao ligar pedacos distantes da pista com uma reta
  const xy = (i) => toScreen(map.points[i][0], map.points[i][1]).map((v) => v.toFixed(1)).join(",");
  const n = map.points.length;
  let d = "";
  if (Array.isArray(map.runs)) {
    map.runs.forEach(([from, to]) => {
      const count = ((to - from + n) % n) + 1;
      for (let k = 0; k < count; k++) d += (k ? "L" : "M") + xy((from + k) % n);
    });
  } else {
    for (let i = 0; i < n; i++) d += (i ? "L" : "M") + xy(i);
    d += "Z";
  }
  document.getElementById("tmOutline").setAttribute("d", d);
  document.getElementById("tmLine").setAttribute("d", d);
  // linha de chegada: atravessada no comeco do tracado
  const a = toScreen(map.points[0][0], map.points[0][1]);
  const b = toScreen(map.points[1][0], map.points[1][1]);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const nx = (-(b[1] - a[1]) / len) * 10;
  const ny = ((b[0] - a[0]) / len) * 10;
  const line = document.getElementById("tmStart");
  line.setAttribute("x1", a[0] - nx);
  line.setAttribute("y1", a[1] - ny);
  line.setAttribute("x2", a[0] + nx);
  line.setAttribute("y2", a[1] + ny);
}

// ponto do tracado a uma distancia da largada (metros)
function pointAt(distance) {
  const n = map.points.length;
  const f = ((((distance % map.length) + map.length) % map.length) / map.length) * n;
  const i = Math.floor(f) % n;
  const j = (i + 1) % n;
  const t = f - Math.floor(f);
  const p = map.points[i];
  const q = map.points[j];
  return toScreen(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t);
}

function lapDistanceOf(e) {
  if (typeof e.lapDistance === "number") return e.lapDistance;
  if (typeof e.totalDistance === "number" && map) return e.totalDistance - (e.lapsCompleted || 0) * map.length;
  return null;
}

const isDnf = (e) => e.raceState === 4 || e.raceState === 5 || e.raceState === 6;

// ---- opacidade do fundo (slider do painel; fica guardada nesta pagina) ----
const MAP_ALPHA_KEY = "mapOpacity";
function setMapAlpha(value, save) {
  const v = Math.max(0, Math.min(1, Number(value)));
  if (!Number.isFinite(v)) return;
  document.getElementById("tm").style.setProperty("--map-alpha", String(v));
  if (save) {
    try {
      localStorage.setItem(MAP_ALPHA_KEY, String(v));
    } catch (_) {}
  }
}
try {
  const saved = localStorage.getItem(MAP_ALPHA_KEY);
  if (saved != null) setMapAlpha(saved, false);
} catch (_) {}

// ---- bandeira amarela no mapa ----
// AMS2: o carro dentro de um mini-setor sob bandeira amarela recebe a amarela
// (flagColour 6) ou a amarela dupla (7). O trecho em volta dele fica amarelo e
// continua assim por YELLOW_HOLD_MS depois do ultimo carro passar, para nao
// piscar entre as leituras. Safety car / amarela geral: a pista inteira.
// LMU: a amarela vem por setor (session.sectorFlags): o setor inteiro fica
// amarelo, quando o mapa ja sabe onde ele comeca (map.sectors), e o trecho em
// volta do carro que causou (causedYellow), como no AMS2.
const YELLOW_FLAGS = new Set([6, 7]);
const LMU_SECTOR_YELLOW = 1;
const YELLOW_SPAN_M = 120; // para cada lado do carro
const YELLOW_HOLD_MS = 5000;
let yellowMarks = []; // [{ d, until }]

function updateYellow(list, now) {
  list.forEach((e) => {
    if (!(YELLOW_FLAGS.has(Number(e.flagColour)) || e.causedYellow) || (e.pitMode || 0) !== 0) return;
    const d = lapDistanceOf(e);
    if (d == null) return;
    const near = yellowMarks.find((m) => Math.abs(m.d - d) < YELLOW_SPAN_M);
    if (near) near.until = now + YELLOW_HOLD_MS;
    else yellowMarks.push({ d, until: now + YELLOW_HOLD_MS });
  });
  yellowMarks = yellowMarks.filter((m) => m.until > now);
}

// pontos da tela do trecho entre duas distancias (pode cruzar a linha de chegada)
function segmentPoints(from, to) {
  const out = [];
  const step = map.length / map.points.length;
  for (let d = from; d <= to; d += step) out.push(pointAt(d).map((v) => v.toFixed(1)).join(","));
  out.push(pointAt(to).map((v) => v.toFixed(1)).join(","));
  return out.join(" ");
}

function drawYellow() {
  const group = document.getElementById("tmYellow");
  const sc = !!(session && session.scOut);
  document.getElementById("tm").classList.toggle("sc-out", sc);
  if (!map || !toScreen || sc) {
    group.innerHTML = "";
    return;
  }
  const line = (from, to) => `<polyline class="tm-yellow" points="${segmentPoints(from, to)}" />`;
  const flags = (session && session.sectorFlags) || [];
  const edges = map.sectors ? [0, map.sectors[0], map.sectors[1], map.length] : null;
  const sectors = edges ? flags.map((v, i) => (v === LMU_SECTOR_YELLOW ? line(edges[i], edges[i + 1]) : "")).join("") : "";
  group.innerHTML = sectors + yellowMarks.map((m) => line(m.d - YELLOW_SPAN_M, m.d + YELLOW_SPAN_M)).join("");
}

// ---- desenho ----
function render() {
  return LLGFrameCap.run(renderNow, []);
}

function renderNow() {
  const root = document.getElementById("tm");
  if (typeof HEADER_COLOR !== "undefined" && HEADER_COLOR) root.style.setProperty("--header-color", HEADER_COLOR);
  // fora da sessao (jogo no menu) o jogo manda a lista de carros vazia: o mapa some
  if (!session || !standings.length) {
    root.classList.add("hidden");
    return;
  }
  root.classList.remove("hidden");

  document.getElementById("tmStatus").textContent = !map
    ? "Aprendendo o mapa da pista..."
    : map.ready
      ? ""
      : `Aprendendo o mapa: ${Math.round((map.coverage || 0) * 100)}%`;

  drawYellow();

  // carros
  const group = document.getElementById("tmCars");
  if (!map || !toScreen) {
    group.innerHTML = "";
    return;
  }
  // aprendendo: carro num trecho ainda nao desenhado ficaria sobre um pedaco inventado da pista
  const onDrawn = (e) => {
    if (!Array.isArray(map.runs)) return true;
    const n = map.points.length;
    const i = Math.floor(((((lapDistanceOf(e) % map.length) + map.length) % map.length) / map.length) * n) % n;
    return map.runs.some(([from, to]) => (from <= to ? i >= from && i <= to : i >= from || i <= to));
  };
  const cars = standings.filter((e) => e && !isDnf(e) && lapDistanceOf(e) != null && onDrawn(e)).sort((a, b) => (a.isPlayer ? 1 : 0) - (b.isPlayer ? 1 : 0) || (b.position || 0) - (a.position || 0));
  // lider de cada classe (o de melhor posicao na classe)
  const leaderByClass = new Map();
  cars.forEach((e) => {
    const cur = leaderByClass.get(e.carClass);
    if (!cur || (e.position || 999) < (cur.position || 999)) leaderByClass.set(e.carClass, e);
  });
  const leaders = new Set(leaderByClass.values());
  // posicao de cada carro dentro da classe (e o numero que aparece no circulo)
  const classPos = new Map();
  const byClass = new Map();
  cars
    .slice()
    .sort((a, b) => (a.position || 999) - (b.position || 999))
    .forEach((e) => {
      const n = (byClass.get(e.carClass) || 0) + 1;
      byClass.set(e.carClass, n);
      classPos.set(e, n);
    });
  const seen = new Set();
  cars.forEach((e) => {
    const id = `car-${e.slot != null ? e.slot : e.name}`;
    seen.add(id);
    let g = document.getElementById(id);
    if (!g) {
      g = document.createElementNS(SVG_NS, "g");
      g.id = id;
      g.setAttribute("class", "tm-car");
      const ring = document.createElementNS(SVG_NS, "circle");
      ring.setAttribute("class", "ring");
      g.appendChild(ring);
      g.appendChild(document.createElementNS(SVG_NS, "circle"));
      g.appendChild(document.createElementNS(SVG_NS, "text"));
    }
    group.appendChild(g); // a ordem desenha o piloto em foco por cima
    const [x, y] = pointAt(lapDistanceOf(e));
    g.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    g.setAttribute("class", `tm-car${e.isPlayer ? " focus" : ""}${(e.pitMode || 0) !== 0 ? " pit" : ""}${leaders.has(e) ? " leader" : ""}`);
    const color = LLGDisplay.classColor(e.carClass, null);
    const r = e.isPlayer ? 15 : 12;
    g.querySelector(".ring").setAttribute("r", r + 4);
    const circle = g.children[1];
    circle.setAttribute("r", r);
    circle.setAttribute("fill", color);
    const text = g.lastChild;
    text.textContent = classPos.get(e) || "";
    text.setAttribute("fill", LLGColors.readableOnColor(color));
  });
  Array.from(group.children).forEach((g) => {
    if (!seen.has(g.id)) g.remove();
  });
}

// ---- dados ----
function handleStandings(payload) {
  if (!payload || Array.isArray(payload)) return;
  session = payload.session || null;
  game = payload.game || "ams2";
  standings = payload.standings || [];
  LLGDisplay.applyGameClassNames(standings, game);
  if (map) updateYellow(standings, Date.now());
  render();
}

let overlayBuildId = null;
function checkBuildId(id) {
  if (!id) return;
  if (overlayBuildId === null) overlayBuildId = id;
  else if (id !== overlayBuildId) location.reload();
}

function connect() {
  const socket = new WebSocket(WS_URL);
  socket.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    LLGFrameCap.handle(msg); // limite de FPS do painel
    if (msg.type === "standings") handleStandings(msg.data);
    else if (msg.type === "overlayCommand" && msg.name === "overlay.setOpacity" && msg.payload && msg.payload.target === "map") setMapAlpha(msg.payload.value, true);
    else if (msg.type === "trackMap") {
      setMap(msg.data);
      render();
    } else if (msg.type === "hello") checkBuildId(msg.buildId);

  });
  socket.addEventListener("close", () => setTimeout(connect, 500));
}

function fitToWindow() {
  document.documentElement.style.zoom = String(Math.max(0.3, window.innerWidth / BASE_WIDTH));
}
window.addEventListener("resize", fitToWindow);
fitToWindow();

connect();
