const WS_URL = `ws://${location.hostname}:${location.port || 8080}/ws`;
const socket = new WebSocket(WS_URL);

socket.addEventListener("open", () => {
  log("Painel WS conectado");
  refreshStatus();
});

// O servidor avisa quando uma temporada e aplicada, inclusive a que ele
// reaplica sozinho ao abrir. O painel acompanha para mostrar a selecao certa.
socket.addEventListener("message", async (ev) => {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch (_) {
    return;
  }
  // arquivos do painel mudaram (versao nova): recarrega, como o painel novo e as overlays
  if (msg.type === "hello" && msg.panelBuildId) {
    if (window.__panelBuildId && msg.panelBuildId !== window.__panelBuildId) location.reload();
    window.__panelBuildId = msg.panelBuildId;
    return;
  }
  // opacidade da transmissao (do jogo que entrou na sessao, ou de outro painel):
  // os sliders acompanham
  if (msg.type === "overlayCommand" && msg.name === "overlay.setOpacity" && msg.payload) {
    const target = msg.payload.target;
    const ids = { table: ["opTable", "opTableVal"], rows: ["opRows", "opRowsVal"], map: ["opMap", "opMapVal"] }[target];
    const v = Math.round(Math.max(0, Math.min(1, Number(msg.payload.value))) * 100);
    if (ids && Number.isFinite(v)) {
      const slider = document.getElementById(ids[0]);
      if (slider && document.activeElement !== slider) slider.value = v;
      const label = document.getElementById(ids[1]);
      if (label) label.textContent = v + "%";
      if (target === "map") {
        try {
          localStorage.setItem("opMapPanel", String(v));
        } catch (_) {}
      }
    }
    return;
  }
  if (msg.type !== "rltConfig" || !msg.data || !msg.data.seasonId) return;
  const sel = document.getElementById("rltSeason");
  const id = String(msg.data.seasonId);
  if (!Array.from(sel.options).some((o) => o.value === id)) await reloadSeasons();
  sel.value = id;
  if (msg.data.paused) return; // temporada pausada (sessao fora da liga): as classes e logos continuam as da ultima vez
  renderClasses(msg.data.classes || []);
  renderTeamLogos(msg.data.standingsRows || []);
});

function send(name, payload = {}) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "command", name, payload }));
  } else {
    console.warn("Socket ainda nao esta aberto");
  }
}

function setOpacity(target, value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const el = document.getElementById(target === "table" ? "opTableVal" : target === "map" ? "opMapVal" : "opRowsVal");
  if (el) el.textContent = v + "%";
  if (target === "map") {
    try {
      localStorage.setItem("opMapPanel", String(v));
    } catch (_) {}
  }
  send("overlay.setOpacity", { target, value: v / 100 });
}

// o slider do mapa abre na ultima opacidade escolhida
try {
  const savedMap = localStorage.getItem("opMapPanel");
  if (savedMap != null) {
    document.getElementById("opMap").value = savedMap;
    document.getElementById("opMapVal").textContent = savedMap + "%";
  }
} catch (_) {}

// Intensidade do degrade com a cor da equipe nas linhas da tabela.
function setTeamTint(value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const el = document.getElementById("teamTintVal");
  if (el) el.textContent = v + "%";
  try {
    localStorage.setItem("teamTintPanel", String(v));
  } catch (_) {}
  send("overlay.setTeamTint", { value: v / 100 });
}

// ---------------------------------------------------------------- Pilotos sem ligacao
// O servidor diz quem da pista nao ligou com ninguem do RLT e quais pilotos do
// lineup sobraram; aqui da para ligar a mao (ou ignorar o nome).
function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function showLinks(body) {
  if (!body) return;
  const badge = document.getElementById("linksBadge");
  const count = (body.unmatched || []).length;
  badge.hidden = !count;
  badge.textContent = String(count);

  const box = document.getElementById("linksUnmatched");
  if (!body.season) {
    box.innerHTML = '<div class="muted">Aplique uma temporada para ver a ligação dos pilotos.</div>';
  } else if (!count) {
    box.innerHTML = '<div class="muted">Todos os pilotos da pista estão ligados.</div>';
  } else {
    const options = ['<option value="">— escolher piloto do lineup —</option>']
      .concat((body.free || []).map((d) => `<option value="${escapeAttr(d.name)}">${escapeAttr(d.name)}${d.className ? " (" + escapeAttr(d.className) + ")" : ""}</option>`))
      .concat(['<option value="__ignore__">Ignorar este nome</option>'])
      .join("");
    box.innerHTML = body.unmatched
      .map(
        (name) => `<div class="row">
          <label style="min-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeAttr(name)}">${escapeAttr(name)}</label>
          <select data-name="${escapeAttr(name)}" onchange="linkDriver(this)">${options}</select>
        </div>`
      )
      .join("");
  }

  const manual = Object.entries(body.manual || {});
  document.getElementById("linksManual").innerHTML = manual.length
    ? manual
        .map(
          ([name, driver]) => `<div class="row">
            <span style="flex:1">${escapeAttr(name)} → ${driver ? escapeAttr(driver) : '<span class="muted">ignorado</span>'}</span>
            <button data-name="${escapeAttr(name)}" onclick="unlinkDriver(this)">Desfazer</button>
          </div>`
        )
        .join("")
    : '<div class="muted">Nenhum.</div>';
}

async function loadLinks() {
  try {
    showLinks(await api("/api/links"));
  } catch (_) {}
}

async function linkDriver(sel) {
  const name = sel.getAttribute("data-name");
  if (!sel.value) return;
  const driver = sel.value === "__ignore__" ? "" : sel.value;
  try {
    showLinks(await api("/api/links", { method: "POST", body: JSON.stringify({ name, driver }) }));
    log(driver ? `Ligado: ${name} → ${driver}` : `Ignorado: ${name}`);
  } catch (e) {
    log("ERRO ao ligar piloto: " + e.message);
  }
}

async function unlinkDriver(btn) {
  const name = btn.getAttribute("data-name");
  try {
    showLinks(await api("/api/links", { method: "POST", body: JSON.stringify({ name, driver: null }) }));
    log(`Ligação desfeita: ${name}`);
  } catch (e) {
    log("ERRO: " + e.message);
  }
}

// atualiza sozinho; um menu aberto nao e redesenhado no meio da escolha
loadLinks();
setInterval(() => {
  const active = document.activeElement;
  if (active && active.tagName === "SELECT" && active.closest("#linksUnmatched")) return;
  loadLinks();
}, 3000);

