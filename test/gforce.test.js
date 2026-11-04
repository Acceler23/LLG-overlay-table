const test = require("node:test");
const assert = require("node:assert/strict");
const { G, sameCar, fromLocalAccel, createEstimator, createPeaks, createTracker } = require("../overlay/shared/gforce");

const STEP_MS = 100; // o listener manda ~10 leituras por segundo
const round1 = (n) => Math.round(n * 10) / 10; // a posicao chega com 0,1 m de resolucao

// Carro andando: v(t) = v0 + a*t, virando com taxa de giro omega (rad/s, positivo = direita).
// Devolve as leituras como o servidor as entrega: velocidade com 2 casas, posicao com 1.
function drive({ v0 = 30, a = 0, omega = 0, seconds = 3, x0 = 1000, z0 = 1000 }) {
  const out = [];
  let x = x0;
  let z = z0;
  let theta = 0;
  for (let i = 0; i <= (seconds * 1000) / STEP_MS; i++) {
    const t = i * STEP_MS;
    const v = v0 + (a * t) / 1000;
    out.push({ t, v: Math.round(v * 100) / 100, x: round1(x), z: round1(z), trueTheta: theta });
    const dt = STEP_MS / 1000;
    theta += omega * dt;
    x += v * Math.sin(theta) * dt;
    z += v * Math.cos(theta) * dt;
  }
  return out;
}

function lastEstimate(samples, name = "A") {
  const est = createEstimator();
  let r = null;
  samples.forEach((s) => {
    r = est.push({ name, ...s });
  });
  return r;
}

test("fromLocalAccel: x negativo e direita, z negativo e acelerando; dado ruim vira null", () => {
  const r = fromLocalAccel([-9.81, 0, -19.62]);
  assert.ok(Math.abs(r.latG - 1) < 1e-9);
  assert.ok(Math.abs(r.longG - 2) < 1e-9);
  const l = fromLocalAccel([9.81, 0, 9.81]); // esquerda e freando
  assert.ok(Math.abs(l.latG + 1) < 1e-9);
  assert.ok(Math.abs(l.longG + 1) < 1e-9);
  assert.equal(fromLocalAccel(null), null);
  assert.equal(fromLocalAccel([1, 2]), null);
  assert.equal(fromLocalAccel([NaN, 0, 0]), null);
});

test("sameCar: velocidade da telemetria bate com a do carro em foco", () => {
  assert.equal(sameCar({ speedMs: 50 }, { speedMs: 52 }), true);
  assert.equal(sameCar({ speedMs: 0 }, { speedMs: 60 }), false); // telemetria do carro parado de quem transmite
  assert.equal(sameCar({ speedMs: 0.5 }, { speedMs: 0 }), true);
  assert.equal(sameCar(null, { speedMs: 10 }), false);
  assert.equal(sameCar({ speedMs: 10 }, {}), false);
});

test("estimador: aceleracao constante em reta", () => {
  const r = lastEstimate(drive({ v0: 20, a: 5, seconds: 3 }));
  assert.ok(Math.abs(r.longG - 5 / G) < 0.03, `longG ${r.longG}`);
  assert.ok(Math.abs(r.latG) < 0.1, `latG ${r.latG}`);
});

test("estimador: freada", () => {
  const r = lastEstimate(drive({ v0: 80, a: -25, seconds: 2 }));
  assert.ok(Math.abs(r.longG + 25 / G) < 0.05, `longG ${r.longG}`);
});

test("estimador: curva a direita e positiva, a esquerda e negativa", () => {
  const v = 40;
  const radius = 100;
  const expected = v ** 2 / radius / G; // ~1,63 g
  const right = lastEstimate(drive({ v0: v, omega: v / radius, seconds: 3 }));
  // a posicao tem 0,1 m de resolucao: isso da ~0,07 g de ruido na lateral estimada
  assert.ok(Math.abs(right.latG - expected) < 0.25, `direita ${right.latG}`);
  const left = lastEstimate(drive({ v0: v, omega: -v / radius, seconds: 3 }));
  assert.ok(Math.abs(left.latG + expected) < 0.25, `esquerda ${left.latG}`);
  assert.ok(Math.abs(right.longG) < 0.05);
});

