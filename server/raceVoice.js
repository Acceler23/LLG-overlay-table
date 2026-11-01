// server/raceVoice.js
// Audios da contagem e dos avisos de bandeira: arquivos prontos em
// server/voice-clips, tocados por server/voice.ps1 (nada de voz gerada na hora).
// Fica no servidor para tocar uma vez so, com qualquer numero de overlays abertas,
// e tambem no PC que so segue o chat. Desligado por padrao (opcao na aba LMU), para
// nao entrar de surpresa numa transmissao.
// Os estados sao os mesmos do painel das overlays (shared/racecontrol.js).

const path = require("path");
const { spawn } = require("child_process");
const { info } = require("../overlay/shared/racecontrol");

const TICK_FROM_S = 10; // conta em voz alta so os ultimos 10 s, como no chat
const PHRASE_MS = 3300; // numeros nao cortam o audio de abertura do FCY
const ACTIVE = new Set(["sc", "scin", "fcy", "prep"]);

// Os unicos audios: nome do arquivo em server/voice-clips
const CLIPS = {
  sc: () => "sc", // "Safety Car"
  count: (n) => (n === 20 ? "fcy-in-20" : "fcy-in"), // "Full Course Yellow in 20"; outro tempo, sem o numero
  fcy: () => "fcy", // "Full Course Yellow"
  green: () => "green", // "Bandeira Verde"
  scin: () => "sc-in", // "Safety Car Nessa volta"
  test: () => "green",
  prep: (n) => (n === 15 ? "green-in-15" : null), // "15 segundos para verde"; outro tempo, sem audio
  tick: (n) => String(n), // 10 a 1
};

// O que falar a cada leitura: [{ id, n }]. id "tick" e um numero da contagem.
function createVoiceCues(opts = {}) {
  const now = opts.now || Date.now;
  let key = null;
  let lastSession = null;
  let enteredAt = 0;
  let lastTick = null;

  return function update(session) {
    const sessionKey = session ? `${session.state}|${session.trackLocation || ""}` : null;
    const same = sessionKey === lastSession;
    lastSession = sessionKey;
    const cur = info(session);
    const nowKey = cur ? cur.key : ACTIVE.has(key) && same ? "green" : null;
    const left = cur && cur.key === "count" ? session.fcyCountdown : cur && cur.key === "prep" ? session.fcyGreenIn : null;
    const out = [];
    if (nowKey !== key) {
      key = nowKey;
      lastTick = left;
      if (nowKey === "prep") {
        // abre com o aviso; contagem curta (ate 10 s) comeca direto nos numeros
        enteredAt = 0;
        out.push({ id: left <= TICK_FROM_S ? "tick" : "prep", n: left });
      } else {
        enteredAt = now();
        if (nowKey) out.push({ id: nowKey, n: left });
      }
    } else if (left != null && left !== lastTick) {
      lastTick = left;
      if (left >= 1 && left <= TICK_FROM_S && now() - enteredAt >= PHRASE_MS) out.push({ id: "tick", n: left });
    }
    return out;
  };
}

function createRaceVoice(settings, opts = {}) {
  const startProcess =
    opts.spawn ||
    (() => {
      const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "voice.ps1")];
      return spawn("powershell.exe", args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    });
  const cues = createVoiceCues(opts);
  let child = null;
  let ready = false; // audios carregados
  let failed = false;
  let testWaiting = false; // "Testar" antes de os audios carregarem

  const isOn = () => !!settings.get("voiceOn");
  const volume = () => {
    const v = Number(settings.get("voiceVolume"));
    return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 100;
  };

  function write(line) {
    if (child && child.stdin.writable) child.stdin.write(line + "\n");
  }

  function say(id, n) {
    const clip = CLIPS[id](n);
    if (clip) write(`PLAY ${clip}`);
  }

  function ensure() {
    if (child) return;
    failed = false;
    try {
      child = startProcess();
    } catch (_) {
      failed = true;
      return;
    }
    const proc = child;
    let buffer = "";
    proc.stdin.on("error", () => {});
    proc.on("error", () => {
      failed = true;
      child = null;
    });
    proc.on("exit", () => {
      if (child === proc) child = null;
    });
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!ready && /READY \d+/.test(buffer)) {
        ready = true;
        if (testWaiting) say("test");
        testWaiting = false;
      }
    });
    write(`VOL ${volume()}`);
  }

  if (isOn()) ensure();

  // A cada leitura do jogo. A maquina de estados roda sempre, assim ligar a voz no
  // meio de um FCY nao fala o que ja passou.
  function update(session) {
    const out = cues(session);
    if (isOn() && ready) out.forEach((c) => say(c.id, c.n));
  }

  const status = () => ({ ok: true, on: isOn(), volume: volume(), ready, failed });

  function configure(body) {
    if (body && body.on != null) settings.set("voiceOn", body.on ? true : null);
    if (body && body.volume != null) {
      const v = Math.round(Number(body.volume));
      if (Number.isFinite(v)) settings.set("voiceVolume", Math.max(0, Math.min(100, v)));
    }
    if (isOn()) ensure();
    write(`VOL ${volume()}`);
    return status();
  }

  // "Testar": toca mesmo com a opcao desligada
  function test() {
    ensure();
    if (ready) say("test");
    else testWaiting = true;
    return status();
  }

  return { update, configure, test, status };
}

module.exports = { createRaceVoice, createVoiceCues, CLIPS };