// ---------------------------------------------------------------- AMS2: carsets
// O servidor baixa o carset da temporada e instala na pasta do jogo; aqui o
// painel so escolhe a temporada e o modo, e acompanha o andamento.
const CARSET_PHASES = { checking: "Conferindo...", downloading: "Baixando", extracting: "Extraindo os arquivos...", installing: "Copiando para a pasta do jogo..." };
const CARSET_MODES = { clean: "antigas renomeadas para _old_", keep: "antigas mantidas", sameName: "só arquivos de mesmo nome" };
let carsetPoll = null;

async function loadCarsets() {
  const sel = document.getElementById("carsetSeason");
  const status = document.getElementById("carsetStatus");
  try {
    const body = await api("/api/carsets");
    const current = sel.value;
    sel.innerHTML = "";
    (body.seasons || []).forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    // comeca na temporada que esta aplicada no painel, se ela tiver carset
    const applied = document.getElementById("rltSeason");
    const appliedName = applied && applied.selectedOptions[0] && applied.value ? applied.selectedOptions[0].textContent : "";
    const wanted = [current, appliedName].find((n) => n && (body.seasons || []).includes(n));
    if (wanted) sel.value = wanted;
    document.getElementById("carsetGame").textContent = body.gameDir
      ? "Pasta do jogo: " + body.gameDir + (body.gameRunning ? " (o jogo está aberto: feche antes de instalar)" : "")
      : "Automobilista 2 não encontrado nas bibliotecas da Steam.";
    document.getElementById("carsetInstall").disabled = !body.gameDir || !(body.seasons || []).length;
    status.textContent = (body.seasons || []).length ? "" : "Nenhum carset na lista.";
    showCarsetStatus(body.status);
  } catch (e) {
    status.textContent = "Não foi possível ler a lista: " + e.message;
    document.getElementById("carsetInstall").disabled = true;
  }
}

function showCarsetStatus(st) {
  if (!st) return;
  const status = document.getElementById("carsetStatus");
  const result = document.getElementById("carsetResult");
  const btn = document.getElementById("carsetInstall");
  if (st.running) {
    btn.disabled = true;
    status.textContent = `${st.season}: ${CARSET_PHASES[st.phase] || st.phase}${st.phase === "downloading" && st.percent ? " " + st.percent + "%" : ""}`;
    if (!carsetPoll) carsetPoll = setInterval(pollCarset, 700);
    return;
  }
  if (carsetPoll) {
    clearInterval(carsetPoll);
    carsetPoll = null;
    btn.disabled = false;
  }
  if (st.phase === "error") {
    status.textContent = `${st.season}: não instalado. ${st.error}`;
    result.textContent = "";
  } else if (st.phase === "done" && st.result) {
    status.textContent = `${st.season}: instalado (${CARSET_MODES[st.result.mode] || st.result.mode}).`;
    const lines = st.result.cars.map((c) => {
      const parts = [`${c.copied} arquivos copiados`];
      if (c.renamed) parts.push(`${c.renamed} itens antigos renomeados para _old_`);
      if (c.skipped) parts.push(`${c.skipped} não copiados`);
      return `${c.car}: ${parts.join(", ")}`;
    });
    if (st.result.unknown && st.result.unknown.length) lines.push(`Pastas ignoradas (não são carros do jogo): ${st.result.unknown.join(", ")}`);
    result.textContent = lines.join("\n");
  }
}

async function pollCarset() {
  try {
    const body = await api("/api/carsets/status");
    const wasRunning = !!carsetPoll;
    showCarsetStatus(body.status);
    if (wasRunning && !body.status.running) log("Carset " + body.status.season + ": " + (body.status.phase === "done" ? "instalado" : body.status.error));
  } catch (_) {}
}

async function installCarset() {
  const season = document.getElementById("carsetSeason").value;
  const mode = (document.querySelector('input[name="carsetMode"]:checked') || {}).value || "clean";
  if (!season) return;
  document.getElementById("carsetResult").textContent = "";
  try {
    await api("/api/carsets/install", { method: "POST", body: JSON.stringify({ season, mode }) });
    log(`Carset ${season}: instalando...`);
    showCarsetStatus({ running: true, phase: "checking", season, percent: 0 });
  } catch (e) {
    document.getElementById("carsetStatus").textContent = "Não foi possível instalar: " + e.message;
  }
}

loadCarsets();

// Pinturas antigas ("_old_") do AMS2: verificar e apagar de vez (com aviso)
let oldInfo = null;
const mb = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

function showOld(info) {
  oldInfo = info;
  const btn = document.getElementById("oldDeleteBtn");
  const el = document.getElementById("oldStatus");
  btn.disabled = !(info && info.count > 0);
  if (!info) return;
  el.textContent = info.count
    ? `${info.count} ${info.count === 1 ? "item antigo" : "itens antigos"} em ${info.cars} ${info.cars === 1 ? "carro" : "carros"}, ocupando ${mb(info.bytes)}.${info.gameRunning ? " Feche o Automobilista 2 para apagar." : ""}`
    : "Nenhuma pintura antiga (_old_) na pasta do jogo.";
}

async function checkOldLiveries() {
  document.getElementById("oldStatus").textContent = "Verificando...";
  try {
    showOld(await api("/api/carsets/old"));
  } catch (e) {
    document.getElementById("oldStatus").textContent = "Erro: " + e.message;
  }
}

