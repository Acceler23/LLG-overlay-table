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

test("volta invalidada conta (treino), distancia 0 nao conta", () => {
  const { map, drive } = setup(null);
  // B: volta invalida mas no tracado (conta); C: distancia 0 no meio da pista (nao conta)
  drive(4, (d) => (d % 10 ? { name: "B", lapDistance: d, worldX: onCircle(d)[0], worldZ: onCircle(d)[1], speedMs: 50, pitMode: 0, lapInvalidated: true } : { name: "C", lapDistance: 0, worldX: 9999, worldZ: 9999, speedMs: 50, pitMode: 0 }));
  const m = map.get();
  assert.ok(m && m.ready);
  assert.ok(Math.hypot(m.points[0][0] - onCircle(0)[0], m.points[0][1] - onCircle(0)[1]) < 6, "largada no lugar");
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
