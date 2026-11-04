const test = require("node:test");
const assert = require("node:assert/strict");
const { createEngineer, tempoFalado, nomeFalado } = require("../server/engineer");

function setup(extra) {
  const said = [];
  let t = 0;
  const eng = createEngineer({ config: Object.assign({ on: true }, extra || {}), speak: (text, urgent) => said.push({ text, urgent }), now: () => t });
  const tick = (data, dt = 100) => {
    t += dt;
    data.ts = t;
    eng.update(data);
  };
  return { eng, said, tick, at: () => t };
}

const session = (state = 5, extra) => Object.assign({ state, trackLocation: "Pista", trackVariation: "GP", trackLength: 1000 }, extra || {});

test("tempo e nome falados como no Analyser", () => {
  assert.equal(tempoFalado(118.2), "1 minuto e 58,2");
  assert.equal(tempoFalado(58), "58,0 segundos");
  assert.equal(tempoFalado(127.3), "2 minutos e 7,3");
  assert.equal(nomeFalado("Leonardo Mendes[PSR]"), "Leonardo Mendes");
  assert.equal(nomeFalado("MAIKON LIMA(AM)"), "Maikon Lima");
  assert.equal(nomeFalado("HRE_Ducati"), "Ducati");
  assert.equal(nomeFalado("Acceler23"), "Acceler");
});

test("spotter: carro a esquerda e a direita pelo rumo, e livre quando sai", () => {
  const { said, tick } = setup({ spotter: true, laps: false, rivals: false, alerts: false });
  // o piloto anda em +z (rumo 0). Mundo left-handed: +x e a DIREITA de quem anda em +z
  let z = 0;
  const step = (otherX, otherDz) => {
    z += 5;
    tick({ game: "ams2", session: session(), standings: [
      { name: "Eu", isPlayer: true, worldX: 0, worldZ: z, speedMs: 50, pitMode: 0, lapsCompleted: 1, position: 2 },
      { name: "Outro", worldX: otherX, worldZ: z + otherDz, speedMs: 50, pitMode: 0, lapsCompleted: 1, position: 1 },
    ] });
  };
  step(30, 0); // longe: nada
  step(3, 1);
  step(3, 1);
  assert.deepEqual(said.map((s) => s.text), ["Direita."]);
  assert.equal(said[0].urgent, true, "o spotter corta o engenheiro");
  // livre: so depois de ~0,5 s sem ninguem e de 1 s desde o ultimo aviso
  for (let i = 0; i < 4; i++) step(30, 0);
  assert.equal(said.length, 1, "ainda cedo para dizer livre");
  for (let i = 0; i < 8; i++) step(30, 0);
  assert.equal(said[said.length - 1].text, "Livre.");
  // outro carro logo depois: espera 1 s desde o "livre" para nao picotar a voz
  for (let i = 0; i < 12; i++) step(-3, 0);
  assert.equal(said[said.length - 1].text, "Esquerda.");
  assert.equal(said.length, 3);
});

test("voltas: primeira, melhor, acima da melhor, invalida; a de saida nao fala", () => {
  const { said, tick } = setup({ rivals: false, alerts: false, spotter: false });
  const lap = (n, ms, inv) => tick({ game: "ams2", session: session(1), standings: [{ name: "Eu", isPlayer: true, lapsCompleted: n, lastLapMs: ms, lapInvalidated: !!inv, position: 1 }] });
  lap(0, 0);
  lap(1, 95000); // volta de saida
  lap(2, 90000);
  lap(3, 89600);
  lap(4, 90400);
  lap(4, 90400, true); // invalidou durante a volta 5
  lap(5, 91000, true);
  assert.deepEqual(said.map((s) => s.text), [
    "Volta 1 minuto e 30,0.",
    "Melhor volta: 1 minuto e 29,6. 0,4 mais rápida.",
    "Volta 1 minuto e 30,4, 0,8 acima da melhor.",
    "Volta inválida.",
  ]);
});

test("frase reescrita pelo piloto vale no lugar da padrao", () => {
  const { said, tick } = setup({ rivals: false, alerts: false, spotter: false, phrases: { volta_primeira: "Tempo {tempo}" } });
  const lap = (n, ms) => tick({ game: "ams2", session: session(1), standings: [{ name: "Eu", isPlayer: true, lapsCompleted: n, lastLapMs: ms, position: 1 }] });
  lap(0, 0);
  lap(1, 95000);
  lap(2, 90000);
  assert.deepEqual(said.map((s) => s.text), ["Tempo 1 minuto e 30,0"]);
});

test("fim da corrida: posicao, melhor volta e veredito; depois o radio cala", () => {
  const { said, tick } = setup({ laps: false, rivals: false, alerts: false, spotter: false });
  const me = (state) => tick({ game: "ams2", session: session(5), standings: [
    { name: "Eu", isPlayer: true, lapsCompleted: 10, position: 2, startPosition: 5, raceState: state },
    { name: "Outro", lapsCompleted: 10, position: 1, raceState: 3 },
    { name: "Mais um", lapsCompleted: 10, position: 3, raceState: 2 },
  ] });
  me(2);
  me(3);
  me(3);
  assert.equal(said.length, 1);
  assert.match(said[0].text, /posição 2 de 3\. Foi bem: ganhou 3 posições desde a largada\./);
});

test("desligado nao fala nada", () => {
  const { said, tick } = setup({ on: false });
  tick({ game: "ams2", session: session(1), standings: [{ name: "Eu", isPlayer: true, lapsCompleted: 0 }] });
  tick({ game: "ams2", session: session(1), standings: [{ name: "Eu", isPlayer: true, lapsCompleted: 1, lastLapMs: 90000 }] });
  assert.equal(said.length, 0);
});

test("so o spotter ligado: avisa os lados e o radio fica quieto", () => {
  const { said, tick } = setup({ on: false, spotter: true });
  let z = 0;
  const step = (otherX, laps, lastLapMs) => {
    z += 5;
    tick({ game: "ams2", session: session(5), standings: [
      { name: "Eu", isPlayer: true, worldX: 0, worldZ: z, speedMs: 50, pitMode: 0, lapsCompleted: laps, lastLapMs, position: 2 },
      { name: "Outro", worldX: otherX, worldZ: z, speedMs: 50, pitMode: 0, lapsCompleted: laps, position: 1 },
    ] });
  };
  step(30, 1, 0);
  step(-3, 2, 90000); // fecha a volta: o radio nao fala
  step(-3, 2, 90000);
  assert.deepEqual(said.map((x) => x.text), ["Esquerda."]);
});
