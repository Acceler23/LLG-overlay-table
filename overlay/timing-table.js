const params = new URLSearchParams(location.search);
const DEMO = params.get("demo") === "1";

const WS_URL = `ws://${location.hostname}:${location.port || 8080}/ws`;

const RIGHT_COLUMN_MODES = ["Intervalo", "Gap líder", "Última volta", "Melhor volta", "Posições", "Paradas", "Stint", "VMax", "Pneus"];
let rightColumnIndex = 0;

const PAGE_MODES_ALL = ["Geral", "Multiclasse", "Minha classe"];
let pageIndex = 0;

let rltConfig = null;
const RLT_MATCH_MIN = 0.98;

// ---- so no Le Mans Ultimate: pneus e energia virtual (VE) ----
// Ficam FORA da tabela, a direita de cada linha (como o relogio da volta
// mais rapida), em elementos criados por updateLmuSide(). A tabela em si nao
// muda de largura. Os dados vem do listener-lmu.ps1.

// composto -> letra e classe de cor do "pneu"
function tyreCompound(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  // Assetto Corsa: o jogo manda a sigla do composto (S, M, H, SH, SM...).
  // As cores seguem o "Pirelli rainbow" de 2018 (classes rb-*, no CSS).
  if (n.length <= 3) {
    if (n === "wet") return { letter: "W", cls: "wet" }; // nome inteiro do LMU, com 3 letras
    const letter = n.toUpperCase();
    const rainbow = { sh: "superhard", h: "hard", m: "medium", s: "soft", ss: "supersoft", us: "ultrasoft", hs: "hypersoft" };
    if (rainbow[n]) return { letter, cls: `rb-${rainbow[n]}` };
    if (n === "w") return { letter, cls: "wet" };
    if (n === "i") return { letter, cls: "inter" };
    return { letter, cls: "other" };
  }
  if (n.includes("wet") || n.includes("rain") || n.includes("chuva")) return { letter: "W", cls: "wet" };
  if (n.includes("inter")) return { letter: "I", cls: "inter" };
  if (n.includes("soft") || n.includes("macio")) return { letter: "S", cls: "soft" };
  if (n.includes("med")) return { letter: "M", cls: "medium" };
  if (n.includes("hard") || n.includes("duro")) return { letter: "H", cls: "hard" };
  return { letter: n[0].toUpperCase(), cls: "other" };
}

// Pneu: letra do composto (dianteiro e traseiro, se forem diferentes).
function tyreBadges(entry) {
  // LMU: composto de cada roda (diant. esq, diant. dir, tras. esq, tras. dir).
  // Todos iguais: um circulo com a letra. Algum diferente: uma grade 2 x 2 so
  // com a cor de cada composto, na posicao em que as rodas estao no carro.
  const wheels = Array.isArray(entry.tyres) && entry.tyres.length === 4 ? entry.tyres.map(tyreCompound) : null;
  if (wheels && wheels.every(Boolean)) {
    if (wheels.every((w) => w.cls === wheels[0].cls && w.letter === wheels[0].letter)) {
      return { html: `<span class="tyre-badge ${wheels[0].cls}">${wheels[0].letter}</span>`, pair: false };
    }
    const cells = wheels.map((w) => `<span class="tyre-cell ${w.cls}"></span>`).join("");
    return { html: `<span class="tyre-grid">${cells}</span>`, pair: false };
  }
  const front = tyreCompound(entry.tyreFront);
  const rear = tyreCompound(entry.tyreRear);
  let html = "";
  if (front) html += `<span class="tyre-badge ${front.cls}">${front.letter}</span>`;
  const pair = !!(front && rear && rear.letter !== front.letter);
  if (rear && (!front || pair)) html += `<span class="tyre-badge ${rear.cls}">${rear.letter}</span>`;
  return { html, pair };
}

// A pagina "Pneus" da coluna da direita so entra no rodizio quando o jogo
// informa o composto. No LMU os pneus ja ficam ao lado da tabela.
// Ganho de posicoes, paradas e stint so fazem sentido em corrida: em treino e
// classificacao essas paginas ficam fora do rodizio.
const RACE_ONLY_MODES = ["Posições", "Paradas", "Stint"];

// Fora isso, uma pagina sem dado nenhum (vazia ou zerada para todos os
// pilotos) tambem sai do rodizio; basta um piloto ter o dado para ela voltar.
// Intervalo e Gap lider aparecem sempre (na corrida o gap e medido na pista,
// sem depender de volta completa).
const positiveNum = (v) => typeof v === "number" && v > 0;
const MODE_HAS_DATA = {
  "Última volta": (e) => positiveNum(e.lastLapMs),
  "Melhor volta": (e) => positiveNum(e.fastestLapMs),
  "Posições": (e) => e.startPosition != null && e.position != null && e.startPosition !== e.position,
  "Paradas": (e) => positiveNum(pitInfo(e).stops),
  "Stint": (e) => positiveNum(pitInfo(e).stintLaps) || (latestGame === "acc" && stintLimitMin > 0 && positiveNum(pitInfo(e).stintMs)),
  "VMax": (e) => positiveNum(e.maxSpeedKmh),
  "Pneus": (e) => !!(e.tyreFront || e.tyreRear),
};

function rightModeAvailable(mode) {
  // (a volta de formacao, estado 4, ja faz parte da corrida)
  if (RACE_ONLY_MODES.includes(mode) && !(isRaceSession() || Number(latestSessionState) === 4)) return false;
  if (mode === "Pneus" && latestGame === "lmu") return false;
  const hasData = MODE_HAS_DATA[mode];
  return !hasData || latestStandings.some((e) => e && hasData(e));
}

function stepRightColumn(dir) {
  const n = RIGHT_COLUMN_MODES.length;
  for (let i = 0; i < n; i++) {
    rightColumnIndex = (rightColumnIndex + dir + n) % n;
    if (rightModeAvailable(RIGHT_COLUMN_MODES[rightColumnIndex])) return;
  }
}

function renderTyreCell(cell, entry) {
  const { html, pair } = tyreBadges(entry);
  cell.classList.toggle("pair", pair); // dois compostos: circulos menores para caber
  if (cell.dataset.html !== html) {
    cell.innerHTML = html;
    cell.dataset.html = html;
  }
}

// VE: energia virtual restante em %. Carros sem VE (ex: LMP2) ficam em branco.
function renderEnergyCell(cell, entry) {
  const ve = entry.virtualEnergy;
  if (typeof ve !== "number") {
    cell.textContent = "";
    cell.className = "energy";
    return;
  }
  const pct = Math.round(ve * 100);
  cell.textContent = `${pct}%`;
  cell.className = "energy" + (pct < 15 ? " low" : pct < 30 ? " mid" : "");
}

const LMU_SIDE_WIDTH = 70; // px, igual ao .lmu-side do CSS
const LMU_TYRE_ONLY_WIDTH = 30; // px, igual ao .lmu-side.tyre-only do CSS
const LMU_SIDE_GAP = 2;
const lmuSideEls = [];

function lmuSideElement(i) {
  while (lmuSideEls.length <= i) {
    const el = document.createElement("div");
    el.className = "lmu-side";
    el.innerHTML = '<span class="tyre"></span><span class="energy"></span>';
    document.body.appendChild(el);
    lmuSideEls.push(el);
  }
  return lmuSideEls[i];
}

// Posiciona pneus e VE ao lado de cada linha de piloto que esta na tela.
// Devolve a largura ocupada ao lado da tabela (0 fora do LMU), para o
// relogio da volta mais rapida ficar depois dela.
// sideOffset: largura da velocidade dos carros em disputa, que fica entre a
// tabela e o pneu dessas linhas. Devolve a largura total ocupada ao lado da
// tabela (velocidade + pneus).
function updateLmuSide(standings, sideOffset) {
  const table = document.getElementById("timing-table");
  const offset = sideOffset || 0;
  const show = latestGame === "lmu" && !showingStandings();
  const rows = [];
  if (show && table) {
    document.querySelectorAll("#rows > .row").forEach((el) => {
      if (el.dataset.kind === "row") rows.push(el);
    });
  }
  const byName = new Map((standings || []).map((e) => [e.name, e]));
  const top0 = table ? table.offsetTop + table.clientTop : 0;
  // Na pagina de disputas fica so o pneu (sem a VE), depois da velocidade.
  const tyreOnly = battleActive();
  const sideWidth = tyreOnly ? LMU_TYRE_ONLY_WIDTH : LMU_SIDE_WIDTH;
  // So as linhas em disputa tem a velocidade antes do pneu; nas outras o pneu
  // fica encostado na tabela, sem buraco.
  const leftFor = (name) => {
    if (!table) return 0;
    const o = offset && battleNames.has(name) ? offset : 0;
    return CLOCK_SIDE === "left" ? table.offsetLeft - o - sideWidth - LMU_SIDE_GAP : table.offsetLeft + table.offsetWidth + o + LMU_SIDE_GAP;
  };

  let used = 0;
  rows.forEach((row) => {
    const entry = byName.get(row.dataset.name);
    if (!entry) return;
    const el = lmuSideElement(used++);
    renderTyreCell(el.querySelector(".tyre"), entry);
    renderEnergyCell(el.querySelector(".energy"), entry);
    el.style.top = `${top0 + row.offsetTop}px`;
    el.style.height = `${row.offsetHeight}px`;
    el.style.left = `${leftFor(entry.name)}px`;
    el.classList.toggle("tyre-only", tyreOnly);
    el.classList.add("visible");
  });
  for (let i = used; i < lmuSideEls.length; i++) lmuSideEls[i].classList.remove("visible");

  return used > 0 ? offset + sideWidth + LMU_SIDE_GAP : 0;
}

// Degrade suave com a cor principal da equipe (RLT) no fundo da linha.
// A intensidade vem da variavel CSS --team-tint, controlada pelo painel.
function applyTeamTint(el, color) {
  const rgb = color ? LLGColors.toRgb(color) : null;
  el.classList.toggle("has-team", !!rgb);
  if (rgb) el.style.setProperty("--team-rgb", rgb.join(", "));
  else el.style.removeProperty("--team-rgb");
}

const TEAM_TINT_KEY = "teamTint";

function setTeamTint(value, save) {
  const root = document.getElementById("timing-table");
  const v = Math.max(0, Math.min(1, Number(value)));
  if (!root || Number.isNaN(v)) return;
  root.style.setProperty("--team-tint", String(v));
  if (save) {
    try {
      localStorage.setItem(TEAM_TINT_KEY, String(v));
    } catch (_) {}
  }
}

// a intensidade escolhida no painel sobrevive a um reload da overlay
try {
  const savedTint = localStorage.getItem(TEAM_TINT_KEY);
  if (savedTint != null) setTeamTint(savedTint, false);
} catch (_) {}

