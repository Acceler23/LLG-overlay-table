const test = require("node:test");
const assert = require("node:assert/strict");
const { createSessionLog } = require("../server/sessionLog");

function setup() {
  const clock = { t: 0 };
  const log = createSessionLog({ clock: () => clock.t, classOf: (e) => e.carClass });
  // roda `seconds` segundos de leituras a cada 0,5 s
  const run = (seconds, cars) => {
    for (let k = 0; k < seconds * 2; k++) {
      clock.t += 500;
      log.apply({
        session: { state: 5, trackLocation: "X" },
        standings: cars.map((c) => Object.assign({ speedMs: 50, pitMode: 0, raceState: 2, lapsCompleted: 3, currentLap: 4, carClass: "GT3", pit: { phase: null } }, c)),
      });
    }
  };
  const types = (type) => log.getEvents().filter((e) => e.type === type);
  return { clock, log, run, types };
}

test("ultrapassagem: so vale depois de 2 s na posicao nova", () => {
  const { run, types } = setup();
  run(3, [{ name: "A", position: 1 }, { name: "B", position: 2 }]);
  run(1, [{ name: "B", position: 1 }, { name: "A", position: 2 }]); // 1 s: ainda nao
  assert.equal(types("overtake").length, 0);
  run(1.5, [{ name: "B", position: 1 }, { name: "A", position: 2 }]);
  const o = types("overtake");
  assert.equal(o.length, 1);
  assert.equal(o[0].gainer, "B");
  assert.equal(o[0].loser, "A");
  assert.equal(o[0].position, 1);
  assert.equal(o[0].lap, 4);
});

test("lado a lado trocando de posicao nao vira varias ultrapassagens", () => {
  const { run, types } = setup();
  run(3, [{ name: "A", position: 1 }, { name: "B", position: 2 }]);
  for (let i = 0; i < 5; i++) {
    run(0.5, [{ name: "B", position: 1 }, { name: "A", position: 2 }]);
    run(0.5, [{ name: "A", position: 1 }, { name: "B", position: 2 }]);
  }
  assert.equal(types("overtake").length, 0);
});

test("quem perde posicao por estar no box nao foi ultrapassado", () => {
  const { run, types } = setup();
  run(3, [{ name: "A", position: 1 }, { name: "B", position: 2 }]);
  run(3, [{ name: "B", position: 1 }, { name: "A", position: 2, pitMode: 2, pit: { phase: "in" } }]);
  assert.equal(types("overtake").length, 0);
});

test("melhor volta: geral, da classe e pessoal", () => {
  const { run, types } = setup();
  const cars = (a, b, c) => [
    { name: "A", position: 1, carClass: "HY", fastestLapMs: a },
    { name: "B", position: 2, carClass: "GT3", fastestLapMs: b },
    { name: "C", position: 3, carClass: "GT3", fastestLapMs: c },
  ];
  run(1, cars(90000, 100000, 101000)); // app aberto: so guarda as marcas
  assert.equal(types("fastest").length, 0);
  run(1, cars(89000, 100000, 101000)); // A melhora: melhor da corrida
  run(1, cars(89000, 99500, 101000)); // B: melhor da GT3
  run(1, cars(89000, 99500, 100500)); // C: melhor dele, mas nao da classe
  assert.deepEqual(
    types("fastest").map((e) => `${e.driver} ${e.scope} ${e.lapMs}`),
    ["A overall 89000", "B class 99500", "C personal 100500"]
  );
});

test("primeira volta de cada um so entra se for a melhor da corrida ou da classe", () => {
  const { run, types } = setup();
  const cars = (a, b) => [
    { name: "A", position: 1, fastestLapMs: a },
    { name: "B", position: 2, fastestLapMs: b },
  ];
  run(1, cars(0, 0));
  run(1, cars(90000, 0));
  run(1, cars(90000, 91000));
  assert.deepEqual(types("fastest").map((e) => `${e.driver} ${e.scope}`), ["A overall"]);
});

