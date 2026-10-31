// overlay/full-timing.js
// Tabela completa da corrida: todos os carros com as colunas lado a lado.
//   posicao | posicao na classe | piloto | logo do carro | equipe (ou o carro) |
//   intervalo para o lider | intervalo para o da frente | ultima volta |
//   melhor volta (com o numero da volta) | voltas desde a ultima parada |
//   posicoes ganhas/perdidas desde a largada (geral grande, na classe pequeno)
// Em classificacao, treino e time attack as colunas sao outras: posicao,
// posicao na classe, piloto, logo do carro, equipe/carro, melhor tempo,
// diferenca para o lider e as parciais (S1, S2, S3) da volta em andamento, nas
// cores do WEC. A lista e continua (todos os carros); a parte que aparece vai
// ate a altura da janela/fonte do OBS. Com a opcao do painel ligada, a lista
// desliza para deixar o piloto em foco no meio.
// A direita, o log da corrida (server/sessionLog.js): ultrapassagens, melhores
// voltas, entradas e saidas do box e punicoes, com a volta e o tempo de corrida.
// Tecla 0 (junto com a tabela de tempos): a pontuacao do campeonato separada
// por classe, com a pontuacao estimada se a corrida acabasse agora e os pontos
// de cada etapa (a descartada em vermelho). Precisa de temporada do RLT.
// Nome do piloto, equipe e classe vem do RLT quando ha temporada aplicada.

const WS_URL = `ws://${location.hostname}:${location.port || 8080}/ws`;
const BASE_WIDTH = 1920; // largura do desenho em px (full-timing.css)
const PAGE_MS = 10000;
const RLT_MATCH_MIN = 0.98;

let rltConfig = null;
let rltMatcher = null;
let standings = [];
let session = null;
let game = "ams2";
let trackLengthM = 0;
let lastSessionKey = null;
let logEvents = [];

const gapTracker = LLGGaps.createGapTracker();
const logoLoader = LLGLogos.createLoader("assets");
const frozenGaps = new Map(); // ultimo intervalo de quem recebeu a bandeirada

// ---------------------------------------------------------------- RLT
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
        minScore: RLT_MATCH_MIN,
      })
    : null;
  if (rltMatcher) rltMatcher.prime(standings.map((e) => e.name));
}

function rltLookup(entry) {
  return rltMatcher && entry ? rltMatcher.lookup(entry.name || "") : null;
}

function displayName(entry) {
  const info = rltLookup(entry);
  if (info) {
    const full = [info.firstName, info.lastName].filter(Boolean).join(" ").trim();
    if (info.firstName && info.lastName && full) return full;
    for (const v of [info.displayName, info.inGameName, info.driverName]) if (v && String(v).trim()) return String(v).trim();
  }
  return (entry.name || "").replace(/​/g, "");
}

function teamName(entry) {
  const info = rltLookup(entry);
  return (info && info.teamName) || entry.teamName || "";
}

const grouper = LLGGroups.createGrouper({
  rltEnabled: () => rltEnabled(),
  lookup: (entry) => rltLookup(entry),
  splitClasses: typeof SPLIT_BY_CAR_CLASSES !== "undefined" ? SPLIT_BY_CAR_CLASSES : [],
});

function classColor(key) {
  return LLGDisplay.classColor(key, rltEnabled() ? rltConfig.classes : null);
}

// ---------------------------------------------------------------- regras de corrida
function isSafetyCar(entry) {
  const cls = (entry.carClass || "").toLowerCase();
  return cls === "safetycar" || (entry.carName || "").toLowerCase().includes("safety");
}

function isDnf(entry) {
  return entry.raceState === 4 || entry.raceState === 5 || entry.raceState === 6;
}

function inPit(entry) {
  const phase = entry.pit && entry.pit.phase;
  return phase === "in" || phase === "out" || entry.pitMode === 1 || entry.pitMode === 2 || entry.pitMode === 4;
}

