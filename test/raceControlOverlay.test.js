const test = require("node:test");
const assert = require("node:assert/strict");
const { info, resolve } = require("../overlay/shared/racecontrol");

test("painel e etiqueta: o que mostrar em cada estado", () => {
  assert.equal(info(null), null);
  assert.equal(info({}), null);
  assert.deepEqual([info({ scOut: true }).key, info({ scOut: true }).tag], ["sc", "SAFETY CAR"]); // SC do proprio jogo
  assert.equal(info({ scCall: true }).key, "sc");
  assert.equal(info({ fcy: true }).tag, "FCY");
  assert.equal(info({ fcy: true, fcyCountdown: 7 }).tag, "FCY EM 7");
  const prep = info({ fcy: true, fcyGreenIn: 5, fcyCountdown: 0 });
  assert.deepEqual([prep.key, prep.tag], ["prep", "VERDE EM 5"]);
  assert.match(prep.big, /Preparar/);
  assert.equal(info({ fcy: true, scOut: true }).key, "fcy"); // FCY tem prioridade
});

test("bandeira verde: quando o FCY ou o SC acaba na mesma sessao; sessao nova nao", () => {
  const key = (s, prev, same = true) => (resolve(s, prev, same) || { key: null }).key;
  assert.equal(key({}, "prep"), "green");
  assert.equal(key({}, "fcy"), "green"); // encerrou direto, sem contagem
  assert.equal(key({}, "sc"), "green"); // fim do SC, inclusive o do proprio jogo
  assert.equal(key({}, "green"), "green"); // fica ate o tempo tirar
  assert.equal(key({}, null), null); // corrida normal
  assert.equal(key({}, "fcy", false), null); // sessao nova so desliga
  assert.equal(key({ fcy: true }, "green"), "fcy"); // novo FCY logo depois
});
