const test = require("node:test");
const assert = require("node:assert/strict");
const { createIndex, find } = require("../overlay/shared/avatars");
const fs = require("fs");
const os = require("os");
const path = require("path");
const avatarsServer = require("../server/avatars");

const index = createIndex([
  "Ben KEATING.png", // so o nome (pilotos da IA do LMU)
  "Célia MARTIN.png",
  "Rafael Rubio__RafaRubio88.png", // nome no RLT __ nome no jogo
  "Rafael Rubio__OutraConta.png",
  "Jordi Seibert.jpg",
  "leia-me.txt",
]);

test("foto pelo nome do jogo, sem diferenciar maiusculas e acentos", () => {
  assert.equal(find(index, [], "Ben Keating"), "Ben KEATING.png");
  assert.equal(find(index, [], "Celia Martin"), "Célia MARTIN.png");
  assert.equal(find(index, [], "Ninguem"), null);
});

test("nome no RLT e nome no jogo: os dois juntos vencem", () => {
  assert.equal(find(index, ["Rafael Rubio"], "OutraConta"), "Rafael Rubio__OutraConta.png");
  assert.equal(find(index, ["Rafael Rubio"], "RafaRubio88"), "Rafael Rubio__RafaRubio88.png");
  // nome no jogo diferente: vale o arquivo do nome no RLT
  assert.equal(find(index, ["Rafael Rubio"], "ContaNova"), "Rafael Rubio__RafaRubio88.png");
  // sem RLT: acha pelo nome no jogo (a segunda parte)
  assert.equal(find(index, [], "RafaRubio88"), "Rafael Rubio__RafaRubio88.png");
  // arquivo so com o nome no RLT
  assert.equal(find(index, ["Jordi Seibert"], "jordi_s"), "Jordi Seibert.jpg");
});

test("lista da pasta local: so imagens, e uma versao que muda quando uma foto muda", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llg-avatars-"));
  try {
    fs.writeFileSync(path.join(dir, "Ben KEATING.png"), "x");
    fs.writeFileSync(path.join(dir, "leia-me.txt"), "x");
    fs.mkdirSync(path.join(dir, "sub.png"));
    const a = avatarsServer.list(dir);
    assert.deepEqual(a.files, ["Ben KEATING.png"]);
    fs.utimesSync(path.join(dir, "Ben KEATING.png"), new Date(), new Date(Date.now() + 60000));
    assert.notEqual(avatarsServer.list(dir).version, a.version);
    assert.deepEqual(avatarsServer.list(path.join(dir, "nao-existe")).files, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