async function deleteOldLiveries() {
  if (!oldInfo || !oldInfo.count) return;
  const ok = window.confirm(
    `Apagar de vez ${oldInfo.count} ${oldInfo.count === 1 ? "pintura antiga" : "pinturas antigas"} (_old_), ${mb(oldInfo.bytes)}?\n\n` +
      "Elas são apagadas da pasta do Automobilista 2 e NÃO vão para a Lixeira: não dá para desfazer.\n" +
      "As pinturas atuais e os arquivos _dist.xml não são tocados."
  );
  if (!ok) return;
  const btn = document.getElementById("oldDeleteBtn");
  btn.disabled = true;
  document.getElementById("oldStatus").textContent = "Apagando...";
  try {
    const r = await api("/api/carsets/old/delete", { method: "POST", body: JSON.stringify({ confirm: true }) });
    showOld(r);
    document.getElementById("oldStatus").textContent =
      `Apagados ${r.deleted} ${r.deleted === 1 ? "item" : "itens"} (${mb(r.bytes)}).` + (r.failed && r.failed.length ? ` Não foi possível apagar: ${r.failed.join("; ")}` : "");
    log(`Pinturas antigas apagadas: ${r.deleted}`);
  } catch (e) {
    document.getElementById("oldStatus").textContent = "Erro: " + e.message;
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- ACC
// Tempo maximo de stint: o servidor guarda a escolha e manda para a tabela.
function showAccStint(body) {
  const minutes = Number(body && body.minutes) || 0;
  document.getElementById("accStintOn").checked = minutes > 0;
  if (minutes > 0) document.getElementById("accStintMin").value = minutes;
  document.getElementById("accStintMin").disabled = !(minutes > 0);
  document.getElementById("accStintStatus").textContent =
    minutes > 0 ? `Limite de ${minutes} min ligado. A coluna "Stint" vira um cronômetro.` : `Sem limite: a coluna "Stint" mostra voltas.`;
}

async function setAccStint() {
  const on = document.getElementById("accStintOn").checked;
  const typed = Math.floor(Number(document.getElementById("accStintMin").value)) || 35;
  try {
    const body = await api("/api/acc/stint", { method: "POST", body: JSON.stringify({ minutes: on ? Math.max(1, typed) : 0 }) });
    showAccStint(body);
    log(body.minutes > 0 ? `ACC: stint máximo de ${body.minutes} min` : "ACC: sem stint máximo");
  } catch (e) {
    log("ERRO stint: " + e.message);
  }
}

api("/api/acc/stint").then(showAccStint).catch(() => {});

// ---------------------------------------------------------------- LMU
// Direcao de prova (aba LMU, com senha). O desbloqueio vale ate fechar o
// painel: o servidor devolve um token, guardado so na memoria desta pagina.
// o acesso fica salvo neste PC (o servidor tambem lembra) ate "Bloquear a aba"
const LMU_TOKEN_KEY = "llgLmuToken";
let lmuTokenValue = "";
try {
  lmuTokenValue = localStorage.getItem(LMU_TOKEN_KEY) || "";
} catch (_) {}
function setLmuToken(t) {
  lmuTokenValue = t || "";
  try {
    if (lmuTokenValue) localStorage.setItem(LMU_TOKEN_KEY, lmuTokenValue);
    else localStorage.removeItem(LMU_TOKEN_KEY);
  } catch (_) {}
}
let lmuFcyOn = false; // com FCY ou SC ligado o painel atualiza a cada segundo
let lmuScOn = false;
const lmuApi = (path, body) => {
  const headers = { "Content-Type": "application/json", "X-LLG-Token": lmuTokenValue };
  return api(path, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
};

function showLmuControl(st) {
  if (st.unlocked === false) setLmuToken(""); // acesso esquecido (bloqueado): pede a senha de novo
  lmuFcyOn = !!st.fcy;
  lmuScOn = !!(st.sc || st.scIn);
  const by = (who) => (who && who !== "painel" ? ` (mandado no chat por ${who})` : "");
  document.getElementById("lmuFcyNow").textContent = st.fcy ? `FCY ligado agora${by(st.fcyBy)}.` : st.sc ? `Safety Car ligado agora${by(st.scBy)}.` : "";
  if (st.follow) document.getElementById("lmuFollow").checked = !!st.follow.enabled;
  const unlocked = !!lmuTokenValue;
  document.getElementById("lmuLocked").hidden = unlocked;
  document.getElementById("lmuUnlocked").hidden = !unlocked;
  if (!unlocked) return;
  const btn = document.getElementById("fcyBtn");
  btn.classList.toggle("on", !!st.fcy);
  btn.textContent = !st.fcy ? "FCY" : st.greenLeft > 0 ? `${st.greenLeft}S PARA VERDE · ENCERRAR JÁ` : "ENCERRAR FCY";
  const scBtn = document.getElementById("scBtn");
  scBtn.classList.toggle("on", !!(st.sc || st.scIn));
  scBtn.textContent = st.scIn ? "SC NESSA VOLTA · BANDEIRA VERDE AGORA" : st.sc ? "ENCERRAR SAFETY CAR" : "SAFETY CAR";
  document.getElementById("waveBtn").disabled = !st.sc || st.waveLeft > 0;
  if (st.scCar) showScCar(st.scCar);
  document.getElementById("waveStatus").textContent =
    st.waveLeft > 0
      ? `Nomes dos retardatários em ${st.waveLeft} s.`
      : st.waveLast
        ? st.waveLast.names.length
          ? `Podem ultrapassar: ${st.waveLast.names.join(", ")}.`
          : "Nenhum retardatário entre o SC e o líder."
        : "";
  document.getElementById("fcyStatus").textContent = !st.fcy ? "" : st.greenLeft > 0 ? `Bandeira verde em ${st.greenLeft} s (o limite de ${st.limitKmh} km/h vale até lá).` : st.countdownLeft > 0 ? `FCY ligado: limite de ${st.limitKmh} km/h vale em ${st.countdownLeft} s.` : `FCY ligado: limite de ${st.limitKmh} km/h valendo.`;
  showFcyBreaches(st.breaches || []);
  const cd = document.getElementById("lmuCountdown");
  if (st.countdownSec != null && document.activeElement !== cd) cd.value = st.countdownSec;
  const chatLag = document.getElementById("lmuChatLag");
  if (st.chatLagSec != null && document.activeElement !== chatLag) chatLag.value = st.chatLagSec;
  const green = document.getElementById("lmuGreen");
  if (st.greenSec != null && document.activeElement !== green) green.value = st.greenSec;
  if (st.chatCountdown != null) document.getElementById("lmuChatCountdown").checked = !!st.chatCountdown;
  if (st.messages) {
    // nao atropela o que esta sendo digitado
    const on = document.getElementById("lmuMsgOn");
    const off = document.getElementById("lmuMsgOff");
    if (document.activeElement !== on) on.value = st.messages.fcyOn;
    if (document.activeElement !== off) off.value = st.messages.fcyOff;
    const ending = document.getElementById("lmuMsgEnding");
    if (document.activeElement !== ending) ending.value = st.messages.fcyEnding || "";
    const go = document.getElementById("lmuMsgGo");
    if (document.activeElement !== go) go.value = st.messages.fcyGo || "";
    const scOn = document.getElementById("lmuMsgScOn");
    const scOff = document.getElementById("lmuMsgScOff");
    if (document.activeElement !== scOn) scOn.value = st.messages.scOn || "";
    if (document.activeElement !== scOff) scOff.value = st.messages.scOff || "";
    [["lmuMsgFcyTick", "fcyTick"], ["lmuMsgGreenTick", "greenTick"], ["lmuMsgScCatch", "scCatch"], ["lmuMsgScWave", "scWave"], ["lmuMsgScWaveDriver", "scWaveDriver"]].forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (document.activeElement !== el) el.value = st.messages[key] || "";
    });
  }
}

// tempo em segundos com uma casa ("3,2 s")
const fcySecs = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1).replace(".", ",")} s`;

function showFcyBreaches(list) {
  const body = document.querySelector("#fcyBreaches tbody");
  body.innerHTML = "";
  list.forEach((b) => {
    const tr = document.createElement("tr");
    tr.className = b.live ? "live" : "";
    [String(b.fcy), (b.carNumber ? `#${b.carNumber} ` : "") + b.name, fcySecs(b.overMs), fcySecs(b.afterMs), `${Math.round(b.maxKmh)} km/h`].forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i >= 2) td.className = "n";
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
  document.getElementById("fcyBreaches").hidden = !list.length;
  document.getElementById("fcyNoBreach").hidden = !!list.length;
}

