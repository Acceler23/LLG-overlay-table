const test = require("node:test");
const assert = require("node:assert/strict");
const { createRaceState, uniquifyNames } = require("../server/raceState");
const { normalizeName } = require("../overlay/shared/names");

function setup() {
  const clock = { t: 1000000 };
  const rs = createRaceState(() => clock.t);
  return { clock, rs };
}

function payload(state, entries) {
  return {
    session: { state, trackLocation: "Interlagos", trackVariation: "GP" },
    standings: entries.map((e) => Object.assign({ pitMode: 0, raceState: 2, speedMs: 0, lapsCompleted: 0, currentLap: 1 }, e)),
  };
}

function byName(p, name) {
  return p.standings.find((e) => e.name === name);
}

test("posicao de largada trava quando o pelotao anda", () => {
  const { clock, rs } = setup();
  rs.apply(payload(5, [{ name: "A", position: 2 }, { name: "B", position: 1 }]));
  // grid ainda muda antes da largada
  clock.t += 200;
  let p = rs.apply(payload(5, [{ name: "A", position: 1 }, { name: "B", position: 2 }]));
  assert.equal(byName(p, "A").startPosition, 1);
  // largou
  clock.t += 200;
  rs.apply(payload(5, [{ name: "A", position: 1, speedMs: 30 }, { name: "B", position: 2, speedMs: 30 }]));
  clock.t += 200;
  p = rs.apply(payload(5, [{ name: "A", position: 2, speedMs: 50 }, { name: "B", position: 1, speedMs: 50 }]));
  assert.equal(byName(p, "A").startPosition, 1);
  assert.equal(byName(p, "B").startPosition, 2);
});

test("piloto que entra depois da largada nao tem posicao de largada", () => {
  const { clock, rs } = setup();
  rs.apply(payload(5, [{ name: "A", position: 1, speedMs: 30 }]));
  clock.t += 200;
  const p = rs.apply(payload(5, [{ name: "A", position: 1, speedMs: 30 }, { name: "C", position: 2, speedMs: 30 }]));
  assert.equal(byName(p, "C").startPosition, null);
});

test("conta paradas, stint e tempo de box", () => {
  const { clock, rs } = setup();
  const car = { name: "A", position: 1, speedMs: 50, lapsCompleted: 5, currentLap: 6 };
  rs.apply(payload(5, [car]));
  clock.t += 20000; // passa a janela inicial de 10 s
  let p = rs.apply(payload(5, [car]));
  assert.equal(byName(p, "A").pit.stops, 0);

  clock.t += 200;
  p = rs.apply(payload(5, [Object.assign({}, car, { pitMode: 2 })]));
  assert.equal(byName(p, "A").pit.stops, 1);
  assert.equal(byName(p, "A").pit.phase, "in");

  clock.t += 30000;
  p = rs.apply(payload(5, [Object.assign({}, car, { pitMode: 3 })]));
  assert.equal(byName(p, "A").pit.phase, "out");
  assert.equal(byName(p, "A").pit.elapsedMs, 30000);

  clock.t += 5000;
  p = rs.apply(payload(5, [car]));
  assert.equal(byName(p, "A").pit.phase, "done");
  assert.equal(byName(p, "A").pit.elapsedMs, 35000);
  assert.equal(byName(p, "A").pit.outLap, true);
  assert.equal(byName(p, "A").pit.stops, 1);

  // completa a volta de saida e mais duas
  clock.t += 90000;
  p = rs.apply(payload(5, [Object.assign({}, car, { lapsCompleted: 8, currentLap: 9 })]));
  assert.equal(byName(p, "A").pit.phase, null);
  assert.equal(byName(p, "A").pit.outLap, false);
  assert.equal(byName(p, "A").pit.stintLaps, 3);
});

test("carro no box no grid nao conta como parada", () => {
  const { clock, rs } = setup();
  const car = { name: "A", position: 1, pitMode: 4 };
  rs.apply(payload(5, [car]));
  clock.t += 5000;
  rs.apply(payload(5, [car]));
  clock.t += 20000;
  const p = rs.apply(payload(5, [Object.assign({}, car, { pitMode: 0, speedMs: 40 })]));
  assert.equal(byName(p, "A").pit.stops, 0);
});

test("registra o instante da bandeirada uma unica vez", () => {
  const { clock, rs } = setup();
  rs.apply(payload(5, [{ name: "A", position: 1, speedMs: 50 }]));
  clock.t += 1000;
  let p = rs.apply(payload(5, [{ name: "A", position: 1, speedMs: 50, raceState: 3 }]));
  const at = byName(p, "A").finishedAtMs;
  assert.equal(at, clock.t);
  clock.t += 5000;
  p = rs.apply(payload(5, [{ name: "A", position: 1, speedMs: 10, raceState: 3 }]));
  assert.equal(byName(p, "A").finishedAtMs, at);
});

