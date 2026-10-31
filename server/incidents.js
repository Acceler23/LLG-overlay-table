// server/incidents.js
// Direcao de prova no LMU (aba LMU do painel, com senha): o que os comissarios
// precisam olhar durante a corrida.
// Valem so em corrida.
// - Carro lento (pista verde, fora do box): abaixo de 40 km/h, ou abaixo de
//   60 km/h por mais de 3 s. Cada trecho lento vira um incidente, com a
//   duracao, a menor velocidade e onde aconteceu (metros da volta).
// - Ultrapassagem com o SC ou o FCY (fora do box): um carro passa outro na
//   pista. Vale a ordem na pista (metros da volta), nao a classificacao, e a
//   nova ordem precisa se manter por OVERTAKE_CONFIRM_MS (lado a lado nao conta).
// Os dados vem de server/raceControl.js, que sabe se ha FCY/SC e qual e o
// carro do safety car.

const SLOW_KMH = 60;
const VERY_SLOW_KMH = 40;
const SLOW_AFTER_MS = 3000;
const RESUME_MS = 1000; // acima de 60 por esse tempo: o trecho lento acabou
const NEAR_M = 300; // so carros perto um do outro na pista se ultrapassam
const OVERTAKE_CONFIRM_MS = 1500;
const MAX_ITEMS = 100;
const RACE_STATE = 5;
// LMU: o jogo so informa a amarela por setor (mSectorFlag), nao por carro.
// Causador: abaixo disto, fora do box, num setor sob amarela.
const LMU_SECTOR_YELLOW = 1; // conferido no jogo com um carro parado na pista
const YELLOW_CAUSE_KMH = 40;
// Curvas em que todo mundo passa devagar: dentro do trecho (metros da volta; se
// from > to, o trecho passa pela linha de chegada) so conta abaixo de minKmh.
// Long Beach, ultima curva: medido no jogo em 30/10/2026 (minimo de 41 a 43 km/h,
// abaixo de 60 entre 2761 e 2841 m), com 20 m de folga.
const SLOW_ZONES = [{ track: /long\s*beach/i, from: 2740, to: 2860, minKmh: 30 }];

function zoneAt(zones, track, lapDistance) {
  if (typeof lapDistance !== "number") return null;
  return (
    zones.find(
      (z) => z.track.test(String(track || "")) && (z.from <= z.to ? lapDistance >= z.from && lapDistance <= z.to : lapDistance >= z.from || lapDistance <= z.to)
    ) || null
  );
}

const speedKmh = (e) => (typeof e.speedKmh === "number" ? e.speedKmh : typeof e.speedMs === "number" ? e.speedMs * 3.6 : null);
// abandonou, desclassificado, fora da corrida ou ja recebeu a bandeirada
const outOfRace = (e) => e.raceState === 3 || e.raceState === 4 || e.raceState === 5 || e.raceState === 6;
const inPit = (e) => {
  const phase = e.pit && e.pit.phase;
  return phase === "in" || phase === "out" || e.pitMode > 0; // listener-lmu.ps1: 1 entrando, 2 no box, 3 saindo, 4 garagem
};
const lapOf = (e) => (e.currentLap != null ? e.currentLap : (e.lapsCompleted || 0) + 1);

// Marca quem causou a amarela (entry.causedYellow): tabela, mapa e log usam.
function markLmuYellow(payload) {
  const flags = payload && payload.session && payload.session.sectorFlags;
  if (!Array.isArray(flags)) return;
  (payload.standings || []).forEach((e) => {
    if (!e) return;
    const v = speedKmh(e);
    e.causedYellow = flags[e.currentSector] === LMU_SECTOR_YELLOW && v != null && v < YELLOW_CAUSE_KMH && !inPit(e) && !outOfRace(e);
  });
}