async function lmuSaveFollow() {
  try {
    const body = await api("/api/lmu/follow", {
      method: "POST",
      body: JSON.stringify({ enabled: document.getElementById("lmuFollow").checked }),
    });
    log(body.follow.enabled ? "LMU: seguindo o FCY e o SC do chat" : "LMU: não segue o FCY e o SC do chat");
  } catch (e) {
    log("ERRO seguir chat: " + e.message);
  }
}

// ---- audios da contagem e dos avisos: vale so para este PC
function showVoice(st) {
  document.getElementById("voiceOn").checked = !!st.on;
  const vol = document.getElementById("voiceVolume");
  if (document.activeElement !== vol) vol.value = st.volume;
  document.getElementById("voiceStatus").textContent = st.failed ? "Não foi possível iniciar os áudios." : "";
}

async function saveVoice() {
  try {
    showVoice(
      await api("/api/voice", {
        method: "POST",
        body: JSON.stringify({ on: document.getElementById("voiceOn").checked, volume: Number(document.getElementById("voiceVolume").value) }),
      })
    );
  } catch (e) {
    log("ERRO voz: " + e.message);
  }
}

async function testVoice() {
  try {
    showVoice(await api("/api/voice/test", { method: "POST", body: "{}" }));
  } catch (e) {
    log("ERRO voz: " + e.message);
  }
}

api("/api/voice").then(showVoice).catch(() => {});

async function lmuUnlock() {
  const input = document.getElementById("lmuPass");
  const status = document.getElementById("lmuLockStatus");
  try {
    const st = await api("/api/lmu/unlock", { method: "POST", body: JSON.stringify({ password: input.value }) });
    setLmuToken(st.token);
    input.value = "";
    status.textContent = "";
    showLmuControl(st);
  } catch (e) {
    status.textContent = e.message;
  }
}

async function lmuLock() {
  await lmuApi("/api/lmu/lock", {}).catch(() => {});
  setLmuToken("");
  api("/api/lmu/control").then(showLmuControl).catch(() => {});
}

// tela de direcao de prova no navegador: leva o acesso junto (sem pedir a senha de novo)
function lmuOpenDirecao() {
  window.open("/panel/direcao.html" + (lmuTokenValue ? "#t=" + encodeURIComponent(lmuTokenValue) : ""));
}

async function lmuToggleFcy() {
  const btn = document.getElementById("fcyBtn");
  const on = !btn.classList.contains("on");
  btn.disabled = true;
  try {
    const st = await lmuApi("/api/lmu/fcy", { on });
    showLmuControl(st);
    log(on ? "LMU: FCY ligado" : st.fcy ? `LMU: bandeira verde em ${st.greenLeft} s` : "LMU: FCY encerrado");
  } catch (e) {
    document.getElementById("fcyStatus").textContent = e.message;
    log("ERRO FCY: " + e.message);
  } finally {
    btn.disabled = false;
  }
}

async function lmuToggleSc() {
  const btn = document.getElementById("scBtn");
  const on = !btn.classList.contains("on");
  btn.disabled = true;
  try {
    showLmuControl(await lmuApi("/api/lmu/sc", { on }));
    log(on ? "LMU: Safety Car" : "LMU: Safety Car encerrado");
  } catch (e) {
    document.getElementById("fcyStatus").textContent = e.message;
    log("ERRO Safety Car: " + e.message);
  } finally {
    btn.disabled = false;
  }
}

// Carro do safety car: automatico (o unico LMGTE) ou um piloto da sessao
function showScCar(info) {
  const sel = document.getElementById("lmuScCar");
  const autoText = info.auto && info.name ? `Automático (LMGTE): ${info.name}` : `Automático (LMGTE): ${info.problem || "sem dados do LMU"}`;
  const options = [["", autoText]].concat(info.drivers.map((d) => [d.name, `${d.carNumber ? "#" + d.carNumber + " " : ""}${d.name}${d.carClass ? " · " + d.carClass : ""}`]));
  // escolhido que saiu da sessao continua na lista (o servidor volta ao automatico)
  if (info.chosen && !info.drivers.some((d) => d.name === info.chosen)) options.push([info.chosen, `${info.chosen} (fora da sessão)`]);
  const key = JSON.stringify(options);
  if (sel.dataset.key !== key && document.activeElement !== sel) {
    sel.dataset.key = key;
    sel.innerHTML = "";
    options.forEach(([value, text]) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      sel.appendChild(opt);
    });
  }
  if (document.activeElement !== sel) sel.value = info.chosen || "";
  document.getElementById("lmuScCarHint").textContent = info.name
    ? `Safety Car: ${info.name}. Ele não conta como líder, não entra na lista de retardatários nem em "quem queimou o FCY".`
    : `Sem carro do SC (${info.problem}): escolha o piloto do Safety Car. Sem ele, a fila vai até meia volta à frente do líder.`;
}

async function lmuSetScCar() {
  try {
    showLmuControl(await lmuApi("/api/lmu/sc/car", { name: document.getElementById("lmuScCar").value }));
  } catch (e) {
    log("ERRO carro do SC: " + e.message);
  }
}

async function lmuWaveBy() {
  const btn = document.getElementById("waveBtn");
  btn.disabled = true;
  try {
    showLmuControl(await lmuApi("/api/lmu/sc/waveby", {}));
    log("LMU: retardatários podem ultrapassar");
  } catch (e) {
    document.getElementById("waveStatus").textContent = e.message;
    log("ERRO retardatários: " + e.message);
    btn.disabled = false;
  }
}

async function lmuSaveMessages() {
  try {
    showLmuControl(
      await lmuApi("/api/lmu/messages", {
        fcyOn: document.getElementById("lmuMsgOn").value,
        fcyOff: document.getElementById("lmuMsgOff").value,
        countdownSec: document.getElementById("lmuCountdown").value,
        fcyGo: document.getElementById("lmuMsgGo").value,
        fcyEnding: document.getElementById("lmuMsgEnding").value,
        fcyTick: document.getElementById("lmuMsgFcyTick").value,
        greenTick: document.getElementById("lmuMsgGreenTick").value,
        greenSec: document.getElementById("lmuGreen").value,
        chatLagSec: document.getElementById("lmuChatLag").value,
        scOn: document.getElementById("lmuMsgScOn").value,
        scOff: document.getElementById("lmuMsgScOff").value,
        scCatch: document.getElementById("lmuMsgScCatch").value,
        scWave: document.getElementById("lmuMsgScWave").value,
        scWaveDriver: document.getElementById("lmuMsgScWaveDriver").value,
        chatCountdown: document.getElementById("lmuChatCountdown").checked,
      })
    );
  } catch (e) {
    log("ERRO mensagens: " + e.message);
  }
}