test("troca de sessao zera tudo", () => {
  const { clock, rs } = setup();
  rs.apply(payload(3, [{ name: "A", position: 3, speedMs: 50 }]));
  clock.t += 1000;
  const p = rs.apply(payload(5, [{ name: "A", position: 1 }]));
  assert.equal(byName(p, "A").startPosition, 1);
  assert.equal(byName(p, "A").finishedAtMs, null);
});

test("reset manual recalcula a largada", () => {
  const { clock, rs } = setup();
  rs.apply(payload(5, [{ name: "A", position: 1, speedMs: 50 }]));
  clock.t += 1000;
  rs.reset();
  const p = rs.apply(payload(5, [{ name: "A", position: 4, speedMs: 50 }]));
  assert.equal(byName(p, "A").startPosition, 4);
});

test("nomes repetidos viram chaves distintas e estaveis", () => {
  const a = uniquifyNames([
    { name: "Ronaldo Junior", slot: 7, position: 4 },
    { name: "Outro", slot: 1, position: 1 },
    { name: "Ronaldo Junior", slot: 2, position: 16 },
  ]);
  assert.notEqual(a[0].name, a[2].name);
  assert.equal(a[2].name, "Ronaldo Junior"); // menor slot fica com o nome puro
  assert.equal(normalizeName(a[0].name), "ronaldo junior"); // invisivel para o RLT
  // mesma atribuicao com os carros em outra ordem de posicao
  const b = uniquifyNames([
    { name: "Ronaldo Junior", slot: 2, position: 3 },
    { name: "Ronaldo Junior", slot: 7, position: 9 },
  ]);
  assert.equal(b[0].name, a[2].name);
  assert.equal(b[1].name, a[0].name);
});

test("carro na garagem nao prende o OUT de outro carro com o mesmo nome", () => {
  const { clock, rs } = setup();
  const garage = { name: "Ronaldo Junior", slot: 2, position: 16, pitMode: 4, currentLap: 1 };
  const driving = (lap) => ({ name: "Ronaldo Junior", slot: 7, position: 4, pitMode: 0, speedMs: 50, currentLap: lap, lapsCompleted: lap - 1 });
  rs.apply(payload(3, [Object.assign({}, driving(1), { pitMode: 3 }), garage]));
  clock.t += 200;
  let p = rs.apply(payload(3, [driving(1), garage]));
  const car = (q) => q.standings.find((e) => e.slot === 7);
  assert.equal(car(p).pit.outLap, true); // volta de saida
  clock.t += 200;
  p = rs.apply(payload(3, [driving(2), garage]));
  assert.equal(car(p).pit.outLap, false); // abriu a volta: OUT some
  assert.equal(p.standings.find((e) => e.slot === 2).pit.phase, "in");
});

test("classificacao: OUT some ao cruzar a linha, mesmo sem o numero da volta subir", () => {
  const { clock, rs } = setup();
  const TRACK = 5800;
  const tick = (extra) => {
    clock.t += 200;
    const p = payload(3, [Object.assign({ name: "A", position: 1, speedMs: 50, currentLap: 1, lapsCompleted: 0 }, extra)]);
    p.session.trackLength = TRACK;
    return byName(rs.apply(p), "A").pit;
  };
  tick({ pitMode: 4, totalDistance: 5650, speedMs: 0 }); // garagem
  tick({ pitMode: 5, totalDistance: 5700 }); // saindo
  tick({ pitMode: 3, totalDistance: 60 }); // pit lane passa pela linha: ainda nao vale
  assert.equal(tick({ pitMode: 0, totalDistance: 400 }).outLap, true); // na pista, volta de saida
  assert.equal(tick({ pitMode: 0, totalDistance: 3000 }).outLap, true);
  assert.equal(tick({ pitMode: 0, totalDistance: 5790 }).outLap, true);
  // cruza a linha: o jogo continua em currentLap=1/lapsCompleted=0
  const opened = tick({ pitMode: 0, totalDistance: 12 });
  assert.equal(opened.outLap, false);
  assert.equal(opened.phase, null);
  assert.equal(tick({ pitMode: 0, totalDistance: 2500 }).outLap, false);
});

test("troca de piloto: largada e paradas continuam com o carro", () => {
  const { clock, rs } = setup();
  const car = (name, extra) => Object.assign({ name, slot: 7, carNumber: "23", position: 3, speedMs: 50, lapsCompleted: 10, currentLap: 11 }, extra);
  rs.apply(payload(5, [car("Piloto A")]));
  clock.t += 20000;
  rs.apply(payload(5, [car("Piloto A")]));
  // entra no box, troca de piloto, sai
  clock.t += 200;
  rs.apply(payload(5, [car("Piloto A", { pitMode: 2 })]));
  clock.t += 40000;
  let p = rs.apply(payload(5, [car("Piloto B", { pitMode: 2, position: 5 })]));
  assert.equal(byName(p, "Piloto B").startPosition, 3); // largada do carro
  assert.equal(byName(p, "Piloto B").pit.stops, 1); // a parada nao foi contada de novo
  assert.equal(byName(p, "Piloto B").pit.phase, "in");
  assert.equal(byName(p, "Piloto B").pit.elapsedMs, 40000); // o cronometro do box nao recomecou
});

