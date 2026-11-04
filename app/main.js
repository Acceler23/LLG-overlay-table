// app/main.js
// Aplicativo (Electron): um unico programa que
//   - sobe o servidor (o mesmo de "npm start"), dentro deste processo
//   - inicia os listeners (AMS2 e LMU) e o hotkeys.ps1 escondidos, e os reinicia se cairem
//   - abre o painel de controle numa janela propria
//   - mostra a tabela do piloto numa janela transparente por cima do jogo
// Rodar em desenvolvimento: npm run app. Gerar a pasta com o .exe: npm run build.

const { app, BrowserWindow, Menu, dialog, ipcMain, screen, shell } = require("electron");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const updater = require("./updater");

const ROOT = path.join(__dirname, "..");

// tamanho da janela do piloto em 100% (a tabela e desenhada com 340 px)
const DRIVER_BASE = { width: 340, height: 620 };
const EDIT_CSS = `
  html { -webkit-app-region: drag; min-height: 100vh; cursor: move;
         background: rgba(0, 197, 253, 0.18) !important;
         outline: 2px dashed #00c5fd; outline-offset: -2px; }
`;

let panelWin = null;
let quitting = false;
let ports = { http: 8080, bridge: 5607 };
const helpers = []; // { name, child }

// ---------------------------------------------------------------- estado
const dataDir = app.getPath("userData");
const stateFile = path.join(dataDir, "app-state.json");
let state = {
  driver: { visible: false, edit: false, scale: 1, x: null, y: null, preset: null },
  // outras overlays do piloto (telemetria...): { id: { visible, scale, x, y } }
  overlays: {},
  // programas que o usuario escolheu no painel para abrir junto com o aplicativo
  companion: { paths: [] },
};

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.driver = Object.assign(state.driver, saved.driver || {});
    state.overlays = Object.assign({}, saved.overlays || {});
    const c = saved.companion || {};
    // versao anterior guardava um programa so, em "path"
    const list = Array.isArray(c.paths) ? c.paths : c.path ? [c.path] : [];
    state.companion.paths = list.filter((f) => typeof f === "string" && f);
  } catch (_) {}
  state.driver.edit = false; // sempre abre travada
}

function saveState() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (_) {}
}

// ---------------------------------------------------------------- scripts auxiliares
function startHelper(name, args) {
  const file = path.join(ROOT, name);
  const logFile = path.join(dataDir, name.replace(/\.ps1$/, ".log"));
  const entry = { name, child: null };
  helpers.push(entry);

  function launch() {
    if (quitting) return;
    let log;
    try {
      log = fs.createWriteStream(logFile, { flags: "w" });
    } catch (_) {
      log = null;
    }
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", file].concat(args),
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    entry.child = child;
    if (log) {
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
    }
    child.on("error", (err) => console.error(`${name}: ${err.message}`));
    child.on("exit", () => {
      entry.child = null;
      if (log) log.end();
      if (!quitting) setTimeout(launch, 3000); // caiu: tenta de novo
    });
  }
  launch();
}

function stopHelpers() {
  helpers.forEach((h) => {
    if (h.child) {
      try {
        h.child.kill();
      } catch (_) {}
    }
  });
}

// ---------------------------------------------------------------- janela do painel
function createPanelWindow() {
  panelWin = new BrowserWindow({
    width: 880,
    height: 960,
    title: "LLG Overlay",
    icon: path.join(__dirname, "icon.png"), // gerado por app/make-icon.ps1
    autoHideMenuBar: true,
    backgroundColor: "#111111",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true },
  });
  panelWin.loadURL(`http://127.0.0.1:${ports.http}/panel/painel.html`);
  // links (docs do RLT etc.) abrem no navegador padrao
  panelWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  panelWin.on("page-title-updated", (e) => e.preventDefault());
  panelWin.on("closed", () => {
    panelWin = null;
    app.quit();
  });
}

