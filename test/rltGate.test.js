const test = require("node:test");
const assert = require("node:assert/strict");
const { createRltGate } = require("../server/rltGate");

// pacote do jogo como o servidor recebe: n carros e, no LMU, session.online
function pkt(game, cars, online) {
  const session = { state: 1 };
  if (online !== undefined) session.online = online;
  return { game, session, standings: Array.from({ length: cars }, (_, i) => ({ name: `P${i}` })) };
}

function setup({ season = true, linked = 0 } = {}) {
  const state = { season, linked, changes: [] };
  const gate = createRltGate({
    hasSeason: () => state.season,
    linkedCount: () => state.linked,
    onChange: (live, why) => state.changes.push([live, why]),
  });
  return { gate, state };
}

test("LMU online: RLT ligado mesmo sem ninguem do lineup", () => {
  const { gate, state } = setup({ linked: 0 });
  gate.noteSession(pkt("lmu", 10, true));
  assert.equal(gate.isLive(), true);
  assert.deepEqual(state.changes, [[true, "o jogo informa sessao online"]]);
});

test("LMU offline: RLT pausado mesmo com pilotos do lineup na pista", () => {
  const { gate } = setup({ linked: 5 });
  gate.noteSession(pkt("lmu", 10, false));
  assert.equal(gate.isLive(), false);
});

test("LMU: sair de online para offline pausa; no menu (sem carros) mantem", () => {
  const { gate, state } = setup();
  gate.noteSession(pkt("lmu", 10, true));
  assert.equal(gate.isLive(), true);
  gate.noteSession(pkt("lmu", 0, true)); // menu entre sessoes
  assert.equal(gate.isLive(), true, "no menu nao pisca");
  gate.noteSession(pkt("lmu", 8, false)); // entrou offline
  assert.equal(gate.isLive(), false);
  assert.equal(state.changes.length, 2);
});

test("LMU: pacotes repetidos nao reavaliam", () => {
  const { gate, state } = setup();
  for (let i = 0; i < 50; i++) gate.noteSession(pkt("lmu", 10, true));
  assert.equal(state.changes.length, 1);
});

test("sem temporada aplicada: nunca liga", () => {
  const { gate } = setup({ season: false });
  gate.noteSession(pkt("lmu", 10, true));
  assert.equal(gate.isLive(), false);
});

test("AMS2 (o jogo nao informa): vale o lineup, 2 pilotos ou mais", () => {
  const { gate, state } = setup({ linked: 1 });
  gate.noteSession(pkt("ams2", 12));
  assert.equal(gate.isLive(), false, "so 1 do lineup");
  state.linked = 2; // os nomes foram ligados (updateLinkStatus chama refresh)
  gate.refresh();
  assert.equal(gate.isLive(), true);
  assert.deepEqual(state.changes, [[true, "2 pilotos do lineup na pista"]]);
});

test("LMU online e depois AMS2 offline: a flag do LMU nao vaza para o AMS2", () => {
  const { gate, state } = setup({ linked: 0 });
  gate.noteSession(pkt("lmu", 10, true));
  assert.equal(gate.isLive(), true);
  gate.noteSession(pkt("ams2", 12)); // AMS2 contra a IA: ninguem do lineup
  assert.equal(gate.isLive(), false);
  assert.equal(state.changes.at(-1)[1], "0 pilotos do lineup na pista");
});

test("tirar a temporada pausa na hora", () => {
  const { gate, state } = setup();
  gate.noteSession(pkt("lmu", 10, true));
  state.season = false;
  gate.refresh();
  assert.equal(gate.isLive(), false);
});
