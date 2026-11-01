const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { createRaceVoice, createVoiceCues, CLIPS } = require("../server/raceVoice");

// o que seria falado a cada leitura, ja com o texto final
function cuesSetup() {
  let t = 0;
  const update = createVoiceCues({ now: () => t });
  return (ms, session) => {
    t += ms;
    return update(Object.assign({ state: 5, trackLocation: "Spa" }, session)).map((c) => CLIPS[c.id](c.n));
  };
}

test("audios: todo arquivo usado existe em server/voice-clips", () => {
  const names = [CLIPS.prep(15), CLIPS.sc(), CLIPS.count(20), CLIPS.count(15), CLIPS.fcy(), CLIPS.green(), CLIPS.scin(), CLIPS.test()];
  for (let n = 1; n <= 10; n++) names.push(CLIPS.tick(n));
  names.forEach((n) => assert.ok(fs.existsSync(path.join(__dirname, "../server/voice-clips", n + ".wav")), n));
});

test("voz do FCY: abertura, ultimos 10 s, FCY valendo, numeros da verde, bandeira verde", () => {
  const step = cuesSetup();
  assert.deepEqual(step(0, {}), []);
  assert.deepEqual(step(100, { fcy: true, fcyCountdown: 20 }), ["fcy-in-20"]);
  assert.deepEqual(step(1000, { fcy: true, fcyCountdown: 19 }), []); // pausa: o chat tambem nao conta aqui
  assert.deepEqual(step(9000, { fcy: true, fcyCountdown: 10 }), ["10"]);
  assert.deepEqual(step(100, { fcy: true, fcyCountdown: 10 }), []); // um numero fala uma vez
  assert.deepEqual(step(900, { fcy: true, fcyCountdown: 9 }), ["9"]);
  assert.deepEqual(step(9000, { fcy: true, fcyCountdown: 0 }), ["fcy"]);
  assert.deepEqual(step(1000, { fcy: true, fcyGreenIn: 15 }), ["green-in-15"]); // o aviso
  assert.deepEqual(step(1000, { fcy: true, fcyGreenIn: 14 }), []); // pausa, como no chat
  assert.deepEqual(step(4000, { fcy: true, fcyGreenIn: 10 }), ["10"]);
  assert.deepEqual(step(1000, { fcy: true, fcyGreenIn: 9 }), ["9"]);
  assert.deepEqual(step(9000, {}), ["green"]);
  assert.deepEqual(step(1000, {}), []);
});

test("audio do safety car: encerrado, Nessa volta e depois a bandeira verde; o do jogo, direto a verde", () => {
  const step = cuesSetup();
  step(0, {});
  assert.deepEqual(step(100, { scCall: true, scOut: true }), ["sc"]);
  assert.deepEqual(step(100, { scCall: true, scOut: true }), []);
  assert.deepEqual(step(100, { scIn: true, scOut: true }), ["sc-in"]);
  assert.deepEqual(step(100, { scIn: true, scOut: true }), []);
  assert.deepEqual(step(100, {}), ["green"]);
  step(100, {});
  assert.deepEqual(step(100, { scOut: true }), ["sc"]);
  assert.deepEqual(step(100, {}), ["green"]);
});

test("voz: sessao nova nao fala nada; contagem cancelada nao fala bandeira verde", () => {
  const step = cuesSetup();
  step(0, {});
  step(100, { fcy: true });
  assert.deepEqual(step(100, { state: 1 }), []);
  step(100, { state: 1 });
  step(100, { state: 1, fcy: true, fcyCountdown: 5 });
  assert.deepEqual(step(100, { state: 1 }), []);
});

// processo falso no lugar do voice.ps1
function setup(values = {}) {
  const data = Object.assign({}, values);
  const settings = { get: (k) => data[k], set: (k, v) => (v == null ? delete data[k] : (data[k] = v)) };
  const lines = [];
  let started = 0;
  const proc = new EventEmitter();
  proc.stdin = Object.assign(new EventEmitter(), { writable: true, write: (l) => lines.push(l.trim()) });
  proc.stdout = new EventEmitter();
  const voice = createRaceVoice(settings, {
    spawn: () => {
      started++;
      return proc;
    },
  });
  return { voice, lines, ready: () => proc.stdout.emit("data", Buffer.from("READY 16\n")), started: () => started };
}

test("voz: desligada nao inicia o processo nem fala", () => {
  const { voice, lines, started } = setup();
  voice.update({ state: 5, fcy: true });
  assert.equal(started(), 0);
  assert.deepEqual(lines, []);
});

test("audios: ligados, tocam o arquivo do momento", () => {
  const { voice, lines, ready } = setup({ voiceOn: true });
  ready();
  voice.update({ state: 5 });
  voice.update({ state: 5, scOut: true });
  assert.equal(lines[lines.length - 1], "PLAY sc");
  assert.equal(voice.status().ready, true);
});

test("voz: o teste espera a voz iniciar e fala mesmo com a opcao desligada", () => {
  const { voice, lines, ready } = setup();
  voice.test();
  assert.ok(!lines.some((l) => l.startsWith("PLAY")));
  ready();
  assert.equal(lines[lines.length - 1], "PLAY green");
});
