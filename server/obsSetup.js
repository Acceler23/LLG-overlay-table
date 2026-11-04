// server/obsSetup.js
//
// O painel monta as overlays no OBS sozinho (botao "Montar no OBS"), sem o
// transmissor colar link por link:
//   - status(): o OBS esta instalado? aberto? com o servidor WebSocket ligado?
//     quais overlays ja estao na cena atual, e visiveis?
//   - setup(): cria (ou acerta) uma Fonte de navegador por overlay na cena atual,
//     com URL, tamanho e posicao, acima da captura do jogo. Rodar de novo nao
//     duplica nada: so corrige o que mudou. { unica: true } usa uma fonte so
//     com todas (overlay/cena.html).
//   - enableWebsocket(): liga o servidor WebSocket do OBS (vem desligado). Com o
//     OBS aberto, fecha-o normalmente, liga e abre de novo: o OBS so le essa
//     configuracao ao abrir, e regrava a dele ao fechar.
//   - setVisible(): mostra ou esconde uma overlay na cena (o olho do OBS).
//
// A senha do WebSocket e lida do config.json do proprio OBS; nada para digitar.
// Overlay escondida no OBS nao desenha (overlay/shared/framecap.js): mostrar e
// esconder pelo painel ou pelo OBS e o jeito barato de usar cada uma na hora certa.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { OBSWebSocket } = require("obs-websocket-js");

// posicoes num canvas 1920x1080 (escaladas se o canvas do OBS for outro)
const SEPARADAS = [
  { id: "tabela", nome: "LLG Tabela", arq: "timing-table.html", w: 880, h: 1080, x: 20, y: 0 },
  { id: "card", nome: "LLG Driver card", arq: "driver-card.html", w: 560, h: 210, x: 680, y: 850 },
  { id: "mapa", nome: "LLG Mapa", arq: "track-map.html", w: 420, h: 400, x: 1480, y: 20 },
  { id: "gforce", nome: "LLG G-force", arq: "g-force.html", w: 300, h: 420, x: 1600, y: 640 },
];
const UNICA = [{ id: "cena", nome: "LLG Cena", arq: "cena.html", w: 1920, h: 1080, x: 0, y: 0 }];

const OBS_DIR = path.join(process.env.APPDATA || "", "obs-studio");
const WS_CONFIG = path.join(OBS_DIR, "plugin_config", "obs-websocket", "config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(WS_CONFIG, "utf8"));
  } catch (_) {
    return null;
  }
}

function run(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeout || 10000 }, (err, stdout) => resolve(err ? "" : String(stdout || "")));
  });
}

// caminho do obs64.exe aberto agora ("" se fechado)
async function runningObsPath() {
  if (process.platform !== "win32") return "";
  const out = await run("powershell.exe", ["-NoProfile", "-Command", "(Get-Process obs64 -ErrorAction SilentlyContinue | Select-Object -First 1).Path"]);
  return out.trim();
}

