// control-panel/direcao.js
// Direcao de prova do LMU numa tela so, no estilo da tabela completa: todos os
// carros (posicao, classe, piloto, carro, equipe), a velocidade agora, a
// situacao (box, lento, acima do limite no FCY, carro do SC). A direita, duas
// colunas de avisos: as infracoes (FCY/SC e carro parado) e os incidentes do
// proprio jogo, com a forca da batida quando houver. Clicar num aviso leva o
// replay do LMU ao momento. Os botoes de FCY, Safety Car e retardatarios sao
// os mesmos da aba LMU do painel.
// Dados: a lista dos carros vem pelo WebSocket (como nas overlays); os
// incidentes e o estado do FCY/SC vem de /api/lmu/control, com a senha da aba.

const WS_URL = `ws://${location.hostname}:${location.port || 8080}/ws`;
const TOKEN_KEY = "llgRcToken"; // acesso salvo neste navegador ate "Sair"
const POLL_MS = 1000;

let token = "";
try {
  token = localStorage.getItem(TOKEN_KEY) || "";
} catch (_) {}
// aberta pelo painel: o acesso vem no endereco (#t=...); sai do endereco logo
{
  const fromPanel = new URLSearchParams(location.hash.slice(1)).get("t");
  if (fromPanel) {
    token = fromPanel;
    history.replaceState(null, "", location.pathname);
  }
}
let control = null; // ultima resposta de /api/lmu/control
let data = null; // ultimos dados do LMU (standings)
let renderQueued = false;

const logoLoader = LLGLogos.createLoader("/overlay/assets");
const grouper = LLGGroups.createGrouper({ splitClasses: typeof SPLIT_BY_CAR_CLASSES !== "undefined" ? SPLIT_BY_CAR_CLASSES : [] });

// ---------------------------------------------------------------- senha
async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-LLG-Token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
  return out;
}

function setToken(t) {
  token = t || "";
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (_) {}
  document.getElementById("login").hidden = !!token;
  document.getElementById("rc").hidden = !token;
  if (!token) setTimeout(() => document.getElementById("pass").focus(), 0);
}

async function login() {
  const input = document.getElementById("pass");
  try {
    const st = await api("/api/lmu/unlock", { password: input.value });
    input.value = "";
    document.getElementById("loginError").textContent = "";
    setToken(st.token);
    showControl(st);
  } catch (e) {
    document.getElementById("loginError").textContent = e.message;
  }
}

document.getElementById("loginBtn").addEventListener("click", login);
document.getElementById("pass").addEventListener("keydown", (e) => e.key === "Enter" && login());

async function poll() {
  if (!token) return;
  const sent = token;
  try {
    const st = await api("/api/lmu/control");
    if (sent !== token) return;
    if (st.unlocked === false) {
      setToken(""); // acesso esquecido (bloqueado no painel): senha de novo
      return;
    }
    showControl(st);
  } catch (_) {}
}

// ---------------------------------------------------------------- botoes
async function tool(path, body, label) {
  const status = document.getElementById("toolStatus");
  try {
    showControl(await api(path, body));
    status.textContent = label;
  } catch (e) {
    status.textContent = e.message;
  }
}

document.getElementById("fcyBtn").addEventListener("click", () => {
  const on = !(control && control.fcy);
  tool("/api/lmu/fcy", { on }, on ? "FCY ligado." : control && control.greenLeft > 0 ? "FCY encerrado." : "Contagem da bandeira verde.");
});
document.getElementById("scBtn").addEventListener("click", () => {
  const on = !(control && control.sc);
  tool("/api/lmu/sc", { on }, on ? "Safety Car ligado." : "Safety Car encerrado.");
});
// sair: esquece o acesso (no painel tambem, e o mesmo)
document.getElementById("logoutBtn").addEventListener("click", async () => {
  await api("/api/lmu/lock", {}).catch(() => {});
  setToken("");
});
document.getElementById("waveBtn").addEventListener("click", () => tool("/api/lmu/sc/waveby", {}, "Retardatários: nomes em 10 s."));