// ---------------------------------------------------------------- overlays do piloto
// Janelas transparentes por cima do jogo (que precisa estar em janela sem bordas):
//   tabela      a tabela do piloto (overlay/driver-table.html)
//   telemetria  acelerador, freio e volante rolando e o combustivel por volta (overlay/telemetria.html)
//   gforce      a forca G do carro, sem as luzes dos pedais (overlay/g-force.html?piloto=1)
// Cada uma tem visivel, escala e posicao proprias. O modo de edicao vale para todas, como no
// Cubic Racing Analyser: destravadas, ganham contorno, arrastam pelo corpo e uma barrinha
// (ou a roda do mouse) muda o tamanho; travadas, os cliques passam direto para o jogo.
const PILOT_OVERLAYS = {
  tabela: { page: "driver-table.html", width: DRIVER_BASE.width, height: DRIVER_BASE.height, x: 20, y: 120 },
  telemetria: { page: "telemetria.html", width: 460, height: 150, x: null, y: -190 }, // x null = centralizada; y negativo = a partir de baixo
  gforce: { page: "g-force.html?piloto=1", width: 300, height: 350, x: -330, y: 260 }, // x negativo = a partir da direita
};
const pilotWins = {}; // id -> BrowserWindow
const pilotCss = {}; // id -> chave do CSS de edicao

// estado de cada overlay; a tabela continua em state.driver (versoes anteriores)
function ovState(id) {
  if (id === "tabela") return state.driver;
  if (!state.overlays[id]) state.overlays[id] = { visible: false, scale: 1, x: null, y: null, opacity: 1 };
  return state.overlays[id];
}

// transparencia do FUNDO da overlay (painel: Ajustes > Piloto): numeros, linhas e graficos ficam
// sempre inteiros. Vai na variavel CSS --llg-bg, que multiplica o alfa dos fundos (0 = sem fundo).
function overlayOpacity(id) {
  const o = Number(ovState(id).opacity);
  return Number.isFinite(o) ? Math.max(0, Math.min(1, o)) : 1;
}
function applyOpacity(id) {
  const win = pilotWins[id];
  if (!win || win.isDestroyed()) return;
  const o = overlayOpacity(id);
  win.webContents.executeJavaScript(`document.documentElement.style.setProperty("--llg-bg", "${o}"); true`).catch(() => {});
}

// Lugares prontos da tabela (painel antigo): linha (t, m, b) + coluna (l, c, r)
const DRIVER_PRESETS = ["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"];
const DRIVER_CONTENT_HEIGHT = 300; // px da tabela com ~6 linhas, em escala 1
const PRESET_MARGIN = 24;
function presetPosition(preset, scale) {
  const a = screen.getPrimaryDisplay().workArea;
  const w = Math.round(DRIVER_BASE.width * scale);
  const h = Math.round(DRIVER_CONTENT_HEIGHT * scale);
  const col = preset[1];
  const row = preset[0];
  const x = col === "l" ? a.x + PRESET_MARGIN : col === "c" ? a.x + (a.width - w) / 2 : a.x + a.width - w - PRESET_MARGIN;
  const y = row === "t" ? a.y + PRESET_MARGIN : row === "m" ? a.y + (a.height - h) / 2 : a.y + a.height - h - PRESET_MARGIN;
  return { x: Math.round(x), y: Math.round(y) };
}

function overlayBounds(id) {
  const def = PILOT_OVERLAYS[id];
  const s = ovState(id);
  const width = Math.round(def.width * (s.scale || 1));
  const height = Math.round(def.height * (s.scale || 1));
  let x = s.x;
  let y = s.y;
  // posicao salva fora de qualquer monitor (ex: monitor desconectado): volta ao padrao
  const visible =
    x != null &&
    y != null &&
    screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return x + 40 < a.x + a.width && x + width - 40 > a.x && y + 20 < a.y + a.height && y >= a.y - 10;
    });
  if (!visible) {
    const a = screen.getPrimaryDisplay().workArea;
    x = def.x == null ? a.x + (a.width - width) / 2 : def.x < 0 ? a.x + a.width + def.x * (s.scale || 1) : a.x + def.x;
    y = def.y < 0 ? a.y + a.height + def.y * (s.scale || 1) : a.y + def.y;
  }
  return { x: Math.round(x), y: Math.round(y), width, height };
}