function createObsSetup(opts) {
  const httpPort = (opts && opts.httpPort) || 8080;
  const base = `http://localhost:${httpPort}/overlay`;
  let obs = null;
  let connecting = null;

  async function connect() {
    if (obs) return obs;
    if (connecting) return connecting;
    const cfg = readConfig();
    if (!cfg) throw Object.assign(new Error("OBS nao encontrado neste computador."), { code: "noObs" });
    if (cfg.server_enabled === false) throw Object.assign(new Error("O servidor WebSocket do OBS esta desligado."), { code: "wsOff" });
    const client = new OBSWebSocket();
    connecting = client
      .connect(`ws://127.0.0.1:${cfg.server_port || 4455}`, cfg.auth_required ? cfg.server_password : undefined)
      .then(() => {
        obs = client;
        client.on("ConnectionClosed", () => {
          if (obs === client) obs = null;
        });
        return client;
      })
      .catch((err) => {
        throw Object.assign(new Error(`O OBS nao respondeu: ${err.message}`), { code: "noConnect" });
      })
      .finally(() => {
        connecting = null;
      });
    return connecting;
  }

  async function sceneItems(client, scene) {
    const { sceneItems: items } = await client.call("GetSceneItemList", { sceneName: scene });
    return items;
  }

  async function status() {
    const cfg = readConfig();
    const out = {
      installed: fs.existsSync(OBS_DIR),
      wsEnabled: !!(cfg && cfg.server_enabled !== false),
      running: false,
      connected: false,
      scene: null,
      overlays: [...SEPARADAS, ...UNICA].map((f) => ({ id: f.id, name: f.nome, inScene: false, visible: false })),
      error: null,
    };
    try {
      const client = await connect();
      out.running = true;
      out.connected = true;
      out.scene = (await client.call("GetCurrentProgramScene")).currentProgramSceneName;
      const items = await sceneItems(client, out.scene);
      out.overlays.forEach((o) => {
        const it = items.find((s) => s.sourceName === o.name);
        if (it) {
          o.inScene = true;
          o.visible = !!it.sceneItemEnabled;
        }
      });
    } catch (err) {
      out.error = err.code || "error";
      out.running = !!(await runningObsPath());
    }
    return out;
  }

  async function setup(options) {
    const unica = !!(options && options.unica);
    const fontes = unica ? UNICA : SEPARADAS;
    const outras = unica ? SEPARADAS : UNICA;
    const client = await connect();
    const video = await client.call("GetVideoSettings");
    const esc = video.baseWidth / 1920;
    const scene = (await client.call("GetCurrentProgramScene")).currentProgramSceneName;
    const { inputs } = await client.call("GetInputList");
    const existing = new Set(inputs.map((i) => i.inputName));
    const done = [];
    // fontes do outro modo saem (senao as overlays aparecem duas vezes)
    for (const f of outras) {
      if (existing.has(f.nome)) {
        await client.call("RemoveInput", { inputName: f.nome });
        done.push(`removida: ${f.nome}`);
      }
    }
    for (const f of fontes) {
      const settings = {
        url: `${base}/${f.arq}`,
        width: f.w,
        height: f.h,
        is_local_file: false,
        shutdown: false, // nao desliga quando a fonte some (a overlay se pausa sozinha)
        restart_when_active: false, // nao recarrega (e nao perde o estado) ao trocar de cena
        reroute_audio: false,
      };
      let itemId;
      if (existing.has(f.nome)) {
        await client.call("SetInputSettings", { inputName: f.nome, inputSettings: settings });
        try {
          itemId = (await client.call("GetSceneItemId", { sceneName: scene, sourceName: f.nome })).sceneItemId;
        } catch (_) {
          itemId = (await client.call("CreateSceneItem", { sceneName: scene, sourceName: f.nome })).sceneItemId;
        }
        done.push(`atualizada: ${f.nome}`);
      } else {
        itemId = (await client.call("CreateInput", { sceneName: scene, inputName: f.nome, inputKind: "browser_source", inputSettings: settings, sceneItemEnabled: true })).sceneItemId;
        done.push(`criada: ${f.nome}`);
      }
      await client.call("SetSceneItemTransform", {
        sceneName: scene,
        sceneItemId: itemId,
        sceneItemTransform: { positionX: f.x * esc, positionY: f.y * esc, scaleX: esc, scaleY: esc },
      });
      await client.call("SetSceneItemEnabled", { sceneName: scene, sceneItemId: itemId, sceneItemEnabled: true });
    }
    // overlays acima de tudo (a captura do jogo fica embaixo)
    const items = await sceneItems(client, scene);
    const top = items.length - 1;
    let k = 0;
    for (const f of fontes.slice().reverse()) {
      const it = items.find((s) => s.sourceName === f.nome);
      if (it) await client.call("SetSceneItemIndex", { sceneName: scene, sceneItemId: it.sceneItemId, sceneItemIndex: top - k++ });
    }
    return { scene, canvas: `${video.baseWidth}x${video.baseHeight}`, done };
  }

  async function setVisible(id, visible) {
    const f = [...SEPARADAS, ...UNICA].find((x) => x.id === id);
    if (!f) throw new Error("Overlay desconhecida.");
    const client = await connect();
    const scene = (await client.call("GetCurrentProgramScene")).currentProgramSceneName;
    const { sceneItemId } = await client.call("GetSceneItemId", { sceneName: scene, sourceName: f.nome });
    await client.call("SetSceneItemEnabled", { sceneName: scene, sceneItemId, sceneItemEnabled: !!visible });
    return { id, visible: !!visible };
  }

  // Liga o servidor WebSocket do OBS. O OBS so le a configuracao ao abrir e
  // regrava a dele ao fechar: aberto, ele e fechado normalmente e aberto de novo.
  async function enableWebsocket() {
    const cfg = readConfig();
    if (!cfg) throw new Error("OBS nao encontrado neste computador. Abra o OBS uma vez e tente de novo.");
    if (cfg.server_enabled !== false) return { changed: false, restarted: false };
    const exe = await runningObsPath();
    if (exe) {
      // fecha como o X da janela (o OBS salva cenas e configuracoes)
      await run("powershell.exe", ["-NoProfile", "-Command", "$p=Get-Process obs64 -ErrorAction SilentlyContinue; if($p){[void]$p.CloseMainWindow(); $p.WaitForExit(20000) | Out-Null}"], 30000);
      if (await runningObsPath()) throw new Error("O OBS nao fechou (alguma pergunta aberta nele?). Feche o OBS e tente de novo.");
    }
    const fresh = readConfig() || cfg;
    fresh.server_enabled = true;
    fs.writeFileSync(WS_CONFIG, JSON.stringify(fresh, null, 2));
    obs = null;
    if (exe) {
      const { spawn } = require("child_process");
      spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: "ignore" }).unref();
    }
    return { changed: true, restarted: !!exe };
  }

  function close() {
    if (obs) obs.disconnect().catch(() => {});
    obs = null;
  }

  return { status, setup, setVisible, enableWebsocket, close };
}

module.exports = { createObsSetup, SEPARADAS, UNICA };
