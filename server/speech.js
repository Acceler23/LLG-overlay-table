// server/speech.js
// Fala do engenheiro de pista: um server/speech.ps1 aberto (vozes do Windows ja carregadas:
// Daniel, masculina, e Maria, feminina, como no Cubic Racing Analyser) e a fila aqui.
//   - cada frase do engenheiro sai inteira, uma depois da outra
//   - "urgent" (spotter) toca na hora, cortando a que estiver tocando; a frase do engenheiro
//     cortada volta para o comeco da fila e e dita de novo depois, para nada se perder
// So abre quando algo vai falar e fecha junto com o servidor.

const path = require("path");
const { spawn } = require("child_process");

const NICKNAMES = { Maria: "Bia", Daniel: "Chico" }; // como as vozes do Windows aparecem no painel
const MAX_QUEUE = 6; // fila maior que isso: o mais velho do engenheiro fica velho e sai
const GAP_MS = 250; // pausa entre duas frases

function createSpeech() {
  let child = null;
  let wanted = { volume: 80, rate: 0, voice: "" };
  let voices = [];
  let waitingVoices = [];
  let waitingDur = null; // resolve da duracao da frase que acabou de ser mandada
  const queue = []; // { text, urgent }
  let current = null; // { text, urgent, until }
  let timer = null;

  function start() {
    if (child || process.platform !== "win32") return;
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "speech.ps1")], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith("VOICES ")) {
          voices = line
            .slice(7)
            .split(";")
            .filter(Boolean)
            .map((v) => {
              const [id, raw, gender] = v.split("|");
              // nomes do engenheiro no painel: a Maria do Windows e a "Bia" e o Daniel e o "Chico"
              const name = NICKNAMES[raw] || raw;
              // as classicas (SAPI) ficam como reserva: o nome diz
              return { id, name: id.startsWith("sapi:") ? `${name} (clássica)` : name, gender: /female/i.test(gender || "") ? "feminina" : /male/i.test(gender || "") ? "masculina" : "" };
            });
          waitingVoices.splice(0).forEach((fn) => fn(voices));
        } else if (line.startsWith("DUR ") || line.startsWith("ERRO")) {
          const fn = waitingDur;
          waitingDur = null;
          if (fn) fn(line.startsWith("DUR ") ? Number(line.slice(4)) || 0 : 0);
        }
      }
    });
    const gone = () => {
      child = null;
      if (waitingDur) waitingDur(0);
      waitingDur = null;
    };
    child.on("exit", gone);
    child.on("error", gone);
    child.stdin.on("error", () => {});
  }

  function send(line) {
    start();
    if (child && child.stdin.writable) child.stdin.write(line.replace(/[\r\n]+/g, " ") + "\n");
  }

  function play(item) {
    clearTimeout(timer);
    current = { text: item.text, urgent: item.urgent, until: Infinity };
    const v = wanted;
    new Promise((resolve) => {
      waitingDur = resolve;
      // o texto vai em base64: acentos (à, ç, ã) chegam intactos, qualquer que seja a codificacao do console
      send(`PLAY ${Math.round(v.volume)}|${Math.round(v.rate)}|${v.voice || ""}|${Buffer.from(item.text, "utf8").toString("base64")}`);
      setTimeout(() => resolve(0), 8000); // o PowerShell nao respondeu
    }).then((dur) => {
      if (current && current.text === item.text) {
        current.until = Date.now() + dur;
        timer = setTimeout(next, dur + GAP_MS);
      }
    });
  }

  function next() {
    current = null;
    const item = queue.shift();
    if (item) play(item);
  }

  function say(text, urgent) {
    if (!text) return;
    if (urgent) {
      // spotter tocando: o aviso novo espera ele terminar (cortar um aviso no outro picota a voz)
      if (current && current.urgent && Date.now() < current.until) {
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].urgent) queue.splice(i, 1);
        queue.unshift({ text, urgent: true });
        return;
      }
      // spotter: na hora. O que o engenheiro estava falando volta para a fila, inteiro.
      if (current && !current.urgent) queue.unshift({ text: current.text, urgent: false });
      // um aviso do spotter mais velho na fila ja nao vale
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].urgent) queue.splice(i, 1);
      play({ text, urgent: true });
      return;
    }
    queue.push({ text, urgent: false });
    while (queue.length > MAX_QUEUE) queue.splice(queue.findIndex((q) => !q.urgent), 1);
    if (!current) next();
  }

  function apply(cfg) {
    wanted = Object.assign({}, wanted, cfg || {});
  }

  function listVoices() {
    return new Promise((resolve) => {
      if (process.platform !== "win32") return resolve([]);
      waitingVoices.push(resolve);
      send("VOICES");
      setTimeout(() => resolve(voices), 6000);
    });
  }

  function stop() {
    queue.length = 0;
    clearTimeout(timer);
    if (child) {
      try {
        child.stdin.end();
        child.kill();
      } catch (_) {}
      child = null;
    }
  }

  // nome da voz em uso, para o painel
  function voice() {
    const v = voices.find((x) => x.id === wanted.voice);
    return v ? v.name : wanted.voice || "padrão";
  }

  return { say, apply, listVoices, stop, voice };
}

module.exports = { createSpeech };
