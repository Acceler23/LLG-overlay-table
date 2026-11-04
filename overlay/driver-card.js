const WS_URL = `ws://${location.hostname}:${location.port || 8080}/ws`;

let rltConfig = null;
let latestStandings = [];
let latestSessionState = null; // 1 treino, 2 teste, 3 classificacao, 5 corrida, 6 time attack
let standingsView = false;
let standingsColumnIndex = 0;
const STANDINGS_COLUMN_MODES = ["Pts", "Pts proj.", "Gap líder"];

let stablePlayerName = null;
let pendingPlayerName = null;
let pendingPlayerSince = 0;
// Troca de piloto em foco: vale assim que duas leituras seguidas do jogo
// concordam (~0,13 s cada). Uma leitura isolada e ignorada, para a camera
// passando por outro carro nao fazer o destaque piscar.
const PLAYER_STABLE_MS = 100;

// Fonte online primeiro, pasta local overlay/assets como reserva.
const logoLoader = LLGLogos.createLoader("assets");
let teamLogoOverrides = {};
try {
  const saved = localStorage.getItem("teamLogoOverrides");
  if (saved) teamLogoOverrides = JSON.parse(saved) || {};
} catch (_) {}

const normalizeDriverName = LLGNames.normalizeName;
const nameCandidates = LLGNames.nameCandidates;

// Mesmo casador da tabela (shared/names.js), para o card e a tabela
// mostrarem sempre o mesmo piloto.
let rltMatcher = null;

function rebuildRltMatcher() {
  const hasDrivers =
    rltConfig &&
    ((rltConfig.drivers && rltConfig.drivers.length) || (rltConfig.standingsRows && rltConfig.standingsRows.length));
  rltMatcher = hasDrivers
    ? LLGNames.createMatcher(LLGNames.buildPool(rltConfig), {
        // ligacoes feitas a mao no painel (aba Pilotos) valem junto com o RLT_INGAME_MAP
        explicitMap: Object.assign({}, typeof RLT_INGAME_MAP !== "undefined" ? RLT_INGAME_MAP : {}, (rltConfig && rltConfig.manualLinks) || {}),
      })
    : null;
  if (rltMatcher) rltMatcher.prime(latestStandings.map((e) => e.name));
}

function rltLookup(entry) {
  if (!rltMatcher || !entry) return null;
  return rltMatcher.lookup(entry.name || "");
}

function ordinal(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return "";
  const j = x % 10;
  const k = x % 100;
  if (j === 1 && k !== 11) return "st";
  if (j === 2 && k !== 12) return "nd";
  if (j === 3 && k !== 13) return "rd";
  return "th";
}

function formatTime(ms) {
  if (!ms || ms <= 0) return "—";
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  if (m > 0) return `${m}:${s.toFixed(3).padStart(6, "0")}`;
  return s.toFixed(3);
}

// Mesmas regras de logo da tabela (shared/display.js), incluindo a lista
// TEAM_LOGO_OVERRIDES do drivers-config.js.
function setBgLogo(img, teamName, carName, variant) {
  if (!img) return;
  logoLoader.load(img, LLGDisplay.logoPaths(teamName, carName, teamLogoOverrides, variant));
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
  return fallback;
}

// ---- foto do piloto (shared/avatars.js) ----
let avatarIndex = [];
let avatarVersion = ""; // muda quando uma foto da pasta muda (recarrega)

// nomes do piloto no RLT, para achar o arquivo "<nome no RLT>__<nome no jogo>"
function rltNamesFor(entry) {
  const info = rltLookup(entry);
  if (!info) return [];
  return [info.displayName, [info.firstName, info.lastName].filter(Boolean).join(" "), info.driverName].filter((n) => n && String(n).trim());
}

