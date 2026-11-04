const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createTrackMap, buildPoints } = require("../server/trackMap");

// pista circular de 1000 m: o ponto certo de cada distancia
const R = 1000 / (2 * Math.PI);
const onCircle = (d) => [R * Math.cos((d / 1000) * 2 * Math.PI), R * Math.sin((d / 1000) * 2 * Math.PI)];

function setup(file) {
  const clock = { t: 0 };
  const changes = [];
  const map = createTrackMap({ file, clock: () => clock.t, onChange: (m) => changes.push(m) });
  // n voltas de varios carros, uma leitura a cada 5 m
  const drive = (laps, extra) => {
    for (let lap = 0; lap < laps; lap++) {
      for (let d = 0; d < 1000; d += 5) {
        clock.t += 100;
        const [x, z] = onCircle(d);
        const cars = [{ name: "A", lapDistance: d, worldX: x, worldZ: z, speedMs: 50, pitMode: 0 }];
        if (extra) cars.push(extra(d));
        map.apply("ams2", { session: { trackLocation: "Pista", trackVariation: "GP", trackLength: 1000 }, standings: cars });
      }
    }
  };
  return { clock, map, changes, drive };
}

test("mediana: um ponto fora do lugar nao desloca o trecho", () => {
  const b = [[[0, 0], [1, 1], [0.5, 0.5], [500, 500]]];
  assert.deepEqual(buildPoints(b).points[0], [0.8, 0.8]);
});

test("aprende o tracado e ignora rodada (carro lento) e carro no box", () => {
  const { map, drive } = setup(null);
  // carro B: rodando devagar e longe do tracado, e depois no box
  drive(4, (d) => ({ name: "B", lapDistance: d, worldX: 9999, worldZ: 9999, speedMs: d < 500 ? 5 : 50, pitMode: d < 500 ? 0 : 2 }));
  const m = map.get();
  assert.ok(m && m.ready, "mapa pronto");
  // todos os pontos perto do circulo
  const worst = Math.max(...m.points.map((p, i) => Math.hypot(p[0] - onCircle(i * (1000 / m.points.length))[0], p[1] - onCircle(i * (1000 / m.points.length))[1])));
  assert.ok(worst < 6, `erro maximo ${worst.toFixed(1)} m`);
});

