// overlay/driver-table.js
// Tabela do piloto: versao compacta para quem esta pilotando.
//   - posicoes na ordem GERAL da corrida: o lider geral, os 2 carros a
//     frente do piloto, o piloto e os 2 atras, de todas as classes. Cada linha
//     mostra a posicao geral e a posicao na classe (na cor da classe), entao
//     da pra ver quem esta a frente e de que classe.
//     Com temporada do RLT aplicada, cada piloto mostra tambem os pontos dele
//     no campeonato (da classe dele)
//   - pontuacao do campeonato ao vivo (precisa de temporada do RLT aplicada):
//     pontos atuais + pontos da posicao na corrida, em volta do piloto.
//     Sempre por classe quando a temporada tem classes
// Esta pagina nao obedece aos atalhos/comandos da tabela da transmissao.

const WS_URL = `ws://${location.hostname}:${location.port || 8080}/ws`;

const BASE_WIDTH = 340; // largura do desenho em px (driver-table.css)
// ordem geral: o lider + 2 carros a frente do piloto + o piloto + 2 atras
const POSITION_WINDOW = 5; // carros em volta do piloto na ordem geral (contando ele)
const POINTS_ROWS = 5; // linhas da pontuacao (lider + vizinhos)

const SESSION_LABELS = {
  1: "TREINO LIVRE",
  2: "TESTE",
  3: "CLASSIFICAÇÃO",
  4: "VOLTA DE FORMAÇÃO",
  5: "CORRIDA",
  6: "TIME ATTACK",
};

let rltConfig = null;
let rltMatcher = null;
let standings = [];
let session = null;
let sessionState = null;
let trackLength = 0;
let lastSessionKey = null;
let meName = null;

const gapTracker = LLGGaps.createGapTracker();
const gapSmoother = LLGGaps.createGapSmoother(); // evita o ultimo digito do gap ficar piscando
const normalize = LLGNames.normalizeName;

function rltEnabled() {
  return !!(rltConfig && rltConfig.classes && rltConfig.classes.length > 0);
}

function rebuildMatcher() {
  const hasDrivers =
    rltConfig &&
    ((rltConfig.drivers && rltConfig.drivers.length) || (rltConfig.standingsRows && rltConfig.standingsRows.length));
  rltMatcher = hasDrivers
    ? LLGNames.createMatcher(LLGNames.buildPool(rltConfig), {
        // ligacoes feitas a mao no painel (aba Pilotos) valem junto com o RLT_INGAME_MAP
        explicitMap: Object.assign({}, typeof RLT_INGAME_MAP !== "undefined" ? RLT_INGAME_MAP : {}, (rltConfig && rltConfig.manualLinks) || {}),
      })
    : null;
  if (rltMatcher) rltMatcher.prime(standings.map((e) => e.name));
}

function rltLookup(entry) {
  if (!rltMatcher || !entry) return null;
  return rltMatcher.lookup(entry.name || "");
}

const grouper = LLGGroups.createGrouper({
  rltEnabled: () => rltEnabled(),
  lookup: (entry) => rltLookup(entry),
  splitClasses: typeof SPLIT_BY_CAR_CLASSES !== "undefined" ? SPLIT_BY_CAR_CLASSES : [],
});

function isRace() {
  return sessionState === 5;
}

// raceState do jogo: 4 desclassificado, 5 retirado, 6 DNF
function isDnf(entry) {
  return entry.raceState === 4 || entry.raceState === 5 || entry.raceState === 6;
}

