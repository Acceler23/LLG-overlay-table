// server/trackMap.js
// Mapa da pista aprendido com as posicoes dos carros (overlay/track-map.html).
//
// A volta e dividida em trechos (ate 500 por pista). Para cada trecho ficam as
// posicoes (X, Z do mundo) das ultimas passagens de todos os carros, e o ponto
// do mapa e a MEDIA delas sem as mais distantes (media aparada: tira um quarto
// de cada ponta). Uma rodada, um carro fora da pista ou uma leitura errada nao
// deformam o desenho, e com varias passagens o ponto fica no meio da pista em
// vez de seguir um carro so. Depois, cada ponto e suavizado com os dois
// vizinhos, para a linha nao ondular. Passagens que nao contam:
//   - carro lento (rodada, acidente, carro parado): abaixo de MIN_SPEED_MS
//   - carro no box e na volta de saida do box (ate cruzar a linha de chegada)
//   - volta queimada (lapInvalidated: corte de pista, limites da pista)
//   - fora da pista: a passagem a mais de OFF_TRACK_M do meio das outras
//     passagens daquele trecho (os jogos so informam a superficie das rodas do
//     proprio piloto; a dos outros carros nao vem, entao vale a posicao)
// Quando ha trechos cobertos o bastante (READY_COVERAGE), o mapa fica pronto;
// os trechos sem passagem sao preenchidos pelos vizinhos. O mapa pronto e
// salvo em disco (trackmaps.json na pasta de dados do aplicativo), por jogo,
// pista e tracado: da proxima vez ele ja aparece sem precisar aprender.
// O mapa continua aprendendo depois de pronto (tambem o que veio do arquivo):
// quando as passagens por trecho crescem (samples), ele e trocado e salvo de
// novo, ate MAX_SAMPLES. Assim um mapa feito com poucas voltas no comeco do
// treino melhora sozinho quando a pista enche.
// Onde cada setor comeca (map.sectors, para pintar o setor sob amarela) e
// aprendido a parte: mediana dos metros em que os carros trocam de setor.

const fs = require("fs");
const path = require("path");

const TARGET_BUCKETS = 500; // trechos por pista (Spa: ~14 m cada)
const MIN_BUCKET_M = 8; // maior que o que um carro rapido anda entre duas leituras do jogo
const MAX_SAMPLES = 25; // passagens guardadas por trecho
const MIN_SAMPLES = 3; // passagens para o trecho valer
const REFINE_STEP = 2; // o mapa pronto so e trocado com pelo menos tantas passagens a mais por trecho
const MIN_SPEED_MS = 20; // ~72 km/h
const READY_COVERAGE = 0.9;
const REBUILD_MS = 3000;
const SAVE_DELAY_MS = 2000;
const SECTOR_SAMPLES = 5; // trocas de setor para a fronteira valer
const TELEPORT_HOLD_MS = 3000; // depois do box ou de um salto de posicao, o carro nao conta por este tempo
const OFF_TRACK_M = 10; // passagem mais longe que isso do meio do trecho = fora da pista
const OFF_TRACK_MIN_SAMPLES = 5; // passagens no trecho para ja saber onde fica o meio