lmuApi("/api/lmu/control").then(showLmuControl).catch(() => {}); // com o acesso salvo, ja abre desbloqueada
// sessao nova desliga o FCY no servidor: o botao acompanha. Com FCY ligado,
// a cada segundo (contagem e quem esta acima do limite agora)
let lmuPollTick = 0;
setInterval(() => {
  lmuPollTick++;
  // desbloqueado (direcao de prova), FCY ou SC: a cada segundo; senao a cada 5 s
  if (!lmuTokenValue && !lmuFcyOn && !lmuScOn && lmuPollTick % 5) return;
  if (document.getElementById("fcyBtn").disabled) return;
  // resposta de um pedido feito antes de desbloquear (ou bloquear) nao vale mais
  const sentToken = lmuTokenValue;
  lmuApi("/api/lmu/control")
    .then((st) => sentToken === lmuTokenValue && showLmuControl(st))
    .catch(() => {});
}, 1000);

// Bateria mostrada no cabecalho da tabela (CORRIDA 2, QUALI 1): automatico
// (vazio), 0 = sem numero, ou o numero escolhido
function setHeat() {
  const read = (id) => {
    const v = document.getElementById(id).value;
    return v === "" ? null : Number(v);
  };
  const value = { race: read("heatRace"), quali: read("heatQuali") };
  try {
    localStorage.setItem("heatPanel", JSON.stringify(value));
  } catch (_) {}
  send("overlay.setHeat", value);
}

// os menus abrem na ultima escolha
try {
  const savedHeat = JSON.parse(localStorage.getItem("heatPanel") || "null");
  if (savedHeat) {
    document.getElementById("heatRace").value = savedHeat.race == null ? "" : String(savedHeat.race);
    document.getElementById("heatQuali").value = savedHeat.quali == null ? "" : String(savedHeat.quali);
  }
} catch (_) {}

// Pagina de disputas (tecla 9): a tabela toda (0,3 s) ou so o piloto assistido (0,5 s)
function setBattleScope(value) {
  try {
    localStorage.setItem("battleScopePanel", value);
  } catch (_) {}
  send("overlay.setBattleScope", { value });
}

// ---------------------------------------------------------------- mapa da pista
async function showTrackMapStatus() {
  try {
    const { map } = await api("/api/trackmap");
    document.getElementById("mapStatus").textContent = !map
      ? "Sem pista carregada agora."
      : map.ready
        ? map.saved
          ? "Mapa desta pista salvo."
          : "Mapa desta pista pronto e salvo."
        : `Aprendendo o mapa desta pista: ${Math.round((map.coverage || 0) * 100)}%`;
  } catch (_) {}
}

async function forgetTrackMap() {
  if (!window.confirm("Apagar o mapa salvo desta pista e aprender de novo com os carros na pista?")) return;
  try {
    await api("/api/trackmap/forget", { method: "POST", body: "{}" });
    log("Mapa da pista apagado: aprendendo de novo");
    showTrackMapStatus();
  } catch (e) {
    log("ERRO mapa: " + e.message);
  }
}

showTrackMapStatus();
setInterval(showTrackMapStatus, 10000);

// ---------------------------------------------------------------- fotos dos pilotos
// Pasta local das fotos do driver card (server/avatars.js)
function showAvatars(body) {
  document.getElementById("avatarsPath").value = body.path || "";
  document.getElementById("avatarsStatus").textContent = !body.exists
    ? "Pasta não encontrada."
    : `${body.count} ${body.count === 1 ? "foto" : "fotos"} na pasta${body.isDefault ? " (pasta padrão)" : ""}.`;
}

async function saveAvatarsPath(useDefault) {
  try {
    const p = useDefault ? "" : document.getElementById("avatarsPath").value.trim();
    showAvatars(await api("/api/avatars/path", { method: "POST", body: JSON.stringify({ path: p }) }));
    log("Pasta das fotos dos pilotos salva");
  } catch (e) {
    document.getElementById("avatarsStatus").textContent = "Erro: " + e.message;
  }
}

async function openAvatarsFolder() {
  try {
    await api("/api/avatars/open", { method: "POST", body: "{}" });
  } catch (e) {
    document.getElementById("avatarsStatus").textContent = "Erro: " + e.message;
  }
}

api("/api/avatars").then(showAvatars).catch(() => {});

// ---------------------------------------------------------------- rede local
// Overlays em outros aparelhos da mesma rede: link e QR code do mini painel
// (overlay/menu.html), com o endereco deste PC

function showLan(body) {
  document.getElementById("lanOverlays").checked = !!body.enabled;
  const links = document.getElementById("lanLinks");
  const ip = (body.addresses || [])[0];
  if (!body.enabled) {
    links.innerHTML = "";
    document.getElementById("lanStatus").textContent = "Desligado: as overlays só abrem neste computador.";
    return;
  }
  if (!ip) {
    links.innerHTML = "";
    document.getElementById("lanStatus").textContent = "Ligado, mas este computador não está conectado a nenhuma rede.";
    return;
  }
  // mini painel (overlay/menu.html): o outro aparelho escolhe a tabela la
  const url = `http://${ip}:${body.port}/overlay/menu.html`;
  links.innerHTML = `
    <div class="row"><label class="muted" style="min-width:150px">Mini painel</label><input id="lanMenu" type="text" readonly value="${escapeAttr(url)}" onclick="this.select()" /><button onclick="copyLink('lanMenu')">Copiar</button></div>
    <div style="display:flex; gap:14px; align-items:center; margin-top:8px">
      <img src="/api/lan/qr.svg?ip=${encodeURIComponent(ip)}&t=${Date.now()}" alt="QR code do mini painel" style="width:170px; height:170px; background:#fff; border-radius:6px" />
      <div class="muted">Aponte a câmera do celular para o QR code: abre o mini painel, onde se escolhe qual tabela mostrar naquele aparelho.</div>
    </div>`;
  const others = (body.addresses || []).slice(1);
  document.getElementById("lanStatus").textContent =
    "Os dois aparelhos precisam estar na mesma rede. Se não abrir, libere o LLG Overlay no Firewall do Windows para redes privadas." +
    (others.length ? ` Outros endereços deste PC: ${others.join(", ")}.` : "");
}

async function setLan(on) {
  try {
    showLan(await api("/api/lan", { method: "POST", body: JSON.stringify({ enabled: !!on }) }));
    log(on ? "Overlays liberadas para a rede local" : "Overlays só neste computador");
  } catch (e) {
    log("ERRO rede local: " + e.message);
  }
}

api("/api/lan").then(showLan).catch(() => {});