test("estimador: o rumo atravessa +-pi sem estragar a lateral", () => {
  // anda para o sul (dz negativo): o atan2 fica perto de +-pi
  const est = createEstimator();
  const v = 40;
  const omega = 0.4;
  let x = 1000;
  let z = 1000;
  let theta = Math.PI - 0.5;
  let r = null;
  for (let i = 0; i <= 30; i++) {
    r = est.push({ name: "A", t: i * STEP_MS, v, x: round1(x), z: round1(z) });
    theta += omega * 0.1;
    x += v * Math.sin(theta) * 0.1;
    z += v * Math.cos(theta) * 0.1;
  }
  assert.ok(Math.abs(r.latG - (v * omega) / G) < 0.25, `latG ${r.latG}`);
});

test("estimador: devagar nao inventa lateral (so ruido de posicao)", () => {
  const r = lastEstimate(drive({ v0: 5, seconds: 3 }));
  assert.equal(r.latG, null);
  assert.ok(r.longG !== null);
});

test("estimador: sem posicao (Assetto Corsa) so tem a longitudinal", () => {
  const samples = drive({ v0: 20, a: 5, seconds: 3 }).map((s) => ({ t: s.t, v: s.v }));
  const r = lastEstimate(samples);
  assert.equal(r.latG, null);
  assert.ok(Math.abs(r.longG - 5 / G) < 0.03);
});

test("estimador: jogo que atualiza devagar (4 Hz) ainda estima", () => {
  const est = createEstimator();
  let r = null;
  for (let i = 0; i < 20; i++) {
    const t = i * 250;
    const s = t / 1000;
    // posicao coerente com a velocidade: z = z0 + v0*s + a*s^2/2
    r = est.push({ name: "A", t, v: 20 + 5 * s, x: 1000, z: round1(1000 + 20 * s + 2.5 * s * s) });
  }
  assert.ok(r && Math.abs(r.longG - 5 / G) < 0.05, `longG ${r && r.longG}`);
});

test("estimador: buraco de mais de 1 s, salto de posicao e troca de carro recomecam", () => {
  const est = createEstimator();
  drive({ v0: 30, seconds: 1 }).forEach((s) => est.push({ name: "A", ...s }));
  assert.equal(est.push({ name: "A", t: 5000, v: 30, x: 1000, z: 1000 }), null); // buraco
  const est2 = createEstimator();
  const base = drive({ v0: 30, seconds: 1 });
  base.forEach((s) => est2.push({ name: "A", ...s }));
  const last = base[base.length - 1];
  // teletransporte de 500 m em 100 ms
  assert.equal(est2.push({ name: "A", t: last.t + 100, v: 30, x: last.x + 500, z: last.z }), null);
  const est3 = createEstimator();
  base.forEach((s) => est3.push({ name: "A", ...s }));
  assert.equal(est3.push({ name: "B", t: last.t + 100, v: 30, x: last.x, z: last.z }), null); // outro carro
});

test("estimador: leitura repetida (mesmo instante) e ignorada", () => {
  const est = createEstimator();
  const samples = drive({ v0: 20, a: 5, seconds: 2 });
  let r = null;
  samples.forEach((s) => {
    r = est.push({ name: "A", ...s });
    est.push({ name: "A", ...s });
  });
  assert.ok(Math.abs(r.longG - 5 / G) < 0.03);
});

test("picos: guarda o maior dos ultimos segundos e esquece o antigo", () => {
  const p = createPeaks(1000);
  p.push(0, 2.5, -3);
  p.push(500, -1, 1);
  assert.deepEqual(p.get(), { lat: 2.5, brake: 3, accel: 1 });
  const later = p.push(1600, 0.5, 0.2);
  assert.deepEqual(later, { lat: 0.5, brake: 0, accel: 0.2 });
});

// ---- tracker: de onde vem o dado de cada jogo ----

function entry(s, extra) {
  return Object.assign({ name: "Piloto", isPlayer: true, position: 3, speedMs: s.v, worldX: s.x, worldZ: s.z }, extra);
}

function runTracker(tracker, samples, build) {
  let r = null;
  samples.forEach((s) => {
    r = tracker.update(build(s), s.t);
  });
  return r;
}

test("tracker: AMS2 com a telemetria de outro carro (quem transmite esta parado) usa a estimativa", () => {
  const samples = drive({ v0: 40, omega: 0.4, seconds: 3 });
  const r = runTracker(createTracker(), samples, (s) => ({
    game: "ams2",
    ts: s.t,
    standings: [entry(s)],
    car: { speedMs: 0, localAccel: [0, 0, 0] }, // o carro parado do player
  }));
  assert.equal(r.source, "estimated");
  assert.ok(r.latG > 1.2, `latG ${r.latG}`);
});