const median = (list) => {
  const a = list.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// Media sem um quarto de cada ponta (com 3 ou 4 passagens, tira a mais alta e a
// mais baixa). Cada eixo e aparado separado.
const trimmedMean = (list) => {
  const a = list.slice().sort((x, y) => x - y);
  const k = a.length >= 3 ? Math.max(1, Math.floor(a.length / 4)) : 0;
  const mid = a.slice(k, a.length - k);
  return mid.reduce((sum, v) => sum + v, 0) / mid.length;
};

function mapKey(game, session) {
  return [game || "", session.trackLocation || "", session.trackVariation || ""].join("|");
}

// Pontos do mapa a partir das passagens de cada trecho (mediana; os trechos
// sem passagens suficientes sao preenchidos entre os vizinhos, na volta fechada).
// "runs" diz quais trechos sao de verdade (aprendidos, ou buraco curto entre
// dois aprendidos): enquanto o mapa nao fica pronto, a overlay desenha so eles,
// em vez de ligar pedacos distantes da pista com uma linha reta.
const MAX_SHORT_GAP = 4; // buracos de ate tantos trechos contam como desenhados
function buildPoints(buckets) {
  const n = buckets.length;
  const raw = buckets.map((b) => (b && b.length >= MIN_SAMPLES ? [trimmedMean(b.map((p) => p[0])), trimmedMean(b.map((p) => p[1]))] : null));
  const filled = raw.filter(Boolean).length;
  if (!filled) return { points: [], coverage: 0, runs: [], samples: 0 };
  // suaviza com os vizinhos (1-2-1), so onde os dois vizinhos foram aprendidos
  const points = raw.map((p, i) => {
    const a = raw[(i - 1 + n) % n];
    const b = raw[(i + 1) % n];
    if (!p || !a || !b || n < 3) return p;
    return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4];
  });
  // passagens tipicas por trecho (mediana entre os trechos aprendidos): a "qualidade" do mapa
  const samples = median(buckets.filter((b) => b && b.length >= MIN_SAMPLES).map((b) => b.length));
  const known = points.map(Boolean);
  for (let i = 0; i < n; i++) {
    if (known[i]) continue;
    // tamanho do buraco que comeca aqui
    let len = 0;
    while (len < n && !points[(i + len) % n]) len++;
    if (len <= MAX_SHORT_GAP && points[(i - 1 + n) % n]) for (let k = 0; k < len; k++) known[(i + k) % n] = true;
    i += len - 1;
  }
  // trechos desenhados, como [inicio, fim] (indices, fim incluso; pode dar a volta)
  const runs = [];
  if (known.every(Boolean)) runs.push([0, n - 1]);
  else {
    const start = known.findIndex((k) => !k); // comeca num buraco: nenhum trecho fica partido no 0
    for (let s = 0; s < n; s++) {
      const i = (start + s) % n;
      if (known[i] && !known[(i - 1 + n) % n]) runs.push([i, i]);
      if (known[i]) runs[runs.length - 1][1] = i;
    }
  }
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
  return { points: points.map((p) => (p ? [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10] : null)), coverage: filled / n, runs, samples };
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
    lastPos.clear(); // pista nova: esquece onde cada carro estava
    outLap.clear();
    current = { key, length, bucketM: length / count, buckets: new Array(count).fill(null), map: null, dirty: false, builtAt: 0, sectors: null, crossings: [[], []], lastSector: new Map() };
    const known = saved[key];
    if (known && Array.isArray(known.sectors) && Math.abs(known.length - length) < 1) current.sectors = known.sectors;
    if (known && known.points && known.points.length && Math.abs(known.length - length) < 1) {
      // mapas salvos antes de existir "samples" contam como feitos com o minimo
      current.map = { key, length, points: known.points, coverage: known.coverage, ready: known.coverage >= READY_COVERAGE, saved: true, sectors: current.sectors, samples: known.samples || MIN_SAMPLES };
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

  // Carro que acabou de ir para o box ou saltou de lugar (voltar aos pits pelo menu teleporta o
  // carro): as leituras dele nao contam por TELEPORT_HOLD_MS, para nenhuma posicao do meio do
  // salto (ou do caminho box -> pista) entrar no mapa.
  const lastPos = new Map(); // carro -> { x, z, t, until }
  function teleported(e, t) {
    const id = e.slot != null ? `#${e.slot}` : e.name;
    const prev = lastPos.get(id);
    const cur = { x: e.worldX, z: e.worldZ, t, until: prev ? prev.until : 0 };
    if ((e.pitMode || 0) !== 0) cur.until = t + TELEPORT_HOLD_MS;
    else if (prev && t > prev.t) {
      const dt = (t - prev.t) / 1000;
      const moved = Math.hypot(e.worldX - prev.x, e.worldZ - prev.z);
      const v = Math.max(Number(e.speedMs) || 0, 20);
      if (moved > v * dt * 2 + 30) cur.until = t + TELEPORT_HOLD_MS;
    }
    lastPos.set(id, cur);
    return t < cur.until;
  }

  // Volta de saida do box: do box ate o carro cruzar a linha de chegada.
  const outLap = new Map(); // carro -> { on, d }
  function onOutLap(e, d, length) {
    const id = e.slot != null ? `#${e.slot}` : e.name;
    const st = outLap.get(id) || { on: false, d: null };
    const valid = d > 0 && d < length;
    if ((e.pitMode || 0) !== 0) st.on = true;
    else if (st.on && valid && st.d != null && st.d - d > length / 2) st.on = false; // cruzou a linha
    if (valid) st.d = d;
    outLap.set(id, st);
    return st.on;
  }

  // Fora da pista: longe do meio das passagens que o trecho ja tem
  function offTrack(b, x, z) {
    if (!b || b.length < OFF_TRACK_MIN_SAMPLES) return false;
    return Math.hypot(x - median(b.map((p) => p[0])), z - median(b.map((p) => p[1]))) > OFF_TRACK_M;
  }

  // Recebe o payload de um jogo. Os carros precisam de lapDistance, worldX e worldZ.
  function apply(game, payload) {
    const session = (payload && payload.session) || {};
    const length = Number(session.trackLength) || 0;
    if (!(length > 100) || !session.trackLocation) return;
    const key = mapKey(game, session);
    if (!current || current.key !== key || Math.abs(current.length - length) >= 1) start(key, length);
    learnSectors((payload && payload.standings) || [], length);
    // mapa pronto com o maximo de passagens por trecho: nao tem mais o que melhorar
    if (current.map && current.map.ready && current.map.samples >= MAX_SAMPLES) return;

    const t = clock();
    ((payload && payload.standings) || []).forEach((e) => {
      if (!e) return;
      const d = Number(e.lapDistance);
      // antes de tudo: o box e a volta de saida sao acompanhados mesmo nas leituras que nao contam
      const leavingPit = onOutLap(e, d, length);
      if (typeof e.worldX !== "number" || typeof e.worldZ !== "number") return;
      if (e.worldX === 0 && e.worldZ === 0) return; // posicao nao informada
      if (teleported(e, t)) return; // voltou para o box (ou trocou de carro): posicao saltou
      // 0 exato: o jogo ainda nao sabe a distancia (volta de saida no AMS2), mesmo com o carro no meio da pista
      if (!(d > 0 && d < length)) return;
      if (leavingPit) return; // box e volta de saida
      if (!(Number(e.speedMs) >= MIN_SPEED_MS)) return; // rodada, acidente, carro lento
      if (e.lapInvalidated === true) return; // volta queimada
      const i = Math.min(current.buckets.length - 1, Math.floor(d / current.bucketM));
      if (offTrack(current.buckets[i], e.worldX, e.worldZ)) return; // fora da pista
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
    // ja ha um mapa pronto (desta sessao ou do arquivo): so troca por um pronto com mais passagens
    const have = current.map && current.map.ready ? current.map : null;
    if (have && !(ready && built.samples >= Math.min(MAX_SAMPLES, (have.samples || MIN_SAMPLES) + REFINE_STEP))) return;
    current.map = { key, length, points: built.points, coverage: Math.round(built.coverage * 1000) / 1000, ready, saved: false, sectors: current.sectors, runs: ready ? null : built.runs, samples: built.samples };
    if (ready) {
      saved[key] = { length, points: built.points, coverage: current.map.coverage, samples: built.samples, updatedAt: new Date(now).toISOString(), sectors: current.sectors };
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
