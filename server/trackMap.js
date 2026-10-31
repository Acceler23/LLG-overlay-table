// server/trackMap.js
// Mapa da pista aprendido com as posicoes dos carros (overlay/track-map.html).
//
// A volta e dividida em trechos (ate 500 por pista). Para cada trecho ficam as
// posicoes (X, Z do mundo) das ultimas passagens, e o ponto do mapa e a
// MEDIANA delas: uma rodada, um carro fora da pista ou uma leitura errada nao
// deformam o desenho. Passagens que nao contam:
//   - carro lento (rodada, acidente, carro parado): abaixo de MIN_SPEED_MS
//   - carro no box ou volta invalidada (corte de pista)
// Quando ha trechos cobertos o bastante (READY_COVERAGE), o mapa fica pronto;
// os trechos sem passagem sao preenchidos pelos vizinhos. O mapa pronto e
// salvo em disco (trackmaps.json na pasta de dados do aplicativo), por jogo,
// pista e tracado: da proxima vez ele ja aparece sem precisar aprender.
// Onde cada setor comeca (map.sectors, para pintar o setor sob amarela) e
// aprendido a parte: mediana dos metros em que os carros trocam de setor.

const fs = require("fs");
const path = require("path");

const TARGET_BUCKETS = 500; // trechos por pista (Spa: ~14 m cada)
const MIN_BUCKET_M = 8; // maior que o que um carro rapido anda entre duas leituras do jogo
const MAX_SAMPLES = 25; // passagens guardadas por trecho
const MIN_SAMPLES = 3; // passagens para o trecho valer
const MIN_SPEED_MS = 20; // ~72 km/h
const READY_COVERAGE = 0.9;
const REBUILD_MS = 3000;
const SAVE_DELAY_MS = 2000;
const SECTOR_SAMPLES = 5; // trocas de setor para a fronteira valer