function showControl(st) {
  control = st;
  notifyNewSlow(st);
  const fcyBtn = document.getElementById("fcyBtn");
  fcyBtn.classList.toggle("on", !!st.fcy);
  fcyBtn.textContent = !st.fcy ? "FCY" : st.greenLeft > 0 ? `VERDE EM ${st.greenLeft} · ENCERRAR JÁ` : "ENCERRAR FCY";
  const scBtn = document.getElementById("scBtn");
  scBtn.classList.toggle("on", !!st.sc);
  scBtn.textContent = st.sc ? "ENCERRAR SAFETY CAR" : "SAFETY CAR";
  document.getElementById("waveBtn").disabled = !st.sc || st.waveLeft > 0;
  document.getElementById("liveBtn").hidden = !st.replayActive;
  queueRender();
}

// ---------------------------------------------------------------- regras
const outOfRace = (e) => e.raceState === 4 || e.raceState === 5 || e.raceState === 6;
const inPit = (e) => {
  const phase = e.pit && e.pit.phase;
  return phase === "in" || phase === "out" || e.pitMode > 0; // listener-lmu.ps1: 1 entrando, 2 no box, 3 saindo, 4 garagem
};
const speedOf = (e) => (typeof e.speedKmh === "number" ? e.speedKmh : typeof e.speedMs === "number" ? e.speedMs * 3.6 : null);
const secs = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1).replace(".", ",")} s`;
const clock = (at) => new Date(at).toLocaleTimeString("pt-BR");
const where = (lap, m) => [lap != null ? `V${lap}` : "", m != null ? `${(m / 1000).toFixed(2).replace(".", ",")} km` : ""].filter(Boolean).join(" · ");
const driver = (num, name) => (num ? `#${num} ` : "") + name;