test("box: entrada e saida com tempo parado, andando, posicoes, pneus e energia", () => {
  const { run, types } = setup();
  const car = (o) => Object.assign({ name: "A", position: 3, tyres: ["M", "M", "M", "M"], tyreWear: [0.6, 0.6, 0.6, 0.6], virtualEnergy: 0.1 }, o);
  run(2, [car({})]);
  run(5, [car({ pitMode: 2, speedMs: 20, pit: { phase: "in", elapsedMs: 0 } })]); // andando no box
  run(20, [car({ pitMode: 2, speedMs: 0, pit: { phase: "in" } })]); // parado
  run(1, [car({ pitMode: 2, speedMs: 0, tyres: ["H", "H", "H", "H"], tyreWear: [1, 1, 1, 1], virtualEnergy: 0.95, pit: { phase: "in" } })]);
  run(5, [car({ pitMode: 3, speedMs: 20, position: 6, tyres: ["H", "H", "H", "H"], tyreWear: [1, 1, 1, 1], virtualEnergy: 0.95, pit: { phase: "out" } })]);
  run(1, [car({ position: 6, tyres: ["H", "H", "H", "H"], tyreWear: [1, 1, 1, 1], virtualEnergy: 0.95, pit: { phase: "done", elapsedMs: 31000 } })]);
  assert.equal(types("pitIn").length, 1);
  assert.equal(types("pitIn")[0].position, 3);
  const out = types("pitOut");
  assert.equal(out.length, 1);
  assert.equal(out[0].totalMs, 31000);
  assert.ok(Math.abs(out[0].stoppedMs - 21000) <= 1000, `parado ${out[0].stoppedMs}`);
  assert.equal(out[0].movingMs, 31000 - out[0].stoppedMs);
  assert.equal(out[0].positionBefore, 3);
  assert.equal(out[0].positionAfter, 6);
  assert.deepEqual(out[0].tyres, { before: ["M", "M", "M", "M"], after: ["H", "H", "H", "H"] });
  assert.equal(out[0].energyAdded, 85);
});

test("punicoes (LMU) e desclassificacao", () => {
  const { run, types } = setup();
  run(1, [{ name: "A", position: 1, penalties: 0 }]);
  run(1, [{ name: "A", position: 1, penalties: 1 }]);
  run(1, [{ name: "A", position: 1, penalties: 0 }]);
  run(1, [{ name: "A", position: 1, raceState: 4 }]);
  assert.equal(types("penalty").length, 1);
  assert.equal(types("penaltyServed").length, 1);
  assert.equal(types("disqualified").length, 1);
});

test("sessao nova zera o log", () => {
  const { clock, log, run } = setup();
  run(3, [{ name: "A", position: 1 }, { name: "B", position: 2 }]);
  run(3, [{ name: "B", position: 1 }, { name: "A", position: 2 }]);
  assert.equal(log.getEvents().length, 1);
  clock.t += 500;
  log.apply({ session: { state: 3, trackLocation: "X" }, standings: [] });
  assert.equal(log.getEvents().length, 0);
});

test("cada evento leva o tempo restante da corrida que o jogo informa", () => {
  const clock = { t: 0 };
  const log = createSessionLog({ clock: () => clock.t });
  const frame = (remaining, cars) => {
    clock.t += 500;
    log.apply({ session: { state: 5, trackLocation: "X", timeRemainingSec: remaining }, standings: cars.map((c) => Object.assign({ speedMs: 50, pitMode: 0, raceState: 2, currentLap: 2, pit: { phase: null } }, c)) });
  };
  for (let i = 0; i < 6; i++) frame(1800 - i * 0.5, [{ name: "A", position: 1 }, { name: "B", position: 2 }]);
  for (let i = 0; i < 6; i++) frame(1797 - i * 0.5, [{ name: "B", position: 1 }, { name: "A", position: 2 }]);
  const ev = log.getEvents()[0];
  assert.equal(ev.type, "overtake");
  assert.ok(ev.remainingSec >= 1794 && ev.remainingSec <= 1796, String(ev.remainingSec));
  // corrida por voltas (sem tempo restante): null, a overlay mostra o tempo de corrida
  const log2 = createSessionLog({ clock: () => clock.t });
  clock.t += 500;
  log2.apply({ session: { state: 5, trackLocation: "X", timeRemainingSec: -1, lapsInEvent: 20 }, standings: [{ name: "A", position: 1, speedMs: 50, raceState: 4 }] });
  assert.equal(log2.getEvents()[0].remainingSec, null);
  // corrida por tempo depois do tempo acabar: 0:00
  const log3 = createSessionLog({ clock: () => clock.t });
  clock.t += 500;
  log3.apply({ session: { state: 5, trackLocation: "X", timeRemainingSec: -1, lapsInEvent: 0 }, standings: [{ name: "A", position: 1, speedMs: 50, raceState: 4 }] });
  assert.equal(log3.getEvents()[0].remainingSec, 0);
});