// Limite de 30 FPS nas overlays (shared/framecap.js)
function setMaxFps(on) {
  try {
    localStorage.setItem("maxFpsPanel", on ? "1" : "0");
  } catch (_) {}
  send("overlay.setMaxFps", { value: on ? 30 : 0 });
}

try {
  document.getElementById("maxFps30").checked = localStorage.getItem("maxFpsPanel") === "1";
} catch (_) {}

// Tabela completa: manter o piloto em foco no meio da lista
function setFullCenter(on) {
  try {
    localStorage.setItem("fullCenterPanel", on ? "1" : "0");
  } catch (_) {}
  send("overlay.setFullCenter", { value: !!on });
}

try {
  document.getElementById("fullCenter").checked = localStorage.getItem("fullCenterPanel") === "1";
} catch (_) {}

// o menu abre na ultima escolha
try {
  const savedScope = localStorage.getItem("battleScopePanel");
  if (savedScope) document.getElementById("battleScope").value = savedScope;
} catch (_) {}

// o slider abre na ultima intensidade escolhida
try {
  const saved = localStorage.getItem("teamTintPanel");
  if (saved != null) {
    document.getElementById("teamTint").value = saved;
    document.getElementById("teamTintVal").textContent = saved + "%";
  }
} catch (_) {}

function log(msg) {
  const el = document.getElementById("rltLog");
  if (!el) return;
  const t = new Date().toLocaleTimeString();
  el.textContent = `[${t}] ${msg}\n` + el.textContent;
  console.log("[panel]", msg);
}

// Assetto Corsa 1: instala o app do jogo (so quando o botao e clicado)
async function installAcApp() {
  const btn = document.getElementById("acInstallBtn");
  const status = document.getElementById("acInstallStatus");
  btn.disabled = true;
  status.textContent = "Instalando...";
  try {
    const r = await api("/api/ac/install", { method: "POST" });
    let msg = r.copied || r.enabled ? "Instalado em " + r.gameDir + "." : "Já estava instalado e atualizado em " + r.gameDir + ".";
    if (!r.active) msg += " O app está desligado no jogo: ative \"LLG Overlay\" em Opções > Geral > UI Modules.";
    else if (r.copied || r.enabled) msg += " Se o jogo estiver numa sessão, entre nela de novo.";
    status.textContent = msg;
    log("Assetto Corsa 1: " + msg);
  } catch (err) {
    status.textContent = err.message;
    log("Assetto Corsa 1: " + err.message);
  }
  btn.disabled = false;
}

// Estado da chave e da temporada, em palavras (aba Configuracao)
function showRltStatus(st) {
  const el = document.getElementById("rltStatus");
  if (!el) return;
  if (!st || !st.hasKey) {
    el.textContent = "Sem chave salva: a tabela usa só os dados do jogo.";
    return;
  }
  const parts = ["Chave salva"];
  if (st.leagueName) parts.push("liga " + st.leagueName);
  parts.push(st.selectedSeasonId ? "temporada aplicada" : "nenhuma temporada aplicada");
  // cache do RLT (server/rltCache.js): requisicoes de hoje e bloqueio pelo limite da API
  const c = st.cache;
  if (c) {
    parts.push(`${c.requestsToday} requisições à API hoje`);
    if (c.blocked) {
      const until = c.blockedUntil ? new Date(c.blockedUntil).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
      parts.push(`limite da API atingido: usando os dados salvos${until ? " até " + until : ""}`);
    }
  }
  el.textContent = parts.join(" · ");
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function renderSeasons(seasons) {
  const sel = document.getElementById("rltSeason");
  const cur = sel.value;
  sel.innerHTML = '<option value="">Sem temporada</option>';
  (seasons || []).forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.seasonId;
    const n = s.classes ? s.classes.length : 0;
    // temporada do backup do Drive (sem a API): o servidor nao sabe as classes antes de abrir
    opt.textContent = s.backup ? `${s.seasonName} (backup)` : `${s.seasonName} (${n} classes)`;
    sel.appendChild(opt);
  });
  if (cur) sel.value = cur;
}

function renderClasses(classes) {
  const box = document.getElementById("rltClasses");
  if (!classes || !classes.length) {
    box.innerHTML = '<span class="muted">Sem RacingClasses nesta season</span>';
    return;
  }
  box.innerHTML = classes
    .map((c) => {
      const bg = c.color || "#444";
      return `<span class="class-chip" style="background:${bg};color:#fff">${c.name || c.uniqueName}</span>`;
    })
    .join("");
}

async function saveKey() {
  const apiKey = document.getElementById("rltKey").value.trim();
  if (!apiKey) return log("Cole a API key");
  try {
    log("Salvando key e buscando seasons…");
    const body = await api("/api/rlt/key", {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    });
    log(`League ok. Seasons ativas: ${(body.seasons || []).length}`);
    renderSeasons(body.seasons || []);
    showRltStatus(body.status || {});
    loadTrackStats();
  } catch (e) {
    log("ERRO key: " + e.message);
  }
}

async function reloadSeasons() {
  try {
    log("Recarregando seasons…");
    const body = await api("/api/rlt/seasons");
    log(`Seasons: ${(body.seasons || []).length}`);
    if (body.apiError) log("API do RLT indisponível: " + body.apiError + " (as temporadas do backup continuam valendo)");
    renderSeasons(body.seasons || []);
  } catch (e) {
    log("ERRO seasons: " + e.message);
  }
}

// Logos de equipe: um menu com as equipes da temporada e um campo para o
// arquivo da equipe escolhida.
const teamLogoTyped = {}; // equipe -> ultimo arquivo digitado nesta sessao do painel

function renderTeamLogos(rows) {
  const box = document.getElementById("teamLogos");
  if (!box) return;
  const teams = [];
  const seen = new Set();
  (rows || []).forEach((r) => {
    const t = r.teamName;
    if (!t || seen.has(t)) return;
    seen.add(t);
    teams.push(t);
  });
  teams.sort((a, b) => a.localeCompare(b));
  if (!teams.length) {
    box.innerHTML = '<span class="muted">Nenhuma equipe na season</span>';
    return;
  }
  const previous = (document.getElementById("teamLogoSelect") || {}).value;
  box.innerHTML = `<div class="row">
      <select id="teamLogoSelect" onchange="showTeamLogo()"></select>
    </div>
    <div class="row">
      <input id="teamLogoFile" type="text" placeholder="arquivo.png (vazio=padrão)" />
      <button onclick="saveTeamLogo()">OK</button>
    </div>`;
  const sel = document.getElementById("teamLogoSelect");
  teams.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    sel.appendChild(opt);
  });
  if (previous && teams.includes(previous)) sel.value = previous;
  showTeamLogo();
}