function setPhoto(entry) {
  const card = document.getElementById("card");
  const img = document.getElementById("photo");
  const file = LLGAvatars.find(avatarIndex, rltNamesFor(entry), String(entry.name || "").replace(/\u200B+$/, ""));
  card.classList.toggle("has-photo", !!file);
  if (!file) {
    img.removeAttribute("src");
    img.dataset.file = "";
    return;
  }
  // A base da foto fica no fim da faixa do nome e ela sobe um pouco acima do
  // cartao. A altura acompanha a largura da foto (110 px no CSS), sempre com o
  // mesmo enquadramento: 1,3 x a altura de "100 px acima do cartao ate o fim da
  // faixa" para cada 100 px de largura. O espaco transparente em cima da pagina
  // (body padding-top no CSS) precisa caber o quanto ela sobe (~48 px).
  const identity = document.querySelector(".identity");
  const bottom = identity.offsetTop + identity.offsetHeight;
  const box = document.getElementById("photoBox");
  const height = Math.round((((100 + bottom) * 2) / 3) * (box.offsetWidth / 100));
  box.style.height = `${height}px`;
  box.style.top = `${bottom - height}px`;
  // pasta das fotos escolhida no painel, servida em /overlay/avatars/
  const src = `avatars/${encodeURIComponent(file)}?v=${encodeURIComponent(avatarVersion)}`;
  if (img.dataset.file === src) return;
  img.dataset.file = src;
  img.onerror = () => card.classList.remove("has-photo"); // arquivo sumiu ou nao abre
  img.src = src;
}

function rltTeamName(entry) {
  const info = rltLookup(entry);
  if (info && info.teamName) return info.teamName;
  // a equipe do proprio jogo (LMU) so vale sem temporada do RLT aplicada
  if (!rltConfig && entry.teamName) return entry.teamName;
  return entry.carName || "";
}

// Nome completo da equipe (so para exibir; os logos usam o nome curto).
function rltTeamFullName(entry) {
  const info = rltLookup(entry);
  return (info && info.teamFullName) || rltTeamName(entry);
}

// Bloco do logo, embaixo da posicao: na cor principal da equipe (RLT). Devolve
// a variante do logo para esse fundo, como na pagina de disputas da tabela:
// "light" (logo claro) em fundo escuro, "dark" (logo escuro) em fundo claro.
// Sem equipe no RLT: azul padrao do CSS e o logo normal.
function paintLogoBox(entry) {
  const box = document.getElementById("logoBox");
  const info = rltLookup(entry);
  const rgb = info && LLGColors.toRgb(info.teamPrimaryColor);
  if (!rgb) {
    box.style.removeProperty("--team-bg");
    return null;
  }
  box.style.setProperty("--team-bg", `rgb(${rgb.join(",")})`);
  return LLGColors.readableOn(rgb) === "#ffffff" ? "light" : "dark";
}

// Nome da classe, igual ao cabecalho da tabela: classe do RLT quando ha
// temporada, modelo do carro em classe dividida por carro, senao a classe do
// jogo ja formatada (CLASS_NAME_OVERRIDES, sem sufixos tecnicos).
function classLabel(entry) {
  const key = grouper.key(entry, latestStandings);
  if (rltEnabled()) {
    const c = rltConfig.classes.find((x) => x.uniqueName === key || x.name === key);
    if (c) return LLGDisplay.formatClassName(c.name || c.uniqueName);
  }
  return LLGDisplay.formatClassName(key);
}

function rltRaceNumber(entry) {
  const info = rltLookup(entry);
  if (info && info.raceNumber != null && String(info.raceNumber).trim() !== "") return String(info.raceNumber);
  // o LMU informa o numero do carro (entry.carNumber)
  if (entry && entry.carNumber != null && String(entry.carNumber).trim() !== "") return String(entry.carNumber);
  return "";
}

// Mesma cor de classe da tabela (RLT, CLASS_COLORS ou cor derivada do nome).
function classColor(entry) {
  return LLGDisplay.classColor(grouper.key(entry, latestStandings), rltEnabled() ? rltConfig.classes : null);
}