test("bandeiras: carro lento na amarela (AMS2), amarela local (LMU) e safety car", () => {
  const clock = { t: 0 };
  const log = createSessionLog({ clock: () => clock.t });
  const frame = (sessionExtra, cars) => {
    clock.t += 500;
    log.apply({
      session: Object.assign({ state: 5, trackLocation: "X" }, sessionExtra),
      standings: cars.map((c) => Object.assign({ speedMs: 50, pitMode: 0, raceState: 2, currentLap: 7, pit: { phase: null } }, c)),
    });
  };
  const cars = (yellow) => [{ name: "A", position: 1 }, { name: "B", position: 2, causedYellow: yellow, speedMs: 5 }];
  const types = () => log.getEvents().map((e) => e.type);
  frame({}, cars(false));
  frame({}, cars(true)); // um instante so: nao entra
  frame({}, cars(false));
  assert.deepEqual(types(), []);
  for (let i = 0; i < 4; i++) frame({}, cars(true));
  for (let i = 0; i < 10; i++) frame({}, cars(true)); // continua amarela: nao repete
  assert.deepEqual(types(), ["yellow"]);
  assert.equal(log.getEvents()[0].driver, "B");
  assert.equal(log.getEvents()[0].lap, 7);

  // LMU: amarela local em um setor
  for (let i = 0; i < 4; i++) frame({ sectorFlags: [0, 1, 0] }, cars(false));
  frame({ sectorFlags: [0, 0, 0] }, cars(false)); // limpou por pouco tempo e voltou: a mesma amarela
  for (let i = 0; i < 4; i++) frame({ sectorFlags: [1, 0, 0] }, cars(false));
  assert.deepEqual(types(), ["yellow", "localYellow"]);
  for (let i = 0; i < 12; i++) frame({ sectorFlags: [0, 0, 0] }, cars(false)); // 6 s sem amarela
  for (let i = 0; i < 4; i++) frame({ sectorFlags: [0, 0, 1] }, cars(false)); // amarela nova
  assert.deepEqual(types(), ["yellow", "localYellow", "localYellow"]);

  // safety car e bandeira verde
  frame({ scOut: true }, cars(false));
  frame({ scOut: true }, cars(false));
  frame({ scOut: false }, cars(false));
  assert.deepEqual(types().slice(-2), ["safetyCar", "green"]);
});

test("classificacao: melhores voltas e box entram; ultrapassagem nao", () => {
  const clock = { t: 0 };
  const log = createSessionLog({ clock: () => clock.t, classOf: (e) => e.carClass });
  const run = (seconds, cars) => {
    for (let k = 0; k < seconds * 2; k++) {
      clock.t += 500;
      log.apply({
        session: { state: 3, trackLocation: "X", timeRemainingSec: 900 },
        standings: cars.map((c) => Object.assign({ speedMs: 50, pitMode: 0, raceState: 1, currentLap: 3, carClass: "GT3", pit: { phase: null } }, c)),
      });
    }
  };
  run(2, [{ name: "A", position: 1, fastestLapMs: 90000 }, { name: "B", position: 2, fastestLapMs: 91000 }]);
  // B faz a melhor volta e passa para P1 pelo tempo: nao e ultrapassagem
  run(3, [{ name: "B", position: 1, fastestLapMs: 89000 }, { name: "A", position: 2, fastestLapMs: 90000 }]);
  run(1, [{ name: "B", position: 1, fastestLapMs: 89000 }, { name: "A", position: 2, fastestLapMs: 90000, pitMode: 2, pit: { phase: "in" } }]);
  const types = log.getEvents().map((e) => e.type);
  assert.deepEqual(types, ["fastest", "pitIn"]);
  assert.equal(log.getEvents()[0].scope, "overall");
  assert.equal(log.getEvents()[0].race, false);
  assert.equal(log.getEvents()[0].remainingSec, 900);
});