function escapeHtml(text) {
  return String(text == null ? "" : text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function displayName(entry) {
  const info = rltLookup(entry);
  if (info) {
    if (info.firstName && info.lastName) return `${info.firstName} ${info.lastName}`.trim();
    if (info.displayName) return info.displayName;
  }
  return String(entry.name || "").replace(/\[[^\]]*\]/g, "").trim();
}

function formatTime(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

function formatClock(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function classLabel(key) {
  if (rltEnabled()) {
    const c = rltConfig.classes.find((x) => x.uniqueName === key || x.name === key);
    if (c) return LLGDisplay.formatClassName(c.name || c.uniqueName);
  }
  return LLGDisplay.formatClassName(key);
}

function classColor(key) {
  return LLGDisplay.classColor(key, rltEnabled() ? rltConfig.classes : null);
}

// corrida: pela posicao, abandonos no fim; outras sessoes: pela melhor volta
function sortForDisplay(list) {
  return list.slice().sort((a, b) => {
    const da = isDnf(a) ? 1 : 0;
    const db = isDnf(b) ? 1 : 0;
    if (da !== db) return da - db;
    if (!isRace()) {
      const fa = a.fastestLapMs > 0 ? a.fastestLapMs : Infinity;
      const fb = b.fastestLapMs > 0 ? b.fastestLapMs : Infinity;
      if (fa !== fb) return fa - fb;
    }
    return (a.position || 999) - (b.position || 999);
  });
}

let latestGame = "ams2"; // jogo que esta mandando os dados

// Coluna da direita: intervalo para o carro da frente na classe (corrida)
// ou diferenca da melhor volta para o lider da classe (treino/classificacao).
function gapCell(entry, ahead, leader) {
  if (isDnf(entry)) return { text: "DNF", cls: "dnf" };
  if (isRace()) {
    const pit = entry.pit || {};
    if (pit.phase === "in" || pit.phase === "out") return { text: "BOX", cls: "pit" };
    if (!ahead) return { text: "Líder", cls: "" };
    // so no AMS2 a distancia da primeira volta nao serve para o intervalo
    if (latestGame === "ams2" && !entry.lapsCompleted && entry.currentLap <= 1) return { text: "", cls: "" };
    const g = gapTracker.gap(entry.name, ahead.name, trackLength);
    if (!g) return { text: "–", cls: "" };
    if (g.laps) return { text: `+${g.laps} v`, cls: "" };
    return { text: `+${gapSmoother.value(`${entry.name}>${ahead.name}`, g.sec).toFixed(1)}`, cls: "" };
  }
  const mine = Number(entry.fastestLapMs);
  if (!(mine > 0)) return { text: "–", cls: "" };
  const best = leader && leader.fastestLapMs > 0 ? leader.fastestLapMs : mine;
  if (entry === leader || mine <= best) return { text: formatTime(mine), cls: "" };
  return { text: `+${((mine - best) / 1000).toFixed(3)}`, cls: "" };
}

// Coluna da direita da ordem geral: diferenca de cada carro PARA O PILOTO.
//   corrida: tempo ate o piloto. Quem esta a frente aparece com "-" (falta
//            isso para alcanca-lo), quem esta atras com "+".
//   treino/classificacao: diferenca da melhor volta para a melhor do piloto;
//            a linha do piloto mostra o tempo dele.
// aheadOfMe: o carro esta a frente do piloto na ordem da tabela?
function relativeCell(entry, me, aheadOfMe) {
  if (isDnf(entry)) return { text: "DNF", cls: "dnf" };
  const isMe = entry.name === me.name;
  if (isRace()) {
    const pit = entry.pit || {};
    if (pit.phase === "in" || pit.phase === "out") return { text: "BOX", cls: "pit" };
    if (isMe) return { text: "—", cls: "" };
    const g = aheadOfMe
      ? gapTracker.gap(me.name, entry.name, trackLength)
      : gapTracker.gap(entry.name, me.name, trackLength);
    if (!g) return { text: "–", cls: "" };
    const sign = aheadOfMe ? "-" : "+";
    if (g.laps) return { text: `${sign}${g.laps} v`, cls: "" };
    const key = aheadOfMe ? `${me.name}>${entry.name}` : `${entry.name}>${me.name}`;
    return { text: `${sign}${gapSmoother.value(key, g.sec).toFixed(1)}`, cls: "" };
  }
  const theirs = Number(entry.fastestLapMs);
  if (!(theirs > 0)) return { text: "–", cls: "" };
  const mine = Number(me.fastestLapMs);
  if (isMe || !(mine > 0)) return { text: formatTime(theirs), cls: "" };
  const diff = (theirs - mine) / 1000;
  return { text: `${diff < 0 ? "-" : "+"}${Math.abs(diff).toFixed(3)}`, cls: "" };
}

// pts: pontos do campeonato do piloto (null = linha sem essa coluna)
// classPos: posicao na classe (null = linha sem essa coluna). Com ela, a
//   primeira caixa (posicao geral) fica neutra e a segunda leva a cor da classe.
function rowHtml(pos, color, name, valueHtml, valueCls, extraCls, pts, classPos) {
  const fg = LLGColors.toRgb(color) ? LLGColors.readableOn(LLGColors.toRgb(color)) : "#fff";
  const withPts = pts !== null && pts !== undefined;
  const withClass = classPos !== null && classPos !== undefined;
  const colored = `style="background:${color};color:${fg}"`;
  return (
    `<div class="dt-row ${withPts ? "with-pts " : ""}${withClass ? "with-class " : ""}${extraCls || ""}">` +
    (withClass
      ? `<span class="dt-pos overall">${escapeHtml(pos)}</span><span class="dt-pos class" ${colored}>${escapeHtml(classPos)}</span>`
      : `<span class="dt-pos" ${colored}>${escapeHtml(pos)}</span>`) +
    `<span class="dt-name">${escapeHtml(name)}</span>` +
    (withPts ? `<span class="dt-pts">${escapeHtml(pts)}</span>` : "") +
    `<span class="dt-val ${valueCls || ""}">${valueHtml}</span>` +
    `</div>`
  );
}

// Monta as linhas de uma janela de indices, com um separador onde ha salto.
function windowRows(indices, build) {
  let html = "";
  let prev = -1;
  indices.forEach((i) => {
    if (prev >= 0 && i > prev + 1) html += '<div class="dt-row skip"></div>';
    html += build(i);
    prev = i;
  });
  return html;
}

function rowKey(row) {
  return normalize(row.displayName || row.driverName || `${row.firstName || ""} ${row.lastName || ""}`);
}

function infoKey(info) {
  return normalize(info.displayName || info.driverName || `${info.firstName || ""} ${info.lastName || ""}`);
}

// Pontuacao do campeonato ao vivo. Sempre por classe quando a temporada tem
// classes; so cai no geral em temporada de classe unica.
// Devolve null sem temporada, ou:
//   byClass:  Map(classe -> lista projetada, ordenada)   ("_all" sem classes)
//   byDriver: Map(nome do RLT normalizado -> item da projecao)
// Etapa em andamento, para o descarte da projecao: a etapa do calendario do
// RLT na pista do jogo, ou a proxima ainda nao concluida.
let latestTrackNames = [];
function currentRoundNumber() {
  const events = (rltConfig && rltConfig.events) || [];
  const matched = LLGDisplay.matchEvent(events, latestTrackNames, Date.now());
  return LLGPoints.currentRound(events, matched, Date.now());
}

function buildPoints() {
  const all = (rltConfig && rltConfig.standingsRows) || [];
  if (!all.length) return null;
  const classMode = rltEnabled() && rltConfig.classes.length > 1;
  const groupOf = (uniqueName) => (classMode ? uniqueName || "—" : "_all");

  // posicao de cada piloto na corrida agora, dentro da classe dele
  const racePos = new Map();
  const present = new Set();
  const counters = new Map();
  standings
    .slice()
    .sort((a, b) => (a.position || 999) - (b.position || 999))
    .forEach((e) => {
      const info = rltLookup(e);
      if (!info) return;
      const k = infoKey(info);
      present.add(k);
      if (isDnf(e)) return; // quem abandonou nao projeta pontos
      const g = groupOf(info.uniqueName);
      const n = (counters.get(g) || 0) + 1;
      counters.set(g, n);
      racePos.set(k, n);
    });

  const groups = new Map();
  all.forEach((r) => {
    // so quem ja pontuou ou esta na sessao
    if (!(Number(r.pointsRaw) > 0 || Number(r.classPointsRaw) > 0 || present.has(rowKey(r)))) return;
    const g = groupOf(r.classUniqueName);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  });

  const table = LLGPoints.pointsTable(rltConfig);
  const byClass = new Map();
  const byDriver = new Map();
  groups.forEach((rows, g) => {
    const projected = LLGPoints.project(rows, {
      classMode,
      inRace: isRace(),
      table,
      currentRound: currentRoundNumber(),
      racePosOf: (r) => racePos.get(rowKey(r)) || null,
    });
    byClass.set(g, projected);
    projected.forEach((it) => byDriver.set(rowKey(it.row), it));
  });
  return { classMode, byClass, byDriver };
}

// Indices a mostrar na ordem geral: sempre 5 carros em volta do piloto (2 a
// frente, ele, 2 atras; nas pontas a janela desliza, entao o primeiro ve os 4
// de tras e o ultimo os 4 da frente), mais o lider geral e o lider da classe
// do piloto quando estao fora dessa janela. Sem piloto em foco, os primeiros.
function positionIndices(length, myIndex, classLeaderIndex) {
  const out = [];
  if (length <= 0) return out;
  const size = Math.min(length, POSITION_WINDOW);
  if (myIndex < 0) {
    for (let i = 0; i < Math.min(length, POSITION_WINDOW + 1); i++) out.push(i);
    return out;
  }
  let from = myIndex - Math.floor(POSITION_WINDOW / 2);
  from = Math.max(0, Math.min(from, length - size));
  const picked = new Set([0]);
  if (classLeaderIndex >= 0 && classLeaderIndex < length) picked.add(classLeaderIndex);
  for (let i = from; i < from + size; i++) picked.add(i);
  return Array.from(picked).sort((a, b) => a - b);
}

// Ordem geral da corrida, com o lider e os carros em volta do piloto.
function renderPositions(me, points) {
  const list = sortForDisplay(standings);
  const keyOf = (e) => grouper.key(e, standings);

  // legenda: uma etiqueta colorida por classe presente (so com mais de uma)
  const classKeys = [];
  list.forEach((e) => {
    const k = keyOf(e);
    if (!classKeys.includes(k)) classKeys.push(k);
  });
  let html = "";
  if (classKeys.length > 1) {
    html += '<div class="dt-legend">';
    classKeys.forEach((k) => {
      const color = classColor(k);
      const fg = LLGColors.toRgb(color) ? LLGColors.readableOn(LLGColors.toRgb(color)) : "#fff";
      html += `<span class="dt-chip" style="background:${color};color:${fg}">${escapeHtml(classLabel(k))}</span>`;
    });
    html += "</div>";
  }
  // Com uma classe so, a posicao geral e a da classe sao o mesmo numero:
  // fica uma unica coluna de posicao.
  const multiclass = classKeys.length > 1;
  // titulos das colunas: posicao geral, posicao na classe, pontos, intervalo
  html +=
    `<div class="dt-cols ${points ? "with-pts" : ""} ${multiclass ? "" : "single"}">` +
    (multiclass
      ? '<span class="dt-head-col center">ger</span><span class="dt-head-col center">cls</span><span></span>'
      : '<span class="dt-head-col center">pos</span><span></span>') +
    (points ? '<span class="dt-head-col">pts</span>' : "") +
    `<span class="dt-head-col gap">${me ? "p/ você" : isRace() ? "int." : "volta"}</span></div>`;

  // posicao de cada carro dentro da propria classe, na mesma ordem da lista
  const classPos = new Map();
  const classCount = new Map();
  list.forEach((e) => {
    if (isDnf(e)) return;
    const k = keyOf(e);
    const n = (classCount.get(k) || 0) + 1;
    classCount.set(k, n);
    classPos.set(e.name, n);
  });

  const myIndex = me ? list.findIndex((e) => e.name === me.name) : -1;
  // lider da classe do piloto: o primeiro da fila que e da mesma classe
  const myClass = me && myIndex >= 0 ? keyOf(list[myIndex]) : null;
  const classLeaderIndex = myClass == null ? -1 : list.findIndex((e) => keyOf(e) === myClass);
  html += windowRows(positionIndices(list.length, myIndex, classLeaderIndex), (i) => {
    const e = list[i];
    // intervalo para o carro imediatamente a frente, de qualquer classe
    // com piloto em foco, a diferenca e em relacao a ele; sem foco, para o carro da frente
    const cell = me && myIndex >= 0
      ? relativeCell(e, me, i < myIndex)
      : gapCell(e, i > 0 ? list[i - 1] : null, list[0]);
    const cls = (me && e.name === me.name ? "me " : "") + (isDnf(e) ? "dnf" : "");
    // pontos do campeonato do piloto (da classe dele), ao lado do nome
    let pts = null;
    if (points) {
      const info = rltLookup(e);
      const item = info ? points.byDriver.get(infoKey(info)) : null;
      pts = item ? String(item.total) : "";
    }
    const dnf = isDnf(e);
    return rowHtml(
      dnf ? "—" : i + 1,
      classColor(keyOf(e)),
      displayName(e),
      escapeHtml(cell.text),
      cell.cls,
      cls,
      pts,
      !multiclass ? null : dnf ? "—" : classPos.get(e.name) || "—"
    );
  });
  document.getElementById("dtClasses").innerHTML = html;
}

// Classificacao do campeonato da classe do piloto (lider + vizinhos).
function renderPoints(me, points) {
  const box = document.getElementById("dtPoints");
  if (!points || !points.byClass.size) {
    box.innerHTML = "";
    return;
  }
  const meInfo = me ? rltLookup(me) : null;
  let group = "_all";
  if (points.classMode) {
    const mine = meInfo && meInfo.uniqueName && meInfo.uniqueName !== "—" ? meInfo.uniqueName : null;
    // piloto nao reconhecido no RLT: mostra a primeira classe da temporada,
    // em vez de voltar para a pontuacao geral
    group = mine && points.byClass.has(mine)
      ? mine
      : (rltConfig.classes.map((c) => c.uniqueName).find((u) => points.byClass.has(u)) || Array.from(points.byClass.keys())[0]);
  }
  const projected = points.byClass.get(group) || [];
  if (!projected.length) {
    box.innerHTML = "";
    return;
  }
  const myKey = meInfo ? infoKey(meInfo) : null;
  const myIndex = myKey ? projected.findIndex((it) => rowKey(it.row) === myKey) : -1;
  const indices = LLGPoints.windowAround(projected.length, myIndex >= 0 ? myIndex : null, POINTS_ROWS);

  const title = points.classMode ? `Pontuação · ${classLabel(group)}` : "Pontuação";
  let html = `<div class="dt-head points">${escapeHtml(title)}${isRace() ? " · ao vivo" : ""}</div>`;
  html += windowRows(indices, (i) => {
    const it = projected[i];
    const color = it.row.color || classColor(it.row.classUniqueName);
    let value = escapeHtml(String(it.total));
    if (isRace() && it.add > 0) value += ` <span class="add">(+${it.add})</span>`;
    if (it.delta > 0) value += ` <span class="up">▲${it.delta}</span>`;
    else if (it.delta < 0) value += ` <span class="down">▼${-it.delta}</span>`;
    return rowHtml(it.rank, color, it.row.displayName || it.row.driverName || "—", value, "", i === myIndex ? "me" : "", null);
  });
  box.innerHTML = html;
}

function renderTitle() {
  document.getElementById("dtSession").textContent = SESSION_LABELS[sessionState] || (session && session.label) || "—";
  const timer = document.getElementById("dtTimer");
  if (!session) {
    timer.textContent = "";
    return;
  }
  const lapsInEvent = Number(session.lapsInEvent) || 0;
  if (isRace() && lapsInEvent > 0) {
    const leader = standings.reduce((a, b) => (!a || (b.position || 999) < (a.position || 999) ? b : a), null);
    timer.textContent = `Volta ${Math.min((leader && leader.currentLap) || 0, lapsInEvent)}/${lapsInEvent}`;
  } else {
    timer.textContent = formatClock(Number(session.timeRemainingSec) || 0);
  }
}

// redesenho com o limite de FPS do painel (shared/framecap.js)
function render() {
  return LLGFrameCap.run(renderNow, []);
}

function renderNow() {
  const root = document.getElementById("driver-table");
  if (!standings.length) {
    root.classList.add("hidden");
    return;
  }
  root.classList.remove("hidden");
  const viewed = standings.find((e) => e.isPlayer);
  if (viewed) meName = viewed.name;
  const me = standings.find((e) => e.name === meName) || null;
  const points = buildPoints();
  renderTitle();
  renderPositions(me, points);
  renderPoints(me, points);
}

// Safety car / FCY: painel e etiqueta em shared/racecontrol.js. O painel cobre a
// tabela abaixo do titulo, sem passar do fim da janela.
const RC_MIN_PANEL_H = 420;
function placeRaceControl() {
  const root = document.getElementById("driver-table");
  const panel = document.getElementById("rcPanel");
  if (panel.hidden) return;
  const top = root.offsetTop + root.querySelector(".dt-title").offsetHeight + 1;
  const zoom = Number(document.documentElement.style.zoom) || 1;
  const room = window.innerHeight / zoom - top;
  panel.style.top = `${top}px`;
  panel.style.left = `${root.offsetLeft}px`;
  panel.style.width = `${root.offsetWidth}px`;
  panel.style.setProperty("--rc-h", `${Math.min(room, Math.max(root.offsetHeight - top, RC_MIN_PANEL_H))}px`);
}
const raceControl = LLGRaceControl.create({ place: placeRaceControl });

function handleStandings(payload) {
  const list = Array.isArray(payload) ? payload : (payload && payload.standings) || [];
  session = Array.isArray(payload) ? null : (payload && payload.session) || null;
  if (session) {
    const st = Number(session.state);
    sessionState = Number.isNaN(st) ? null : st;
    trackLength = Number(session.trackLength) || 0;
    const key = `${sessionState}|${session.trackLocation || ""}|${session.trackVariation || ""}`;
    if (key !== lastSessionKey) {
      lastSessionKey = key;
      gapTracker.reset();
      gapSmoother.reset();
    }
  }
  standings = list.filter((e) => e && e.name);
  latestGame = (!Array.isArray(payload) && payload && payload.game) || "ams2";
  {
    const s = (!Array.isArray(payload) && payload && payload.session) || {};
    const t = LLGDisplay.trackDisplay(s.trackLocation, s.trackVariation);
    latestTrackNames = [s.trackLocation, `${s.trackLocation || ""} ${s.trackVariation || ""}`, t.name];
  }
  LLGDisplay.applyGameClassNames(standings, latestGame);
  gapTracker.update(standings, (!Array.isArray(payload) && payload && payload.ts) || Date.now());
  if (rltMatcher) rltMatcher.prime(standings.map((e) => e.name));
  render();
  raceControl.update(standings.length ? session : null);
}

// O servidor manda a "versao" dos arquivos da overlay ao conectar e de tempos
// em tempos. Se ela mudar (programa atualizado, arquivo editado), a pagina se
// recarrega sozinha, para o OBS nunca ficar rodando codigo antigo.
let overlayBuildId = null;
function checkBuildId(id) {
  if (!id) return;
  if (overlayBuildId === null) overlayBuildId = id;
  else if (id !== overlayBuildId) location.reload();
}

// "Editar na tela" do app: a janela ganha a barrinha de edicao (llgEditBar). Em edicao, sem o jogo
// em sessao, a tabela mostra os dados de exemplo; ao travar, o exemplo some.
const editing = () => !!document.getElementById("llgEditBar");
let showingDemo = false;
let demoLoop = null;
setInterval(() => {
  if (showingDemo && !editing()) {
    showingDemo = false;
    demoLoop = null;
    demoSeeded = false;
    handleStandings({ standings: [], session: null });
  }
}, 500);

// historico do exemplo (server/demo.js): a distancia de cada carro, 5x por segundo, dos 60 s antes
// do trecho ate este quadro (a ultima linha e agora). Entra nos intervalos com horarios "para tras".
let demoSeeded = false;
function seedDemoHistory(data) {
  const h = data && data.hist;
  if (!h || !Array.isArray(h.d) || !Array.isArray(h.names) || !(h.hz > 0)) return false;
  gapTracker.reset();
  gapSmoother.reset();
  const now = Number(data.ts) || Date.now();
  const n = h.d.length;
  h.d.forEach((row, k) => {
    const cars = [];
    h.names.forEach((name, i) => {
      if (typeof row[i] === "number") cars.push({ name, totalDistance: row[i] });
    });
    gapTracker.update(cars, now - ((n - 1 - k) * 1000) / h.hz);
  });
  return true;
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
    if (msg.type === "standings") {
      // jogo real com carros: ele manda, mesmo em edicao
      if (msg.data && Array.isArray(msg.data.standings) && msg.data.standings.length) showingDemo = false;
      if (!showingDemo) handleStandings(msg.data);
    } else if (msg.type === "demo" && editing()) {
      // dados de exemplo do "Editar na tela" (server/demo.js): so na janela do piloto em edicao
      if (msg.data.demoLoop !== demoLoop) {
        demoLoop = msg.data.demoLoop;
        demoSeeded = false;
        gapTracker.reset(); // o loop recomeca: o tempo "volta para tras"
        gapSmoother.reset();
      }
      showingDemo = true;
      handleStandings(msg.data);
      // depois da lista: a primeira dela e uma "sessao nova", que zera os intervalos
      if (!demoSeeded && seedDemoHistory(msg.data)) {
        demoSeeded = true;
        render();
      }
    } else if (msg.type === "hello") {
      checkBuildId(msg.buildId);
    } else if (msg.type === "rltConfig") {
      rltConfig = msg.data || null;
      rebuildMatcher();
      render();
    } else if (msg.type === "overlayCommand" && msg.name === "overlay.resetRace") {
      gapTracker.reset();
      gapSmoother.reset();
    }
  });
  // servidor reiniciando: tenta de novo logo, para a overlay voltar rapido
  socket.addEventListener("close", () => setTimeout(connect, 500));
}

// A tabela acompanha a largura da janela (ou da fonte no OBS).
function fitToWindow() {
  document.documentElement.style.zoom = String(Math.max(0.3, window.innerWidth / BASE_WIDTH));
}
window.addEventListener("resize", fitToWindow);
fitToWindow();

connect();