function formatTime(ms) {
  if (!(ms > 0)) return "--:--.---";
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

// segundos -> "+3.9" ou, acima de 1 minuto, "+2:09.4"
function plusSeconds(sec) {
  const ms = Math.round(Math.max(0, sec) * 1000);
  if (ms < 60000) return `+${(ms / 1000).toFixed(3)}`;
  const m = Math.floor(ms / 60000);
  const rest = (ms % 60000) / 1000;
  return `+${m}:${rest.toFixed(3).padStart(6, "0")}`;
}

// Com milesimos o numero mudaria a cada leitura (varias por segundo) e ficaria
// piscando. Cada intervalo so troca de valor a cada GAP_HOLD_MS; um salto
// grande (ultrapassagem, box) aparece na hora.
const GAP_HOLD_MS = 500;
const GAP_JUMP_S = 1.5;
const heldGaps = new Map(); // chave -> { sec, at }
function steadyGap(key, sec) {
  const now = Date.now();
  const held = heldGaps.get(key);
  if (held && now - held.at < GAP_HOLD_MS && Math.abs(sec - held.sec) < GAP_JUMP_S) return held.sec;
  heldGaps.set(key, { sec, at: now });
  return sec;
}

function lapsBehind(n) {
  return n === 1 ? "+1 volta" : `+${n} voltas`;
}

// Intervalo de `entry` para `ref` (o lider ou o carro da frente), por tempo:
// quanto faz que `ref` passou onde `entry` esta (shared/gaps.js).
function gapText(entry, ref, kind) {
  if (!ref || ref === entry) return kind === "leader" ? `Volta ${entry.currentLap || 0}` : "";
  const key = `${entry.name}>${kind}`;
  // bandeirada: a diferenca na chegada, congelada
  if (entry.raceState === 3) {
    if (frozenGaps.has(key)) return frozenGaps.get(key);
    if (ref.raceState === 3 && entry.finishedAtMs && ref.finishedAtMs) {
      const lapDiff = (ref.lapsCompleted || 0) - (entry.lapsCompleted || 0);
      const text = lapDiff > 0 ? lapsBehind(lapDiff) : plusSeconds((entry.finishedAtMs - ref.finishedAtMs) / 1000);
      frozenGaps.set(key, text);
      return text;
    }
  }
  // AMS2: na primeira volta a distancia que o jogo informa nao serve
  if (game === "ams2" && (!entry.lapsCompleted || entry.currentLap <= 1)) return "-";
  const g = gapTracker.gap(entry.name, ref.name, trackLengthM);
  if (g) {
    if (g.laps) return lapsBehind(g.laps);
    return plusSeconds(steadyGap(`${entry.name}>${ref.name}`, g.sec));
  }
  // sem historico ainda (overlay recem-aberta): estimativa distancia/velocidade
  if (typeof ref.totalDistance !== "number" || typeof entry.totalDistance !== "number") return "-";
  const behind = ref.totalDistance - entry.totalDistance;
  if (behind <= 0) return "+0.0";
  if (trackLengthM > 0 && behind >= trackLengthM) return lapsBehind(Math.floor(behind / trackLengthM));
  if (!(entry.speedMs >= 2)) return "-";
  return plusSeconds(behind / entry.speedMs);
}

// ---------------------------------------------------------------- cabecalho
function renderHeader() {
  const root = document.getElementById("full-timing");
  if (typeof HEADER_COLOR !== "undefined" && HEADER_COLOR) root.style.setProperty("--header-color", HEADER_COLOR);
  root.classList.toggle("sc-out", !!(session && (session.scOut || session.fcy)));

  let title = typeof HEADER_TITLE !== "undefined" && HEADER_TITLE ? HEADER_TITLE : "Liga Let's Go";
  let subtitle = "";
  const season = rltConfig && rltConfig.seasonName ? String(rltConfig.seasonName).trim() : "";
  if (season) {
    const parts = season.split(/\s+[-–—|]\s+/);
    title = parts[0];
    subtitle = parts.slice(1).join(" - ");
  }

  // pista: nome do jogo arrumado pelo track-names.js; com a etapa do RLT, o nome e o pais de la
  const loc = (session && session.trackLocation) || "";
  const lay = (session && session.trackVariation) || "";
  const track = LLGDisplay.trackDisplay(loc, lay);
  const event =
    season && loc ? LLGDisplay.matchEvent(rltConfig.events, [loc, `${loc} ${lay}`, track.name, `${track.name} ${track.layout}`], Date.now()) : null;
  let flag = null;
  if (event) {
    track.name = event.trackName || event.name || track.name;
    flag = LLGDisplay.flagFile(event.country);
    if (event.round != null) subtitle = [subtitle, `Etapa ${event.round}`].filter(Boolean).join(" · ");
  }
  document.getElementById("ftBrand").textContent = title;
  document.getElementById("ftSubtitle").textContent = subtitle;
  document.getElementById("ftTrack").textContent = track.name;
  const flagEl = document.getElementById("ftFlag");
  if (flag) logoLoader.load(flagEl, [flag]);
  else logoLoader.hide(flagEl);

  // volta do lider (corrida por voltas) ou tempo restante
  const leader = standings.find((e) => !isDnf(e));
  const laps = Number(session && session.lapsInEvent) || 0;
  let timer;
  if (leader && leader.raceState === 3) timer = "FIM";
  else if (laps > 0) {
    const lap = leader ? leader.currentLap || 0 : 0;
    timer = lap >= laps ? "ÚLTIMA VOLTA" : `VOLTA ${lap}/${laps}`;
  } else if (session && session.lapsLeft != null) {
    // corrida por tempo com o relogio zerado: as voltas que o lider ainda faz (servidor)
    timer = session.lapsLeft <= 1 ? "ÚLTIMA VOLTA" : `+${session.lapsLeft} VOLTAS`;
  } else timer = formatClock(Number(session && session.timeRemainingSec) || 0);
  document.getElementById("ftTimer").textContent = timer;
}

// ---------------------------------------------------------------- linhas
function escapeHtml(text) {
  return String(text == null ? "" : text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function contrastText(color) {
  const el = document.createElement("div");
  el.style.color = color;
  document.body.appendChild(el);
  const rgb = getComputedStyle(el).color.match(/\d+/g) || [0, 0, 0];
  el.remove();
  const [r, g, b] = rgb.map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#000" : "#fff";
}
const contrastCache = new Map();
function textOn(color) {
  if (!contrastCache.has(color)) contrastCache.set(color, contrastText(color));
  return contrastCache.get(color);
}

function carLogoPaths(entry) {
  const file = LLGDisplay.carLogo(entry.carName) || LLGDisplay.carLogoFromTeam(teamName(entry));
  if (!file) return [];
  const light = file.replace(/(\.[a-z0-9]+)?$/i, (ext) => `__light${ext}`);
  return [`cars/${light}`, `cars/${file}`];
}

// ▲3 (ganhou), ▼2 (perdeu), = (igual); vazio sem posicao de largada
function setGain(el, diff) {
  if (diff == null) {
    el.textContent = "";
    el.className = el.className.replace(/ (up|down|same)$/, "");
    return;
  }
  el.textContent = diff > 0 ? `▲${diff}` : diff < 0 ? `▼${-diff}` : "=";
  el.className = el.className.replace(/ (up|down|same)$/, "") + (diff > 0 ? " up" : diff < 0 ? " down" : " same");
}

// Aviso de punicao pendente ao lado do nome: DT (drive-through) ou SG (stop &
// go) no AMS2; no LMU o jogo so informa quantas ha (PEN, ou PEN x2).
const PENALTY_NAMES = { driveThrough: "Drive-through", stopGo: "Stop & go" };
function setPenaltyBadge(row, entry) {
  const badge = row.querySelector(".pen-badge");
  if (!badge) return;
  const text = LLGDisplay.penaltyLabel(entry);
  badge.textContent = text;
  badge.hidden = !text || isDnf(entry);
}

let pageIndex = 0;
let pageTimer = null;

// redesenho com o limite de FPS do painel (shared/framecap.js)
function render() {
  return LLGFrameCap.run(renderNow, []);
}

function renderNow() {
  const root = document.getElementById("full-timing");
  const champ = showingChampionship();
  document.getElementById("ftStandings").hidden = !champ;
  document.querySelector(".ft-table").hidden = champ;
  if (champ) {
    root.classList.remove("hidden");
    renderHeader();
    renderChampionship();
    return;
  }
  const state = session ? Number(session.state) : null;
  const timed = TIMED_LABELS[state] != null;
  root.classList.toggle("quali", timed);
  if (timed && standings.length) {
    root.classList.remove("hidden");
    renderHeader();
    renderQuali();
    return;
  }
  // volta de formacao: mesma tabela da corrida (o grid ja esta formado)
  const formation = state === 4;
  document.getElementById("ftSessionLabel").textContent = formation ? "FORMAÇÃO" : session && session.fcy ? (session.fcyGreenIn > 0 ? `VERDE EM ${session.fcyGreenIn}` : session.fcyCountdown > 0 ? `FCY EM ${session.fcyCountdown}` : "FCY") : session && (session.scCall || session.scOut) ? "SAFETY CAR" : "CORRIDA"; // FCY e SC: chamados no painel (aba LMU)
  const race = state === 5 || formation;
  if (!race || !standings.length) {
    root.classList.add("hidden");
    return;
  }
  root.classList.remove("hidden");
  renderHeader();
  setTableMode("race");
  document.querySelector(".ft-log-head").textContent = "LOG DA CORRIDA";

  const ordered = standings.slice().sort((a, b) => (isDnf(a) ? 1 : 0) - (isDnf(b) ? 1 : 0) || (a.position || 999) - (b.position || 999));
  const classes = new Set(ordered.map((e) => grouper.key(e, ordered)));
  const multiClass = classes.size > 1;
  root.classList.toggle("single-class", !multiClass);

  // melhor volta da corrida (roxo) e de cada classe
  const bestOverall = Math.min(...ordered.map((e) => (e.fastestLapMs > 0 ? e.fastestLapMs : Infinity)));
  const leader = ordered[0];

  const shown = ordered; // lista continua: todos os carros
  document.getElementById("ftPage").textContent = "";

  const rowsEl = document.getElementById("ftRows");
  while (rowsEl.children.length > shown.length) rowsEl.lastChild.remove();
  shown.forEach((entry, i) => {
    let row = rowsEl.children[i];
    if (!row) {
      row = document.createElement("div");
      row.className = "ft-row";
      row.innerHTML = `
        <div class="c-pos"></div>
        <div class="c-cls"></div>
        <div class="c-name"><span class="c-text"></span><span class="pen-badge" hidden></span></div>
        <div class="c-logo"><img alt="" /></div>
        <div class="c-team"><span class="c-text"></span></div>
        <div class="c-num c-leader"></div>
        <div class="c-num c-ahead"></div>
        <div class="c-num c-last"></div>
        <div class="c-best"></div>
        <div class="c-stint"></div>
        <div class="c-gain"><span class="g-all"></span><span class="g-cls"></span></div>`;
      rowsEl.appendChild(row);
    }
    const idx = ordered.indexOf(entry);
    const ahead = idx > 0 ? ordered[idx - 1] : null;
    const dnf = isDnf(entry);
    row.classList.toggle("dnf", dnf);
    row.classList.toggle("player", !!entry.isPlayer && !dnf); // piloto assistido
    row.classList.toggle("battle", !dnf && battleNames.has(entry.name)); // em disputa
    row.classList.toggle("yellow", !dnf && !!entry.causedYellow); // causou a bandeira amarela

    row.querySelector(".c-pos").textContent = dnf ? "-" : String(idx + 1); // ordem da tabela (DNF no fim)
    const clsCell = row.querySelector(".c-cls");
    if (multiClass) {
      const key = grouper.key(entry, ordered);
      const color = classColor(key);
      clsCell.textContent = dnf ? "-" : String(grouper.position(entry, ordered) || "");
      clsCell.style.backgroundColor = color;
      clsCell.style.color = textOn(color);
    }
    row.querySelector(".c-name .c-text").textContent = displayName(entry);
    row.querySelector(".c-team .c-text").textContent = teamName(entry) || LLGDisplay.carDisplayName(entry.carName); // sem equipe: o carro
    setPenaltyBadge(row, entry);

    const img = row.querySelector(".c-logo img");
    const logoKey = `${entry.carName}|${teamName(entry)}`;
    if (img.dataset.key !== logoKey) {
      img.dataset.key = logoKey;
      const paths = carLogoPaths(entry);
      if (paths.length) logoLoader.load(img, paths);
      else logoLoader.hide(img);
    }

    const leaderCell = row.querySelector(".c-leader");
    const aheadCell = row.querySelector(".c-ahead");
    if (dnf) {
      leaderCell.innerHTML = `<span class="t-dnf">DNF</span>`;
      aheadCell.textContent = "";
    } else if (formation) {
      // ninguem completou volta: diferencas ainda nao dizem nada
      leaderCell.textContent = "";
      aheadCell.textContent = "";
    } else {
      leaderCell.textContent = gapText(entry, leader, "leader");
      aheadCell.textContent = ahead ? gapText(entry, ahead, "ahead") : "";
    }

    const last = row.querySelector(".c-last");
    last.textContent = formatTime(entry.lastLapMs);
    last.className = "c-num c-last" + (entry.lastLapMs > 0 && entry.lastLapMs === bestOverall ? " t-purple" : entry.lastLapMs > 0 && entry.lastLapMs === entry.fastestLapMs ? " t-green" : "");

    const best = row.querySelector(".c-best");
    const lapNum = entry.fastestLapMs > 0 && entry.fastestLapNum ? `<span class="lap-num">V${entry.fastestLapNum}</span>` : "";
    best.innerHTML = `<span class="${entry.fastestLapMs > 0 && entry.fastestLapMs === bestOverall ? "t-purple" : ""}">${formatTime(entry.fastestLapMs)}</span>${lapNum}`;

    // posicoes ganhas/perdidas desde a largada: geral (grande) e na classe (pequeno)
    const gainAll = row.querySelector(".g-all");
    const gainCls = row.querySelector(".g-cls");
    const start = entry.startPosition;
    const classStart = multiClass ? grouper.startPosition(entry, ordered) : null;
    const noGain = dnf || formation; // na formacao a largada ainda nao aconteceu
    setGain(gainAll, noGain || start == null ? null : start - (idx + 1));
    setGain(gainCls, noGain || classStart == null ? null : classStart - (grouper.position(entry, ordered) || classStart));

    const stint = row.querySelector(".c-stint");
    if (!dnf && inPit(entry)) stint.innerHTML = `<span class="t-box">BOX</span>`;
    else stint.textContent = dnf ? "" : String((entry.pit && entry.pit.stintLaps) || 0);
  });

  applyViewport(); // parte visivel e piloto em foco no meio
  fitLog(); // a altura da tabela pode ter mudado (carro entrou ou saiu)
  ensurePaging(1);
}

// ---- lista continua: a parte visivel vai ate o fim da janela (fonte do OBS) ----
const CENTER_KEY = "fullCenter";
let centerFocus = false; // opcao do painel: manter o piloto em foco no meio
try {
  centerFocus = localStorage.getItem(CENTER_KEY) === "1";
} catch (_) {}

// Rolagem manual (botoes do painel ou roda do mouse): em linhas a partir do
// topo. Com a centralizacao ligada, vale por MANUAL_HOLD_MS e depois a lista
// volta para o piloto em foco; desligada, fica onde foi deixada.
const MANUAL_HOLD_MS = 20000;
let manualRow = null; // primeira linha visivel escolhida a mao (null = automatico)
let manualUntil = 0;
let lastFirstRow = 0; // primeira linha visivel agora (para a rolagem partir dela)
let lastVisibleRows = 1;

// dir: +1 desce, -1 sobe (meia tela por vez); 0 volta ao automatico
function scrollManual(dir) {
  if (!dir) {
    manualRow = null;
  } else {
    const step = Math.max(1, Math.floor(lastVisibleRows / 2));
    manualRow = Math.max(0, (manualRow != null ? manualRow : lastFirstRow) + dir * step);
    manualUntil = Date.now() + MANUAL_HOLD_MS;
  }
  render();
}

function setCenterFocus(on) {
  centerFocus = !!on;
  try {
    localStorage.setItem(CENTER_KEY, centerFocus ? "1" : "0");
  } catch (_) {}
  render();
}

function applyViewport() {
  const vp = document.getElementById("ftViewport");
  const rows = document.getElementById("ftRows");
  const zoom = parseFloat(document.documentElement.style.zoom) || 1;
  // da linha de cima da lista ate o fim da janela (em px do desenho, sem o zoom)
  let top = 0;
  for (let el = vp; el; el = el.offsetParent) top += el.offsetTop;
  let visible = Math.max(80, Math.floor(window.innerHeight / zoom - top - 4));
  // so linhas inteiras: nada cortado no meio embaixo nem em cima
  const list = rows.children;
  const pitch = list.length > 1 ? list[1].offsetTop - list[0].offsetTop : 0;
  const first = list.length ? list[0].offsetTop : 0;
  if (pitch > 0) visible = Math.max(pitch + first, first + Math.floor((visible - first) / pitch) * pitch);
  vp.style.maxHeight = `${visible}px`;
  const total = rows.scrollHeight;
  let offset = 0;
  if (manualRow != null && centerFocus && Date.now() > manualUntil) manualRow = null; // acabou o tempo: volta a centralizar
  if (manualRow != null && total > visible && pitch > 0) {
    offset = Math.min(total - visible, manualRow * pitch);
    manualRow = Math.round(offset / pitch); // nao passa do fim da lista
  } else if (centerFocus && total > visible) {
    const me = rows.querySelector(".ft-row.player");
    if (me) {
      offset = Math.max(0, Math.min(total - visible, me.offsetTop + me.offsetHeight / 2 - visible / 2));
      if (pitch > 0) offset = Math.min(total - visible, Math.round(offset / pitch) * pitch); // comeca no inicio de uma linha
    }
  }
  rows.style.transform = offset ? `translateY(${-Math.round(offset)}px)` : "";
  lastFirstRow = pitch > 0 ? Math.round(offset / pitch) : 0;
  lastVisibleRows = pitch > 0 ? Math.max(1, Math.floor((visible - first) / pitch)) : 1;
}

// Mais linhas do que cabem: alterna as paginas a cada PAGE_MS (pontuacao).
function ensurePaging(pages) {
  if (pages > 1 && !pageTimer) {
    pageTimer = setInterval(() => {
      pageIndex += 1;
      render();
    }, PAGE_MS);
  } else if (pages <= 1 && pageTimer) {
    clearInterval(pageTimer);
    pageTimer = null;
    pageIndex = 0;
  }
}

// ---------------------------------------------------------------- classificacao e treino
const TIMED_LABELS = { 1: "TREINO", 2: "TESTE", 3: "QUALI", 6: "TIME ATTACK" };
const RACE_HEAD = document.querySelector(".ft-head").innerHTML;
const QUALI_HEAD = `
      <div class="c-pos">POS</div>
      <div class="c-cls">CLS</div>
      <div class="c-name">PILOTO</div>
      <div class="c-logo"></div>
      <div class="c-team">EQUIPE / CARRO</div>
      <div class="c-num">MELHOR</div>
      <div class="c-num">DIF. LÍDER</div>
      <div class="c-sec">S1</div>
      <div class="c-sec">S2</div>
      <div class="c-sec">S3</div>`;
let tableMode = "race";

// Troca as colunas entre corrida e classificacao (as linhas sao refeitas)
function setTableMode(mode) {
  if (tableMode === mode) return;
  tableMode = mode;
  document.querySelector(".ft-head").innerHTML = mode === "quali" ? QUALI_HEAD : RACE_HEAD;
  document.getElementById("ftRows").innerHTML = "";
}

// Parciais da volta em andamento (shared/sectors.js, as mesmas do driver card)
const sectorTracker = LLGSectors.createSectorTracker();

// Logo do carro, piloto, equipe e posicao na classe: iguais nas duas tabelas
function fillIdentity(row, entry, multiClass, classPos) {
  const clsCell = row.querySelector(".c-cls");
  if (multiClass) {
    const color = classColor(grouper.key(entry, standings));
    clsCell.textContent = classPos != null ? String(classPos) : "-";
    clsCell.style.backgroundColor = color;
    clsCell.style.color = textOn(color);
  }
  row.querySelector(".c-name .c-text").textContent = displayName(entry);
  row.querySelector(".c-team .c-text").textContent = teamName(entry) || LLGDisplay.carDisplayName(entry.carName); // sem equipe: o carro
  setPenaltyBadge(row, entry);
  const img = row.querySelector(".c-logo img");
  const logoKey = `${entry.carName}|${teamName(entry)}`;
  if (img.dataset.key !== logoKey) {
    img.dataset.key = logoKey;
    const paths = carLogoPaths(entry);
    if (paths.length) logoLoader.load(img, paths);
    else logoLoader.hide(img);
  }
}

function renderQuali() {
  setTableMode("quali");
  document.querySelector(".ft-log-head").textContent = "LOG DA SESSÃO";
  const root = document.getElementById("full-timing");
  document.getElementById("ftSessionLabel").textContent = TIMED_LABELS[Number(session.state)];

  // pela melhor volta; quem ainda nao tem tempo vai para o fim
  const timed = (e) => e.fastestLapMs > 0;
  const ordered = standings
    .slice()
    .sort((a, b) => (timed(a) ? 0 : 1) - (timed(b) ? 0 : 1) || (timed(a) && timed(b) ? a.fastestLapMs - b.fastestLapMs : (a.position || 999) - (b.position || 999)));
  const classes = new Set(ordered.map((e) => grouper.key(e, ordered)));
  const multiClass = classes.size > 1;
  root.classList.toggle("single-class", !multiClass);

  // posicao na classe pela melhor volta
  const classPos = new Map();
  const counters = new Map();
  ordered.forEach((e) => {
    const k = grouper.key(e, ordered);
    const n = (counters.get(k) || 0) + 1;
    counters.set(k, n);
    classPos.set(e.name, timed(e) ? n : null);
  });
  const leaderBest = ordered.length && timed(ordered[0]) ? ordered[0].fastestLapMs : null;

  const shown = ordered; // lista continua: todos os carros
  document.getElementById("ftPage").textContent = "";

  const now = Date.now();
  const rowsEl = document.getElementById("ftRows");
  while (rowsEl.children.length > shown.length) rowsEl.lastChild.remove();
  shown.forEach((entry, i) => {
    let row = rowsEl.children[i];
    if (!row) {
      row = document.createElement("div");
      row.className = "ft-row";
      row.innerHTML = `
        <div class="c-pos"></div>
        <div class="c-cls"></div>
        <div class="c-name"><span class="c-text"></span><span class="pen-badge" hidden></span></div>
        <div class="c-logo"><img alt="" /></div>
        <div class="c-team"><span class="c-text"></span></div>
        <div class="c-num c-qbest"></div>
        <div class="c-num c-qgap"></div>
        <div class="c-sec"></div>
        <div class="c-sec"></div>
        <div class="c-sec"></div>`;
      rowsEl.appendChild(row);
    }
    const idx = ordered.indexOf(entry);
    row.classList.toggle("player", !!entry.isPlayer);
    row.querySelector(".c-pos").textContent = timed(entry) ? String(idx + 1) : "-";
    fillIdentity(row, entry, multiClass, classPos.get(entry.name));

    const best = row.querySelector(".c-qbest");
    best.textContent = timed(entry) ? formatTime(entry.fastestLapMs) : "";
    best.className = "c-num c-qbest" + (timed(entry) && entry.fastestLapMs === leaderBest ? " t-purple" : "");
    const gap = row.querySelector(".c-qgap");
    gap.textContent = timed(entry) && leaderBest != null && entry.fastestLapMs > leaderBest ? plusSeconds((entry.fastestLapMs - leaderBest) / 1000) : "";

    // S1, S2, S3 da volta em andamento, na cor da parcial
    const cells = row.querySelectorAll(".c-sec");
    sectorTracker.view(entry.name, now).forEach((sec, k) => {
      cells[k].textContent = sec.ms != null ? (sec.ms / 1000).toFixed(3) : "";
      cells[k].className = "c-sec" + (sec.ms != null && sec.color ? ` sec-${sec.color}` : "");
    });
  });

  applyViewport(); // parte visivel e piloto em foco no meio
  fitLog(); // o log acompanha a altura da tabela
  ensurePaging(1);
}

// ---------------------------------------------------------------- pontuacao (tecla 0)
const CHAMP_ROWS_PER_PAGE = 24; // linhas (pilotos + nomes de classe) por pagina
let championshipView = false;
let lastChampHtml = null; // HTML da pontuacao na tela (so troca quando muda)

function showingChampionship() {
  return championshipView && !!(rltConfig && rltConfig.standingsRows && rltConfig.standingsRows.length);
}

const normalize = LLGNames.normalizeName;

// nomes (normalizados) de um piloto do RLT: o de exibicao, o do RLT e os apelidos
function rowKeys(row) {
  return [normalize(row.displayName), normalize(row.driverName), normalize(row.inGameName), ...(row.aliases || [])].filter(Boolean);
}

// Posicao de cada piloto na CLASSE na corrida em andamento, pelos nomes, para
// a pontuacao estimada. Quem abandonou nao entra.
function liveClassPositions() {
  const map = new Map();
  if (!(session && Number(session.state) === 5)) return map;
  const groups = new Map();
  standings.forEach((e) => {
    if (isDnf(e)) return;
    const k = grouper.key(e, standings);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  });
  groups.forEach((list) => {
    list
      .sort((a, b) => (a.position || 999) - (b.position || 999))
      .forEach((e, i) => {
        const info = rltLookup(e);
        const keys = [normalize(e.name)];
        if (info) keys.push(normalize(info.displayName || ""), ...(info.aliases || []));
        keys.filter(Boolean).forEach((k) => map.set(k, i + 1));
      });
  });
  return map;
}

// quem esta na pista agora (aparece na pontuacao mesmo sem pontos ainda)
function liveKeys() {
  const set = new Set();
  standings.forEach((e) => {
    set.add(normalize(e.name));
    const info = rltLookup(e);
    if (info) set.add(normalize(info.displayName || ""));
  });
  return set;
}

function renderChampionship() {
  document.getElementById("ftSessionLabel").textContent = "PONTOS";
  document.getElementById("ftTimer").textContent = "";
  const present = liveKeys();
  const data = LLGChampionship.build(rltConfig.standingsRows, rltConfig.events, (r) => rowKeys(r).some((k) => present.has(k)));
  const livePos = liveClassPositions();
  const inRace = livePos.size > 0;
  const table = LLGPoints.pointsTable(rltConfig);
  const roundNow = LLGPoints.currentRound(rltConfig.events || [], null, Date.now());
  const fmt = (n) => String(Math.round(n * 10) / 10);

  const cols = `60px minmax(0, 1fr) 54px minmax(0, 230px) 80px 104px 100px 92px repeat(${data.rounds.length}, 54px)`;
  let html = `<div class="st-head" style="grid-template-columns: ${cols}">
      <div class="c-pos">POS</div><div class="c-name">PILOTO</div><div class="c-logo"></div><div class="c-team">EQUIPE</div>
      <div class="c-pts">PTS</div><div class="c-pts">ESTIMADA</div><div class="c-pts">DESCARTE</div><div class="c-pts">PENALTY</div>
      ${data.rounds.map((n) => `<div class="c-rnd">E${n}</div>`).join("")}
    </div>`;
  const items = [];
  data.groups.forEach((g) => {
    if (data.multiClass) items.push({ header: g });
    g.rows.forEach((line) => items.push({ line, classMode: data.multiClass }));
  });
  // mais linhas do que cabem: as paginas se alternam
  const pages = Math.max(1, Math.ceil(items.length / CHAMP_ROWS_PER_PAGE));
  if (pageIndex >= pages) pageIndex = 0;
  ensurePaging(pages);
  items.slice(pageIndex * CHAMP_ROWS_PER_PAGE, (pageIndex + 1) * CHAMP_ROWS_PER_PAGE).forEach((it) => {
    if (it.header) {
      const color = it.header.color || classColor(it.header.key);
      html += `<div class="st-class" style="background-color: ${color}; color: ${textOn(color)}">${escapeHtml(it.header.name || it.header.key)}</div>`;
      return;
    }
    const l = it.line;
    let estimate = "-";
    if (inRace) {
      const pos = rowKeys(l.row).map((k) => livePos.get(k)).find((p) => p != null);
      const add = pos ? LLGPoints.pointsForPosition(pos, table) : 0;
      estimate = fmt(LLGPoints.projectedTotal(l.row, add, roundNow, it.classMode));
    }
    const cells = l.cells.map((c) => `<div class="c-rnd${c && c.discarded ? " discarded" : ""}">${c ? fmt(c.points) : ""}</div>`).join("");
    html += `<div class="st-row" style="grid-template-columns: ${cols}">
        <div class="c-pos">${l.position}</div>
        <div class="c-name"><span class="c-text">${escapeHtml(l.row.displayName || l.row.driverName || "")}</span></div>
        <div class="c-logo"><img alt="" data-team="${escapeHtml(l.row.teamName || "")}" /></div>
        <div class="c-team"><span class="c-text">${escapeHtml(l.row.teamName || "")}</span></div>
        <div class="c-pts main">${fmt(l.points)}</div>
        <div class="c-pts">${estimate}</div>
        <div class="c-pts${l.hasDiscard ? " discarded" : ""}">${l.hasDiscard ? fmt(l.discarded) : "-"}</div>
        <div class="c-pts">${l.penaltyPoints ? fmt(l.penaltyPoints) : "-"}</div>
        ${cells}
      </div>`;
  });
  html += `<div class="ft-page">${pages > 1 ? `${pageIndex + 1}/${pages}` : ""}</div>`;
  // so troca o HTML quando muda algo: senao os logos recarregariam a cada leitura do jogo
  const el = document.getElementById("ftStandings");
  if (lastChampHtml !== html) {
    lastChampHtml = html;
    el.innerHTML = html;
    el.querySelectorAll("img[data-team]").forEach((img) => {
      const team = img.dataset.team;
      if (team) logoLoader.load(img, LLGDisplay.logoPaths(team, null, {}, "light"));
      else logoLoader.hide(img);
    });
  }
  fitLog(); // o log acompanha a altura da pontuacao
}

// ---------------------------------------------------------------- log da corrida
const LOG_MAX_ITEMS = 30; // o que nao couber na altura fica escondido

function nameOf(raw) {
  return displayName({ name: raw });
}

function lapClock(ms) {
  return formatClock((ms || 0) / 1000);
}

function shortTime(ms) {
  if (!(ms >= 0)) return "-";
  const sec = ms / 1000;
  return sec < 60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, "0")}`;
}

// compostos: um so quando as 4 rodas sao iguais ("M"), senao todos ("M M H H")
function tyreText(set) {
  if (!set || !set.length) return "?";
  const short = set.map((t) => String(t).trim().charAt(0).toUpperCase() || "?");
  return short.every((x) => x === short[0]) ? short[0] : short.join(" ");
}

const FASTEST_LABELS = { overall: "Volta mais rápida geral", class: "Volta mais rápida da classe", personal: "Melhor volta pessoal" };

function logItem(ev) {
  const line = (cls, arrow, name, right) =>
    `<div class="lg-line ${cls}">${arrow ? `<span>${arrow}</span>` : ""}<span class="lg-name">${escapeHtml(name)}</span>${right ? `<span class="lg-right">${escapeHtml(right)}</span>` : ""}</div>`;
  let cls = "";
  let style = "";
  let type = "";
  let typeAttrs = "";
  let body = "";
  if (ev.type === "overtake") {
    cls = "lg-overtake";
    type = "Ultrapassagem";
    body = line("lg-up", "▲", nameOf(ev.gainer), `P${ev.position}`) + line("lg-down", "▼", nameOf(ev.loser), `P${ev.lostPosition}`);
  } else if (ev.type === "fastest") {
    cls = `lg-fastest ${ev.scope}`;
    if (ev.scope === "class") {
      const color = classColor(ev.classKey);
      style = ` style="--lg-color: ${color}"`;
      typeAttrs = ` chip" style="color: ${textOn(color)}`;
    }
    type = FASTEST_LABELS[ev.scope] || FASTEST_LABELS.personal;
    body = line("", "", nameOf(ev.driver), formatTime(ev.lapMs));
  } else if (ev.type === "pitIn") {
    cls = "lg-pit";
    type = "Entrou no box";
    body = line("", "", nameOf(ev.driver), `P${ev.position}`);
  } else if (ev.type === "pitOut") {
    cls = "lg-pit";
    type = "Saiu do box";
    const diff = (ev.positionAfter || 0) - (ev.positionBefore || 0);
    const change = diff > 0 ? `-${diff}` : diff < 0 ? `+${-diff}` : "=";
    // fora da corrida a posicao nao muda pelo box: sem posicoes ganhas/perdidas
    body = line("", "", nameOf(ev.driver), ev.race === false ? "" : `P${ev.positionBefore} → P${ev.positionAfter} (${change})`);
    const times = ev.totalMs != null ? `Box ${shortTime(ev.totalMs)} · parado ${shortTime(ev.stoppedMs)} · andando ${shortTime(ev.movingMs)}` : `Parado ${shortTime(ev.stoppedMs)}`;
    body += `<div class="lg-detail">${escapeHtml(times)}</div>`;
    const extra = [];
    if (ev.tyres) extra.push(`Pneus ${tyreText(ev.tyres.before)} → ${tyreText(ev.tyres.after)}`);
    if (ev.energyAdded != null) extra.push(`Energia +${ev.energyAdded}%`);
    if (ev.fuelAdded != null) extra.push(`Combustível +${ev.fuelAdded} L`);
    if (extra.length) body += `<div class="lg-detail">${escapeHtml(extra.join(" · "))}</div>`;
  } else if (ev.type === "penalty" || ev.type === "penaltyServed" || ev.type === "disqualified") {
    cls = "lg-penalty";
    // tipo da punicao: o AMS2 informa (drive-through, stop & go); o LMU nao
    const kind = ev.kind && PENALTY_NAMES[ev.kind] ? `: ${PENALTY_NAMES[ev.kind]}` : "";
    type = ev.type === "penalty" ? `Punição${kind}` : ev.type === "penaltyServed" ? `Cumpriu punição${kind}` : "Desclassificado";
    const right = ev.type === "disqualified" ? "" : ev.pending > 0 ? `${ev.pending} pendente${ev.pending > 1 ? "s" : ""}` : "";
    body = line("", "", nameOf(ev.driver), right);
  } else if (ev.type === "yellow") {
    cls = "lg-yellow";
    type = "Bandeira amarela";
    body = line("", "", nameOf(ev.driver), `P${ev.position}`);
  } else if (ev.type === "localYellow") {
    cls = "lg-yellow";
    type = "Bandeira amarela";
    body = line("", "", "Bandeira amarela local na pista", "");
  } else if (ev.type === "safetyCar") {
    cls = "lg-yellow";
    type = "Safety car";
    body = line("", "", "Bandeira amarela em toda a pista", "");
  } else if (ev.type === "fcy") {
    cls = "lg-yellow";
    type = "FCY";
    body = line("", "", "Full course yellow", "");
  } else if (ev.type === "fcyBreach") {
    cls = "lg-yellow";
    type = "FCY queimado";
    const secs = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1).replace(".", ",")} s`;
    body = line("", "", nameOf(ev.driver), `máx ${ev.maxKmh} km/h`) + line("", "", `${secs(ev.overMs)} acima do limite`, `${secs(ev.afterMs)} após a contagem`);
  } else if (ev.type === "green") {
    cls = "lg-green";
    type = "Bandeira verde";
    body = line("", "", "Pista liberada", "");
  } else return "";
  return `<div class="lg-item ${cls}"${style}>
      <div class="lg-meta"><span>V${ev.lap != null ? ev.lap : "-"}</span><span class="lg-time">${ev.remainingSec != null ? formatClock(ev.remainingSec) : lapClock(ev.sessionMs)}</span></div>
      <div class="lg-body"><div class="lg-type${typeAttrs}">${type}</div>${body}</div>
    </div>`;
}