test("punicao do AMS2 com o tipo: drive-through recebido e cumprido", () => {
  const clock = { t: 0 };
  const log = createSessionLog({ clock: () => clock.t });
  const frame = (kind) => {
    clock.t += 500;
    log.apply({ session: { state: 5, trackLocation: "X" }, standings: [{ name: "A", position: 1, speedMs: 50, pitMode: 0, raceState: 2, currentLap: 4, pit: { phase: null }, penaltyType: kind }] });
  };
  frame(null);
  frame("driveThrough");
  frame("driveThrough");
  frame(null);
  frame("stopGo");
  const ev = log.getEvents().map((e) => `${e.type}:${e.kind}`);
  assert.deepEqual(ev, ["penalty:driveThrough", "penaltyServed:driveThrough", "penalty:stopGo"]);
});

test("corrida: sem aviso de melhor volta nas voltas 1 e 2", () => {
  const clock = { t: 0 };
  const log = createSessionLog({ clock: () => clock.t });
  const frame = (laps, a, b) => {
    clock.t += 500;
    log.apply({
      session: { state: 5, trackLocation: "X" },
      standings: [
        { name: "A", position: 1, speedMs: 50, pitMode: 0, raceState: 2, lapsCompleted: laps, currentLap: laps + 1, fastestLapMs: a, pit: { phase: null } },
        { name: "B", position: 2, speedMs: 50, pitMode: 0, raceState: 2, lapsCompleted: laps, currentLap: laps + 1, fastestLapMs: b, pit: { phase: null } },
      ],
    });
  };
  frame(0, 0, 0);
  frame(1, 92000, 93000); // volta 1
  frame(2, 91000, 90500); // volta 2: B mais rapido de todos, mas ainda nao avisa
  frame(3, 90800, 90500); // volta 3: A melhora, mas nao bate o 90500 de B: pessoal
  frame(4, 90000, 90500); // volta 4: A faz a melhor da corrida
  assert.deepEqual(log.getEvents().map((e) => `${e.driver} ${e.scope} ${e.lap}`), ["A personal 3", "A overall 4"]);
});

test("FCY: inicio, infracoes (com o tempo acima e apos a contagem) e fim, nessa ordem", () => {
  let t = 0;
  const log = createSessionLog({ clock: () => t });
  const car = { name: "A", position: 1, lapsCompleted: 3, currentLap: 4, speedMs: 50, raceState: 2 };
  const tick = (ms, session) => {
    t += ms;
    log.apply({ session: Object.assign({ state: 5, trackLocation: "Spa" }, session), standings: [Object.assign({}, car)] });
  };
  tick(0, { fcy: false });
  tick(1000, { fcy: true });
  tick(1000, { fcy: false, fcyBreaches: [{ name: "A", overMs: 3200, afterMs: 4100, maxKmh: 112.4 }] });
  const ev = log.getEvents().map((e) => (e.type === "fcyBreach" ? `${e.type} ${e.driver} ${e.overMs} ${e.afterMs} ${e.maxKmh}` : e.type));
  assert.deepEqual(ev, ["fcy", "fcyBreach A 3200 4100 112", "green"]);
});

test("FCY virando safety car (e o contrario): sem bandeira verde no meio", () => {
  let t = 0;
  const log = createSessionLog({ clock: () => t });
  const car = { name: "A", position: 1, lapsCompleted: 3, currentLap: 4, speedMs: 50, raceState: 2 };
  const tick = (session) => {
    t += 1000;
    log.apply({ session: Object.assign({ state: 5, trackLocation: "Spa" }, session), standings: [Object.assign({}, car)] });
  };
  tick({ fcy: false, scOut: false });
  tick({ fcy: true, scOut: false });
  tick({ fcy: false, scOut: true });
  tick({ fcy: true, scOut: false });
  tick({ fcy: false, scOut: false });
  assert.deepEqual(log.getEvents().map((e) => e.type), ["fcy", "safetyCar", "fcy", "green"]);
});
