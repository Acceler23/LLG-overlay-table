const test = require("node:test");
const assert = require("node:assert/strict");
const { createIncidentWatch, markLmuYellow } = require("../server/incidents");

// corrida no LMU numa pista de 4000 m; cada tick avanca o relogio
function setup() {
  let t = 0;
  const watch = createIncidentWatch({ now: () => t });
  const tick = (ms, cars, ctx = {}) => {
    t += ms;
    watch.apply({ session: { state: 5, trackLength: 4000 }, standings: cars }, Object.assign({ under: null, scName: null, released: [] }, ctx));
  };
  return { watch, tick };
}
const car = (name, kmh, lapDistance = 1000, extra = {}) => Object.assign({ name, speedKmh: kmh, lapDistance, raceState: 2, pitMode: 0, currentLap: 5 }, extra);

test("carro lento: abaixo de 40 conta na hora; abaixo de 60 so depois de 3 s", () => {
  const { watch, tick } = setup();
  tick(0, [car("Parado", 20), car("Devagar", 55), car("Normal", 150)]);
  let names = watch.status().slow.map((s) => s.name);
  assert.deepEqual(names, ["Parado"]);
  tick(2000, [car("Parado", 20), car("Devagar", 55), car("Normal", 150)]);
  assert.deepEqual(watch.status().slow.map((s) => s.name).sort(), ["Parado"]);
  tick(1500, [car("Parado", 20), car("Devagar", 50), car("Normal", 150)]);
  assert.deepEqual(watch.status().slow.map((s) => s.name).sort(), ["Devagar", "Parado"]);
  assert.ok(watch.status().slow.every((s) => s.live));
});

test("carro lento: o incidente fecha 1 s depois de voltar a 60, com a duracao (ate voltar) e a menor velocidade", () => {
  const { watch, tick } = setup();
  tick(0, [car("A", 35, 2200)]);
  tick(1000, [car("A", 12, 2210)]);
  tick(4000, [car("A", 90, 2300)]); // voltou a 60: ainda conta como lento ate ficar 1 s acima
  assert.equal(watch.status().slow[0].live, true);
  tick(1000, [car("A", 120, 2400)]);
  const [inc] = watch.status().slow;
  assert.deepEqual([inc.name, inc.durationMs, inc.minKmh, inc.lapDistance, inc.live], ["A", 5000, 12, 2200, undefined]);
});

test("carro lento: abaixo de 60 por menos de 3 s nao vira incidente; box, bandeirada e o SC nao contam", () => {
  const { watch, tick } = setup();
  tick(0, [car("Curva lenta", 55), car("Box", 10, 1000, { pitMode: 3 }), car("Terminou", 10, 1000, { raceState: 3 }), car("SC", 10)], { scName: "SC" });
  tick(2000, [car("Curva lenta", 70), car("Box", 10, 1000, { pitMode: 3 }), car("Terminou", 10, 1000, { raceState: 3 }), car("SC", 10)], { scName: "SC" });
  assert.deepEqual(watch.status().slow, []);
});

test("carro lento: com SC/FCY nao conta (andar devagar e o normal)", () => {
  const { watch, tick } = setup();
  tick(0, [car("A", 30)], { under: "FCY" });
  tick(5000, [car("A", 30)], { under: "FCY" });
  assert.deepEqual(watch.status().slow, []);
});

test("ultrapassagem com SC: B passa A e a nova ordem se mantem", () => {
  const { watch, tick } = setup();
  const under = { under: "SC" };
  tick(0, [car("A", 80, 1000), car("B", 85, 980)], under);
  tick(500, [car("A", 80, 1040), car("B", 90, 1050)], under); // B na frente
  tick(1000, [car("A", 80, 1080), car("B", 90, 1100)], under);
  assert.deepEqual(watch.status().overtakes, []); // ainda nao confirmou
  tick(1000, [car("A", 80, 1120), car("B", 90, 1150)], under);
  const [o] = watch.status().overtakes;
  assert.deepEqual([o.passer, o.passed, o.under, o.allowed], ["B", "A", "SC", false]);
});

test("ultrapassagem com SC: lado a lado (troca e volta) nao conta; retardatario liberado e o SC ficam marcados/fora", () => {
  const { watch, tick } = setup();
  const ctx = { under: "SC", scName: "SC", released: ["Liberado"] };
  tick(0, [car("A", 80, 1000), car("B", 80, 990)], ctx);
  tick(500, [car("A", 80, 1040), car("B", 80, 1045)], ctx);
  tick(500, [car("A", 80, 1090), car("B", 80, 1080)], ctx); // A voltou a frente
  tick(2000, [car("A", 80, 1190), car("B", 80, 1180)], ctx);
  assert.deepEqual(watch.status().overtakes, []);

  tick(0, [car("Liberado", 120, 2000), car("C", 80, 2050), car("SC", 80, 2100)], ctx);
  tick(500, [car("Liberado", 120, 2090), car("C", 80, 2070), car("SC", 80, 2120)], ctx);
  tick(2000, [car("Liberado", 120, 2200), car("C", 80, 2110), car("SC", 80, 2160)], ctx);
  const list = watch.status().overtakes;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].passer, list[0].allowed], ["Liberado", true]);
});