// barrinha do modo de edicao, dentro de cada janela: diminuir, aumentar, travar
const EDIT_JS = `(() => {
  if (document.getElementById("llgEditBar")) return;
  const bar = document.createElement("div");
  bar.id = "llgEditBar";
  bar.style.cssText = "position:fixed;top:6px;right:6px;z-index:99999;display:flex;gap:4px;-webkit-app-region:no-drag;font:700 14px Segoe UI,sans-serif;zoom:1";
  const btn = (txt, title, fn) => { const b = document.createElement("button"); b.textContent = txt; b.title = title;
    b.style.cssText = "min-width:30px;height:28px;border:0;border-radius:7px;background:#00b7e8;color:#002a5c;font:inherit;cursor:pointer";
    b.onclick = fn; bar.appendChild(b); };
  btn("−", "Menor", () => window.llgOverlay && window.llgOverlay.scaleBy(-0.1));
  btn("+", "Maior", () => window.llgOverlay && window.llgOverlay.scaleBy(0.1));
  btn("Travar", "Travar todas as overlays", () => window.llgOverlay && window.llgOverlay.lock());
  document.body.appendChild(bar);
  window.__llgWheel = (e) => { if (window.llgOverlay) window.llgOverlay.scaleBy(e.deltaY < 0 ? 0.05 : -0.05); };
  window.addEventListener("wheel", window.__llgWheel);
})()`;
const UNEDIT_JS = `(() => { const b = document.getElementById("llgEditBar"); if (b) b.remove(); if (window.__llgWheel) window.removeEventListener("wheel", window.__llgWheel); })()`;

function applyEdit(id) {
  const win = pilotWins[id];
  if (!win) return;
  const edit = !!state.driver.edit;
  win.setIgnoreMouseEvents(!edit); // travada: cliques passam direto pro jogo
  win.setFocusable(edit);
  if (edit && !pilotCss[id]) {
    win.webContents.insertCSS(EDIT_CSS).then((key) => (pilotCss[id] = key));
  } else if (!edit && pilotCss[id]) {
    win.webContents.removeInsertedCSS(pilotCss[id]).catch(() => {});
    pilotCss[id] = null;
  }
  win.webContents.executeJavaScript(edit ? EDIT_JS : UNEDIT_JS).catch(() => {});
}

function createOverlayWindow(id) {
  const def = PILOT_OVERLAYS[id];
  const win = new BrowserWindow(
    Object.assign(overlayBounds(id), {
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      show: false,
      webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, "overlay-preload.js") },
    })
  );
  pilotWins[id] = win;
  pilotCss[id] = null;
  // nivel mais alto: fica por cima do jogo em janela sem bordas
  win.setAlwaysOnTop(true, "screen-saver");
  win.loadURL(`http://127.0.0.1:${ports.http}/overlay/${def.page}`);
  win.webContents.on("did-finish-load", () => {
    pilotCss[id] = null;
    applyEdit(id);
    applyOpacity(id);
  });
  win.once("ready-to-show", () => {
    if (pilotWins[id]) pilotWins[id].showInactive();
  });
  win.on("moved", () => {
    if (pilotWins[id] !== win) return;
    const [x, y] = win.getPosition();
    const s = ovState(id);
    if (x !== s.x || y !== s.y) s.preset = null; // arrastada pelo piloto
    s.x = x;
    s.y = y;
    saveState();
  });
  win.on("closed", () => {
    if (pilotWins[id] === win) {
      delete pilotWins[id];
      pilotCss[id] = null;
    }
  });
}

function syncOverlay(id) {
  const s = ovState(id);
  const win = pilotWins[id];
  if (s.visible) {
    if (!win) createOverlayWindow(id);
    else {
      win.setBounds(overlayBounds(id));
      applyOpacity(id);
      applyEdit(id);
    }
  } else if (win) {
    win.destroy();
  }
}

function syncOverlays() {
  Object.keys(PILOT_OVERLAYS).forEach(syncOverlay);
  // em edicao, as overlays mostram os dados de exemplo (server/demo.js) quando o jogo nao esta em sessao
  try {
    require(path.join(ROOT, "server", "index.js")).setPilotDemo(!!state.driver.edit);
  } catch (_) {}
}

function anyOverlayVisible() {
  return Object.keys(PILOT_OVERLAYS).some((id) => ovState(id).visible);
}

// estado para o painel: { edit, overlays: { id: { visible, scale } } }
function pilotState() {
  const overlays = {};
  Object.keys(PILOT_OVERLAYS).forEach((id) => {
    const s = ovState(id);
    overlays[id] = { visible: !!s.visible, scale: s.scale || 1, opacity: overlayOpacity(id) };
  });
  return { edit: !!state.driver.edit, overlays };
}