function formatClock(sec) {
  if (!(sec >= 0)) return "";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const contrastCache = new Map();
function textOn(color) {
  if (!contrastCache.has(color)) {
    const el = document.createElement("div");
    el.style.color = color;
    document.body.appendChild(el);
    const [r, g, b] = (getComputedStyle(el).color.match(/\d+/g) || [0, 0, 0]).map(Number);
    el.remove();
    contrastCache.set(color, 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#000" : "#fff");
  }
  return contrastCache.get(color);
}

function carLogoPaths(entry) {
  const file = LLGDisplay.carLogo(entry.carName) || LLGDisplay.carLogoFromTeam(entry.teamName || "");
  if (!file) return [];
  const light = file.replace(/(\.[a-z0-9]+)?$/i, (ext) => `__light${ext}`);
  return [`cars/${light}`, `cars/${file}`];
}

// ---------------------------------------------------------------- tela
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// quem esta lento ou acima do limite agora
function liveNow(st) {
  const inc = (st && st.incidents) || { slow: [] };
  const breaches = (st && st.breaches) || [];
  return {
    slowLive: new Map(inc.slow.filter((s) => s.live).map((s) => [s.name, s])),
    overLive: new Map(breaches.filter((b) => b.live).map((b) => [b.name, b])),
  };
}

function renderHeader(st) {
  const session = (data && data.session) || {};
  const track = LLGDisplay.trackDisplay(session.trackLocation || "", session.trackVariation || "");
  document.getElementById("rcTrack").textContent = [track.name, track.layout].filter(Boolean).join(" ");
  const flag = document.getElementById("rcFlag");
  let text = "VERDE";
  let cls = "";
  if (st && st.fcy) {
    cls = "fcy";
    text = st.greenLeft > 0 ? `VERDE EM ${st.greenLeft}` : st.countdownLeft > 0 ? `FCY EM ${st.countdownLeft}` : "FCY";
  } else if ((st && st.sc) || session.scOut) {
    cls = "sc";
    text = "SAFETY CAR";
  }
  flag.textContent = text;
  flag.className = `rc-flag ${cls}`;
  document.getElementById("rcClock").textContent = formatClock(session.timeRemainingSec);
}

function cell(row, cls) {
  return row.querySelector(`.${cls}`);
}

function renderRows(st) {
  const rowsEl = document.getElementById("rows");
  const list = ((data && data.standings) || []).filter((e) => e && e.name);
  const ordered = list.slice().sort((a, b) => (outOfRace(a) ? 1 : 0) - (outOfRace(b) ? 1 : 0) || (a.position || 999) - (b.position || 999));
  const multiClass = new Set(ordered.map((e) => grouper.key(e, ordered))).size > 1;
  const t = liveNow(st);
  const scName = st && st.scCar ? st.scCar.name : null;
  const fcyLive = !!(st && st.fcy && !(st.countdownLeft > 0));
  const green = !(st && (st.fcy || st.sc)) && !(data && data.session && data.session.scOut);

  while (rowsEl.children.length > ordered.length) rowsEl.lastChild.remove();
  ordered.forEach((e, i) => {
    let row = rowsEl.children[i];
    if (!row) {
      row = document.createElement("div");
      row.className = "rc-row";
      row.innerHTML = `
        <div class="c-pos"></div>
        <div class="c-cls"></div>
        <div class="c-name"><span></span></div>
        <div class="c-logo"><img alt="" /></div>
        <div class="c-team"><span></span></div>
        <div class="c-speed"></div>
        <div class="c-state"></div>`;
      rowsEl.appendChild(row);
    }
    const dnf = outOfRace(e);
    const pit = inPit(e);
    const isSc = e.name === scName;
    const slowNow = t.slowLive.get(e.name);
    const overNow = t.overLive.get(e.name);
    row.className = "rc-row" + (dnf ? " dnf" : isSc ? " sccar" : slowNow ? " slow" : overNow ? " over" : "");

    cell(row, "c-pos").textContent = dnf ? "-" : String(e.position || i + 1);
    const clsCell = cell(row, "c-cls");
    if (multiClass) {
      const color = LLGDisplay.classColor(grouper.key(e, ordered), null);
      clsCell.textContent = dnf ? "-" : String(grouper.position(e, ordered) || "");
      clsCell.style.backgroundColor = color;
      clsCell.style.color = textOn(color);
    } else {
      clsCell.textContent = "";
      clsCell.style.backgroundColor = "";
    }
    cell(row, "c-name").firstChild.textContent = driver(e.carNumber, e.name);
    cell(row, "c-team").firstChild.textContent = e.teamName || LLGDisplay.carDisplayName(e.carName);

    const img = cell(row, "c-logo").querySelector("img");
    const logoKey = `${e.carName}|${e.teamName}`;
    if (img.dataset.key !== logoKey) {
      img.dataset.key = logoKey;
      const paths = carLogoPaths(e);
      if (paths.length) logoLoader.load(img, paths);
      else logoLoader.hide(img);
    }

    const v = speedOf(e);
    const speed = cell(row, "c-speed");
    speed.textContent = v == null || dnf ? "" : String(Math.round(v));
    speed.className = "c-speed" + (!dnf && !pit && !isSc && v != null ? (fcyLive && v > 60 ? " speed-high" : green && v < 60 ? " speed-low" : "") : "");

    const tags = [];
    if (isSc) tags.push(["sccar", "SAFETY CAR"]);
    if (dnf) tags.push(["dnf", "FORA"]);
    else if (pit) tags.push(["box", "BOX"]);
    if (slowNow) tags.push(["slow", `LENTO ${secs(slowNow.durationMs)}`]);
    if (overNow) tags.push(["over", `ACIMA DE 60 · ${secs(overNow.overMs)}`]);
    const state = cell(row, "c-state");
    const html = tags.map(([c, txt]) => `<span class="tag ${c}">${txt}</span>`).join("");
    if (state.innerHTML !== html) state.innerHTML = html;

  });
}

// infracoes: carro lento, FCY queimado e ultrapassagem com SC/FCY, mais recentes primeiro
function renderLog(st) {
  const inc = (st && st.incidents) || { slow: [], overtakes: [] };
  const items = []
    .concat(
      inc.slow.map((s) => ({
        at: s.at,
        et: s.et,
        cls: "slow" + (s.live ? " live" : ""),
        type: s.live ? "Carro lento (agora)" : "Carro lento",
        lines: [[driver(s.carNumber, s.name), `${s.minKmh} km/h`], [where(s.lap, s.lapDistance), secs(s.durationMs)]],
      })),
      ((st && st.breaches) || []).map((b) => ({
        at: b.at,
        et: b.et,
        cls: "fcy" + (b.live ? " live" : ""),
        type: `FCY ${b.fcy} queimado${b.live ? " (agora)" : ""}`,
        lines: [[driver(b.carNumber, b.name), `máx ${Math.round(b.maxKmh)} km/h`], [`${secs(b.overMs)} acima de 60`, `${secs(b.afterMs)} após a contagem`]],
      })),
      inc.overtakes.map((o) => ({
        at: o.at,
        et: o.et,
        cls: "overtake" + (o.allowed ? " allowed" : ""),
        type: `Ultrapassagem com ${o.under}${o.countdown ? " (na contagem)" : ""}${o.allowed ? " · retardatário liberado" : ""}`,
        lines: [[`${driver(o.passerNumber, o.passer)} passou`, where(o.lap, o.lapDistance)], [driver(o.passedNumber, o.passed), ""]],
      }))
    )
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  const html = items.length
    ? items
        .map(
          (it) => `<div class="lg ${it.cls}"${etAttr(it.et)}>
        <div class="lg-meta"><b>${it.at ? clock(it.at) : ""}</b></div>
        <div class="lg-body"><div class="lg-type">${esc(it.type)}</div>${it.lines
          .map(([l, r]) => `<div class="lg-line"><span>${esc(l)}</span><span class="r">${esc(r)}</span></div>`)
          .join("")}${goHint(it.et)}</div>
      </div>`
        )
        .join("")
    : `<div class="lg-empty">Nenhuma infração nesta corrida.</div>`;
  setHtml("log", html);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const etAttr = (et) => (typeof et === "number" ? ` data-et="${et}"` : "");
const goHint = (et) => (typeof et === "number" ? `<div class="lg-go">▶ ver no replay</div>` : "");

function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

// Forca da batida: o numero e o que o jogo informa, sem unidade documentada. As
// faixas sao uma escala nossa, tirada das batidas vistas em Sebring.
function forceHtml(force) {
  if (force == null) return `<span class="force none">força: sem dado</span>`;
  const [cls, label] = force >= 1500 ? ["high", "forte"] : force >= 500 ? ["mid", "média"] : ["low", "leve"];
  return `<span class="force ${cls}">${Math.round(force).toLocaleString("pt-BR")} · ${label}</span>`;
}

// incidentes do jogo (a lista que o LMU guarda), mais recentes primeiro
function renderGameLog(st) {
  const list = (st && st.gameIncidents) || [];
  const html = list.length
    ? list
        .map(
          (c) => `<div class="lg ${c.wall ? "wall" : "contact"}"${etAttr(c.et)}>
        <div class="lg-meta"><b>${formatClock(c.et)}</b></div>
        <div class="lg-body"><div class="lg-type">${c.wall ? "Batida no muro" : "Contato"}</div>
          <div class="lg-line"><span>${esc(c.player)}</span></div>
          ${c.contactWith ? `<div class="lg-line"><span>× ${esc(c.contactWith)}</span></div>` : ""}
          <div class="lg-line"><span>${forceHtml(c.force)}</span></div>${goHint(c.et)}</div>
      </div>`
        )
        .join("")
    : `<div class="lg-empty">Nenhum incidente informado pelo jogo.</div>`;
  setHtml("gameLog", html);
}

// ---------------------------------------------------------------- replay
// Clicar num aviso leva o replay do LMU ao momento (um pouco antes)
async function goToReplay(et) {
  const status = document.getElementById("toolStatus");
  try {
    showControl(await api("/api/lmu/replay", { et }));
    status.textContent = `Replay em ${formatClock(et)}.`;
  } catch (e) {
    status.textContent = e.message;
  }
}

["log", "gameLog"].forEach((id) =>
  document.getElementById(id).addEventListener("click", (e) => {
    const item = e.target.closest("[data-et]");
    if (item) goToReplay(Number(item.dataset.et));
  })
);

document.getElementById("liveBtn").addEventListener("click", () => tool("/api/lmu/replay/exit", {}, "De volta ao vivo."));

function render() {
  if (!token) return;
  renderHeader(control);
  renderRows(control);
  renderLog(control);
  renderGameLog(control);
}

// ---------------------------------------------------------------- dados ao vivo
function connect() {
  const socket = new WebSocket(WS_URL);
  socket.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    if (msg.type === "standings" && msg.data && msg.data.game === "lmu") {
      data = msg.data;
      queueRender();
    } else if (msg.type === "assetsConfig") {
      logoLoader.setConfig(msg.data || {});
      document.querySelectorAll(".c-logo img").forEach((img) => delete img.dataset.key);
      queueRender();
    }
  });
  socket.addEventListener("close", () => setTimeout(connect, 1000));
}

// ---------------------------------------------------------------- avisos
// Carro lento (abaixo de 40 km/h, ou abaixo de 60 por mais de 3 s): aviso no
// canto da tela, bipe e notificacao do Windows. So o que aparece depois de
// abrir a tela (o que ja estava na lista nao avisa de novo).
const SOUND_KEY = "llgRcSound";
const TOAST_MS = 8000;
let soundOn = true;
try {
  soundOn = localStorage.getItem(SOUND_KEY) !== "0";
} catch (_) {}
let seenSlow = null; // null: ainda nao leu a lista
let audio = null;

function showSoundButton() {
  const btn = document.getElementById("soundBtn");
  btn.textContent = soundOn ? "AVISOS: LIGADOS" : "AVISOS: DESLIGADOS";
  btn.classList.toggle("off", !soundOn);
}

// o navegador so libera som e notificacao depois de um clique na pagina
function unlockAlerts() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch (_) {}
  if (window.Notification && Notification.permission === "default") Notification.requestPermission().catch(() => {});
}
document.addEventListener("click", unlockAlerts);