test("tracker: AMS2 com a telemetria do carro em foco usa a telemetria", () => {
  const samples = drive({ v0: 40, omega: 0.4, seconds: 3 });
  const r = runTracker(createTracker(), samples, (s) => ({
    game: "ams2",
    ts: s.t,
    standings: [entry(s)],
    car: { speedMs: s.v, localAccel: [-((40 * 0.4) ** 1), 0, 0] }, // 16 m/s2 para a direita
  }));
  assert.equal(r.source, "telemetry");
  assert.ok(Math.abs(r.latG - 16 / G) < 0.05, `latG ${r.latG}`);
});

test("tracker: LMU usa a aceleracao real de cada carro", () => {
  const samples = drive({ v0: 40, omega: 0.4, seconds: 5 });
  const r = runTracker(createTracker(), samples, (s) => ({
    game: "lmu",
    ts: s.t,
    standings: [entry(s, { localAccel: [-16, 0, 0] })],
  }));
  assert.equal(r.source, "telemetry");
  assert.ok(Math.abs(r.latG - 16 / G) < 0.05);
});

test("tracker: dado real com o sinal trocado perde para a estimativa depois de alguns segundos", () => {
  const samples = drive({ v0: 40, omega: 0.4, seconds: 8 });
  const tracker = createTracker();
  const sources = [];
  samples.forEach((s) => {
    const r = tracker.update({ game: "lmu", ts: s.t, standings: [entry(s, { localAccel: [16, 0, 0] })] }, s.t); // esquerda: errado
    sources.push(r.source);
  });
  assert.equal(sources[sources.length - 1], "estimated");
  assert.equal(sources[0], "telemetry"); // comeca valendo, ate conferir
});

test("tracker: dado real certo continua valendo", () => {
  const samples = drive({ v0: 40, omega: 0.4, seconds: 8 });
  const r = runTracker(createTracker(), samples, (s) => ({ game: "lmu", ts: s.t, standings: [entry(s, { localAccel: [-16, 0, 0] })] }));
  assert.equal(r.source, "telemetry");
});

test("tracker: ACC so com velocidade e posicao estima as duas; flip inverte o lado so naquele jogo", () => {
  const samples = drive({ v0: 40, omega: 0.4, seconds: 3 });
  const build = (game) => (s) => ({ game, ts: s.t, standings: [entry(s)] });
  const normal = runTracker(createTracker(), samples, build("acc"));
  const flipped = runTracker(createTracker({ flip: ["acc"] }), samples, build("acc"));
  assert.ok(normal.latG > 1.2 && flipped.latG < -1.2, `${normal.latG} / ${flipped.latG}`);
  const otherGame = runTracker(createTracker({ flip: ["acc"] }), samples, build("lmu"));
  assert.ok(otherGame.latG > 1.2);
});

test("tracker: Assetto Corsa sem posicao devolve lateral null e longitudinal", () => {
  const samples = drive({ v0: 20, a: 5, seconds: 3 });
  const r = runTracker(createTracker(), samples, (s) => ({ game: "ac", ts: s.t, standings: [{ name: "P", isPlayer: true, speedMs: s.v }] }));
  assert.equal(r.latG, null);
  assert.ok(r.longG > 0.3);
});

test("tracker: sem carro em foco devolve null; trocar o foco zera o suavizado e os picos", () => {
  const tracker = createTracker();
  assert.equal(tracker.update({ game: "ams2", standings: [{ name: "X", isPlayer: false }] }, 0), null);
  const samples = drive({ v0: 40, omega: 0.4, seconds: 2 });
  samples.forEach((s) => tracker.update({ game: "ams2", ts: s.t, standings: [entry(s)] }, s.t));
  const other = drive({ v0: 40, seconds: 2, x0: 5000 });
  let r = null;
  other.forEach((s) => {
    r = tracker.update({ game: "ams2", ts: 10000 + s.t, standings: [entry(s, { name: "Outro" })] }, 10000 + s.t);
  });
  assert.equal(r.name, "Outro");
  assert.ok(r.peaks.lat < 0.3, `pico herdado ${r.peaks.lat}`);
});