function rowBg(hex) {
  const root = document.getElementById("timing-table");
  const op = root ? parseFloat(getComputedStyle(root).getPropertyValue("--row-opacity")) || 1 : 1;
  const h = String(hex || "#0e42a5").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return `rgba(14,66,165,${op})`;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${op})`;
}

const normalizeDriverName = LLGNames.normalizeName;
const nameCandidates = LLGNames.nameCandidates;

// Casador nome-do-jogo -> piloto do RLT (ver shared/names.js). Refeito
// sempre que a config do RLT muda; resolve os nomes da sessao como conjunto,
// para dois carros nunca receberem o mesmo piloto.
let rltMatcher = null;

function rebuildRltMatcher() {
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
  if (rltMatcher) rltMatcher.prime(latestStandings.map((e) => e.name));
}

function rltLookup(entry) {
  if (!rltMatcher || !entry) return null;
  return rltMatcher.lookup(entry.name || "");
}

function rltDisplayName(entry) {
  const fallback = (entry && entry.name) || "";
  const info = rltLookup(entry);
  if (!info) return fallback;
  if (info.firstName && info.lastName) {
    const full = `${info.firstName} ${info.lastName}`.trim();
    if (full) return full;
  }
  if (info.displayName && String(info.displayName).trim()) return info.displayName;
  if (info.inGameName && String(info.inGameName).trim()) return info.inGameName;
  if (info.driverName && String(info.driverName).trim()) return info.driverName;
  return fallback;
}

function rltEnabled() {
  return !!(rltConfig && rltConfig.classes && rltConfig.classes.length > 0);
}

function countClasses(standings) {
  const set = new Set();
  (standings || []).forEach((e) => {
    if (e.carClass) set.add(e.carClass);
  });
  return set.size;
}

function countCars(standings) {
  const set = new Set();
  (standings || []).forEach((e) => {
    if (e.carName) set.add(e.carName);
  });
  return set.size;
}

// Regra de classe compartilhada com o driver card (shared/groups.js).
// A lista SPLIT_BY_CAR_CLASSES fica em drivers-config.js.
const grouper = LLGGroups.createGrouper({
  rltEnabled: () => rltEnabled(),
  lookup: (entry) => rltLookup(entry),
  splitClasses: typeof SPLIT_BY_CAR_CLASSES !== "undefined" ? SPLIT_BY_CAR_CLASSES : [],
});

function isSplitByCarSession(standings) {
  return grouper.isSplitByCar(standings);
}

function groupKey(entry, standings) {
  return grouper.key(entry, standings);
}

function groupLabel(key) {
  if (rltEnabled() && rltConfig.classes) {
    const c = rltConfig.classes.find((x) => x.uniqueName === key || x.name === key);
    if (c) return c.name || c.uniqueName;
  }
  return key;
}

function activePageModes(standings) {
  if (rltEnabled()) {
    return rltConfig.classes.length > 1 ? PAGE_MODES_ALL : ["Geral"];
  }
  if (isSplitByCarSession(standings)) {
    return countCars(standings) > 1 ? PAGE_MODES_ALL : ["Geral"];
  }
  if (countClasses(standings) <= 1) return ["Geral"];
  return PAGE_MODES_ALL;
}

function currentPageMode(standings) {
  const modes = activePageModes(standings);
  if (pageIndex >= modes.length) pageIndex = 0;
  return modes[pageIndex];
}
// Alturas em px. Precisam bater com timing-table.css:
//   linha  = 43 (min-height) + 3 (border-top) + 3 (gap do #rows) = 49
//   classe = 46 (mesma altura da linha) + 3 (gap)                = 49
// Com 49 px por linha cabem 20 linhas em 1080 px (total real: 1075 px).
const MAX_TABLE_H = 1080;
const TITLE_H = 62; // linha de cima do cabecalho (.title-bar no CSS)
const COL_HEADER_H = 32; // linha de baixo do cabecalho (.header no CSS)
const ROW_H = 49;
const CLASS_HDR_H = 49;
const SAFETY_H = 6; // bordas da tabela (com o cabecalho de 94 px, 20 linhas dao 1075 px)
// Rodape do clima (.weather-bar no CSS, 32 px). Nao tira espaco dos pilotos:
// so aparece quando cabe dentro de MAX_TABLE_H junto com as linhas da tela
// (com 20 pilotos numa classe so, a tabela fica completa e o rodape some).
const FOOTER_H = 32;
let weatherData = false; // o jogo informa o clima (AMS2, LMU)
let rotateTick = 0;
const ROTATE_MS = 10000;

function maxDriverSlots() {
  return Math.max(1, Math.floor((MAX_TABLE_H - TITLE_H - COL_HEADER_H - SAFETY_H) / ROW_H));
}

function pickPageSynced(arr, page, count, maxPages) {
  if (!arr.length || count <= 0) return [];
  if (arr.length <= count) return arr.slice();
  const pages = Math.ceil(arr.length / count);
  const p = maxPages > 0 ? (page % maxPages) : 0;
  if (p >= pages) {
    // ultima pagina da classe ate o ciclo global reiniciar
    const start = (pages - 1) * count;
    return arr.slice(start, start + count);
  }
  const start = p * count;
  return arr.slice(start, start + count);
}

function slotsPerClass(groups) {
  const classes = Object.keys(groups);
  const n = classes.length;
  if (n === 0) return {};

  const available = MAX_TABLE_H - TITLE_H - COL_HEADER_H - SAFETY_H;
  const minCost = n * (CLASS_HDR_H + ROW_H);
  let extra = Math.floor((available - minCost) / ROW_H);
  if (extra < 0) extra = 0;

  const sizes = classes.map((cls) => groups[cls].length);
  const othersNeed = sizes.map((s) => Math.max(0, s - 1));
  const totalOthers = othersNeed.reduce((a, b) => a + b, 0);

  const result = {};
  if (totalOthers === 0 || extra >= totalOthers) {
    classes.forEach((cls, i) => { result[cls] = sizes[i]; });
    return result;
  }

  // distribui extras proporcionalmente; minimo 1 (lider) por classe
  let assigned = 0;
  const extras = classes.map((cls, i) => {
    if (totalOthers === 0) return 0;
    const share = Math.floor((othersNeed[i] / totalOthers) * extra);
    return share;
  });
  assigned = extras.reduce((a, b) => a + b, 0);
  let left = extra - assigned;
  let idx = 0;
  while (left > 0 && totalOthers > 0) {
    if (extras[idx % n] < othersNeed[idx % n]) {
      extras[idx % n] += 1;
      left -= 1;
    }
    idx += 1;
    if (idx > n * extra + 10) break;
  }

  classes.forEach((cls, i) => {
    // total slots na classe = lider + extras (pelo menos 1)
    // se sobrar pouco espaço no geral, limita a 3 (lider+2)
    let slots = 1 + extras[i];
    if (extra < n * 2) slots = Math.min(slots, 3);
    slots = Math.min(slots, sizes[i]);
    slots = Math.max(1, slots);
    result[cls] = slots;
  });
  return result;
}

let latestStandings = [];
let latestGame = "ams2"; // "ams2" ou "lmu" (vem no payload do listener)
let latestSessionLabel = null;
let latestSessionState = null;
let latestLapsInEvent = 0;

function formatLapLabel(currentLap) {
  const lap = currentLap != null ? currentLap : 0;
  if (latestLapsInEvent > 0) return `Volta ${lap}/${latestLapsInEvent}`;
  return `Volta ${lap}`;
}

const SESSION_LABELS = {
  0: "INVÁLIDA",
  1: "TREINO LIVRE",
  2: "TESTE",
  3: "CLASSIFICAÇÃO",
  4: "VOLTA DE FORMAÇÃO",
  5: "CORRIDA",
  6: "TIME ATTACK",
};

function isTimedSession() {
  const st = Number(latestSessionState);
  if (st === 1 || st === 2 || st === 3 || st === 6) return true;
  if (st === 5) return false;
  const lab = (latestSessionLabel || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return /TREINO|CLASSIFICA|TESTE|TIME ATTACK|ATTACK|QUAL/i.test(lab);
}

function isRaceSession() {
  const st = Number(latestSessionState);
  if (st === 5) return true;
  if (st === 1 || st === 2 || st === 3 || st === 6 || st === 4) return false;
  const lab = (latestSessionLabel || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/TREINO|CLASSIFICA|TESTE|TIME ATTACK|ATTACK|QUAL|FORMACAO/i.test(lab)) return false;
  return /CORRIDA/i.test(lab);
}

let lastSessionKey = null;
let trackLengthM = 0;
const gapTracker = LLGGaps.createGapTracker();
const gapSmoother = LLGGaps.createGapSmoother(); // evita o ultimo digito do gap ficar piscando

// Estado que so vale dentro de uma sessao e mora nesta pagina. Largada,
// paradas e bandeiradas ficam no servidor (server/raceState.js).
function resetSessionLocalState() {
  frozenGaps.clear();
  sessionDriverCache.clear();
  gapTracker.reset();
  gapSmoother.reset();
  garageSince.clear();
  sectorTracker.reset();
  lastDisplayPos.clear();
}

// Posicao atual e de largada de cada piloto dentro do proprio grupo (classe).
// A posicao de largada geral vem do servidor em entry.startPosition.
function buildGroupRanks(standings) {
  const groups = {};
  standings.forEach((e) => {
    const key = groupKey(e, standings);
    (groups[key] = groups[key] || []).push(e);
  });
  const cur = new Map();
  const start = new Map();
  Object.values(groups).forEach((list) => {
    list
      .slice()
      .sort((a, b) => a.position - b.position)
      .forEach((e, i) => cur.set(e.name, i + 1));
    list
      .filter((e) => e.startPosition != null)
      .sort((a, b) => a.startPosition - b.startPosition)
      .forEach((e, i) => start.set(e.name, i + 1));
  });
  return { cur, start };
}

function positionChange(entry, isClassMode, ranks) {
  if (entry.startPosition == null) return null;
  if (isClassMode) {
    if (!ranks.start.has(entry.name) || !ranks.cur.has(entry.name)) return null;
    return ranks.start.get(entry.name) - ranks.cur.get(entry.name);
  }
  return entry.startPosition - entry.position;
}

function isSafetyCar(entry) {
  const cls = (entry.carClass || "").toLowerCase();
  const name = (entry.carName || "").toLowerCase();
  return cls === "safetycar" || name.includes("safety");
}

function isObserver(entry) {
  if (!entry.inRace) return false;
  if (entry.lapsCompleted > 0) return false;
  if (entry.pitMode === 4 || entry.pitMode === 2) return true;
  if (entry.raceState === 0 || entry.raceState === 1) return true;
  return false;
}

const sessionDriverCache = new Map();

// Identifica o CARRO de uma linha, para reconhecer troca de piloto: mesma
// vaga na sessao, mesmo modelo e mesmo numero (quando o jogo informa o numero).
// Devolve null se o jogo nao manda a vaga.
function sameCarKey(e) {
  if (e.slot == null) return null;
  return `${e.slot}|${e.carName || ""}|${e.carNumber != null ? e.carNumber : ""}`;
}

function mergeDisconnectedDrivers(standings) {
  if (!isRaceSession()) {
    sessionDriverCache.clear();
    return standings;
  }
  const present = new Set();
  const presentCars = new Set(); // carros na pista agora (ver sameCarKey)
  (standings || []).forEach((e) => {
    if (!e || !e.name) return;
    present.add(e.name);
    const car = sameCarKey(e);
    if (car) presentCars.add(car);
    if (e.name !== "Player" && (e.lapsCompleted > 0 || e.currentLap > 1 || e.position > 0)) {
      sessionDriverCache.set(e.name, Object.assign({}, e));
    }
  });
  const merged = (standings || []).slice();
  sessionDriverCache.forEach((cached, name) => {
    if (present.has(name)) return;
    // Troca de piloto: o nome sumiu, mas o carro dele continua na pista com
    // outro piloto. Nao e abandono: o piloto antigo simplesmente sai da lista.
    const car = sameCarKey(cached);
    if (car && presentCars.has(car)) {
      sessionDriverCache.delete(name);
      return;
    }
    if (!(cached.lapsCompleted > 0 || cached.currentLap > 1)) return;
    merged.push(
      Object.assign({}, cached, {
        inRace: false,
        raceState: 5,
        speedMs: 0,
        disconnected: true,
        _lastPos: cached.position || 999,
        position: 9000 + (cached.position || 999),
      })
    );
  });
  merged.sort(sortRaceOrder);
  return merged;
}

function sortRaceOrder(a, b) {
  const da = isDnf(a) ? 1 : 0;
  const db = isDnf(b) ? 1 : 0;
  if (da !== db) return da - db;
  const pa = da ? (a._lastPos || a.position || 999) : (a.position || 999);
  const pb = db ? (b._lastPos || b.position || 999) : (b.position || 999);
  return pa - pb;
}

function handleStandings(payload) {
  const raw = Array.isArray(payload) ? payload : payload.standings || [];
  const session = Array.isArray(payload) ? null : payload.session;
  latestGame = (!Array.isArray(payload) && payload.game) || "ams2";
  LLGDisplay.applyGameClassNames(raw, latestGame); // classes do LMU com os nomes do drivers-config

  if (session) {
    latestSessionState = typeof session.state === "number" ? session.state : (session.state != null ? Number(session.state) : null);
    if (Number.isNaN(latestSessionState)) latestSessionState = null;
    latestSessionLabel = (latestSessionState != null && SESSION_LABELS[latestSessionState]) || session.label || null;
    latestLapsInEvent = Number(session.lapsInEvent) || 0;
    trackLengthM = Number(session.trackLength) || 0;
    const sessionKey = `${latestSessionState}|${session.trackLocation || ""}|${session.trackVariation || ""}`;
    if (sessionKey !== lastSessionKey) {
      lastSessionKey = sessionKey;
      resetSessionLocalState();
    }
  }

  let standings = raw.filter((e) => !isSafetyCar(e) && !isObserver(e));
  gapTracker.update(standings, (!Array.isArray(payload) && payload.ts) || Date.now());
  sectorTracker.update(standings, (e) => groupKey(e, standings), Date.now());
  if (rltMatcher) rltMatcher.prime(standings.map((e) => e.name));
  standings = mergeDisconnectedDrivers(standings);
  updateStablePlayer(standings);
  standings.forEach((e) => {
    e.isPlayer = isStablePlayer(e);
  });

  latestStandings = standings;
  // fora da sessao o jogo manda a lista vazia: a tabela some (a pontuacao do
  // campeonato, que nao depende do jogo, continua aparecendo se estiver ligada)
  updateSessionVisibility();
  updateSessionHeader(session);
  render(latestStandings);
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

// A pagina de disputas e a pontuacao sao ligadas e desligadas aqui na tabela
// (teclas 9 e 0, fim da corrida, safety car). O driver card troca o que mostra
// conforme a tela da tabela, entao ela avisa pelo WebSocket quando muda e
// repete de tempos em tempos (um card aberto depois tambem fica sabendo).
//   active:    pagina de disputas na tela
//   standings: pontuacao do campeonato na tela
let wsSocket = null;
let battleStateSent = null;

function announceBattleState(force) {
  const active = battleActive();
  const standings = showingStandings();
  const key = `${active}|${standings}`;
  if (!force && key === battleStateSent) return;
  if (!wsSocket || wsSocket.readyState !== 1) return;
  battleStateSent = key;
  wsSocket.send(JSON.stringify({ type: "command", name: "overlay.battleState", payload: { active, standings } }));
}
setInterval(() => announceBattleState(true), 2000);

function connect() {
  const socket = new WebSocket(WS_URL);
  wsSocket = socket;
  socket.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    LLGFrameCap.handle(msg); // limite de FPS do painel
    if (msg.type === "standings") {
      handleStandings(msg.data || []);
    } else if (msg.type === "hello") {
      checkBuildId(msg.buildId);
    } else if (msg.type === "overlayCommand") {
      applyOverlayCommand(msg.name, msg.payload || {});
    } else if (msg.type === "rltConfig") {
      rltConfig = msg.data || null;
      rebuildRltMatcher();
      if (latestStandings.length) render(latestStandings);
    } else if (msg.type === "assetsConfig") {
      logoLoader.setConfig(msg.data || {});
      loadWeatherIcons();
      if (latestStandings.length) render(latestStandings);
    }
  });
  // servidor reiniciando: tenta de novo logo, para a overlay voltar rapido
  socket.addEventListener("close", () => setTimeout(connect, 500));
}

function applyOverlayCommand(name, payload = {}) {
  if (name === "overlay.prevColumn") {
    if (showingStandings()) {
      standingsColumnIndex = (standingsColumnIndex - 1 + STANDINGS_COLUMN_MODES.length) % STANDINGS_COLUMN_MODES.length;
    } else {
      stepRightColumn(-1);
    }
  } else if (name === "overlay.nextColumn") {
    if (showingStandings()) {
      standingsColumnIndex = (standingsColumnIndex + 1) % STANDINGS_COLUMN_MODES.length;
    } else {
      stepRightColumn(1);
    }
  } else if (name === "overlay.prevPage") {
    const modes = activePageModes(latestStandings);
    if (modes.length <= 1) return;
    pageIndex = ((Number(pageIndex) || 0) % modes.length + modes.length - 1) % modes.length;
  } else if (name === "overlay.nextPage") {
    const modes = activePageModes(latestStandings);
    if (modes.length <= 1) return;
    pageIndex = ((Number(pageIndex) || 0) % modes.length + 1) % modes.length;
  } else if (name === "overlay.toggleHighlight") {
    playerHighlightEnabled = !playerHighlightEnabled;
  } else if (name === "overlay.toggleStandings") {
    // alterna o que esta NA TELA: sem temporada com pontuacao, o 0 nao deixa um
    // "ligado" escondido que apareceria sozinho depois
    standingsView = !showingStandings();
  } else if (name === "overlay.setStandings") {
    // define a tela direto (posicoes ou pontuacao), em vez de alternar
    standingsView = !!payload.value;
  } else if (name === "overlay.resetRace") {
    resetSessionLocalState();
  } else if (name === "overlay.setOpacity") {
    const root = document.getElementById("timing-table");
    if (!root) return;
    const v = Math.max(0, Math.min(1, Number(payload.value)));
    if (payload.target === "table") {
      root.style.setProperty("--table-opacity", String(v));
    } else if (payload.target === "rows") {
      root.style.setProperty("--row-opacity", String(v));
    }
    return;
  } else if (name === "overlay.setTeamTint") {
    setTeamTint(payload.value, true);
    return;
  } else if (name === "overlay.setHeat") {
    setHeatOverride(payload);
    if (!showingStandings()) document.getElementById("sessionLabel").textContent = headerSessionLabel(document.getElementById("sessionLabel").textContent);
  } else if (name === "overlay.setBattleScope") {
    setBattleScope(payload.value);
  } else if (name === "overlay.toggleBattles") {
    // pagina de disputas: so liga em corrida e sem safety car
    if (!battleActive() && (!isRaceSession() || latestScOut)) return;
    if (showingStandings()) {
      // com a pontuacao na tela, o 9 sai dela e abre as disputas (antes ligava as
      // disputas escondidas atras da pontuacao, e elas so apareciam com o 0)
      standingsView = false;
      battleMode = true;
    } else {
      battleMode = !battleMode;
    }
  } else if (name === "overlay.setTeamLogo") {
    setTeamLogoOverride(payload.teamName, payload.file || null);
  } else {
    return;
  }
  render(latestStandings);
}

function getLeader() {
  let leader = null;
  latestStandings.forEach((e) => {
    if (!leader || e.position < leader.position) leader = e;
  });
  return leader;
}

// "ULTIMA VOLTA" ou "+2 VOLTAS" (corrida por tempo depois do relogio zerar)
function lapsLeftLabel(n) {
  return n <= 1 ? "ÚLTIMA VOLTA" : `+${n} VOLTAS`;
}

function formatClock(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

// Nomes curtos da sessao para o bloco preto do cabecalho.
const HEADER_SESSION_LABELS = { 1: "TREINO", 2: "TESTE", 3: "QUALI", 4: "FORMAÇÃO", 5: "CORRIDA", 6: "TIME ATTACK" };
const GAME_TITLES = { ams2: "Automobilista 2", lmu: "Le Mans Ultimate", acc: "Assetto Corsa Competizione", ac: "Assetto Corsa" };
let latestTrack = { location: "", variation: "" };
let latestEvent = null; // etapa do RLT que corresponde a pista do jogo (ou null)

// Bateria mostrada no cabecalho ("CORRIDA 2", "QUALI 1"), escolhida no painel:
// null = automatico (pelo que ja tem resultado lancado no RLT), 0 = sem
// numero, outro numero = essa bateria.
const HEAT_KEY = "heatOverride";
let heatOverride = { race: null, quali: null };
try {
  const savedHeat = JSON.parse(localStorage.getItem(HEAT_KEY) || "null");
  if (savedHeat) heatOverride = { race: savedHeat.race != null ? savedHeat.race : null, quali: savedHeat.quali != null ? savedHeat.quali : null };
} catch (_) {}

function setHeatOverride(payload) {
  const clean = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Math.max(0, Math.floor(Number(v))));
  heatOverride = { race: clean(payload && payload.race), quali: clean(payload && payload.quali) };
  try {
    localStorage.setItem(HEAT_KEY, JSON.stringify(heatOverride));
  } catch (_) {}
}

// Nome da sessao para o cabecalho, com o numero da bateria em corrida e quali.
function headerSessionLabel(fallback) {
  const state = Number(latestSessionState);
  const base = HEADER_SESSION_LABELS[state] || fallback;
  if (state !== 5 && state !== 3) return base;
  const heats = latestEvent ? (state === 5 ? latestEvent.races : latestEvent.qualifications) : null;
  const n = LLGDisplay.heatNumber(heats, state === 5 ? heatOverride.race : heatOverride.quali);
  return n ? `${base} ${n}` : base;
}

// Faixa colorida e bloco da pista. Com temporada aplicada, a faixa mostra o
// nome dela ("Campeonato - Temporada 2" vira duas linhas); sem temporada, o
// HEADER_TITLE do drivers-config.js e o nome do jogo.
function updateHeaderBrand() {
  const table = document.getElementById("timing-table");
  if (typeof HEADER_COLOR !== "undefined" && HEADER_COLOR) table.style.setProperty("--header-color", HEADER_COLOR);
  let title = typeof HEADER_TITLE !== "undefined" && HEADER_TITLE ? HEADER_TITLE : "Liga Let's Go";
  let subtitle = GAME_TITLES[latestGame] || "";
  const season = rltConfig && rltConfig.seasonName ? String(rltConfig.seasonName).trim() : "";
  if (season) {
    const parts = season.split(/\s+[-–—|]\s+/);
    title = parts[0];
    subtitle = parts.slice(1).join(" - ");
  }

  // Pista: o nome do jogo, arrumado pelo track-names.js. Com temporada
  // aplicada, se alguma etapa do calendario do RLT for nessa pista, vale o
  // nome que esta no RLT, o pais na segunda linha e o numero da etapa na faixa.
  const track = LLGDisplay.trackDisplay(latestTrack.location, latestTrack.variation);
  const event = season
    ? LLGDisplay.matchEvent(
        rltConfig.events,
        [latestTrack.location, `${latestTrack.location} ${latestTrack.variation}`, track.name, `${track.name} ${track.layout}`],
        Date.now()
      )
    : null;
  latestEvent = event;
  let flag = null;
  if (event) {
    track.name = event.trackName || event.name || track.name;
    const country = LLGDisplay.countryName(event.country);
    if (country) {
      track.layout = country;
      flag = LLGDisplay.flagFile(event.country);
    }
    if (event.round != null) subtitle = [subtitle, `Etapa ${event.round}`].filter(Boolean).join(" · ");
  }
  // bandeira do pais (repositorio de imagens, pasta country/), ao lado do nome
  const flagEl = document.getElementById("trackFlag");
  if (flag) logoLoader.load(flagEl, [flag]);
  else logoLoader.hide(flagEl);
  const titleEl = document.getElementById("headerTitle");
  titleEl.textContent = title;
  // nome comprido: letra menor para caber na faixa sem cortar
  titleEl.style.fontSize = title.length > 34 ? "13px" : title.length > 28 ? "15px" : title.length > 22 ? "18px" : "";
  document.getElementById("headerSubtitle").textContent = subtitle;

  document.getElementById("trackName").textContent = track.name;
  document.getElementById("trackLayout").textContent = track.layout;
  document.querySelector(".tb-country").classList.toggle("empty", !track.layout && !flag);
  document.getElementById("trackTag").classList.toggle("no-track", !track.name);
  updateTrackTag();
}

// A etiqueta da pista fica colada na borda direita da tabela, na altura da
// primeira linha do cabecalho. A tabela pode mudar de lugar (?clock=left).
function updateTrackTag() {
  const table = document.getElementById("timing-table");
  const tag = document.getElementById("trackTag");
  if (!table || !tag) return;
  tag.style.top = `${table.offsetTop}px`;
  tag.style.left = `${table.offsetLeft + table.offsetWidth}px`;
  placeRaceControl();
}

// Clima no rodape: temperatura da pista e do ar e chuva (AMS2 e LMU informam)
function updateWeather(session) {
  const has = typeof session.trackTempC === "number" || typeof session.ambientTempC === "number";
  weatherData = has;
  if (!has) {
    document.getElementById("weatherBar").hidden = true;
    return;
  }
  const t = (v) => (typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(0)}°C` : "—");
  document.getElementById("wbTrack").textContent = t(session.trackTempC);
  document.getElementById("wbAir").textContent = t(session.ambientTempC);
  document.getElementById("wbRain").textContent = typeof session.rain === "number" ? `${Math.round(session.rain * 100)}%` : "—";
}