document.getElementById("soundBtn").addEventListener("click", () => {
  soundOn = !soundOn;
  try {
    localStorage.setItem(SOUND_KEY, soundOn ? "1" : "0");
  } catch (_) {}
  showSoundButton();
});

function beep() {
  if (!audio || audio.state !== "running") return;
  [0, 0.18].forEach((delay) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.25, audio.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + delay + 0.15);
    osc.connect(gain).connect(audio.destination);
    osc.start(audio.currentTime + delay);
    osc.stop(audio.currentTime + delay + 0.16);
  });
}

function toast(title, text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = "<b></b><span></span>";
  el.firstChild.textContent = title;
  el.lastChild.textContent = text;
  document.getElementById("toasts").prepend(el);
  setTimeout(() => el.classList.add("out"), TOAST_MS);
  setTimeout(() => el.remove(), TOAST_MS + 500);
}

function notifyNewSlow(st) {
  const list = (st && st.incidents && st.incidents.slow) || [];
  const key = (s) => `${s.name}|${s.at}`;
  if (seenSlow === null) {
    seenSlow = new Set(list.map(key));
    return;
  }
  list.forEach((s) => {
    if (seenSlow.has(key(s))) return;
    seenSlow.add(key(s));
    const why = s.reason || "abaixo do limite";
    const text = `${driver(s.carNumber, s.name)} · ${s.minKmh} km/h · ${where(s.lap, s.lapDistance)}`;
    toast(`Carro lento: ${why}`, text);
    if (!soundOn) return;
    beep();
    if (window.Notification && Notification.permission === "granted" && document.hidden) {
      try {
        new Notification("Carro lento", { body: text, tag: key(s) });
      } catch (_) {}
    }
  });
}

showSoundButton();
setToken(token);
poll();
setInterval(poll, POLL_MS);
connect();