// patch: { edit } ou { id, visible, scale, reset }
function setPilot(patch) {
  const p = patch || {};
  if (p.id && PILOT_OVERLAYS[p.id]) {
    const s = ovState(p.id);
    if (typeof p.visible === "boolean") s.visible = p.visible;
    if (typeof p.scale === "number" && p.scale > 0) s.scale = Math.max(0.5, Math.min(2.5, p.scale));
    if (typeof p.opacity === "number") s.opacity = Math.max(0, Math.min(1, p.opacity));
    if (p.reset) {
      s.x = null;
      s.y = null;
      s.preset = null;
    }
  }
  if (typeof p.edit === "boolean") state.driver.edit = p.edit;
  if (!anyOverlayVisible()) state.driver.edit = false;
  saveState();
  syncOverlays();
  return pilotState();
}

// painel antigo: so a tabela
function setDriver(patch) {
  const s = state.driver;
  const p = patch || {};
  if (typeof p.visible === "boolean") s.visible = p.visible;
  if (typeof p.scale === "number" && p.scale > 0) s.scale = Math.max(0.5, Math.min(2.5, p.scale));
  if (p.reset) {
    s.x = null;
    s.y = null;
    s.preset = null;
  }
  if (typeof p.preset === "string" && DRIVER_PRESETS.includes(p.preset)) s.preset = p.preset;
  if (s.preset && (typeof p.preset === "string" || typeof p.scale === "number")) {
    const pos = presetPosition(s.preset, s.scale);
    s.x = pos.x;
    s.y = pos.y;
  }
  if (typeof p.edit === "boolean") s.edit = p.edit;
  if (!anyOverlayVisible()) s.edit = false;
  saveState();
  syncOverlays();
  return s;
}

// barrinha da janela em edicao: tamanho e travar
ipcMain.on("pilot:scaleBy", (event, delta) => {
  const id = Object.keys(pilotWins).find((k) => pilotWins[k] && pilotWins[k].webContents === event.sender);
  if (!id || typeof delta !== "number") return;
  const s = ovState(id);
  setPilot({ id, scale: Math.round(((s.scale || 1) + delta) * 100) / 100 });
  if (panelWin) panelWin.webContents.send("pilot:changed", pilotState());
});
ipcMain.on("pilot:lock", () => {
  setPilot({ edit: false });
  if (panelWin) panelWin.webContents.send("pilot:changed", pilotState());
});
ipcMain.handle("pilot:get", () => pilotState());
ipcMain.handle("pilot:set", (_event, patch) => setPilot(patch));

ipcMain.handle("driver:get", () => state.driver);
ipcMain.handle("driver:set", (_event, patch) => setDriver(patch));
ipcMain.handle("app:info", () => ({
  version: app.getVersion(),
  dataDir,
  configFile: path.join(ROOT, "overlay", "drivers-config.js"),
  noHotkeys: !!process.env.LLG_NO_HOTKEYS,
}));
// ---------------------------------------------------------------- programas abertos junto
// O usuario monta no painel (aba Configuracao) uma lista de outros programas
// para abrir sempre que este aplicativo abrir: o OBS, por exemplo. So entram
// na lista arquivos que ele mesmo escolheu pela janela de selecao; nada e
// aberto sem essa escolha.
const COMPANION_TYPES = [".exe", ".bat", ".cmd", ".lnk"];

// messages: { caminho: texto } para mostrar ao lado de um item; note: aviso geral
function companionInfo(messages, note) {
  const msgs = messages || {};
  return {
    items: state.companion.paths.map((file) => ({ path: file, exists: fs.existsSync(file), message: msgs[file] || "" })),
    note: note || "",
  };
}

function isRunning(file) {
  // so da para conferir programas .exe, pelo nome do arquivo
  return new Promise((resolve) => {
    if (path.extname(file).toLowerCase() !== ".exe") return resolve(false);
    const image = path.basename(file);
    execFile("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH", "/FO", "CSV"], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(!err && String(stdout || "").toLowerCase().includes(`"${image.toLowerCase()}"`));
    });
  });
}