// mostra o rodape so se ele couber junto com as linhas que estao na tela
function fitWeatherBar() {
  const bar = document.getElementById("weatherBar");
  if (!weatherData) {
    bar.hidden = true;
    return;
  }
  const table = document.getElementById("timing-table");
  const withoutBar = table.offsetHeight - (bar.hidden ? 0 : bar.offsetHeight);
  bar.hidden = withoutBar + FOOTER_H > MAX_TABLE_H;
}

function loadWeatherIcons() {
  [
    ["wbIcTrack", "weather/track_temp.png"],
    ["wbIcAir", "weather/air_temp.png"],
    ["wbIcRain", "weather/rain.png"],
  ].forEach(([id, file]) => {
    const img = document.getElementById(id);
    if (!img.dataset.watch) {
      img.dataset.watch = "1";
      img.addEventListener("load", () => img.parentElement.classList.add("has-icon"));
    }
    img.parentElement.classList.remove("has-icon");
    logoLoader.load(img, [file]);
  });
}

function updateSessionHeader(session) {
  if (!session) return;
  updateWeather(session);
  latestTrack = { location: session.trackLocation || "", variation: session.trackVariation || "" };
  stintLimitMin = Number(session.stintLimitMin) || 0;
  updateHeaderBrand(); // define a etapa (latestEvent), usada no numero da bateria
  const label = headerSessionLabel(latestSessionLabel || SESSION_LABELS[session.state] || session.label || "CORRIDA");
  document.getElementById("sessionLabel").textContent = label;

  const timerEl = document.getElementById("sessionTimer");
  const leader = getLeader();

  if (isRaceSession()) {
    if (leader && leader.raceState === 3) {
      timerEl.textContent = "FIM";
    } else if (latestLapsInEvent > 0) {
      const leadLap = leader ? (leader.currentLap || 0) : 0;
      if (leadLap >= latestLapsInEvent) {
        timerEl.textContent = "ÚLTIMA VOLTA";
      } else {
        timerEl.textContent = `Volta ${leadLap}/${latestLapsInEvent}`;
      }
    } else if (session.lapsLeft != null) {
      // corrida por tempo com o relogio zerado: as voltas que o lider ainda faz (servidor)
      timerEl.textContent = lapsLeftLabel(session.lapsLeft);
    } else {
      const totalSeconds = typeof session.timeRemainingSec === "number" ? session.timeRemainingSec : 0;
      timerEl.textContent = formatClock(totalSeconds);
    }
  } else {
    const totalSeconds = typeof session.timeRemainingSec === "number" ? session.timeRemainingSec : 0;
    timerEl.textContent = formatClock(totalSeconds);
  }

  const table = document.getElementById("timing-table");
  if (table) table.classList.toggle("sc-out", !!(session.scOut || session.fcy));
  latestScOut = !!(session.scOut || session.fcy);
  raceControl.update(session);
}

