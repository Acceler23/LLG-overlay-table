const test = require("node:test");
const assert = require("node:assert/strict");
const { createRaceMarks } = require("../server/raceMarks");

function fakeSettings(initial = {}) {
  const data = Object.assign({}, initial);
  return { data, get: (k) => data[k], set: (k, v) => (v == null ? delete data[k] : (data[k] = v)) };
}

const pass = (passer, passed, at, extra) => Object.assign({ passer, passed, under: "FCY", countdown: false, allowed: false, at }, extra);

test("FCY queimado e ultrapassagem ficam marcados no piloto", () => {
  const marks = createRaceMarks({ settings: fakeSettings() });
  marks.addFcy({ name: "Kyle West", fcy: 1, at: 10 });
  marks.addFcy({ name: "Kyle West", fcy: 2, at: 20 });
  marks.addPasses([pass("Kirin PT", "Jozef Pivo", 30)]);
  const list = marks.list();
  assert.deepEqual(list.find((m) => m.name === "Kyle West").fcy.map((f) => f.fcy), [1, 2]);
  assert.equal(list.find((m) => m.name === "Kirin PT").passes[0].passed, "Jozef Pivo");
});

test("ultrapassagem: so as novas contam, e retardatario liberado nao marca", () => {
  const marks = createRaceMarks({ settings: fakeSettings() });
  const list = [pass("A", "B", 100), pass("C", "D", 110, { allowed: true })];
  marks.addPasses(list);
  marks.addPasses(list); // a mesma lista de novo (leitura seguinte)
  marks.addPasses(list.concat(pass("A", "E", 120)));
  const a = marks.list().find((m) => m.name === "A");
  assert.equal(a.passes.length, 2);
  assert.equal(marks.list().find((m) => m.name === "C"), undefined);
});

test("drive-through recebido limpa os marcadores do piloto (so dele, e so quando chega)", () => {
  const marks = createRaceMarks({ settings: fakeSettings() });
  marks.addFcy({ name: "A", fcy: 1, at: 1 });
  marks.addFcy({ name: "B", fcy: 1, at: 1 });
  marks.noteStandings([{ name: "A", penaltyType: null }, { name: "B", penaltyType: "stopGo" }]);
  assert.equal(marks.list().length, 2, "stop & go nao limpa");
  marks.noteStandings([{ name: "A", penaltyType: "driveThrough" }, { name: "B", penaltyType: "stopGo" }]);
  assert.deepEqual(marks.list().map((m) => m.name), ["B"]);
  // o mesmo DT ainda pendente: uma infracao nova depois dele fica marcada
  marks.addFcy({ name: "A", fcy: 2, at: 2 });
  marks.noteStandings([{ name: "A", penaltyType: "driveThrough" }]);
  assert.ok(marks.list().some((m) => m.name === "A"));
});

test("limpar no botao: um piloto ou todos; fica salvo entre aberturas", () => {
  const settings = fakeSettings();
  const a = createRaceMarks({ settings });
  a.addFcy({ name: "A", fcy: 1, at: 1 });
  a.addPasses([pass("B", "C", 5)]);
  const b = createRaceMarks({ settings }); // reabriu o aplicativo
  assert.equal(b.list().length, 2);
  b.clear("A");
  assert.deepEqual(b.list().map((m) => m.name), ["B"]);
  b.clear();
  assert.equal(b.list().length, 0);
  assert.equal(settings.data.lmuMarks, undefined);
});