function showTeamLogo() {
  const sel = document.getElementById("teamLogoSelect");
  const input = document.getElementById("teamLogoFile");
  if (!sel || !input) return;
  input.value = teamLogoTyped[sel.value] || "";
}

function saveTeamLogo() {
  const sel = document.getElementById("teamLogoSelect");
  const input = document.getElementById("teamLogoFile");
  if (!sel || !input || !sel.value) return;
  const teamName = sel.value;
  const file = (input.value || "").trim() || null;
  teamLogoTyped[teamName] = file || "";
  send("overlay.setTeamLogo", { teamName, file });
  log(file ? `Logo ${teamName} → ${file}` : `Logo ${teamName} → padrão`);
}

async function applySeason() {
  const seasonId = document.getElementById("rltSeason").value;
  try {
    if (!seasonId) {
      log("Modo só jogo (sem season RLT)…");
      const body = await api("/api/rlt/season", {
        method: "POST",
        body: JSON.stringify({ seasonId: null }),
      });
      renderClasses([]);
      renderTeamLogos([]);
      showRltStatus(body.status || {});
      log("OK — overlay usa apenas dados do AMS2");
      return;
    }
    log(`Aplicando season ${seasonId}…`);
    const body = await api("/api/rlt/season", {
      method: "POST",
      // temporada do backup do Drive: o id e "drive:<pasta>", nao um numero
      body: JSON.stringify({ seasonId: /^drive:/.test(seasonId) ? seasonId : Number(seasonId) }),
    });
    const p = body.payload || {};
    const nDrivers = Array.isArray(p.drivers) ? p.drivers.length : Object.keys(p.drivers || {}).length;
    log(`Season aplicada: ${p.seasonName} | classes=${(p.classes || []).length} | drivers=${nDrivers}`);
    renderClasses(p.classes || []);
    renderTeamLogos(p.standingsRows || []);
    showRltStatus(body.status || {});
  } catch (e) {
    log("ERRO season: " + e.message);
  }
}




async function clearRlt() {
  try {
    await api("/api/rlt/clear", { method: "POST", body: "{}" });
    document.getElementById("rltKey").value = "";
    document.getElementById("rltSeason").innerHTML = '<option value="">Sem temporada</option>';
    document.getElementById("rltClasses").innerHTML = "";
    document.getElementById("rltStatus").textContent = "";
    renderTeamLogos([]);
    log("RLT limpo");
  } catch (e) {
    log("ERRO clear: " + e.message);
  }
}

function showAssetsBaseStatus(body) {
  const el = document.getElementById("assetsBaseStatus");
  const input = document.getElementById("assetsBaseUrl");
  if (!el) return;
  if (input) input.value = body.baseUrl || "";
  el.textContent = body.baseUrl
    ? `Online primeiro: ${body.baseUrl} (v=${body.cacheBust || "—"}). Reserva: pasta local.`
    : "Usando só a pasta local do projeto";
}

async function loadAssetsBase() {
  try {
    const body = await api("/api/assets/base");
    showAssetsBaseStatus(body);
  } catch (_) {}
}

async function saveAssetsBase() {
  try {
    const u = (document.getElementById("assetsBaseUrl").value || "").trim();
    const body = await api("/api/assets/base", {
      method: "POST",
      body: JSON.stringify({ baseUrl: u || "" }),
    });
    showAssetsBaseStatus(body);
    log(body.baseUrl ? "Logos: " + body.baseUrl : "Logos: local");
  } catch (e) {
    log("ERRO assets: " + e.message);
  }
}

async function resetAssetsBase() {
  document.getElementById("assetsBaseUrl").value = "";
  await saveAssetsBase();
}

// Primeira vez: sem chave salva, o painel pede a chave antes de tudo.
function showFirstRun(show) {
  document.getElementById("firstRun").style.display = show ? "flex" : "none";
  if (show) document.getElementById("firstRunKey").focus();
}

function skipFirstRun() {
  try {
    localStorage.setItem("skipFirstRun", "1"); // escolheu usar sem chave: nao pergunta mais (a chave fica em Ajustes > Liga)
  } catch (_) {}
  showFirstRun(false);
}

async function saveFirstRunKey() {
  const apiKey = document.getElementById("firstRunKey").value.trim();
  const status = document.getElementById("firstRunStatus");
  if (!apiKey) {
    status.textContent = "Cole a chave primeiro.";
    return;
  }
  const btn = document.getElementById("firstRunBtn");
  btn.disabled = true;
  status.textContent = "Conferindo a chave...";
  try {
    const body = await api("/api/rlt/key", { method: "POST", body: JSON.stringify({ apiKey }) });
    document.getElementById("firstRunKey").value = "";
    status.textContent = "";
    showFirstRun(false);
    log(`Chave salva. Seasons ativas: ${(body.seasons || []).length}`);
    renderSeasons(body.seasons || []);
    showRltStatus(body.status || {});
    loadTrackStats();
  } catch (e) {
    status.textContent = "Não funcionou: " + e.message;
  }
  btn.disabled = false;
}

async function refreshStatus() {
  try {
    const body = await api("/api/rlt/status");
    showRltStatus(body);
    let skipped = false;
    try {
      skipped = localStorage.getItem("skipFirstRun") === "1";
    } catch (_) {}
    showFirstRun(!body.hasKey && !skipped);
    // com ou sem chave: as temporadas do backup do Drive funcionam sem a API
    await reloadSeasons();
    // a temporada aplicada (inclusive a reaplicada ao abrir) aparece selecionada
    if (body.selectedSeasonId) document.getElementById("rltSeason").value = String(body.selectedSeasonId);
  } catch (_) {}
  loadAssetsBase();
}

// ---------------------------------------------------------------- alternancia automatica
// Colunas da tabela rodando sozinhas. O servidor guarda a escolha e faz a troca.
function showAlternateSeconds(value) {
  document.getElementById("altSecondsVal").textContent = `${value} s`;
}

function showAlternate(body) {
  document.getElementById("altEnabled").checked = !!body.enabled;
  document.getElementById("altSeconds").value = body.seconds;
  showAlternateSeconds(body.seconds);
}

async function setAlternate() {
  try {
    const body = await api("/api/overlay/alternate", {
      method: "POST",
      body: JSON.stringify({
        enabled: document.getElementById("altEnabled").checked,
        seconds: Number(document.getElementById("altSeconds").value),
      }),
    });
    showAlternate(body);
    log(body.enabled ? `Alternando posições e pontuação a cada ${body.seconds} s` : "Alternância desligada");
  } catch (e) {
    log("ERRO alternância: " + e.message);
  }
}

api("/api/overlay/alternate").then(showAlternate).catch(() => {});