function renderLog() {
  const el = document.getElementById("ftLog");
  if (!el) return;
  el.innerHTML = logEvents.slice(-LOG_MAX_ITEMS).reverse().map(logItem).join("");
  fitLog();
}

// O log tem a altura da tabela: evento que nao cabe inteiro fica escondido
// (nada de evento cortado no meio).
function fitLog() {
  const el = document.getElementById("ftLog");
  if (!el) return;
  const limit = el.clientHeight;
  let hidden = false;
  Array.from(el.children).forEach((item) => {
    item.style.display = "";
    if (hidden || item.offsetTop + item.offsetHeight > limit) {
      item.style.display = "none";
      hidden = true;
    }
  });
}

// ---------------------------------------------------------------- disputas
// Mesma regra da pagina de disputas da tabela de tempos (shared/battles.js):
// menos de 0,6 s por 5 s seguidos vira disputa; deixa de ser depois de 10 s
// acima disso, ou na hora se abrir mais de 2 s. So em corrida e desligada com
// safety car. A disputa e entre posicoes seguidas DENTRO da classe (com varias
// classes, um carro de outra classe passando nao e briga por posicao).
const battleDetector = LLGBattles.createBattleDetector();
let battleNames = new Set();

function updateBattles() {
  if (!(session && Number(session.state) === 5) || session.scOut || session.fcy) {
    battleDetector.reset();
    battleNames = new Set();
    return;
  }
  const gapOf = (behind, ahead) => {
    const g = gapTracker.gap(behind.name, ahead.name, trackLengthM);
    return g && !g.laps ? g.sec : null;
  };
  // quem esta no box, terminou ou abandonou quebra a sequencia (AMS2: sem intervalo na 1a volta)
  const eligible = (e) =>
    isDnf(e) || e.raceState === 3 || (e.pitMode || 0) !== 0 || (game === "ams2" && (!e.lapsCompleted || e.currentLap <= 1)) ? null : e;
  const sorted = standings.slice().sort((a, b) => (a.position || 999) - (b.position || 999));
  const byClass = new Map();
  sorted.forEach((e) => {
    const key = grouper.key(e, sorted);
    if (!byClass.has(key)) byClass.set(key, []);
    byClass.get(key).push(eligible(e));
  });
  const chained = [];
  byClass.forEach((list) => {
    if (chained.length) chained.push(null); // o ultimo de uma classe nao forma par com o primeiro da outra
    list.forEach((e) => chained.push(e));
  });
  battleNames = battleDetector.update(chained, gapOf, Date.now());
}