// onlyIfClosed: na abertura do aplicativo, nao abre de novo o que ja esta aberto.
// Devolve o texto do que aconteceu.
async function launchOne(file, onlyIfClosed) {
  if (!fs.existsSync(file)) return "Arquivo não encontrado. Remova e adicione de novo.";
  if (onlyIfClosed && (await isRunning(file))) return "Já estava aberto.";
  const error = await shell.openPath(file);
  return error ? `Não foi possível abrir: ${error}` : "Aberto.";
}

async function launchCompanions(onlyIfClosed) {
  const messages = {};
  for (const file of state.companion.paths.slice()) messages[file] = await launchOne(file, onlyIfClosed);
  return companionInfo(messages);
}

ipcMain.handle("companion:get", () => companionInfo());
ipcMain.handle("companion:add", async () => {
  const result = await dialog.showOpenDialog(panelWin, {
    title: "Programa para abrir junto com o LLG Overlay",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Programas", extensions: COMPANION_TYPES.map((e) => e.slice(1)) }],
  });
  if (result.canceled || !result.filePaths.length) return companionInfo();
  const have = new Set(state.companion.paths.map((f) => f.toLowerCase()));
  let added = 0;
  let skipped = 0;
  result.filePaths.forEach((file) => {
    if (!COMPANION_TYPES.includes(path.extname(file).toLowerCase()) || have.has(file.toLowerCase())) {
      skipped++;
      return;
    }
    have.add(file.toLowerCase());
    state.companion.paths.push(file);
    added++;
  });
  saveState();
  const note = added
    ? `${added === 1 ? "Programa adicionado" : added + " programas adicionados"}. ${added === 1 ? "Vai" : "Vão"} abrir junto na próxima vez que o aplicativo abrir.`
    : skipped
      ? "Nada adicionado: o programa já está na lista ou não é .exe, .bat, .cmd ou atalho .lnk."
      : "";
  return companionInfo(null, note);
});
ipcMain.handle("companion:remove", (_event, file) => {
  state.companion.paths = state.companion.paths.filter((f) => f !== file);
  saveState();
  return companionInfo(null, "Removido da lista.");
});
ipcMain.handle("companion:launch", async (_event, file) => {
  // so abre o que esta na lista
  if (!state.companion.paths.includes(file)) return companionInfo();
  return companionInfo({ [file]: await launchOne(file, false) });
});
ipcMain.handle("companion:launchAll", () => launchCompanions(false));

ipcMain.handle("app:openPath", (_event, target) => {
  // so abre as duas pastas que o painel oferece
  if (target === "data") return shell.openPath(dataDir);
  if (target === "config") return shell.openPath(path.join(ROOT, "overlay"));
  return "";
});