// Safety car / FCY: painel e etiqueta em shared/racecontrol.js
const RC_MIN_PANEL_H = 640; // o painel e mais alto que uma tabela com poucos carros
const raceControl = LLGRaceControl.create({
  place: placeRaceControl,
  onUpdate: (active) => document.getElementById("trackTag").classList.toggle("rc-joined", active),
});

function placeRaceControl() {
  const table = document.getElementById("timing-table");
  const panel = document.getElementById("rcPanel");
  const tag = document.getElementById("rcTag");
  const track = document.getElementById("trackTag");
  if (!table) return;
  if (!panel.hidden) {
    const titleH = table.querySelector(".title-bar").offsetHeight + 2; // + a borda de cima
    panel.style.top = `${table.offsetTop + titleH}px`;
    panel.style.left = `${table.offsetLeft}px`;
    panel.style.width = `${table.offsetWidth}px`;
    panel.style.setProperty("--rc-h", `${Math.max(table.offsetHeight - titleH, RC_MIN_PANEL_H)}px`);
  }
  if (!tag.hidden) {
    const hasTrack = !track.classList.contains("no-track") && !track.classList.contains("rc-joined");
    tag.style.top = `${table.offsetTop}px`;
    tag.style.left = `${table.offsetLeft + table.offsetWidth + (hasTrack ? track.offsetWidth : 0)}px`;
  }
}

// Nome e cor de classe e arquivos de logo: regras compartilhadas com o
// driver card (shared/display.js).
const formatClassName = LLGDisplay.formatClassName;

const normalizeColor = LLGColors.normalizeColor;

function classColor(carClass) {
  return LLGDisplay.classColor(carClass, rltEnabled() ? rltConfig.classes : null);
}

// Texto preto ou branco sobre uma cor: a mesma regra das linhas de disputa e
// das outras overlays (shared/colors.js), para o numero da posicao e o nome
// do piloto nunca ficarem um branco e o outro preto na mesma cor.
function contrastText(bg) {
  return bg ? LLGColors.readableOnColor(bg) : "#fff";
}

function sortByTiming(a, b) {
  if (isRaceSession()) return sortRaceOrder(a, b);
  const da = isDnf(a) ? 1 : 0;
  const db = isDnf(b) ? 1 : 0;
  if (da !== db) return da - db;
  const fa = a.fastestLapMs > 0 ? a.fastestLapMs : Infinity;
  const fb = b.fastestLapMs > 0 ? b.fastestLapMs : Infinity;
  if (fa !== fb) return fa - fb;
  return (a.position || 999) - (b.position || 999);
}

// Nao existe campo na Shared Memory que diga "estou so' assistindo" --
// so' temos qual carro a camera esta olhando (que e' o mesmo se voce esta
// pilotando ou so' espectando). Por isso o destaque de "voce" e' opcional:
// aperte "p" pra ligar/desligar quando estiver so' assistindo.
let playerHighlightEnabled = true;

let stablePlayerName = null;
let stablePlayerClass = null;
let pendingPlayerName = null;
let pendingPlayerSince = 0;
// Troca de piloto em foco: vale assim que duas leituras seguidas do jogo
// concordam (~0,13 s cada). Uma leitura isolada e ignorada, para a camera
// passando por outro carro nao fazer o destaque piscar.
const PLAYER_STABLE_MS = 100;

function updateStablePlayer(standings) {
  const viewed = standings.find((e) => e.isPlayer);
  const name = viewed ? viewed.name : null;
  const cls = viewed ? viewed.carClass : null;
  const now = Date.now();

  // primeira detecção: assume imediatamente
  if (!stablePlayerName && name) {
    stablePlayerName = name;
    stablePlayerClass = cls;
    pendingPlayerName = null;
    return;
  }

  if (name && name === stablePlayerName) {
    pendingPlayerName = null;
    if (cls) stablePlayerClass = cls;
    return;
  }

  if (!name) {
    // perda momentanea do viewedIndex — mantem o ultimo estavel
    pendingPlayerName = null;
    return;
  }

  // mudanca de piloto: so aplica quando a leitura seguinte confirma
  if (name === pendingPlayerName) {
    if (now - pendingPlayerSince >= PLAYER_STABLE_MS) {
      stablePlayerName = name;
      stablePlayerClass = cls || stablePlayerClass;
      pendingPlayerName = null;
    }
    return;
  }

  pendingPlayerName = name;
  pendingPlayerSince = now;
}

function isStablePlayer(entry) {
  if (stablePlayerName) return entry.name === stablePlayerName;
  return !!entry.isPlayer;
}

function getStablePlayerClass(standings) {
  if (stablePlayerClass) return stablePlayerClass;
  const viewed = standings.find((e) => e.isPlayer);
  return viewed ? viewed.carClass : null;
}

// Fonte online primeiro, pasta local overlay/assets como reserva.
const logoLoader = LLGLogos.createLoader("assets");

// Logo da linha: o da equipe se existir, senao o da montadora.
// variant: "light" ou "dark" para pedir a versao do logo feita para aquele
// fundo (ver logoPaths em shared/display.js); sem ela, o logo normal.
function applyLogo(img, teamName, carName, variant) {
  if (!img) return;
  logoLoader.load(img, LLGDisplay.logoPaths(teamName, carName, teamLogoOverrides, variant));
}

let teamLogoOverrides = {};
try {
  const saved = localStorage.getItem("teamLogoOverrides");
  if (saved) teamLogoOverrides = JSON.parse(saved) || {};
} catch (_) {}

function setTeamLogoOverride(teamName, file) {
  if (!teamName) return;
  if (file) teamLogoOverrides[teamName] = file;
  else delete teamLogoOverrides[teamName];
  try {
    localStorage.setItem("teamLogoOverrides", JSON.stringify(teamLogoOverrides));
  } catch (_) {}
}

function rltTeamName(entry) {
  const info = rltLookup(entry);
  if (info && info.teamName) return info.teamName;
  if (rltConfig && Array.isArray(rltConfig.standingsRows)) {
    const keys = nameCandidates(entry.name || "").filter(Boolean);
    for (const row of rltConfig.standingsRows) {
      const rowKeys = [
        normalizeDriverName(row.displayName),
        normalizeDriverName(row.driverName),
        ...(row.aliases || []),
      ].filter(Boolean);
      if (keys.some((k) => rowKeys.includes(k)) && row.teamName) return row.teamName;
    }
  }
  return null;
}

const EMPTY_PIT = { phase: null, elapsedMs: null, stops: 0, stintLaps: 0, outLap: false };

// Paradas, stint e tempo de box sao calculados no servidor (server/raceState.js),
// para todos os carros e nao so para as linhas visiveis.
function pitInfo(entry) {
  return entry.pit || EMPTY_PIT;
}

function lapsBehindText(n) {
  return { text: n === 1 ? "+1 volta" : `+${n} voltas`, cls: "" };
}

// Diferenca na bandeirada, quando os dois ja terminaram. Usa o instante
// registrado pelo servidor, entao continua valendo depois de um reload.
function finishGap(entry, ref) {
  if (!ref || ref === entry || entry.raceState !== 3 || ref.raceState !== 3) return null;
  if (!entry.finishedAtMs || !ref.finishedAtMs) return null;
  const lapDiff = (ref.lapsCompleted || 0) - (entry.lapsCompleted || 0);
  if (lapDiff > 0) return lapsBehindText(lapDiff);
  const sec = Math.max(0, entry.finishedAtMs - ref.finishedAtMs) / 1000;
  return { text: `+${sec.toFixed(1)}`, cls: "" };
}

// Gap de corrida de `entry` para `ref` (carro da frente ou lider do grupo).
// Medido por tempo (shared/gaps.js): quanto faz que `ref` passou onde `entry` esta.
function raceGap(entry, ref) {
  if (!ref || ref === entry) return { text: "Líder", cls: "" };
  const g = gapTracker.gap(entry.name, ref.name, trackLengthM);
  if (g) {
    if (g.laps) return lapsBehindText(g.laps);
    return { text: `+${gapSmoother.value(`${entry.name}>${ref.name}`, g.sec).toFixed(1)}`, cls: "" };
  }

  // sem historico ainda (overlay recem-aberta): estimativa distancia/velocidade
  if (typeof ref.totalDistance !== "number" || typeof entry.totalDistance !== "number") return { text: "-", cls: "" };
  const behind = ref.totalDistance - entry.totalDistance;
  if (behind <= 0) return { text: "+0.0", cls: "" };
  if (trackLengthM > 0 && behind >= trackLengthM) return lapsBehindText(Math.floor(behind / trackLengthM));
  if (!entry.speedMs || entry.speedMs < 2) return { text: "-", cls: "" };
  return { text: `+${(behind / entry.speedMs).toFixed(1)}`, cls: "" };
}

// AMS2: na primeira volta a distancia percorrida que o jogo informa nao serve
// (ela volta para tras quando o carro cruza a linha na largada), entao o
// intervalo so aparece a partir da segunda volta. Nos outros jogos a distancia
// vale desde a largada e o intervalo aparece logo.
function firstLapWithoutGap(entry) {
  return latestGame === "ams2" && (!entry.lapsCompleted || entry.currentLap <= 1);
}

function formatLeaderGap(entry, bestFastestMs) {
  if (!isRaceSession()) return formatQualGap(entry, bestFastestMs);
  if (firstLapWithoutGap(entry)) return { text: "-", cls: "" };
  return raceGap(entry, entry._leader);
}

// entry._ahead e entry._leader sao preenchidos em render() (carro da frente
// e lider, no geral ou dentro da classe conforme a pagina).
function rightColumnValue(entry, change, bestFastestMs, aheadFastestMs) {
  if (isDnf(entry)) return { text: "DNF", cls: "pos-down" };

  const mode = RIGHT_COLUMN_MODES[rightColumnIndex];
  const pit = pitInfo(entry);
  if (mode === "Pneus") return { text: "", html: tyreBadges(entry).html, cls: "tyres", pitPhase: pit.phase };
  const raceGapMode = isRaceSession() && (mode === "Intervalo" || mode === "Gap líder");

  if (raceGapMode && (pit.phase === "in" || pit.phase === "out")) {
    return { text: formatPitDuration(pit.elapsedMs || 0), cls: "pit-time", pitPhase: pit.phase };
  }

  const freezeKey = `${entry.name}|${mode}`;
  if (raceGapMode && entry.raceState === 3) {
    const frozen =
      frozenGaps.get(freezeKey) || finishGap(entry, mode === "Intervalo" ? entry._ahead : entry._leader);
    if (frozen) {
      frozenGaps.set(freezeKey, { text: frozen.text, cls: frozen.cls || "" });
      return { text: frozen.text, cls: frozen.cls || "" };
    }
  }

  let result;
  if (mode === "Intervalo") {
    result = formatGap(entry, change, aheadFastestMs);
  } else if (mode === "Gap líder") {
    result = formatLeaderGap(entry, bestFastestMs);
  } else if (mode === "Última volta") {
    result = { text: entry.lastLapMs ? formatTime(entry.lastLapMs) : "--:--.---", cls: "" };
  } else if (mode === "Melhor volta") {
    result = { text: entry.fastestLapMs ? formatTime(entry.fastestLapMs) : "--:--.---", cls: "" };
  } else if (mode === "Posições") {
    result = formatPosChange(change);
  } else if (mode === "Paradas") {
    result = { text: String(pit.stops), cls: "" };
  } else if (mode === "Stint") {
    result = stintValue(pit);
  } else if (mode === "VMax") {
    result = { text: entry.maxSpeedKmh != null ? `${Math.round(entry.maxSpeedKmh)}` : "-", cls: "" };
  } else {
    result = { text: "-", cls: "" };
  }

  if (pit.phase) result.pitPhase = pit.phase;
  if (raceGapMode && result.text && result.text !== "-") {
    // guarda o ultimo valor valido: e o que fica na tela depois da bandeirada
    if (entry.raceState !== 3 || !frozenGaps.has(freezeKey)) {
      frozenGaps.set(freezeKey, { text: result.text, cls: result.cls || "" });
    }
  }
  return result;
}

// Coluna "Stint". Normalmente e o numero de voltas desde a ultima parada. No
// ACC, com tempo maximo de stint definido no painel (aba ACC), passa a ser um
// cronometro do stint ("23:41"), contando desde a largada ou a ultima saida do
// box: amarelo nos ultimos 5 minutos antes do limite, vermelho quando estoura.
let stintLimitMin = 0;
const STINT_WARN_MIN = 5;

