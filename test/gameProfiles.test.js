const test = require("node:test");
const assert = require("node:assert/strict");
const { createGameProfiles } = require("../server/gameProfiles");

function fakeSettings() {
  const data = {};
  return { data, get: (k) => data[k], set: (k, v) => (v == null ? delete data[k] : (data[k] = v)) };
}

test("cada jogo guarda as suas opacidades (transmissao e pilotar)", () => {
  const settings = fakeSettings();
  const p = createGameProfiles(settings);
  p.noteBroadcast("ams2", "table", 1);
  p.noteBroadcast("lmu", "table", 0.5);
  p.noteBroadcast("lmu", "map", 0.8);
  p.notePilot("lmu", "telemetria", 0.3);
  assert.deepEqual(p.get("ams2"), { broadcast: { table: 1 }, pilot: {} });
  assert.deepEqual(p.get("lmu"), { broadcast: { table: 0.5, map: 0.8 }, pilot: { telemetria: 0.3 } });
  assert.equal(p.get("acc"), null, "jogo sem nada salvo: nada muda ao trocar para ele");
  // continua depois de reabrir
  assert.deepEqual(createGameProfiles(settings).get("lmu").broadcast.table, 0.5);
});

test("valores fora do lugar nao entram", () => {
  const p = createGameProfiles(fakeSettings());
  assert.equal(p.noteBroadcast(null, "table", 1), false, "sem jogo");
  assert.equal(p.noteBroadcast("ams2", "outra", 1), false, "alvo desconhecido");
  assert.equal(p.notePilot("ams2", "tabela", "x"), false, "nao e numero");
  p.noteBroadcast("ams2", "rows", 7);
  assert.equal(p.get("ams2").broadcast.rows, 1, "limitado a 100%");
});