// ---------------------------------------------------------------- dados
function handleStandings(payload) {
  if (!payload || Array.isArray(payload)) return;
  session = payload.session || null;
  game = payload.game || "ams2";
  trackLengthM = Number(session && session.trackLength) || 0;
  const key = session ? `${session.state}|${session.trackLocation || ""}|${session.trackVariation || ""}` : null;
  if (key !== lastSessionKey) {
    lastSessionKey = key;
    gapTracker.reset();
    heldGaps.clear();
    frozenGaps.clear();
    battleDetector.reset();
    sectorTracker.reset();
  }
  const raw = payload.standings || [];
  LLGDisplay.applyGameClassNames(raw, game); // classes do jogo com os nomes do drivers-config
  standings = raw.filter((e) => e && e.name && !isSafetyCar(e));
  gapTracker.update(standings, payload.ts || Date.now());
  updateBattles();
  // parciais por classe (a roxa e a melhor da classe), so fora da corrida
  if (session && TIMED_LABELS[Number(session.state)] != null) sectorTracker.update(standings, (e) => grouper.key(e, standings), Date.now());
  if (rltMatcher) rltMatcher.prime(standings.map((e) => e.name));
  render();
}

// O servidor manda a "versao" dos arquivos da overlay; se mudar, recarrega.
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
    else if (msg.type === "hello") checkBuildId(msg.buildId);
    else if (msg.type === "sessionLog") {
      logEvents = (msg.data && msg.data.events) || [];
      renderLog();
    } else if (msg.type === "rltConfig") {
      rltConfig = msg.data || null;
      rebuildMatcher();
      render();
      renderLog();
    } else if (msg.type === "assetsConfig") {
      logoLoader.setConfig(msg.data || {});
      document.querySelectorAll(".c-logo img").forEach((img) => delete img.dataset.key);
      render();
    } else if (msg.type === "overlayCommand" && msg.name === "overlay.fullScroll") {
      scrollManual(Number(msg.payload && msg.payload.dir) || 0);
    } else if (msg.type === "overlayCommand" && msg.name === "overlay.setFullCenter") {
      setCenterFocus(!!(msg.payload && msg.payload.value));
    } else if (msg.type === "overlayCommand" && msg.name === "overlay.resetRace") {
      gapTracker.reset();
      heldGaps.clear();
      frozenGaps.clear();
      battleDetector.reset();
    } else if (msg.type === "overlayCommand" && (msg.name === "overlay.toggleStandings" || msg.name === "overlay.setStandings")) {
      // tecla 0 / painel: troca junto com a tabela de tempos
      championshipView = msg.name === "overlay.toggleStandings" ? !championshipView : !!(msg.payload && msg.payload.value);
      pageIndex = 0;
      render();
    }
  });
  socket.addEventListener("close", () => setTimeout(connect, 500));
}

// roda do mouse (no navegador, ou no OBS com "Interagir"): rola a lista
window.addEventListener(
  "wheel",
  (e) => {
    if (!e.deltaY) return;
    e.preventDefault();
    scrollManual(e.deltaY > 0 ? 1 : -1);
  },
  { passive: false }
);

function fitToWindow() {
  document.documentElement.style.zoom = String(Math.max(0.3, window.innerWidth / BASE_WIDTH));
}
window.addEventListener("resize", fitToWindow);
fitToWindow();

connect();