function updateStablePlayer(standings) {
  const viewed = (standings || []).find((e) => e.isPlayer);
  const name = viewed ? viewed.name : null;
  const now = Date.now();
  if (!stablePlayerName && name) {
    stablePlayerName = name;
    pendingPlayerName = null;
    return;
  }
  if (name && name === stablePlayerName) {
    pendingPlayerName = null;
    return;
  }
  if (!name) {
    pendingPlayerName = null;
    return;
  }
  if (name === pendingPlayerName) {
    if (now - pendingPlayerSince >= PLAYER_STABLE_MS) {
      stablePlayerName = name;
      pendingPlayerName = null;
    }
    return;
  }
  pendingPlayerName = name;
  pendingPlayerSince = now;
}

function rltEnabled() {
  return !!(rltConfig && rltConfig.classes && rltConfig.classes.length > 0);
}

// Mesma regra de classe da tabela (shared/groups.js), incluindo as classes
// divididas por modelo de carro (SPLIT_BY_CAR_CLASSES em drivers-config.js).
const grouper = LLGGroups.createGrouper({
  rltEnabled: () => rltEnabled(),
  lookup: (entry) => rltLookup(entry),
  splitClasses: typeof SPLIT_BY_CAR_CLASSES !== "undefined" ? SPLIT_BY_CAR_CLASSES : [],
});

function classPosition(entry, standings) {
  return grouper.position(entry, standings);
}

// ---- pagina de disputas: pedais ----
// Quando a tabela esta na pagina de disputas (ela avisa pelo WebSocket, ver
// announceBattleState em timing-table.js), o card troca velocidade, largada e
// melhor volta por uma barra unica dos pedais: o acelerador enche da esquerda
// para a direita e o freio da direita para a esquerda, com a marcha e a
// velocidade ao lado. So aparece se o jogo informa os pedais do carro em foco
// (por enquanto, o Le Mans Ultimate).
const BATTLE_STATE_MAX_AGE_MS = 6000; // a tabela repete o aviso a cada 2 s
let battlePage = { active: false, standings: null, at: 0 };

// O aviso da tabela vale enquanto ela continua mandando (a cada 2 s)
function tableAnnounced() {
  return Date.now() - battlePage.at <= BATTLE_STATE_MAX_AGE_MS;
}

// Pontuacao na tela: segue o que a TABELA mostra (ela avisa). Sem a tabela
// aberta, vale o que as teclas pediram aqui mesmo. Antes o card so alternava a
// propria copia a cada 0 e saia de sincronia (0 sem temporada, card recarregado):
// a barra dos pedais ficava escondida ate apertar 0 de novo.
function showingStandings() {
  if (tableAnnounced() && typeof battlePage.standings === "boolean") return battlePage.standings;
  return standingsView;
}

function showPedals(entry) {
  if (!battlePage.active || !tableAnnounced()) return false;
  if (latestSessionState !== 5) return false; // a tabela ja nao liga disputas com a pontuacao na tela
  return typeof entry.throttle === "number" && typeof entry.brake === "number";
}

function renderPedals(stats, entry) {
  if (stats.dataset.mode !== "pedals") {
    // monta uma vez; depois so muda as larguras e os textos (a barra desliza)
    stats.dataset.mode = "pedals";
    stats.classList.add("pedals");
    stats.innerHTML = `
      <div class="pedal-bar">
        <div class="pedal-fill throttle"></div>
        <div class="pedal-fill brake"></div>
        <span class="pedal-label left">Acelerador</span>
        <span class="pedal-label right">Freio</span>
      </div>
      <div class="pedal-box"><div class="v gear"></div><div class="l">Marcha</div></div>
      <div class="pedal-box"><div class="v speed"></div><div class="l">km/h</div></div>
    `;
  }
  const pct = (v) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
  stats.querySelector(".pedal-fill.throttle").style.width = pct(entry.throttle);
  stats.querySelector(".pedal-fill.brake").style.width = pct(entry.brake);
  const gear = entry.gear;
  stats.querySelector(".gear").textContent = gear == null ? "—" : gear < 0 ? "R" : gear === 0 ? "N" : String(gear);
  stats.querySelector(".speed").textContent = typeof entry.speedKmh === "number" ? String(Math.round(entry.speedKmh)) : "—";
}

