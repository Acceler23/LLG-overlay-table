const test = require("node:test");
const assert = require("node:assert/strict");
const { createGameIncidents, PREROLL_S } = require("../server/lmuIncidents");

// API do jogo falsa: guarda os comandos e responde como o LMU
function fakeGame(incidents = []) {
  const calls = [];
  let active = false;
  const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => String(body) });
  const fetchFake = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    if (opts.method) {
      assert.equal(opts.body, "", "POST e PUT precisam de corpo, senao o jogo nao responde");
      calls.push(`${opts.method} ${path}`);
    }
    if (path.endsWith("/toggleactive")) active = !active;
    if (path.endsWith("/isActive")) return reply(active);
    if (path.includes("getIncidentsList")) return reply(incidents);
    return reply("");
  };
  return { calls, game: createGameIncidents({ fetch: fetchFake, sleep: async () => {} }), isActive: () => active };
}

// dados reais do LMU em Sebring: a telemetria dos dois carros traz a mesma batida
test("casa o incidente do jogo com a forca da telemetria", async () => {
  const { game } = fakeGame([
    { contactWith: "Matteo Cressoni", et: 787.3, player: "Alex Riberas" },
    { contactWith: "Immovable", et: 688.88, player: "Matteo Cressoni" },
    { contactWith: "Rui Andrade", et: 78.96, player: "Nicky Catsburg" },
  ]);
  game.apply({ standings: [{ name: "Matteo Cressoni", lastImpactEt: 688.8, lastImpactMag: 500 }] });
  game.apply({ standings: [{ name: "Alex Riberas", lastImpactEt: 787.22, lastImpactMag: 2281.7 }, { name: "Matteo Cressoni", lastImpactEt: 787.22, lastImpactMag: 2281.7 }] });
  await game.poll();
  assert.deepEqual(game.list(), [
    { et: 787.3, player: "Alex Riberas", contactWith: "Matteo Cressoni", wall: false, force: 2281.7 },
    { et: 688.88, player: "Matteo Cressoni", contactWith: null, wall: true, force: 500 },
    { et: 78.96, player: "Nicky Catsburg", contactWith: "Rui Andrade", wall: false, force: null }, // antes do app abrir
  ]);
});

test("nome com o codigo da conta do online casa com a telemetria", async () => {
  const { game } = fakeGame([{ contactWith: "Immovable", et: 100, player: "Felipe Antunes#1005" }]);
  game.apply({ standings: [{ name: "Felipe Antunes", lastImpactEt: 100.1, lastImpactMag: 900 }] });
  await game.poll();
  assert.deepEqual([game.list()[0].player, game.list()[0].force], ["Felipe Antunes", 900]);
});

test("replay: liga se precisar e vai para um pouco antes do momento", async () => {
  const { game, calls, isActive } = fakeGame();
  await game.jump(787.3);
  assert.equal(isActive(), true);
  assert.deepEqual(calls, ["POST /rest/replay/toggleactive", `PUT /rest/watch/replaytime/${(787.3 - PREROLL_S).toFixed(2)}`]);
  await game.jump(2); // ja ligado: nao desliga; nao pede tempo negativo
  assert.equal(calls[2], "PUT /rest/watch/replaytime/0.00");
  await game.exit();
  assert.equal(isActive(), false);
  await game.exit(); // ja ao vivo: nao liga de novo
  assert.equal(isActive(), false);
});