const median = (list) => {
  const a = list.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

function mapKey(game, session) {
  return [game || "", session.trackLocation || "", session.trackVariation || ""].join("|");
}

// Pontos do mapa a partir das passagens de cada trecho (mediana; os trechos
// sem passagens suficientes sao preenchidos entre os vizinhos, na volta fechada)
function buildPoints(buckets) {
  const n = buckets.length;
  const points = buckets.map((b) => (b && b.length >= MIN_SAMPLES ? [median(b.map((p) => p[0])), median(b.map((p) => p[1]))] : null));
  const filled = points.filter(Boolean).length;
  if (!filled) return { points: [], coverage: 0 };
  for (let i = 0; i < n; i++) {
    if (points[i]) continue;
    let a = i;
    let da = 0;
    while (!points[(a - 1 + n) % n] && da < n) {
      a = (a - 1 + n) % n;
      da++;
    }
    let b = i;
    let db = 0;
    while (!points[(b + 1) % n] && db < n) {
      b = (b + 1) % n;
      db++;
    }
    const pa = points[(a - 1 + n) % n];
    const pb = points[(b + 1) % n];
    if (!pa || !pb) continue;
    const t = (da + 1) / (da + db + 2);
    points[i] = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
  }
  return { points: points.map((p) => (p ? [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10] : null)), coverage: filled / n };
}

function createTrackMap(opts) {
  const file = opts && opts.file;
  const clock = (opts && opts.clock) || Date.now;
  const onChange = (opts && opts.onChange) || (() => {});

  let saved = {}; // chave -> { length, points, coverage, updatedAt }
  try {
    saved = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch (_) {
    saved = {};
  }

  let current = null; // { key, length, bucketM, buckets, map, dirty, builtAt }
  let saveTimer = null;

  function save() {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + ".tmp", JSON.stringify(saved));
        fs.renameSync(file + ".tmp", file);
      } catch (_) {}
    }, SAVE_DELAY_MS);
    if (saveTimer.unref) saveTimer.unref();
  }

  function start(key, length) {
    const count = Math.max(50, Math.min(TARGET_BUCKETS, Math.floor(length / MIN_BUCKET_M)));
    current = { key, length, bucketM: length / count, buckets: new Array(count).fill(null), map: null, dirty: false, builtAt: 0, sectors: null, crossings: [[], []], lastSector: new Map() };
    const known = saved[key];
    if (known && Array.isArray(known.sectors) && Math.abs(known.length - length) < 1) current.sectors = known.sectors;
    if (known && known.points && known.points.length && Math.abs(known.length - length) < 1) {
      current.map = { key, length, points: known.points, coverage: known.coverage, ready: known.coverage >= READY_COVERAGE, saved: true, sectors: current.sectors };
    }
    onChange(current.map);
  }

  // Metros em que os carros passam do setor 1 para o 2 e do 2 para o 3
  function learnSectors(list, length) {
    if (current.sectors) return;
    list.forEach((e) => {
      if (!e || !e.name || typeof e.currentSector !== "number") return;
      const before = current.lastSector.get(e.name);
      current.lastSector.set(e.name, e.currentSector);
      if ((e.pitMode || 0) !== 0 || before === e.currentSector || !(before === 0 || before === 1) || e.currentSector !== before + 1) return;
      const d = Number(e.lapDistance);
      if (d >= 0 && d < length) current.crossings[before].push(d);
    });
    if (current.crossings.some((c) => c.length < SECTOR_SAMPLES)) return;
    current.sectors = current.crossings.map((c) => Math.round(median(c)));
    if (saved[current.key]) {
      saved[current.key].sectors = current.sectors;
      save();
    }
    if (current.map) {
      current.map = Object.assign({}, current.map, { sectors: current.sectors });
      onChange(current.map);
    }
  }

  // Recebe o payload de um jogo. Os carros precisam de lapDistance, worldX e worldZ.
  function apply(game, payload) {
    const session = (payload && payload.session) || {};
    const length = Number(session.trackLength) || 0;
    if (!(length > 100) || !session.trackLocation) return;
    const key = mapKey(game, session);
    if (!current || current.key !== key || Math.abs(current.length - length) >= 1) start(key, length);
    learnSectors((payload && payload.standings) || [], length);
    // mapa salvo e completo: nao precisa aprender de novo
    if (current.map && current.map.saved && current.map.ready) return;

    ((payload && payload.standings) || []).forEach((e) => {
      if (!e || typeof e.worldX !== "number" || typeof e.worldZ !== "number") return;
      const d = Number(e.lapDistance);
      if (!(d >= 0 && d < length)) return;
      if (!(Number(e.speedMs) >= MIN_SPEED_MS)) return; // rodada, acidente, carro lento
      if ((e.pitMode || 0) !== 0 || e.lapInvalidated) return; // box ou corte de pista
      if (e.worldX === 0 && e.worldZ === 0) return; // posicao nao informada
      const i = Math.min(current.buckets.length - 1, Math.floor(d / current.bucketM));
      const b = current.buckets[i] || (current.buckets[i] = []);
      b.push([e.worldX, e.worldZ]);
      if (b.length > MAX_SAMPLES) b.shift();
      current.dirty = true;
    });

    const now = clock();
    if (!current.dirty || now - current.builtAt < REBUILD_MS) return;
    current.dirty = false;
    current.builtAt = now;
    const built = buildPoints(current.buckets);
    if (!built.points.length) return;
    const ready = built.coverage >= READY_COVERAGE;
    current.map = { key, length, points: built.points, coverage: Math.round(built.coverage * 1000) / 1000, ready, saved: false, sectors: current.sectors };
    if (ready) {
      saved[key] = { length, points: built.points, coverage: current.map.coverage, updatedAt: new Date(now).toISOString(), sectors: current.sectors };
      save();
    }
    onChange(current.map);
  }

  function get() {
    return current ? current.map : null;
  }

  // Esquece o mapa salvo da pista atual (para aprender de novo)
  function forget() {
    if (!current) return;
    delete saved[current.key];
    save();
    start(current.key, current.length);
  }

  return { apply, get, forget };
}

module.exports = { createTrackMap, buildPoints, mapKey };