test("carro levado para o box depois da bandeirada nao ganha uma parada", () => {
  const { clock, rs } = setup();
  const car = { name: "A", position: 1, speedMs: 50, lapsCompleted: 5, currentLap: 6 };
  rs.apply(payload(5, [car]));
  clock.t += 20000;
  rs.apply(payload(5, [car]));
  clock.t += 200;
  rs.apply(payload(5, [Object.assign({}, car, { raceState: 3 })]));
  clock.t += 30000;
  const p = rs.apply(payload(5, [Object.assign({}, car, { raceState: 3, pitMode: 4, speedMs: 0 })]));
  assert.equal(byName(p, "A").pit.stops, 0);
});

test("tempo de stint: conta desde a largada, zera no box e recomeca na saida", () => {
  const { clock, rs } = setup();
  const car = { name: "A", position: 1, speedMs: 50, lapsCompleted: 5, currentLap: 6 };
  const pitOf = (extra) => byName(rs.apply(payload(5, [Object.assign({}, car, extra)])), "A").pit;
  pitOf();
  clock.t += 12 * 60000; // 12 minutos de corrida
  assert.equal(pitOf().stintMs, 12 * 60000);
  clock.t += 1000;
  assert.equal(pitOf({ pitMode: 2 }).stintMs, 0); // no box
  clock.t += 40000;
  assert.equal(pitOf().stintMs, 0); // acabou de sair: stint novo
  clock.t += 7 * 60000;
  assert.equal(pitOf().stintMs, 7 * 60000);
  // bandeirada: o tempo para de contar
  clock.t += 60000;
  assert.equal(pitOf({ raceState: 3 }).stintMs, 8 * 60000);
  clock.t += 5 * 60000;
  assert.equal(pitOf({ raceState: 3 }).stintMs, 8 * 60000);
});

test("tempo de stint so existe em corrida", () => {
  const { clock, rs } = setup();
  rs.apply(payload(3, [{ name: "A", position: 1, speedMs: 50 }]));
  clock.t += 10 * 60000;
  assert.equal(byName(rs.apply(payload(3, [{ name: "A", position: 1, speedMs: 50 }])), "A").pit.stintMs, 0);
});

test("numero da volta mais rapida: registrado quando a ultima volta e a melhor", () => {
  const clock = { t: 0 };
  const rs = createRaceState(() => clock.t);
  const p = (laps, last, best) => ({
    session: { state: 5, trackLocation: "X", trackLength: 3000 },
    standings: [{ name: "A", position: 1, pitMode: 0, raceState: 2, speedMs: 50, lapsCompleted: laps, currentLap: laps + 1, lastLapMs: last, fastestLapMs: best }],
  });
  // overlay aberta depois da melhor volta: numero desconhecido
  assert.equal(rs.apply(p(5, 91000, 90000)).standings[0].fastestLapNum, null);
  // volta 6 vira a melhor
  assert.equal(rs.apply(p(6, 89500, 89500)).standings[0].fastestLapNum, 6);
  // voltas seguintes mais lentas: continua a 6
  assert.equal(rs.apply(p(7, 90500, 89500)).standings[0].fastestLapNum, 6);
  assert.equal(rs.apply(p(8, 91000, 89500)).standings[0].fastestLapNum, 6);
  // sem melhor volta ainda
  assert.equal(rs.apply(p(0, 0, 0)).standings[0].fastestLapNum, null);
});

test("corrida por tempo: voltas que faltam depois do relogio zerar", () => {
  const clock = { t: 0 };
  const rs = createRaceState(() => clock.t);
  const frame = (remaining, laps, extra) => {
    clock.t += 500;
    return rs.apply({
      session: { state: 5, trackLocation: "X", trackLength: 3000, lapsInEvent: 0, timeRemainingSec: remaining, additionalLaps: extra },
      standings: [{ name: "A", position: 1, pitMode: 0, raceState: 2, speedMs: 50, lapsCompleted: laps, currentLap: laps + 1 }],
    }).session.lapsLeft;
  };
  assert.equal(frame(30, 10, 1), null); // ainda tem tempo: mostra o relogio
  assert.equal(frame(0, 10, 1), 2); // zerou na volta 11: termina a 11 e faz mais 1
  assert.equal(frame(-5, 10, 1), 2);
  assert.equal(frame(-60, 11, 1), 1); // ultima volta
  // sem voltas extras (outros jogos): so termina a volta em que estava
  const rs2 = createRaceState(() => clock.t);
  clock.t += 500;
  const s = rs2.apply({ session: { state: 5, trackLocation: "Y", lapsInEvent: 0, timeRemainingSec: 0 }, standings: [{ name: "A", position: 1, pitMode: 0, raceState: 2, speedMs: 50, lapsCompleted: 7 }] }).session;
  assert.equal(s.lapsLeft, 1);
  // corrida por voltas: nunca
  clock.t += 500;
  assert.equal(rs2.apply({ session: { state: 5, trackLocation: "Z", lapsInEvent: 20, timeRemainingSec: 0 }, standings: [] }).session.lapsLeft, null);
});