test("mapa pronto fica salvo e aparece direto na proxima vez", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llg-map-"));
  const file = path.join(dir, "trackmaps.json");
  try {
    const a = setup(file);
    a.drive(4);
    assert.ok(a.map.get().ready);
    await new Promise((r) => setTimeout(r, 2300)); // gravacao atrasada
    const b = setup(file);
    b.map.apply("ams2", { session: { trackLocation: "Pista", trackVariation: "GP", trackLength: 1000 }, standings: [] });
    const m = b.map.get();
    assert.ok(m && m.ready && m.saved, "veio do arquivo");
    // outra pista ou outro jogo: comeca do zero
    b.map.apply("lmu", { session: { trackLocation: "Pista", trackVariation: "GP", trackLength: 1000 }, standings: [] });
    assert.equal(b.map.get(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setores: aprende onde cada setor comeca pela troca de setor dos carros", () => {
  const { createTrackMap } = require("../server/trackMap");
  const changes = [];
  let t = 0;
  const tm = createTrackMap({ clock: () => t, onChange: (x) => changes.push(x) });
  const send = (cars) => (t += 4000) && tm.apply("lmu", { session: { trackLocation: "Sebring", trackVariation: "", trackLength: 5000 }, standings: cars });
  const car = (name, currentSector, lapDistance, extra = {}) => Object.assign({ name, currentSector, lapDistance, speedMs: 50, pitMode: 0, worldX: lapDistance, worldZ: 0 }, extra);
  const names = ["A", "B", "C", "D", "E"];
  [1, 2, 3].forEach(() => send([car("Mapa", 0, 100)])); // passagens para o mapa ter pontos
  names.forEach((n) => send([car(n, 0, 1000)]));
  names.forEach((n, i) => send([car(n, 1, 1500 + i)]));
  names.forEach((n) => send([car(n, 1, 2000)]));
  send([car("Box", 0, 100, { pitMode: 2 })]);
  send([car("Box", 1, 9, { pitMode: 2 })]); // troca dentro do box: nao conta
  names.forEach((n, i) => send([car(n, 2, 3200 + i)]));
  const map = tm.get();
  assert.deepEqual(map.sectors, [1502, 3202]);
});

test("aprendendo: so os trechos percorridos sao desenhados, sem reta ligando buracos", () => {
  const P = [[1, 1], [1, 1], [1, 1]];
  const b = new Array(20).fill(null);
  [0, 1, 2, 3, 6, 7, 15, 16, 17, 19].forEach((i) => (b[i] = P));
  // buracos de 2 (4-5) e de 1 (18) entram; o de 7 (8-14) fica de fora; o trecho da a volta no 0
  assert.deepEqual(buildPoints(b).runs, [[15, 7]]);
  assert.deepEqual(buildPoints(new Array(20).fill(P)).runs, [[0, 19]]);
});

// erro maximo do mapa em relacao ao circulo certo
const worstOf = (m) => Math.max(...m.points.map((p, i) => Math.hypot(p[0] - onCircle(i * (1000 / m.points.length))[0], p[1] - onCircle(i * (1000 / m.points.length))[1])));
// desvio para o lado (para fora ou para dentro do circulo), sem o tamanho do trecho
const sideOf = (m) => Math.max(...m.points.map((p) => Math.abs(Math.hypot(p[0], p[1]) - R)));

test("volta queimada nao conta, distancia 0 nao conta", () => {
  const { map, drive } = setup(null);
  // B: volta invalidada e fora do tracado (nao conta); C: distancia 0 no meio da pista (nao conta)
  drive(4, (d) => (d % 10 ? { name: "B", lapDistance: d, worldX: onCircle(d)[0] + 30, worldZ: onCircle(d)[1], speedMs: 50, pitMode: 0, lapInvalidated: true } : { name: "C", lapDistance: 0, worldX: 9999, worldZ: 9999, speedMs: 50, pitMode: 0 }));
  const m = map.get();
  assert.ok(m && m.ready);
  assert.ok(worstOf(m) < 6, `erro maximo ${worstOf(m).toFixed(1)} m`);
});

test("volta de saida do box nao conta, ate cruzar a linha", () => {
  const { map, drive } = setup(null);
  // E sai do box no comeco de uma volta sim, outra nao (pitMode 3 ate 100 m) e anda 7 m para fora
  // do tracado o resto dela (perto o bastante para nao ser "fora da pista"); na volta seguinte,
  // depois da linha, volta a contar (no tracado)
  let lap = 0;
  let last = 0;
  drive(4, (d) => {
    if (d < last) lap++;
    last = d;
    const [x, z] = onCircle(d);
    if (lap % 2 === 0) return { name: "E", lapDistance: d, worldX: x + 7, worldZ: z, speedMs: 50, pitMode: d < 100 ? 3 : 0 };
    return { name: "E", lapDistance: d, worldX: x, worldZ: z, speedMs: 50, pitMode: 0 };
  });
  const m = map.get();
  assert.ok(m && m.ready);
  assert.ok(sideOf(m) < 1, `desvio para o lado ${sideOf(m).toFixed(1)} m`);
});

test("fora da pista: passagem longe do meio do trecho nao conta", () => {
  const { map, drive } = setup(null);
  drive(4); // A sozinho: o meio de cada trecho ja e conhecido
  const before = map.get().points.slice();
  // F passa 6 voltas 20 m para fora, com a volta valida (o jogo nao avisou)
  drive(6, (d) => ({ name: "F", lapDistance: d, worldX: onCircle(d)[0] * (1 + 20 / R), worldZ: onCircle(d)[1] * (1 + 20 / R), speedMs: 50, pitMode: 0 }));
  const m = map.get();
  assert.ok(sideOf(m) < 1, `desvio para o lado ${sideOf(m).toFixed(1)} m`);
  const moved = Math.max(...m.points.map((p, i) => Math.hypot(p[0] - before[i][0], p[1] - before[i][1])));
  assert.ok(moved < 1, `F mexeu no mapa ${moved.toFixed(1)} m`);
});

test("voltar para o box (teleporte) nao deixa a posicao do salto no mapa", () => {
  const { map, drive } = setup(null);
  let jumped = false;
  // D anda no tracado ate a metade e e teleportado para longe, ainda com pitMode 0 por uma leitura
  drive(4, (d) => {
    if (d < 500) return { name: "D", lapDistance: d, worldX: onCircle(d)[0], worldZ: onCircle(d)[1], speedMs: 50, pitMode: 0 };
    if (!jumped) {
      jumped = true;
      return { name: "D", lapDistance: d, worldX: 5000, worldZ: 5000, speedMs: 50, pitMode: 0 };
    }
    return { name: "D", lapDistance: d, worldX: 5000, worldZ: 5000, speedMs: 0, pitMode: 4 };
  });
  const m = map.get();
  // o salto (5000, 5000) daria milhares de metros; ate ~8 m e so o tamanho do trecho
  const worst = Math.max(...m.points.map((p, i) => Math.hypot(p[0] - onCircle(i * (1000 / m.points.length))[0], p[1] - onCircle(i * (1000 / m.points.length))[1])));
  assert.ok(worst < 10, `erro maximo ${worst.toFixed(1)} m`);
});

test("mapa pronto continua aprendendo: mais voltas trocam e salvam o mapa", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llg-map-"));
  const file = path.join(dir, "trackmaps.json");
  try {
    const a = setup(file);
    a.drive(3);
    const first = a.map.get();
    assert.ok(first.ready);
    a.drive(6); // a pista enche: mais passagens por trecho
    const better = a.map.get();
    assert.ok(better.samples >= first.samples + 2, `passagens por trecho: ${first.samples} -> ${better.samples}`);
    assert.notEqual(better, first, "mapa trocado");
    await new Promise((r) => setTimeout(r, 2300));
    const saved = JSON.parse(fs.readFileSync(file, "utf8"))["ams2|Pista|GP"];
    assert.equal(saved.samples, better.samples, "o melhor foi salvo");

    // aberto de novo: comeca pelo salvo e nao troca por um pior enquanto aprende
    const b = setup(file);
    b.drive(3);
    const m = b.map.get();
    assert.ok(m.saved, "continua o do arquivo");
    assert.equal(m.samples, saved.samples);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("carros em linhas diferentes: o ponto fica no meio e a linha nao ondula", () => {
  const { map, drive } = setup(null);
  // A no circulo; B 4 m para fora ou C 4 m para dentro, sorteados a cada leitura (linhas diferentes)
  let seed = 7;
  drive(8, (d) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const flip = seed % 2 ? 1 : -1;
    const [x, z] = onCircle(d);
    const k = 1 + (4 * flip) / R;
    return { name: flip > 0 ? "B" : "C", lapDistance: d, worldX: x * k, worldZ: z * k, speedMs: 50, pitMode: 0 };
  });
  const m = map.get();
  assert.ok(m && m.ready);
  const n = m.points.length;
  const err = m.points.map((p, i) => Math.abs(Math.hypot(p[0], p[1]) - R));
  assert.ok(Math.max(...err) < 3, `fora do meio por ate ${Math.max(...err).toFixed(1)} m`);
  // zigue-zague: diferenca de raio entre vizinhos
  const zig = Math.max(...m.points.map((p, i) => Math.abs(Math.hypot(p[0], p[1]) - Math.hypot(m.points[(i + 1) % n][0], m.points[(i + 1) % n][1]))));
  assert.ok(zig < 0.6, `ondulacao ${zig.toFixed(2)} m`);
});