// classificacao e time attack: o card mostra as parciais da volta
function isQualifying() {
  return latestSessionState === 3 || latestSessionState === 6;
}

const sectorTracker = LLGSectors.createSectorTracker();

function isTimedSession() {
  return latestSessionState === 1 || latestSessionState === 2 || latestSessionState === 3 || latestSessionState === 6;
}

// Diferenca da melhor volta do piloto para a melhor volta da classe dele.
function classLeaderGap(entry, standings) {
  const mine = Number(entry.fastestLapMs);
  if (!(mine > 0)) return "—";
  const key = grouper.key(entry, standings);
  let best = mine;
  (standings || []).forEach((e) => {
    if (e.fastestLapMs > 0 && e.fastestLapMs < best && grouper.key(e, standings) === key) best = e.fastestLapMs;
  });
  if (mine <= best) return "Líder";
  return `+${((mine - best) / 1000).toFixed(3)}`;
}

function findPlayer(standings) {
  updateStablePlayer(standings);
  if (stablePlayerName) {
    const hit = (standings || []).find((e) => e.name === stablePlayerName);
    if (hit) return hit;
  }
  return (standings || []).find((e) => e.isPlayer) || null;
}

function findStandingsRow(entry) {
  if (!entry || !rltConfig || !Array.isArray(rltConfig.standingsRows)) return null;
  const info = rltLookup(entry);
  if (info && info.position != null && info.pointsRaw != null) {
    const byName = rltConfig.standingsRows.find(
      (r) =>
        normalizeDriverName(r.displayName) === normalizeDriverName(info.displayName) ||
        normalizeDriverName(r.driverName) === normalizeDriverName(info.driverName)
    );
    if (byName) return byName;
  }
  const keys = nameCandidates(entry.name);
  for (const r of rltConfig.standingsRows) {
    const pool = [
      normalizeDriverName(r.displayName),
      normalizeDriverName(r.driverName),
      normalizeDriverName(r.inGameName),
      ...(r.aliases || []),
    ].filter(Boolean);
    for (const k of keys) {
      if (pool.includes(k)) return r;
    }
  }
  return null;
}

// redesenho com o limite de FPS do painel (shared/framecap.js)
function render() {
  return LLGFrameCap.run(renderNow, []);
}