function createIncidentWatch(opts = {}) {
  const now = opts.now || Date.now;
  const zones = opts.zones || SLOW_ZONES;
  let slowOpen = new Map(); // nome -> trecho abaixo de 60 em andamento
  let slow = []; // incidentes de carro lento (fechados)
  let order = new Map(); // "A|B" -> { ahead: true se A esta na frente de B, since, pending }
  let overtakes = [];

  function reset() {
    slowOpen = new Map();
    slow = [];
    order = new Map();
    overtakes = [];
  }

  const keep = (list) => (list.length > MAX_ITEMS ? list.slice(-MAX_ITEMS) : list);

  function closeSlow(name, t) {
    const o = slowOpen.get(name);
    if (!o) return;
    slowOpen.delete(name);
    if (o.incident) slow = keep(slow.concat(Object.assign(o.info, { durationMs: t - o.start, minKmh: Math.round(o.minKmh) })));
  }

  // ---- carro lento (pista verde)
  function slowCars(t, cars, track, eventTime) {
    const seen = new Set();
    cars.forEach((e) => {
      const v = speedKmh(e);
      if (v == null) return;
      seen.add(e.name);
      let o = slowOpen.get(e.name);
      const zone = zoneAt(zones, track, e.lapDistance);
      if (v >= (zone ? zone.minKmh : SLOW_KMH)) {
        // so fecha depois de RESUME_MS acima de 60 (uma leitura com ruido nao
        // parte o trecho em varios); o fim e quando voltou a 60
        if (!o) return;
        if (o.fastSince == null) o.fastSince = t;
        if (t - o.fastSince >= RESUME_MS) closeSlow(e.name, o.fastSince);
        return;
      }
      if (o) o.fastSince = null;
      if (!o) {
        o = {
          start: t,
          minKmh: v,
          incident: false,
          info: { name: e.name, carNumber: e.carNumber || "", position: e.position || null, lap: lapOf(e), lapDistance: typeof e.lapDistance === "number" ? Math.round(e.lapDistance) : null, at: t, et: eventTime },
        };
        slowOpen.set(e.name, o);
      }
      o.minKmh = Math.min(o.minKmh, v);
      if (!o.incident && (zone || v < VERY_SLOW_KMH || t - o.start >= SLOW_AFTER_MS)) {
        o.incident = true;
        o.info.reason = zone ? `abaixo de ${zone.minKmh} km/h na curva lenta` : v < VERY_SLOW_KMH ? `abaixo de ${VERY_SLOW_KMH} km/h` : `abaixo de ${SLOW_KMH} km/h por mais de 3 s`;
      }
    });
    // saiu da lista ou entrou no box: fecha onde estava
    [...slowOpen.keys()].filter((n) => !seen.has(n)).forEach((n) => closeSlow(n, slowOpen.get(n).fastSince != null ? slowOpen.get(n).fastSince : t));
  }

  // ---- ultrapassagem com SC/FCY
  function overtaking(t, cars, trackLength, ctx, eventTime) {
    const L = Number(trackLength);
    if (!(L > 0)) return;
    const pos = (e) => (typeof e.lapDistance === "number" ? e.lapDistance : typeof e.totalDistance === "number" ? e.totalDistance % L : null);
    const list = cars.filter((e) => e.name !== ctx.scName && pos(e) != null);
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        // a na frente de b: distancia de b ate a na pista, entre -L/2 e L/2
        let d = (((pos(a) - pos(b)) % L) + L) % L;
        if (d > L / 2) d -= L;
        if (Math.abs(d) > NEAR_M || d === 0) continue;
        const key = a.name < b.name ? `${a.name}|${b.name}` : `${b.name}|${a.name}`;
        const firstIsA = key.startsWith(`${a.name}|`);
        const ahead = firstIsA ? d > 0 : d < 0; // o primeiro do par esta na frente?
        seen.add(key);
        const st = order.get(key);
        if (!st) {
          order.set(key, { ahead, since: t, pending: null });
          continue;
        }
        if (ahead === st.ahead) {
          st.pending = null; // voltou (lado a lado): nada
          continue;
        }
        if (!st.pending) {
          st.pending = { since: t };
          continue;
        }
        if (t - st.pending.since < OVERTAKE_CONFIRM_MS) continue;
        // confirmado: quem passou e quem foi passado
        const [n1, n2] = key.split("|");
        const passer = ahead ? n1 : n2;
        const passed = ahead ? n2 : n1;
        const pe = passer === a.name ? a : b;
        st.ahead = ahead;
        st.pending = null;
        const allowed = (ctx.released || []).includes(passer); // retardatario liberado pelo SC
        overtakes = keep(
          overtakes.concat({
            passer,
            passerNumber: pe.carNumber || "",
            passed,
            passedNumber: (passer === a.name ? b : a).carNumber || "",
            under: ctx.under,
            countdown: !!ctx.countdown,
            allowed,
            lap: lapOf(pe),
            lapDistance: Math.round(pos(pe)),
            at: t,
            et: eventTime,
          })
        );
      }
    }
    // pares que se afastaram: esquece (a ordem volta a ser lida quando se aproximarem)
    [...order.keys()].filter((k) => !seen.has(k)).forEach((k) => order.delete(k));
  }

  // payload do LMU (ja com a corrida em andamento) e o contexto da direcao:
  // { under: "FCY" | "SC" | null, countdown, scName, released }
  function apply(payload, ctx) {
    const t = now();
    const session = (payload && payload.session) || {};
    const cars = Number(session.state) === RACE_STATE ? ((payload && payload.standings) || []).filter((e) => e && e.name && !outOfRace(e) && !inPit(e)) : [];
    if (ctx.under) {
      [...slowOpen.keys()].forEach((n) => closeSlow(n, t)); // com SC/FCY andar devagar e normal
      overtaking(t, cars, session.trackLength, ctx, session.eventTime);
    } else {
      order = new Map();
      slowCars(t, cars.filter((e) => e.name !== ctx.scName), session.trackLocation, session.eventTime);
    }
  }

  function status() {
    const t = now();
    const live = [...slowOpen.values()]
      .filter((o) => o.incident)
      .map((o) => Object.assign({}, o.info, { durationMs: (o.fastSince != null ? o.fastSince : t) - o.start, minKmh: Math.round(o.minKmh), live: true }));
    return {
      slow: slow.concat(live).slice().reverse(), // mais recentes primeiro
      overtakes: overtakes.slice().reverse(),
    };
  }

  return { apply, status, reset };
}

module.exports = { createIncidentWatch, markLmuYellow, SLOW_KMH, VERY_SLOW_KMH, SLOW_AFTER_MS };