// milissegundos -> "m:ss" (ou "h:mm:ss" depois de uma hora)
function formatStopwatch(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function stintValue(pit) {
  if (!(stintLimitMin > 0) || latestGame !== "acc" || typeof pit.stintMs !== "number") {
    return { text: String(pit.stintLaps), cls: "" };
  }
  const minutes = pit.stintMs / 60000;
  const cls = minutes >= stintLimitMin ? "stint-over" : minutes >= stintLimitMin - STINT_WARN_MIN ? "stint-warn" : "";
  return { text: formatStopwatch(pit.stintMs), cls: `stint-clock ${cls}`.trim() };
}

const frozenGaps = new Map(); // nome|modo -> { text, cls }
const garageSince = new Map();
// Parciais de cada carro e a cor de cada uma: mesma regra do driver card
// (shared/sectors.js). Roxo melhor da classe, verde melhor do piloto, amarelo
// pior, vermelho volta invalidada.
const sectorTracker = LLGSectors.createSectorTracker();
const lastDisplayPos = new Map();

function isOutLap(entry) {
  return isInPit(entry) || isExitingPit(entry) || pitInfo(entry).outLap;
}

function isInPit(entry) {
  // 1=entrando, 2=no pitlane, 4=garagem
  return entry.pitMode === 1 || entry.pitMode === 2 || entry.pitMode === 4;
}

function isExitingPit(entry) {
  // 3=saindo do pit, 5=saindo da garagem
  return entry.pitMode === 3 || entry.pitMode === 5;
}

function formatPitDuration(ms) {
  const totalSec = ms / 1000;
  if (totalSec < 60) return totalSec.toFixed(1) + "s";
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function isDnf(entry) {
  if (entry.disconnected) return true;
  if (entry.raceState === 6 || entry.raceState === 5 || entry.raceState === 4) return true;
  if (!entry.inRace || entry.lapsCompleted < 1) return false;
  if (entry.pitMode !== 4) {
    garageSince.delete(entry.name);
    return false;
  }
  const now = Date.now();
  if (!garageSince.has(entry.name)) garageSince.set(entry.name, now);
  return now - garageSince.get(entry.name) >= 120000;
}

function formatPosChange(change) {
  if (change === null || change === undefined) return { text: "-", cls: "" };
  if (change === 0) return { text: "=", cls: "pos-eq" };
  if (change > 0) return { text: `▲${change}`, cls: "pos-up" };
  return { text: `▼${Math.abs(change)}`, cls: "pos-down" };
}

function formatQualGap(entry, refFastestMs) {
  const mine = Number(entry.fastestLapMs);
  if (!mine || mine <= 0) {
    const last = Number(entry.lastLapMs);
    if (last > 0) return { text: formatTime(last), cls: "" };
    return { text: "-", cls: "" };
  }
  const ref = Number(refFastestMs);
  if (!ref || ref <= 0) {
    return { text: formatTime(mine), cls: "fastest-gap" };
  }
  const delta = mine - ref;
  if (delta <= 0) return { text: formatTime(mine), cls: "fastest-gap" };
  return { text: `+${(delta / 1000).toFixed(3)}`, cls: "" };
}

function formatGap(entry, change, aheadFastestMs) {
  if (isDnf(entry)) return { text: "DNF", cls: "pos-down" };

  if (isTimedSession() || !isRaceSession()) {
    return formatQualGap(entry, aheadFastestMs);
  }

  if (firstLapWithoutGap(entry)) return formatPosChange(change);

  // o lider (geral ou da classe, conforme a pagina) nao tem intervalo:
  // mostra a volta em que ele esta
  if (!entry._ahead || entry._ahead === entry) return { text: `Volta ${entry.currentLap || (entry.lapsCompleted || 0) + 1}`, cls: "" };

  return raceGap(entry, entry._ahead);
}

function pickRotated(arr, page, count, maxPages) {
  if (maxPages != null) return pickPageSynced(arr, page, count, maxPages);
  if (!arr.length || count <= 0) return [];
  if (arr.length <= count) return arr.slice();
  const pages = Math.ceil(arr.length / count);
  const p = ((page % pages) + pages) % pages;
  const start = p * count;
  return arr.slice(start, start + count);
}

// Top 10 fixo; o resto do grid roda em paginas no espaco que sobra.
function paginateFixedTop(ordered) {
  const maxSlots = maxDriverSlots();
  if (ordered.length <= maxSlots) return ordered;
  const fixedCount = Math.min(10, ordered.length);
  const fixed = ordered.slice(0, fixedCount);
  const rest = ordered.slice(fixedCount);
  const extraSlots = Math.max(0, maxSlots - fixedCount);
  if (extraSlots <= 0 || rest.length === 0) return fixed;
  // pagina de disputas: se ha disputa nesta parte, ela fica travada nela
  const lock = battleActive() ? LLGBattles.battleWindowStart(rest.map(isBattleItem), extraSlots, rotateTick) : null;
  const picked = lock !== null ? rest.slice(lock, lock + extraSlots) : pickRotated(rest, rotateTick, extraSlots);
  const rotated = picked.map((item) => ({ ...item, rotating: true }));
  while (rotated.length < extraSlots) rotated.push({ type: "spacer" });
  return fixed.concat(rotated);
}

// Multiclasse: cabecalho da classe, lideres fixos e o resto rodando em
// paginas sincronizadas entre as classes.
//   groups:   { chave: [itens crus] }
//   toItems:  ordena os itens crus e devolve [{ type: "row", ... }]
//   headerFor: devolve o item de cabecalho da classe
function paginateByClass(classKeys, groups, toItems, headerFor) {
  const perClass = slotsPerClass(groups);
  const split = (cls) => {
    const slots = perClass[cls] || 1;
    const fixedCount = Math.max(1, Math.ceil(slots / 2));
    return { slots, fixedCount, extraSlots: Math.max(0, slots - fixedCount) };
  };

  let maxPages = 1;
  classKeys.forEach((cls) => {
    const { fixedCount, extraSlots } = split(cls);
    const rest = Math.max(0, groups[cls].length - fixedCount);
    if (extraSlots > 0 && rest > extraSlots) maxPages = Math.max(maxPages, Math.ceil(rest / extraSlots));
  });

  const list = [];
  classKeys.forEach((cls) => {
    list.push(headerFor(cls));
    const sorted = toItems(groups[cls]);
    if (sorted.length === 0) return;
    const { slots, fixedCount, extraSlots } = split(cls);

    if (sorted.length <= slots) {
      sorted.forEach((item) => list.push(item));
      for (let n = sorted.length; n < slots; n++) list.push({ type: "spacer" });
      return;
    }

    sorted.slice(0, fixedCount).forEach((item) => list.push(item));
    if (extraSlots > 0) {
      const restOfClass = sorted.slice(fixedCount);
      const lock = battleActive() ? LLGBattles.battleWindowStart(restOfClass.map(isBattleItem), extraSlots, rotateTick) : null;
      const page = lock !== null ? restOfClass.slice(lock, lock + extraSlots) : pickRotated(restOfClass, rotateTick, extraSlots, maxPages);
      page.forEach((item) => list.push({ ...item, rotating: true }));
      for (let n = page.length; n < extraSlots; n++) list.push({ type: "spacer" });
    }
  });
  return list;
}

function buildDisplayList(standings) {
  const mode = currentPageMode(standings);

  function withAhead(rows) {
    let prevFast = null;
    return rows.map((item) => {
      if (item.type !== "row") {
        if (item.type !== "spacer") prevFast = null;
        return item;
      }
      item.aheadFastestMs = prevFast;
      const f = Number(item.entry.fastestLapMs);
      if (f > 0) prevFast = f;
      return item;
    });
  }

  if (mode === "Geral") {
    let ordered;
    if (!isRaceSession()) {
      ordered = standings.slice().sort(sortByTiming).map((e, i) => ({ type: "row", entry: e, displayPosition: i + 1 }));
    } else {
      ordered = standings
        .slice()
        .sort(sortRaceOrder)
        .map((e, i) => ({
          type: "row",
          entry: e,
          displayPosition: isDnf(e) ? e._lastPos || e.position || i + 1 : e.position || i + 1,
        }));
    }
    return withAhead(paginateFixedTop(ordered));
  }

  if (mode === "Multiclasse") {
    const groups = {};
    standings.forEach((e) => {
      const key = groupKey(e, standings);
      (groups[key] = groups[key] || []).push(e);
    });

    return withAhead(
      paginateByClass(
        Object.keys(groups),
        groups,
        (list) => list.slice().sort(sortByTiming).map((e, i) => ({ type: "row", entry: e, displayPosition: i + 1 })),
        (cls) => ({ type: "header", label: cls })
      )
    );
  }

  if (mode === "Minha classe") {
    const me = standings.find((e) => isStablePlayer(e));
    let myKey = null;
    let matchFn = null;
    if (rltEnabled() && me) {
      myKey = groupKey(me, standings);
      matchFn = (e) => groupKey(e, standings) === myKey;
    } else if (isSplitByCarSession(standings)) {
      myKey = me && me.carName;
      matchFn = (e) => e.carName === myKey;
    } else {
      myKey = getStablePlayerClass(standings);
      matchFn = (e) => e.carClass === myKey;
    }
    if (!myKey) return [];
    const ordered = standings
      .filter(matchFn)
      .slice()
      .sort(sortByTiming)
      .map((e, i) => ({ type: "row", entry: e, displayPosition: i + 1 }));
    return withAhead(paginateFixedTop(ordered));
  }

  return [];
}

function currentPageLabel(standings) {
  const mode = currentPageMode(standings);
  if (mode === "Minha classe") {
    if (rltEnabled()) {
      const me = (standings || []).find((e) => isStablePlayer(e));
      const info = me ? rltLookup(me) : null;
      if (info && (info.name || info.uniqueName)) return info.name || info.uniqueName;
    }
    if (isSplitByCarSession(standings)) {
      const me = standings.find((e) => isStablePlayer(e));
      return (me && me.carName) || "Minha classe";
    }
    const cls = getStablePlayerClass(standings);
    return (cls && formatClassName(cls)) || "Minha classe";
  }
  return mode;
}

let standingsView = false; // pontuacao pedida (tecla 0, painel ou alternancia automatica)

// Fora da sessao (sem carros) a tabela some, menos com a pontuacao na tela.
function updateSessionVisibility() {
  document.body.classList.toggle("no-session", !latestStandings.length && !showingStandings());
}

// A tela de pontuacao so existe com temporada do RLT aplicada. Sem ela, o
// pedido e ignorado e a tabela de tempos continua na tela.
function showingStandings() {
  return standingsView && !!(rltConfig && rltConfig.standingsRows && rltConfig.standingsRows.length);
}
const STANDINGS_COLUMN_MODES = ["Pts", "Pts proj.", "Gap líder"];
let standingsColumnIndex = 0;
const RACE_POINTS_FALLBACK = [45, 38, 32, 27, 23, 20, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5];

// Tabela de pontos da temporada selecionada (indice 0 = P1). Configurada em
// drivers-config.js: RACE_POINTS_BY_SEASON por nome/id da season, ou RACE_POINTS_DEFAULT.
function racePointsTable() {
  if (typeof RACE_POINTS_BY_SEASON !== "undefined" && RACE_POINTS_BY_SEASON && rltConfig) {
    const t = RACE_POINTS_BY_SEASON[rltConfig.seasonName] || RACE_POINTS_BY_SEASON[String(rltConfig.seasonId)];
    if (Array.isArray(t)) return t;
  }
  if (typeof RACE_POINTS_DEFAULT !== "undefined" && Array.isArray(RACE_POINTS_DEFAULT)) return RACE_POINTS_DEFAULT;
  return RACE_POINTS_FALLBACK;
}

function racePointsForPos(pos) {
  if (!pos || pos < 1) return 0;
  return Number(racePointsTable()[pos - 1]) || 0;
}

function formatPosDelta(n) {
  if (n == null || n === 0) return { text: "=", cls: "" };
  if (n > 0) return { text: `▲${n}`, cls: "pos-up" };
  return { text: `▼${Math.abs(n)}`, cls: "pos-down" };
}

function liveRacePosByDriver(standings, classMode) {
  const map = new Map();
  if (!standings || !standings.length) return map;
  if (classMode) {
    const groups = {};
    standings.forEach((e) => {
      const k = groupKey(e, standings);
      (groups[k] = groups[k] || []).push(e);
    });
    Object.values(groups).forEach((list) => {
      list
        .filter((e) => !isDnf(e)) // quem abandonou nao projeta pontos
        .sort((a, b) => a.position - b.position)
        .forEach((e, i) => {
          const racePos = i + 1;
          const info = rltLookup(e);
          map.set(normalizeDriverName(e.name), racePos);
          if (info) {
            map.set(normalizeDriverName(info.displayName || ""), racePos);
            (info.aliases || []).forEach((a) => map.set(a, racePos));
          }
        });
    });
  } else {
    standings.forEach((e) => {
      if (isDnf(e)) return; // quem abandonou nao projeta pontos
      const racePos = e.position;
      const info = rltLookup(e);
      map.set(normalizeDriverName(e.name), racePos);
      if (info) {
        map.set(normalizeDriverName(info.displayName || ""), racePos);
        (info.aliases || []).forEach((a) => map.set(a, racePos));
      }
    });
  }
  return map;
}

function lookupLivePos(row, liveMap) {
  const keys = [
    normalizeDriverName(row.displayName),
    normalizeDriverName(row.driverName),
    ...(row.aliases || []),
  ];
  for (const k of keys) {
    if (k && liveMap.has(k)) return liveMap.get(k);
  }
  return null;
}

function assistedClassKey(standings) {
  const me = (standings || []).find((e) => isStablePlayer(e));
  if (!me) return null;
  const info = rltLookup(me);
  if (info) return info.uniqueName || info.name;
  return null;
}

function classStandingPos(r) {
  return r.classPosition != null ? r.classPosition : r.position || 999;
}

// Nomes (normalizados) de quem esta na sessao atual: o nome do jogo e, se o
// piloto foi reconhecido, o nome dele no RLT. Inclui quem ja abandonou.
function livePresenceKeys(standings) {
  const keys = new Set();
  (standings || []).forEach((e) => {
    const own = normalizeDriverName(e.name);
    if (own) keys.add(own);
    const info = rltLookup(e);
    if (!info) return;
    [info.displayName, info.driverName].forEach((v) => {
      const n = normalizeDriverName(v);
      if (n) keys.add(n);
    });
  });
  return keys;
}

// A pontuacao so lista quem ja pontuou no campeonato ou esta na sessao atual.
// (O RLT manda tambem os inscritos que nunca correram, com 0 ponto.)
function standingsRowsToShow(standings) {
  const rows = (rltConfig && rltConfig.standingsRows) || [];
  const present = livePresenceKeys(standings);
  return rows.filter((r) => {
    if (Number(r.pointsRaw) > 0 || Number(r.classPointsRaw) > 0) return true;
    return [r.displayName, r.driverName, r.inGameName].some((v) => {
      const n = normalizeDriverName(v);
      return n && present.has(n);
    });
  });
}

// Ordem da tela de pontuacao. Na corrida, a ordem e a da pista (posicao ao
// vivo, na classe quando a pagina e por classe), e o numero da linha e essa
// posicao; quem pontuou no campeonato mas nao esta nesta corrida vai para o
// fim, sem numero. Fora da corrida, a ordem do campeonato.
function standingsOrder(list, classMode, standings) {
  const champ = (r) => (classMode ? classStandingPos(r) : r.position || 999);
  const live = isRaceSession() && standings && standings.length ? liveRacePosByDriver(standings, classMode) : null;
  const racePos = new Map(list.map((r) => [r, live ? lookupLivePos(r, live) : null]));
  return list
    .slice()
    .sort((a, b) => {
      const pa = racePos.get(a);
      const pb = racePos.get(b);
      if (live && (pa != null || pb != null)) {
        if (pa == null) return 1;
        if (pb == null) return -1;
        if (pa !== pb) return pa - pb;
      }
      return champ(a) - champ(b);
    })
    .map((r) => ({ row: r, position: live ? (racePos.get(r) != null ? racePos.get(r) : "–") : champ(r) }));
}

function buildStandingsDisplayList(standings) {
  const rows = standingsRowsToShow(standings);
  if (!rows.length) return [];
  const mode = currentPageMode(standings);

  function asItems(list, classMode) {
    const ordered = standingsOrder(list, classMode, standings).map((o) => ({
      type: "row",
      row: o.row,
      displayPosition: o.position,
      classMode: !!classMode,
    }));
    return paginateFixedTop(ordered);
  }

  if (mode === "Multiclasse") {
    const groups = {};
    rows.forEach((r) => {
      const k = r.classUniqueName || r.className || "—";
      if (k === "—") return;
      (groups[k] = groups[k] || []).push(r);
    });
    const classKeys = Object.keys(groups).sort((a, b) => {
      const na = (groups[a][0] && groups[a][0].className) || a;
      const nb = (groups[b][0] && groups[b][0].className) || b;
      return String(na).localeCompare(String(nb));
    });
    return paginateByClass(
      classKeys,
      groups,
      (list) =>
        isRaceSession()
          ? standingsOrder(list, true, standings).map((o) => ({ type: "row", row: o.row, displayPosition: o.position, classMode: true }))
          : list
              .slice()
              .sort((a, b) => classStandingPos(a) - classStandingPos(b))
              .map((r, i) => ({ type: "row", row: r, displayPosition: i + 1, classMode: true })),
      (k) => ({ type: "header", label: k, title: groups[k][0].className || k, color: groups[k][0].color })
    );
  }

  if (mode === "Minha classe") {
    const myKey = assistedClassKey(standings);
    if (!myKey) return asItems(rows, false);
    const filtered = rows.filter((r) => r.classUniqueName === myKey || r.className === myKey);
    return asItems(filtered, true);
  }

  return asItems(rows, false);
}

function renderStandings(standings) {
  const container = document.getElementById("rows");
  const pageLabel = document.getElementById("pageLabel");
  const rightLabel = document.getElementById("rightColumnLabel");
  const sessionLabel = document.getElementById("sessionLabel");
  const timerEl = document.getElementById("sessionTimer");

  // tela de pontuacao: o nome da temporada ja esta na faixa colorida, e o
  // relogio da sessao some
  sessionLabel.textContent = "PONTOS";
  timerEl.textContent = "";
  updateHeaderBrand();
  pageLabel.textContent = currentPageLabel(standings);
  const colMode = STANDINGS_COLUMN_MODES[standingsColumnIndex];
  rightLabel.textContent = colMode;
  document.getElementById("timing-table").classList.toggle("wide-right", colMode === "Pts proj.");

  const classMode = currentPageMode(standings) !== "Geral";
  const liveMap = liveRacePosByDriver(standings, classMode);
  const displayList = buildStandingsDisplayList(standings);

  const inRace = isRaceSession();
  const roundNow = LLGPoints.currentRound((rltConfig && rltConfig.events) || [], latestEvent, Date.now());
  const projected = new Map();
  displayList.forEach((item) => {
    if (item.type !== "row") return;
    const base = item.classMode
      ? Number(item.row.classPointsRaw != null ? item.row.classPointsRaw : item.row.pointsRaw) || 0
      : Number(item.row.pointsRaw) || 0;
    const racePos = lookupLivePos(item.row, liveMap);
    const add = inRace && racePos ? racePointsForPos(racePos) : 0;
    // com descarte, a conta e refeita etapa por etapa (overlay/shared/points.js)
    const total = inRace ? LLGPoints.projectedTotal(item.row, add, roundNow, item.classMode) : base;
    projected.set(item.row, { base, add: total - base, total, racePos });
  });

  // ranking atual vs projetado por grupo
  const rankDelta = new Map();
  {
    const groups = {};
    displayList.forEach((item) => {
      if (item.type !== "row") return;
      const g = item.classMode ? item.row.classUniqueName || "—" : "_all";
      (groups[g] = groups[g] || []).push(item);
    });
    Object.values(groups).forEach((items) => {
      const score = (r, key) => {
        const p = projected.get(r) || {};
        const v = Number(p[key]);
        return Number.isFinite(v) ? v : 0;
      };
      const byBase = items.slice().sort((a, b) => score(b.row, "base") - score(a.row, "base"));
      const byProj = items.slice().sort((a, b) => score(b.row, "total") - score(a.row, "total"));
      const curRank = new Map();
      const projRank = new Map();
      byBase.forEach((it, i) => curRank.set(it.row, i + 1));
      byProj.forEach((it, i) => projRank.set(it.row, i + 1));
      items.forEach((it) => {
        rankDelta.set(it.row, (curRank.get(it.row) || 0) - (projRank.get(it.row) || 0));
      });
    });
  }

  const leaderByGroup = new Map();
  if (colMode === "Gap líder") {
    let overallLeader = 0;
    displayList.forEach((item) => {
      if (item.type !== "row") return;
      const pts = (projected.get(item.row) || {}).total || 0;
      const g = classMode ? item.row.classUniqueName || "—" : "_all";
      const cur = leaderByGroup.get(g) || 0;
      if (pts > cur) leaderByGroup.set(g, pts);
      if (pts > overallLeader) overallLeader = pts;
    });
    if (!classMode) leaderByGroup.set("_all", overallLeader);
  }

  while (container.children.length > displayList.length) {
    container.removeChild(container.lastChild);
  }

  const me = (standings || []).find((e) => isStablePlayer(e));
  const meInfo = me ? rltLookup(me) : null;
  const meKeys = new Set();
  if (me) {
    meKeys.add(normalizeDriverName(me.name));
    if (meInfo) {
      meKeys.add(normalizeDriverName(meInfo.displayName));
      (meInfo.aliases || []).forEach((a) => meKeys.add(a));
    }
  }

  displayList.forEach((item, i) => {
    let el = container.children[i];
    if (item.type === "header") {
      if (!el || el.className !== "class-header") {
        const fresh = document.createElement("div");
        fresh.className = "class-header";
        if (el) container.replaceChild(fresh, el);
        else container.appendChild(fresh);
        el = fresh;
      }
      el.textContent = item.title || groupLabel(item.label) || item.label;
      const hClr = item.color || classColor(item.label);
      el.style.borderLeftColor = hClr;
      el.style.background = hClr;
      el.style.color = contrastText(hClr);
      return;
    }

    if (item.type === "spacer") {
      if (!el || el.dataset.kind !== "spacer") {
        const fresh = document.createElement("div");
        fresh.className = "row row-spacer";
        fresh.dataset.kind = "spacer";
        if (el) container.replaceChild(fresh, el);
        else container.appendChild(fresh);
      }
      return;
    }

    const row = item.row;
    if (!el || el.dataset.view !== "standings") {
      const fresh = document.createElement("div");
      fresh.className = "row";
      fresh.dataset.view = "standings";
      fresh.innerHTML =
        '<span class="col pos"></span><span class="col name"><img class="logo" style="display:none" /><span class="name-text"></span></span><span class="col right-value"></span>';
      if (el) container.replaceChild(fresh, el);
      else container.appendChild(fresh);
      el = fresh;
    }

    // 999 = piloto do lineup que ainda nao pontuou: sem posicao no campeonato
    const rawPos = item.displayPosition != null ? item.displayPosition : row.position;
    const pos = rawPos >= 999 ? "–" : rawPos;
    const clr = row.color || classColor(row.classUniqueName);
    el.style.borderTopColor = clr || "";
    applyTeamTint(el, row.teamPrimaryColor);
    let isAssisted = false;
    if (playerHighlightEnabled && meKeys.size) {
      const rowKeys = [
        normalizeDriverName(row.displayName),
        normalizeDriverName(row.driverName),
        ...(row.aliases || []),
      ];
      isAssisted = rowKeys.some((k) => k && meKeys.has(k));
    }
    el.classList.toggle("player", isAssisted);
    el.classList.remove("fastest", "finished", "dnf", "yellow-flag");
    el.style.backgroundColor = rowBg(isAssisted ? "#006bdd" : "#0e42a5");
    const posEl = el.querySelector(".pos");
    posEl.textContent = String(pos || "—");
    posEl.style.background = clr || "#0e42a5";
    posEl.style.color = contrastText(clr || "#0e42a5");
    applyLogo(el.querySelector(".logo"), row.teamName, row.teamName);
    el.querySelector(".name-text").textContent = row.displayName || row.driverName || "—";

    const right = el.querySelector(".right-value");
    const useClass = !!item.classMode;
    const ptsText = useClass ? (row.classPoints != null ? row.classPoints : row.points) : row.points;
    const projInfo = projected.get(row) || { base: 0, add: 0, total: 0 };
    const addPts = Number(projInfo.add) || 0;
    const totalPts = Number(projInfo.total);
    const safeTotal = Number.isFinite(totalPts) ? totalPts : Number(projInfo.base) || 0;
    let text = String(ptsText || "0");
    let cls = "";
    if (colMode === "Pts") {
      const delta = formatPosDelta(useClass ? row.classPositionChange : row.positionChange);
      text = delta.text !== "=" ? `${ptsText || "0"} ${delta.text}` : String(ptsText || "0");
      cls = delta.cls || "";
    } else if (colMode === "Pts proj.") {
      if (!inRace) {
        text = String(safeTotal);
        cls = "";
      } else {
        const deltaRank = Number(rankDelta.get(row)) || 0;
        const rd = formatPosDelta(deltaRank);
        text = `${safeTotal}(+${addPts})${rd.text !== "=" ? " " + rd.text : ""}`;
        cls = rd.cls || "";
      }
    } else if (colMode === "Gap líder") {
      const g = classMode ? row.classUniqueName || "—" : "_all";
      const leaderPts = Number(leaderByGroup.get(g)) || 0;
      const gap = leaderPts - safeTotal;
      text = !Number.isFinite(gap) || gap <= 0 ? "—" : "-" + String(gap);
      cls = "";
    }
    right.className = "col right-value" + (cls ? " " + cls : "");
    right.textContent = text;
  });
}

// Relogio da volta mais rapida: fica ao lado da tabela, na altura da linha do
// piloto que tem a melhor volta da corrida. So aparece em corrida.
// ---- pagina de disputas (tecla 9, so em corrida) ----
// Destaca os carros que ficam pelo menos 5 s colados no da frente
// (shared/battles.js), mostra a velocidade deles ao lado da tabela e trava a
// parte rotativa da tabela onde houver disputa.
let battleMode = false;
let battleNames = new Set();
let latestScOut = false; // safety car na pista (AMS2 e LMU informam)
// Alcance da pagina, escolhido no painel:
//   "all"   a tabela toda, com intervalo de 0,6 s
//   "focus" so as disputas do piloto assistido, com intervalo de 1 s
const BATTLE_SCOPES = { all: 0.6, focus: 1 };
const BATTLE_SCOPE_KEY = "battleScope";
let battleScope = "all";
try {
  // a escolha do painel sobrevive a um reload da overlay
  const savedScope = localStorage.getItem(BATTLE_SCOPE_KEY);
  if (savedScope && BATTLE_SCOPES[savedScope]) battleScope = savedScope;
} catch (_) {}

function setBattleScope(value) {
  if (!BATTLE_SCOPES[value]) return;
  battleScope = value;
  try {
    localStorage.setItem(BATTLE_SCOPE_KEY, value);
  } catch (_) {}
}

// Para cada alcance, dois detectores, todos rodando a corrida toda: um pela
// ordem geral (pagina Geral) e um pela ordem dentro de cada classe (paginas
// por classe). Cada pagina usa o que combina com o intervalo que ela mostra.
const battleDetectors = {};
Object.keys(BATTLE_SCOPES).forEach((scope) => {
  battleDetectors[scope] = {
    overall: LLGBattles.createBattleDetector({ gap: BATTLE_SCOPES[scope] }),
    byClass: LLGBattles.createBattleDetector({ gap: BATTLE_SCOPES[scope] }),
  };
});

function battleActive() {
  return battleMode && isRaceSession() && !showingStandings();
}

const isBattleItem = (item) => !!(item && item.type === "row" && item.entry && battleNames.has(item.entry.name));

function updateBattles(standings) {
  // a corrida acabou ou o safety car entrou: a pagina desliga sozinha (com o
  // pelotao junto atras do safety car todo mundo estaria "em disputa")
  if (!isRaceSession() || latestScOut) {
    battleMode = false;
    battleNames = new Set();
    Object.values(battleDetectors).forEach((d) => {
      d.overall.reset();
      d.byClass.reset();
    });
    return;
  }
  // A deteccao roda a corrida toda, mesmo com a pagina desligada: como uma
  // disputa leva 5 s para ser reconhecida, ao apertar 9 as que ja estao
  // acontecendo aparecem na hora.
  const now = Date.now();
  const gapOf = (behind, ahead) => {
    const g = gapTracker.gap(behind.name, ahead.name, trackLengthM);
    return g && !g.laps ? g.sec : null;
  };
  // quem esta no box, terminou ou abandonou quebra a sequencia
  const eligible = (e) => (isDnf(e) || e.raceState === 3 || (e.pitMode || 0) !== 0 || firstLapWithoutGap(e) ? null : e);
  const sorted = (standings || []).slice().sort(sortRaceOrder);

  // ordem geral: disputa entre posicoes seguidas na corrida toda
  const overallOrder = sorted.map(eligible);

  // por classe: disputa entre posicoes seguidas DENTRO da classe (a briga por
  // posicao de verdade numa corrida multiclasse). As classes vao em sequencia,
  // separadas por um buraco, para o ultimo de uma nao formar par com o
  // primeiro da outra.
  const byClass = new Map();
  sorted.forEach((e) => {
    const key = groupKey(e, standings);
    if (!byClass.has(key)) byClass.set(key, []);
    byClass.get(key).push(eligible(e));
  });
  const chained = [];
  byClass.forEach((list) => {
    if (chained.length) chained.push(null);
    list.forEach((e) => chained.push(e));
  });
  const found = {};
  Object.keys(battleDetectors).forEach((scope) => {
    found[scope] = {
      overall: battleDetectors[scope].overall.update(overallOrder, gapOf, now),
      byClass: battleDetectors[scope].byClass.update(chained, gapOf, now),
    };
  });

  if (!battleActive()) {
    battleNames = new Set();
    return;
  }
  const kind = currentPageMode(standings) === "Geral" ? "overall" : "byClass";
  if (battleScope === "focus") {
    // so as disputas em que o piloto assistido esta (com o da frente e o de tras)
    const me = (standings || []).find((e) => isStablePlayer(e));
    battleNames = me ? battleDetectors.focus[kind].namesWith(me.name) : new Set();
  } else {
    battleNames = found.all[kind];
  }
}

// Velocidade dos carros em disputa, FORA da tabela, ao lado da linha de cada
// um (como o relogio da volta mais rapida). sideOffset: largura ja ocupada ao
// lado da tabela. Devolve a largura que esta coluna ocupa (0 se nao ha disputa
// na tela).
const BATTLE_SIDE_WIDTH = 66; // px, igual ao .battle-side do CSS
const BATTLE_SIDE_GAP = 2;
const battleSideEls = [];

function updateBattleSide(standings, sideOffset) {
  const table = document.getElementById("timing-table");
  const rows = [];
  if (table && battleActive() && battleNames.size) {
    document.querySelectorAll("#rows > .row").forEach((el) => {
      if (el.dataset.kind === "row" && battleNames.has(el.dataset.name)) rows.push(el);
    });
  }
  const byName = new Map((standings || []).map((e) => [e.name, e]));
  const offset = sideOffset || 0;
  let used = 0;
  rows.forEach((row) => {
    const entry = byName.get(row.dataset.name);
    if (!entry) return;
    while (battleSideEls.length <= used) {
      const el = document.createElement("div");
      el.className = "battle-side";
      document.body.appendChild(el);
      battleSideEls.push(el);
    }
    const el = battleSideEls[used++];
    const text = typeof entry.speedKmh === "number" ? `${Math.round(entry.speedKmh)}` : "–";
    const html = `${text}<small>km/h</small>`;
    if (el.dataset.html !== html) {
      el.innerHTML = html;
      el.dataset.html = html;
    }
    el.style.top = `${table.offsetTop + table.clientTop + row.offsetTop}px`;
    el.style.height = `${row.offsetHeight}px`;
    el.style.left =
      CLOCK_SIDE === "left"
        ? `${table.offsetLeft - offset - BATTLE_SIDE_WIDTH - BATTLE_SIDE_GAP}px`
        : `${table.offsetLeft + table.offsetWidth + offset + BATTLE_SIDE_GAP}px`;
    el.classList.add("visible");
  });
  for (let i = used; i < battleSideEls.length; i++) battleSideEls[i].classList.remove("visible");
  return used > 0 ? BATTLE_SIDE_WIDTH + BATTLE_SIDE_GAP : 0;
}

// Na pagina Geral ha um relogio (melhor volta da corrida); nas paginas por
// classe ha um por classe (melhor volta de cada classe).
// Lado: direito por padrao; ?clock=left coloca a esquerda (a tabela anda
// para a direita para abrir espaco).
const CLOCK_SIDE = params.get("clock") === "left" ? "left" : "right";
const CLOCK_GAP = 2;
const clockEls = [];

// Donos da melhor volta: um no geral, ou um por classe nas paginas por classe.
function fastestLapHolders(standings, perClass) {
  const best = new Map();
  (standings || []).forEach((e) => {
    if (!(e.fastestLapMs > 0)) return;
    const key = perClass ? groupKey(e, standings) : "_all";
    const cur = best.get(key);
    if (!cur || e.fastestLapMs < cur.fastestLapMs) best.set(key, e);
  });
  return Array.from(best.values());
}

function clockElement(i) {
  while (clockEls.length <= i) {
    const img = document.createElement("img");
    img.className = "fast-lap-clock";
    img.alt = "";
    img.style.display = "none";
    document.body.appendChild(img);
    clockEls.push(img);
  }
  return clockEls[i];
}

// sideOffset: largura ja ocupada ao lado da tabela (pneus e VE do LMU)
function updateFastLapClock(standings, sideOffset) {
  const table = document.getElementById("timing-table");
  if (!table) return;
  const offset = sideOffset || 0;
  table.classList.toggle("clock-left", CLOCK_SIDE === "left");

  const rows = [];
  // na pagina de disputas o relogio some: ali o foco e a briga, e ele ficaria
  // colado na velocidade dos carros
  if (!showingStandings() && isRaceSession() && !battleActive()) {
    const perClass = currentPageMode(standings) !== "Geral";
    const names = new Set(fastestLapHolders(standings, perClass).map((e) => e.name));
    // so as linhas na tela: o piloto pode estar numa pagina nao exibida
    document.querySelectorAll("#rows > .row").forEach((el) => {
      if (el.dataset.kind === "row" && names.has(el.dataset.name)) rows.push(el);
    });
  }

  rows.forEach((row, i) => {
    const clock = clockElement(i);
    logoLoader.load(clock, ["clock.png"]);
    const h = clock.offsetHeight || 30;
    const w = clock.offsetWidth || 28;
    clock.style.top = `${table.offsetTop + table.clientTop + row.offsetTop + (row.offsetHeight - h) / 2}px`;
    clock.style.left =
      CLOCK_SIDE === "left"
        ? `${table.offsetLeft - offset - w - CLOCK_GAP}px`
        : `${table.offsetLeft + table.offsetWidth + offset + CLOCK_GAP}px`;
    clock.classList.add("visible");
  });
  for (let i = rows.length; i < clockEls.length; i++) clockEls[i].classList.remove("visible");
}

// redesenho com o limite de FPS do painel (shared/framecap.js)
function render(standings) {
  return LLGFrameCap.run(renderNow, [standings]);
}

function renderNow(standings) {
  updateSessionVisibility(); // a pontuacao pode ter sido ligada ou desligada
  // game-lmu: so abre espaco a esquerda no modo ?clock=left (ver CSS)
  document.getElementById("timing-table").classList.toggle("game-lmu", latestGame === "lmu" && !showingStandings());
  updateBattles(standings); // antes de montar a tabela: define destaque e trava do rodizio
  announceBattleState(false);
  const table = document.getElementById("timing-table");
  table.classList.toggle("battle-on", battleActive());
  table.classList.toggle("battle-has", battleActive() && battleNames.size > 0);
  renderTable(standings);
  fitWeatherBar();
  // ao lado da tabela, nesta ordem: velocidade dos carros em disputa, pneus e
  // VE (LMU) e, por ultimo, o relogio da volta mais rapida
  updateTrackTag();
  const battleWidth = updateBattleSide(standings, 0);
  const lmuWidth = updateLmuSide(standings, battleWidth);
  updateFastLapClock(standings, lmuWidth || battleWidth);
}

function renderTable(standings) {
  if (showingStandings()) {
    renderStandings(standings);
    return;
  }
  // trocou de jogo e a pagina de pneus deixou de existir: volta para a primeira
  if (!rightModeAvailable(RIGHT_COLUMN_MODES[rightColumnIndex])) rightColumnIndex = 0;
  document.getElementById("rightColumnLabel").textContent = RIGHT_COLUMN_MODES[rightColumnIndex];
  document.getElementById("timing-table").classList.remove("wide-right");
  document.getElementById("pageLabel").textContent = currentPageLabel(standings) + (battleActive() ? " · Disputas" : "");

  const groupRanks = buildGroupRanks(standings);

  const isClassMode = currentPageMode(standings) !== "Geral";
  const showLapHighlight = RIGHT_COLUMN_MODES[rightColumnIndex] === "Última volta" || RIGHT_COLUMN_MODES[rightColumnIndex] === "Melhor volta";

  const displayList = buildDisplayList(standings);
  const container = document.getElementById("rows");

  const bestOverallFastest = (() => {
    const t = standings.map((e) => e.fastestLapMs).filter((v) => typeof v === "number" && v > 0);
    return t.length ? Math.min(...t) : null;
  })();
  const bestOverallLast = (() => {
    const t = standings.map((e) => e.lastLapMs).filter((v) => typeof v === "number" && v > 0);
    return t.length ? Math.min(...t) : null;
  })();
  const mode = RIGHT_COLUMN_MODES[rightColumnIndex];

  const bestFastestByClass = {};
  const bestLastByClass = {};
  const bestSectorsByClass = {};
  const bestSectorsOverall = [null, null, null];
  standings.forEach((e) => {
    const cls = groupKey(e, standings);
    if (e.fastestLapMs > 0 && (bestFastestByClass[cls] == null || e.fastestLapMs < bestFastestByClass[cls])) {
      bestFastestByClass[cls] = e.fastestLapMs;
    }
    if (e.lastLapMs > 0 && (bestLastByClass[cls] == null || e.lastLapMs < bestLastByClass[cls])) {
      bestLastByClass[cls] = e.lastLapMs;
    }
    if (!bestSectorsByClass[cls]) bestSectorsByClass[cls] = [null, null, null];
    const bs = [e.bestSector1Ms, e.bestSector2Ms, e.bestSector3Ms];
    for (let i = 0; i < 3; i++) {
      if (bs[i] > 0 && (bestSectorsByClass[cls][i] == null || bs[i] < bestSectorsByClass[cls][i])) {
        bestSectorsByClass[cls][i] = bs[i];
      }
      if (bs[i] > 0 && (bestSectorsOverall[i] == null || bs[i] < bestSectorsOverall[i])) {
        bestSectorsOverall[i] = bs[i];
      }
    }
  });

  while (container.children.length > displayList.length) {
    container.removeChild(container.lastChild);
  }


  // carro da frente e lider reais (ordem completa, nao so as linhas visiveis)
  {
    const link = (list) => {
      const sorted = list.slice().sort(sortByTiming);
      sorted.forEach((e, i) => {
        e._ahead = i > 0 ? sorted[i - 1] : null;
        e._leader = sorted[0];
      });
    };
    if (isClassMode) {
      const byClass = {};
      standings.forEach((e) => {
        const cls = groupKey(e, standings);
        (byClass[cls] = byClass[cls] || []).push(e);
      });
      Object.values(byClass).forEach(link);
    } else {
      link(standings);
    }
  }

  let prevFastestMs = null;
  let bestFastestMs = null;

  const overallBestFastest = (() => {
    const times = standings.map((e) => e.fastestLapMs).filter((v) => typeof v === "number" && v > 0);
    return times.length ? Math.min(...times) : null;
  })();

  displayList.forEach((item, i) => {
    let el = container.children[i];

    if (item.type === "header") {
      if (!el || el.dataset.kind !== "header") {
        const fresh = document.createElement("div");
        fresh.className = "class-header";
        fresh.dataset.kind = "header";
        if (el) container.replaceChild(fresh, el);
        else container.appendChild(fresh);
        el = fresh;
      }
      el.textContent = formatClassName(groupLabel(item.label));
      const hClr = classColor(item.label);
      el.style.borderLeftColor = hClr;
      el.style.background = hClr;
      el.style.color = contrastText(hClr);
      prevFastestMs = null;
      const groupEntries = [];
      for (let j = i + 1; j < displayList.length && displayList[j].type === "row"; j++) {
        groupEntries.push(displayList[j].entry);
      }
      const times = groupEntries.map((e) => e.fastestLapMs).filter((v) => typeof v === "number" && v > 0);
      bestFastestMs = times.length ? Math.min(...times) : null;
      return;
    }

    if (item.type === "spacer") {
      if (!el || el.dataset.kind !== "spacer") {
        const fresh = document.createElement("div");
        fresh.className = "row row-spacer";
        fresh.dataset.kind = "spacer";
        if (el) container.replaceChild(fresh, el);
        else container.appendChild(fresh);
        el = fresh;
      }
      return;
    }

    if (bestFastestMs === null && !isClassMode) {
      bestFastestMs = overallBestFastest;
    }

    if (!el || el.dataset.kind !== "row" || el.dataset.view === "standings") {
      const fresh = document.createElement("div");
      fresh.className = "row";
      fresh.dataset.kind = "row";
      fresh.dataset.view = "race";
      fresh.innerHTML = `
        <span class="col pos"></span>
        <span class="col name"><img class="logo" style="display:none" /><span class="name-text"></span><span class="sectors"><i></i><i></i><i></i></span><span class="pen-badge" hidden></span><span class="pit-badge" style="display:none">P</span></span>
        <span class="col right-value"></span>
      `;
      if (el) container.replaceChild(fresh, el);
      else container.appendChild(fresh);
      el = fresh;
    }

    const entry = item.entry;
    const prevPos = lastDisplayPos.has(entry.name) ? lastDisplayPos.get(entry.name) : null;
    const posChanged = prevPos !== null && prevPos !== item.displayPosition;

    const isDriving = isStablePlayer(entry) && (
      !entry.inRace ||
      entry.lapsCompleted > 0 ||
      entry.pitMode === 0 ||
      entry.pitMode === 3 ||
      entry.pitMode === 5
    );

    el.classList.toggle("player", playerHighlightEnabled && isDriving);
    el.classList.toggle("battle", battleActive() && battleNames.has(entry.name));
    el.classList.toggle("dnf", isDnf(entry));
    let isPurple = false;
    const cls = groupKey(entry, standings);
    const sessionBest = isClassMode ? bestFastestByClass[cls] : bestOverallFastest;
    if (mode === "Melhor volta") {
      isPurple = entry.fastestLapMs > 0 && entry.fastestLapMs === sessionBest;
    } else if (mode === "Última volta") {
      isPurple = entry.lastLapMs > 0 && sessionBest != null && entry.lastLapMs === sessionBest;
    } else if (mode === "Intervalo" && !isRaceSession()) {
      isPurple = false;
    }
    el.classList.toggle("fastest", isPurple);
    const clr = classColor(groupKey(entry, standings));
    el.style.borderTopColor = clr;
    const teamInfo = rltLookup(entry);
    applyTeamTint(el, teamInfo && teamInfo.teamPrimaryColor);
    // pagina de disputas: a linha inteira fica na cor da equipe, como no WEC
    // (sem equipe conhecida, na cor da classe), com o texto na cor que da leitura
    // Na cor da equipe o logo normal pode sumir (logo da mesma cor do fundo):
    // ai vale a variante do logo, clara em fundo escuro e escura em fundo claro.
    let logoVariant = null;
    if (el.classList.contains("battle")) {
      const battleRgb = LLGColors.toRgb((teamInfo && teamInfo.teamPrimaryColor) || clr) || [255, 157, 30];
      const fg = LLGColors.readableOn(battleRgb);
      el.style.setProperty("--battle-bg", `rgb(${battleRgb.join(", ")})`);
      el.style.setProperty("--battle-fg", fg);
      logoVariant = fg === "#ffffff" ? "light" : "dark";
    }
    el.classList.toggle("yellow-flag", !!entry.causedYellow);
    if (!el.classList.contains("flash-up") && !el.classList.contains("flash-down")) {
      if (entry.causedYellow) {
        el.style.backgroundColor = rowBg("#c9a000");
      } else {
        el.style.backgroundColor = rowBg(el.classList.contains("player") ? "#006bdd" : "#0e42a5");
      }
    }
    const posEl = el.querySelector(".pos");
    posEl.style.background = clr;
    posEl.style.color = contrastText(clr);

    if (posChanged) {
      const gained = item.displayPosition < prevPos;
      el.classList.remove("flash-up", "flash-down");
      void el.offsetWidth;
      el.classList.add(gained ? "flash-up" : "flash-down");
      const flashCls = gained ? "flash-up" : "flash-down";
      setTimeout(() => {
        el.classList.remove(flashCls);
        if (entry.causedYellow) {
          el.style.backgroundColor = rowBg("#c9a000");
        } else {
          el.style.backgroundColor = rowBg(el.classList.contains("player") ? "#006bdd" : "#0e42a5");
        }
      }, 500);
    }

    if (item.rotating && el.dataset.name !== entry.name) {
      el.classList.remove("slide-in");
      void el.offsetWidth;
      el.classList.add("slide-in");
    }

    lastDisplayPos.set(entry.name, item.displayPosition);
    el.dataset.name = entry.name;
    el.dataset.pos = String(item.displayPosition);

    const logoImg = el.querySelector(".logo");
    applyLogo(logoImg, rltTeamName(entry), entry.carName, logoVariant);
    const gainEl = el.querySelector(".pos-gain");
    if (gainEl) {
      gainEl.style.display = "none";
      gainEl.textContent = "";
    }

    const change = positionChange(entry, isClassMode, groupRanks);
    const finished = entry.raceState === 3;
    // quadriculado de quem recebeu a bandeirada: na corrida e na classificacao (estado 3)
    el.classList.toggle("finished", !!finished && (isRaceSession() || Number(latestSessionState) === 3));

    // quem abandonou nao tem mais posicao: a coluna da direita ja mostra DNF
    posEl.textContent = isDnf(entry) ? "—" : item.displayPosition;
    el.querySelector(".name-text").textContent = rltDisplayName(entry);
    // punicao pendente, como na tabela completa
    const penBadge = el.querySelector(".pen-badge");
    const penText = isDnf(entry) ? "" : LLGDisplay.penaltyLabel(entry);
    if (penBadge.textContent !== penText) penBadge.textContent = penText;
    penBadge.hidden = !penText;
    const gKey = groupKey(entry, standings);
    const rowBestFastest = (isClassMode && bestFastestByClass[gKey] != null)
      ? bestFastestByClass[gKey]
      : (bestFastestMs != null ? bestFastestMs : bestOverallFastest);
    const aheadFast = item.aheadFastestMs != null ? item.aheadFastestMs : prevFastestMs;
    const rv = rightColumnValue(entry, change, rowBestFastest, aheadFast);
    const rvEl = el.querySelector(".right-value");
    if (rv.html != null) {
      if (rvEl.dataset.html !== rv.html) {
        rvEl.innerHTML = rv.html;
        rvEl.dataset.html = rv.html;
      }
    } else {
      rvEl.textContent = rv.text;
      delete rvEl.dataset.html;
    }
    rvEl.className = "col right-value" + (rv.cls ? ` ${rv.cls}` : "");

    const badge = el.querySelector(".pit-badge");
    const inPitNow = isInPit(entry) || isExitingPit(entry);
    const showOut = !inPitNow && (rv.pitPhase === "done" || isOutLap(entry));
    // volta de formacao: todo mundo sai do grid junto, entao os avisos de box
    // (P / OUT) e as parciais nao dizem nada e ficam escondidos
    const formationLap = Number(latestSessionState) === 4;
    if (formationLap) {
      badge.style.display = "none";
      badge.className = "pit-badge";
    } else if (inPitNow || rv.pitPhase === "in" || rv.pitPhase === "out") {
      badge.style.display = "";
      badge.textContent = "P";
      badge.className = "pit-badge pit-in";
    } else if (showOut) {
      badge.style.display = "";
      badge.textContent = "OUT";
      badge.className = "pit-badge pit-out";
    } else {
      badge.style.display = "none";
      badge.className = "pit-badge";
    }

    const secWrap = el.querySelector(".sectors");
    if (secWrap) {
      // esconde setores no box e na volta de saída (OUT) — evita vermelho no lugar do OUT
      const showSec =
        !formationLap &&
        (isTimedSession() || !isRaceSession()) &&
        !inPitNow &&
        !showOut &&
        entry.pitMode === 0;
      secWrap.style.display = showSec ? "" : "none";
      if (showSec) {
        const colors = sectorTracker.view(entry.name, Date.now()).map((sec) => sec.color);
        const boxes = secWrap.querySelectorAll("i");
        boxes.forEach((box, idx) => {
          box.className = colors[idx] ? `sec-${colors[idx]}` : "";
        });
      } else {
        const boxes = secWrap.querySelectorAll("i");
        boxes.forEach((box) => {
          box.className = "";
        });
      }
    }
    prevFastestMs = entry.fastestLapMs > 0 ? entry.fastestLapMs : prevFastestMs;
  });
}

function formatTime(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${m}:${String(s).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

document.addEventListener("keydown", (e) => {
  const c = e.code;
  const k = e.key;
  if (c === "Digit0" || c === "Numpad0" || k === "0") {
    standingsView = !standingsView;
    render(latestStandings);
    return;
  }
  // pelo caractere (e.key), nao pela posicao da tecla (e.code): num teclado
  // ABNT2 a posicao "BracketLeft" e a tecla do acento agudo
  if (k === ",") applyOverlayCommand("overlay.prevColumn");
  else if (k === ".") applyOverlayCommand("overlay.nextColumn");
  else if (k === "[" || k === "{") applyOverlayCommand("overlay.prevPage");
  else if (k === "]" || k === "}") applyOverlayCommand("overlay.nextPage");
  else if (c === "KeyP" || k === "p" || k === "P") applyOverlayCommand("overlay.toggleHighlight");
  else if (k === "9") applyOverlayCommand("overlay.toggleBattles");
});

setInterval(() => {
  rotateTick += 1;
  if (latestStandings.length) render(latestStandings);
}, ROTATE_MS);

if (DEMO) {
  latestStandings = [
    { position: 1, name: "Willian Garcia[PRO]", carClass: "GT3_LD", carName: "Mercedes-AMG GT3 Evo", currentLap: 8, lapsCompleted: 7, lastLapMs: 82345, fastestLapMs: 81900, totalDistance: 32000, speedMs: 55 },
    { position: 2, name: "Luís Guimarães[PRO]", carClass: "GT3_LD", carName: "Ferrari 488 GT3 Evo 2020", currentLap: 8, lapsCompleted: 7, lastLapMs: 82890, fastestLapMs: 82100, totalDistance: 31940, speedMs: 54 },
    { position: 3, name: "Ader Fernando", carClass: "GT3_LD", carName: "Porsche 911 GT3 R (991.2)", currentLap: 8, lapsCompleted: 7, lastLapMs: 83210, fastestLapMs: 82750, totalDistance: 31800, speedMs: 53, isPlayer: true },
    { position: 4, name: "Leandro Santos[AM]", carClass: "GT4_HD", carName: "McLaren 570S GT4", currentLap: 7, lapsCompleted: 6, lastLapMs: 83500, fastestLapMs: 83100, totalDistance: 27500, speedMs: 51 },
    { position: 5, name: "Catroi[Pro]", carClass: "GT4_HD", carName: "Aston Martin Vantage GT4", currentLap: 7, lapsCompleted: 6, lastLapMs: 83790, fastestLapMs: 83400, totalDistance: 27300, speedMs: 50 },
  ];
  latestStandings.forEach((e) => {
    e.startPosition = e.position;
  });
  render(latestStandings);
} else {
  connect();
}