// ---------------------------------------------------------------- atualizacao
// Ao abrir, procura uma versao nova nos Releases do GitHub (app/updater.js).
// So no aplicativo gerado (nao no "npm run app"); LLG_NO_UPDATE=1 desliga.
// Tambem pelo botao "Procurar atualizacao" do painel (aba Configuracao).
// Devolve o texto que o painel mostra.
async function checkUpdates() {
  if (!app.isPackaged || process.env.LLG_NO_UPDATE) return "A atualização automática só funciona no aplicativo gerado (LLG Overlay.exe).";
  let info;
  try {
    info = await updater.checkForUpdate(app.getVersion());
  } catch (err) {
    console.warn("Atualizacao: nao foi possivel consultar o GitHub:", err.message);
    return `Não foi possível consultar o GitHub: ${err.message}`;
  }
  if (!info) return `Você já está na versão mais nova (${app.getVersion()}).`;
  if (!panelWin) return "";
  const notes = info.notes.replace(/\*\*/g, "").split(/\r?\n/).filter((l) => l.trim()).slice(0, 12).join("\n");
  const { response } = await dialog.showMessageBox(panelWin, {
    type: "info",
    title: "LLG Overlay",
    message: `Nova versão disponível: ${info.version}`,
    detail: `Você está usando a ${app.getVersion()}.\n\nAo atualizar, o aplicativo fecha, instala a versão nova e abre de novo sozinho. As suas configurações são mantidas.${notes ? "\n\n" + notes : ""}`,
    buttons: ["Atualizar agora", "Depois"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0 || !panelWin) return `Versão ${info.version} disponível. Clique de novo quando quiser atualizar.`;
  const baseTitle = panelWin.getTitle();
  try {
    await updater.prepareUpdate(info, (p) => {
      if (!panelWin) return;
      panelWin.setProgressBar(p);
      panelWin.setTitle(`${baseTitle} - baixando a atualização ${Math.round(p * 100)}%`);
    });
  } catch (err) {
    if (panelWin) {
      panelWin.setProgressBar(-1);
      panelWin.setTitle(baseTitle);
    }
    const { response: open } = await dialog.showMessageBox(panelWin, {
      type: "error",
      title: "LLG Overlay",
      message: "Não foi possível atualizar",
      detail: `${err.message}\n\nVocê pode baixar a versão nova pela página de Releases.`,
      buttons: ["Abrir a página", "Fechar"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (open === 0) shell.openExternal(`https://github.com/${updater.REPO}/releases/latest`);
    return `Não foi possível atualizar: ${err.message}`;
  }
  app.quit(); // o script do updater espera fechar, copia a versao nova e abre de novo
  return "Atualizando...";
}

let checkingUpdates = null; // um aviso por vez
ipcMain.handle("update:check", () => {
  if (!checkingUpdates) checkingUpdates = checkUpdates().finally(() => (checkingUpdates = null));
  return checkingUpdates;
});

// ---------------------------------------------------------------- inicio
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (panelWin) {
      if (panelWin.isMinimized()) panelWin.restore();
      panelWin.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    loadState();
    process.env.LLG_DATA_DIR = dataDir; // settings.json do servidor vai pra pasta do usuario

    let server;
    try {
      server = require(path.join(ROOT, "server", "index.js"));
      await server.ready;
    } catch (err) {
      const busy = err && err.code === "EADDRINUSE";
      dialog.showErrorBox(
        "LLG Overlay",
        busy
          ? `A porta ${(server && server.HTTP_PORT) || 8080} ja esta em uso.\n\nO LLG Overlay ja esta aberto, ou o start.bat antigo esta rodando. Feche o outro e abra de novo.`
          : `Nao foi possivel iniciar o servidor:\n${(err && err.message) || err}`
      );
      app.exit(1);
      return;
    }
    ports = { http: server.HTTP_PORT, bridge: server.BRIDGE_PORT };

    const parent = ["-ParentPid", String(process.pid)]; // os scripts fecham sozinhos se o app morrer
    const listenerArgs = ["-BridgePort", String(ports.bridge)].concat(parent);
    // so para testes: ler outro mapeamento de memoria no lugar do jogo
    if (process.env.LLG_MAP_NAME) listenerArgs.push("-MapName", process.env.LLG_MAP_NAME);
    // LLG_LISTENER_LEGACY=1 volta ao leitor antigo do AMS2 (todo em PowerShell, ~50x mais CPU);
    // fica so como reserva caso o novo (C# compilado) de problema em algum PC
    startHelper(process.env.LLG_LISTENER_LEGACY === "1" ? "listener-legacy.ps1" : "listener.ps1", listenerArgs);
    // Le Mans Ultimate: outro listener, mesma ponte. O servidor usa o jogo que estiver em sessao.
    const lmuArgs = ["-BridgePort", String(ports.bridge)].concat(parent);
    if (process.env.LLG_LMU_MAP_NAME) lmuArgs.push("-MapName", process.env.LLG_LMU_MAP_NAME);
    startHelper("listener-lmu.ps1", lmuArgs);
    if (!process.env.LLG_NO_HOTKEYS) startHelper("hotkeys.ps1", ["-Port", String(ports.http)].concat(parent));

    createPanelWindow();
    syncOverlays();
    // abre junto os programas escolhidos no painel, se houver
    launchCompanions(true).catch(() => {});
    // versao nova no GitHub? (depois que o painel aparece, para o aviso ficar por cima dele)
    panelWin.webContents.once("did-finish-load", () => {
      checkingUpdates = checkUpdates()
        .catch(() => {})
        .finally(() => (checkingUpdates = null));
    });
  });

  app.on("before-quit", () => {
    quitting = true;
    // cancela o registro na API do ACC antes de sair
    try {
      require(path.join(ROOT, "server", "index.js")).shutdown();
    } catch (_) {}
    stopHelpers();
  });
  app.on("window-all-closed", () => app.quit());
}