function renderNow() {
  const card = document.getElementById("card");
  const entry = findPlayer(latestStandings);
  if (!entry) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");

  const overall = entry.position || 0;
  // raceState do jogo: 4 desclassificado, 5 retirado, 6 DNF. Quem abandonou
  // nao tem mais posicao.
  const dnf = entry.raceState === 4 || entry.raceState === 5 || entry.raceState === 6;
  const classPos = dnf ? "DNF" : classPosition(entry, latestStandings) || overall;
  document.getElementById("posClass").textContent = dnf ? "—" : classPos || "—";
  document.getElementById("posOverall").textContent = dnf ? "DNF" : overall || "—";
  // Com uma classe so na sessao, a posicao geral e a da classe sao o mesmo
  // numero: o de baixo (geral) so aparece em multiclasse ou para avisar o DNF.
  const classCount = new Set(latestStandings.map((e) => grouper.key(e, latestStandings))).size;
  document.getElementById("posOverall").style.display = classCount > 1 || dnf ? "" : "none";

  // nome e cor da classe pelas mesmas regras da tabela
  const classBar = document.getElementById("classBar");
  const classNameEl = document.getElementById("className");
  classNameEl.textContent = classLabel(entry) || "—";
  const classBg = classColor(entry);
  classBar.style.background = classBg;
  // texto preto ou branco conforme a cor da classe (ex: Super Trofeo e branca)
  classNameEl.style.color = LLGColors.readableOnColor(classBg);

  const team = rltTeamName(entry);
  document.getElementById("driverName").textContent = rltDisplayName(entry) || entry.name || "—";
  document.getElementById("teamName").textContent = rltTeamFullName(entry) || "—";
  document.getElementById("raceNum").textContent = rltRaceNumber(entry);

  setBgLogo(document.getElementById("bgLogo"), team, entry.carName, paintLogoBox(entry));
  setPhoto(entry);

  const stats = document.getElementById("stats");
  // pagina de disputas da tabela: barra dos pedais, marcha e velocidade
  if (showPedals(entry)) {
    renderPedals(stats, entry);
    return;
  }
  if (stats.dataset.mode === "pedals") {
    stats.dataset.mode = "";
    stats.classList.remove("pedals");
  }
  // pontuacao so com temporada do RLT aplicada
  if (showingStandings() && rltConfig && rltConfig.standingsRows && rltConfig.standingsRows.length) {
    const row = findStandingsRow(entry);
    const champPos = row && row.position != null && row.position < 999 ? row.position : "—";
    const pts = row && row.points != null ? row.points : "—";
    let gap = "—";
    if (row && row.gapToLeader != null && String(row.gapToLeader).trim() !== "") {
      gap = row.gapToLeader;
    } else if (row && row.pointsRaw != null && rltConfig.standingsRows && rltConfig.standingsRows.length) {
      const leader = rltConfig.standingsRows.reduce((a, b) =>
        (Number(a.pointsRaw) || 0) >= (Number(b.pointsRaw) || 0) ? a : b
      );
      const diff = (Number(leader.pointsRaw) || 0) - (Number(row.pointsRaw) || 0);
      gap = diff <= 0 ? "—" : `-${diff}`;
    }
    stats.innerHTML = `
      <div class="stat"><div class="v">${champPos}</div><div class="l">Campeonato</div></div>
      <div class="stat"><div class="v">${pts}</div><div class="l">Pontos</div></div>
      <div class="stat"><div class="v">${gap}</div><div class="l">Gap líder</div></div>
    `;
  } else if (isQualifying()) {
    // classificacao: as tres parciais da volta, no estilo do WEC. Em cima o
    // nome e a barra da parcial, na cor dela (shared/sectors.js); embaixo, ao
    // ser fechada, o tempo e a diferenca para o lider da classe.
    const sectors = sectorTracker.view(entry.name, Date.now());
    stats.innerHTML = sectors
      .map((sec, i) => {
        const cls = sec.color ? ` ${sec.color}` : "";
        const time = sec.ms != null ? formatTime(sec.ms) : "&nbsp;";
        let delta = "";
        if (sec.ms != null && sec.deltaMs != null) {
          delta = `${sec.deltaMs > 0 ? "+" : sec.deltaMs < 0 ? "-" : ""}${(Math.abs(sec.deltaMs) / 1000).toFixed(3)}`;
        }
        return `<div class="stat sector${cls}"><div class="l">S${i + 1}</div><div class="bar"></div><div class="t"><span class="v">${time}</span><span class="d">${delta}</span></div></div>`;
      })
      .join("");
  } else if (isTimedSession()) {
    // treino: velocidade, melhor volta e diferenca pro lider da classe
    const speed = typeof entry.speedKmh === "number" ? `${Math.round(entry.speedKmh)} km/h` : "—";
    const fl = entry.fastestLapMs ? formatTime(entry.fastestLapMs) : "—";
    stats.innerHTML = `
      <div class="stat"><div class="v">${speed}</div><div class="l">Velocidade</div></div>
      <div class="stat"><div class="v">${fl}</div><div class="l">Melhor volta</div></div>
      <div class="stat"><div class="v">${classLeaderGap(entry, latestStandings)}</div><div class="l">Líder da classe</div></div>
    `;
  } else {
    // corrida: velocidade, posicao de largada e melhor volta. A posicao atual ja
    // esta em destaque a esquerda (na classe), entao a largada tambem e na classe
    // (a posicao de largada geral vem do servidor, server/raceState.js)
    const startInClass = grouper.startPosition(entry, latestStandings);
    const start = startInClass != null ? startInClass : "—";
    const speed = typeof entry.speedKmh === "number" ? `${Math.round(entry.speedKmh)} km/h` : "—";
    const fl = entry.fastestLapMs ? formatTime(entry.fastestLapMs) : "—";
    stats.innerHTML = `
      <div class="stat"><div class="v">${speed}</div><div class="l">Velocidade</div></div>
      <div class="stat"><div class="v">${start}</div><div class="l">Largada</div></div>
      <div class="stat"><div class="v">${fl}</div><div class="l">Melhor volta</div></div>
    `;
  }
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

function connect() {
  const socket = new WebSocket(WS_URL);
  socket.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      LLGFrameCap.handle(msg); // limite de FPS do painel
      if (msg.type === "standings") {
        const payload = msg.data;
        const list = Array.isArray(payload) ? payload : payload && payload.standings;
        latestStandings = Array.isArray(list) ? list : [];
        LLGDisplay.applyGameClassNames(latestStandings, payload && payload.game);
        if (rltMatcher) rltMatcher.prime(latestStandings.map((e) => e.name));
        const session = Array.isArray(payload) ? null : payload && payload.session;
        if (session && session.state != null) {
          const st = Number(session.state);
          const next = Number.isNaN(st) ? null : st;
          if (next !== latestSessionState) sectorTracker.reset(); // sessao nova: parciais do zero
          latestSessionState = next;
        }
        sectorTracker.update(latestStandings, (e) => grouper.key(e, latestStandings), Date.now());
        render();
      } else if (msg.type === "hello") {
        checkBuildId(msg.buildId);
      } else if (msg.type === "rltConfig") {
        rltConfig = msg.data || null;
        rebuildRltMatcher();
        render();
      } else if (msg.type === "assetsConfig") {
        logoLoader.setConfig(msg.data || {});
        render();
      } else if (msg.type === "avatars") {
        avatarIndex = LLGAvatars.createIndex((msg.data && msg.data.files) || []);
        avatarVersion = (msg.data && msg.data.version) || "";
        render();
      } else if (msg.type === "overlayCommand") {
        const name = msg.name;
        if (name === "overlay.battleState") {
          // aviso da tabela: pagina de disputas ligada ou desligada
          const pl = msg.payload || {};
          battlePage = { active: !!pl.active, standings: typeof pl.standings === "boolean" ? pl.standings : null, at: Date.now() };
          if (battlePage.standings !== null) standingsView = battlePage.standings; // a copia daqui acompanha a tabela
          render();
        } else if (name === "overlay.toggleStandings") {
          standingsView = !showingStandings();
          render();
        } else if (name === "overlay.setStandings") {
          standingsView = !!(msg.payload && msg.payload.value);
          render();
        } else if (name === "overlay.prevColumn" || name === "overlay.nextColumn") {
          if (showingStandings()) {
            if (name === "overlay.prevColumn") {
              standingsColumnIndex = (standingsColumnIndex - 1 + STANDINGS_COLUMN_MODES.length) % STANDINGS_COLUMN_MODES.length;
            } else {
              standingsColumnIndex = (standingsColumnIndex + 1) % STANDINGS_COLUMN_MODES.length;
            }
            render();
          }
        }
      }
    } catch (_) {}
  });
  // servidor reiniciando: tenta de novo logo, para a overlay voltar rapido
  socket.addEventListener("close", () => setTimeout(connect, 500));
}

connect();