// ---------------------------------------------------------------- links das overlays
function fillLinks() {
  const base = `http://localhost:${location.port || 8080}`;
  document.getElementById("linkTable").value = `${base}/overlay/timing-table.html`;
  document.getElementById("linkCard").value = `${base}/overlay/driver-card.html`;
  document.getElementById("linkMap").value = `${base}/overlay/track-map.html`;
  document.getElementById("linkDriver").value = `${base}/overlay/driver-table.html`;
  document.getElementById("linkTrackStats").value = `${base}/overlay/track-stats.html`;
  document.getElementById("linkFull").value = `${base}/overlay/full-timing.html`;
}

// ---------------------------------------------------------------- estatisticas da pista
function showTrackStats(body) {
  const keySel = document.getElementById("tsKey");
  keySel.innerHTML = (body.multiseasons || [])
    .map((m) => `<option value="${escapeAttr(m.key)}">${escapeAttr(m.name)}</option>`)
    .join("");
  if (!body.multiseasons || !body.multiseasons.length) keySel.innerHTML = `<option value="">All Seasons</option>`;
  keySel.value = body.key || "";
  document.getElementById("tsStat").value = body.stat || "winners";
  const trackSel = document.getElementById("tsTrack");
  const tracks = (body.tracks || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  trackSel.innerHTML =
    `<option value="">Automático (pista do jogo)</option>` +
    tracks.map((t) => `<option value="${t.trackId}">${escapeAttr(t.name)}${t.totalEvents ? "" : " (sem etapas)"}</option>`).join("");
  trackSel.value = body.trackId != null ? String(body.trackId) : "";
  document.getElementById("tsStatus").textContent = !body.hasKey
    ? "Precisa da chave do RLT."
    : body.error
      ? "Erro ao ler o RLT: " + body.error
      : `${tracks.length} pistas neste multiseason.`;
}

async function loadTrackStats() {
  try {
    showTrackStats(await api("/api/trackstats"));
  } catch (e) {
    document.getElementById("tsStatus").textContent = "Erro: " + e.message;
  }
}

async function setTrackStats(patch) {
  try {
    if (patch.trackId === "") patch.trackId = null;
    await api("/api/trackstats", { method: "POST", body: JSON.stringify(patch) });
    await loadTrackStats();
  } catch (e) {
    log("ERRO estatisticas da pista: " + e.message);
  }
}

loadTrackStats();

async function copyLink(id) {
  const input = document.getElementById(id);
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
  } catch (_) {
    document.execCommand("copy");
  }
  log("Link copiado: " + input.value);
}

fillLinks();

// ---------------------------------------------------------------- aplicativo (.exe)
// window.llgApp so existe quando o painel roda dentro do aplicativo.
let driverWindowState = null;

function showDriverWindowState(s) {
  driverWindowState = s;
  document.getElementById("drvVisible").checked = !!s.visible;
  const pct = Math.round((s.scale || 1) * 100);
  document.getElementById("drvScale").value = pct;
  document.getElementById("drvScaleVal").textContent = pct + "%";
  const edit = document.getElementById("drvEdit");
  edit.textContent = s.edit ? "Travar posição" : "Mover";
  edit.disabled = !s.visible;
  document.getElementById("drvHint").textContent = s.edit
    ? "Arraste a área azul pontilhada até o lugar desejado e clique em Travar posição."
    : "Travada: os cliques passam direto para o jogo.";
}

async function setDriverWindow(patch) {
  if (!window.llgApp) return;
  showDriverWindowState(await window.llgApp.driver.set(patch));
}

function toggleDriverEdit() {
  setDriverWindow({ edit: !(driverWindowState && driverWindowState.edit) });
}

function setDriverScale(value) {
  const pct = Math.max(50, Math.min(200, Number(value) || 100));
  document.getElementById("drvScaleVal").textContent = pct + "%";
  setDriverWindow({ scale: pct / 100 });
}

// Programas que abrem junto com o aplicativo (so existe dentro do aplicativo).
// A lista cresce e encolhe conforme os itens: uma linha por programa.
function showCompanion(info) {
  if (!info) return;
  const items = info.items || [];
  const list = document.getElementById("companionList");
  list.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.margin = "8px 0";
    empty.textContent = "Nenhum programa na lista.";
    list.appendChild(empty);
  }
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "row";
    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.value = item.path;
    input.title = item.path;
    const open = document.createElement("button");
    open.textContent = "Abrir";
    open.onclick = () => companionAction("launch", item.path);
    const remove = document.createElement("button");
    remove.textContent = "Remover";
    remove.onclick = () => companionAction("remove", item.path);
    row.append(input, open, remove);
    list.appendChild(row);
    const msg = item.message || (item.exists ? "" : "Arquivo não encontrado. Remova e adicione de novo.");
    if (msg) {
      const note = document.createElement("div");
      note.className = "muted";
      note.textContent = msg;
      list.appendChild(note);
      if (item.message) log(`Abrir junto: ${item.path} → ${item.message}`);
    }
  });
  document.getElementById("companionLaunchAll").disabled = !items.length;
  document.getElementById("companionStatus").textContent = info.note || "";
  if (info.note) log("Abrir junto: " + info.note);
}

async function companionAction(action, file) {
  if (!window.llgApp || !window.llgApp.companion) return;
  try {
    showCompanion(await window.llgApp.companion[action](file));
  } catch (e) {
    document.getElementById("companionStatus").textContent = "Erro: " + e.message;
  }
}

// versao do aplicativo e procura de atualizacao (app/updater.js)
async function checkUpdate() {
  if (!window.llgApp || !window.llgApp.checkUpdate) return;
  const btn = document.getElementById("updateBtn");
  const status = document.getElementById("updateStatus");
  btn.disabled = true;
  status.textContent = "Procurando...";
  try {
    status.textContent = (await window.llgApp.checkUpdate()) || "";
  } catch (e) {
    status.textContent = "Erro: " + e.message;
  }
  btn.disabled = false;
}

if (window.llgApp) {
  window.llgApp.info().then((info) => {
    document.getElementById("appVersion").textContent = `Versão ${info.version}`;
  });
  document.getElementById("appSection").hidden = false;
  document.getElementById("appFiles").hidden = false;
  if (window.llgApp.companion) window.llgApp.companion.get().then(showCompanion);
  window.llgApp.driver.get().then(showDriverWindowState);
}

// ---------------------------------------------------------------- abas
// Piloto / Transmissao / Configuracao. A ultima aba aberta fica lembrada.
function showTab(name) {
  document.querySelectorAll(".tab, .tab-page").forEach((el) => el.classList.toggle("active", el.dataset.tab === name));
  try {
    localStorage.setItem("panelTab", name);
  } catch (_) {}
}

(function () {
  let saved = null;
  try {
    saved = localStorage.getItem("panelTab");
  } catch (_) {}
  showTab(document.querySelector(`.tab-page[data-tab="${saved}"]`) ? saved : "piloto");
})();