test("ultrapassagem perto da linha de chegada (a pista da a volta)", () => {
  const { watch, tick } = setup();
  const under = { under: "FCY", countdown: false };
  tick(0, [car("A", 60, 3990), car("B", 60, 3950)], under);
  tick(500, [car("A", 60, 10), car("B", 60, 30)], under); // B cruzou a linha na frente
  tick(2000, [car("A", 60, 50), car("B", 60, 80)], under);
  const [o] = watch.status().overtakes;
  assert.deepEqual([o.passer, o.passed, o.under], ["B", "A", "FCY"]);
});

test("so em corrida: formacao, treino e classificacao nao registram; sessao nova limpa", () => {
  const { watch, tick } = setup();
  [4, 1, 3].forEach((state) => watch.apply({ session: { state, trackLength: 4000 }, standings: [car("A", 10)] }, { under: null }));
  assert.deepEqual(watch.status().slow, []);
  tick(0, [car("A", 10)]);
  assert.equal(watch.status().slow.length, 1);
  watch.reset();
  assert.deepEqual(watch.status(), { slow: [], overtakes: [] });
});

test("carro lento: velocidade com ruido (uma leitura alta no meio) continua um incidente so", () => {
  const { watch, tick } = setup();
  for (let i = 0; i < 10; i++) tick(200, [car("A", i % 2 ? 150 : 18)]);
  tick(1200, [car("A", 150)]);
  tick(200, [car("A", 150)]);
  assert.equal(watch.status().slow.length, 1);
});

test("curva lenta: dentro do trecho so conta abaixo do limite dela; fora, a regra normal", () => {
  let now = 0;
  const watch = createIncidentWatch({ now: () => now, zones: [{ track: /long beach/i, from: 3000, to: 3200, minKmh: 30 }] });
  const tick = (ms, cars, trackLocation = "Long Beach") => {
    now += ms;
    watch.apply({ session: { state: 5, trackLength: 4000, trackLocation }, standings: cars }, { under: null, scName: null, released: [] });
  };
  tick(0, [car("Normal", 35, 3100)]);
  tick(4000, [car("Normal", 45, 3150)]); // 35 a 45 km/h por 4 s na curva: nada
  assert.deepEqual(watch.status().slow, []);
  tick(200, [car("Normal", 25, 3160)]); // abaixo de 30: incidente na hora
  const [inc] = watch.status().slow;
  assert.deepEqual([inc.name, inc.reason], ["Normal", "abaixo de 30 km/h na curva lenta"]);
});

test("curva lenta: fora do trecho, em outra pista ou passando pela linha", () => {
  let now = 0;
  const zones = [{ track: /long beach/i, from: 3900, to: 100, minKmh: 30 }];
  const watch = createIncidentWatch({ now: () => now, zones });
  const tick = (cars, trackLocation) => watch.apply({ session: { state: 5, trackLength: 4000, trackLocation }, standings: cars }, { under: null, scName: null, released: [] });
  tick([car("Fora do trecho", 35, 2000), car("Depois da linha", 35, 50), car("Antes da linha", 35, 3950)], "Long Beach");
  assert.deepEqual(watch.status().slow.map((s) => s.name), ["Fora do trecho"]);
  watch.reset();
  tick([car("Outra pista", 35, 50)], "Spa");
  assert.deepEqual(watch.status().slow.map((s) => s.name), ["Outra pista"]);
});

test("carro lento: entrando no box (pitMode 1) nao conta", () => {
  const { watch, tick } = setup();
  tick(0, [car("Entrando", 20, 3000, { pitMode: 1 })]);
  assert.deepEqual(watch.status().slow, []);
});

test("Long Beach, ultima curva: passagem real (41 km/h, 3,2 s abaixo de 60) nao avisa; abaixo de 30 avisa", () => {
  let now = 0;
  const watch = createIncidentWatch({ now: () => now });
  const tick = (ms, name, kmh, d) => {
    now += ms;
    watch.apply({ session: { state: 5, trackLength: 3187.4, trackLocation: "Grand Prix of Long Beach" }, standings: [car(name, kmh, d)] }, { under: null, scName: null, released: [] });
  };
  [[0, 90, 2700], [500, 59, 2791], [1000, 45, 2805], [1000, 41, 2820], [1200, 58, 2840], [500, 75, 2865], [1000, 110, 2920]].forEach(([ms, kmh, d]) => tick(ms, "Normal", kmh, d));
  assert.deepEqual(watch.status().slow, []);
  tick(500, "Rodou", 25, 2810);
  assert.deepEqual(watch.status().slow.map((s) => s.name), ["Rodou"]);
});

test("causador da amarela no LMU: lento, fora do box, no setor sob amarela", () => {
  const payload = {
    session: { state: 5, sectorFlags: [1, 11, 11] },
    standings: [
      car("Parado", 0, 434, { currentSector: 0 }),
      car("Passando", 120, 500, { currentSector: 0 }),
      car("Parado em outro setor", 0, 3000, { currentSector: 1 }),
      car("Parado no box", 0, 100, { currentSector: 0, pitMode: 2 }),
    ],
  };
  markLmuYellow(payload);
  assert.deepEqual(payload.standings.filter((e) => e.causedYellow).map((e) => e.name), ["Parado"]);
  payload.session.sectorFlags = [11, 11, 11]; // amarela acabou
  markLmuYellow(payload);
  assert.deepEqual(payload.standings.filter((e) => e.causedYellow), []);
});
