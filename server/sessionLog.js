// server/sessionLog.js
// Log da corrida para a tabela completa (overlay/full-timing.html): cada
// evento com a volta e o tempo de corrida em que aconteceu.
//   overtake: ultrapassagem (quem ganhou e quem perdeu a posicao)
//   fastest:  melhor volta (geral, da classe ou pessoal)
//   pitIn / pitOut: entrada e saida do box. Na saida: tempo no box (parado e
//             andando), posicoes perdidas e, quando o jogo informa (LMU, AC1),
//             troca de pneus e reabastecimento
//   penalty:  punicao (LMU informa as punicoes pendentes de cada carro) e
//             desclassificacao (todos os jogos)
//   bandeiras: yellow (AMS2: carro lento dentro de uma bandeira amarela),
//             localYellow (LMU: bandeira amarela local em algum setor; o jogo
//             nao diz qual carro), safetyCar / green (bandeira amarela geral ou
//             safety car, e a volta da bandeira verde)
// Fica no servidor para o log nao se perder quando a overlay recarrega.
// apply() recebe o payload ja passado pelo raceState (entry.pit).

const MAX_EVENTS = 150;
const POSITION_CONFIRM_MS = 2000; // posicao nova so vale depois de 2 s (lado a lado nao vira 10 ultrapassagens)
const START_SPEED_MS = 3; // largada: o primeiro carro andando
const STOPPED_SPEED_MS = 0.5;
const WEAR_CHANGE = 0.02; // desgaste medio que muda durante a parada = pneus trocados
const YELLOW_CONFIRM_MS = 1000; // bandeira que pisca por um instante nao entra no log
const YELLOW_REPEAT_MS = 30000; // o mesmo carro so entra de novo depois de 30 s
const LOCAL_YELLOW_CLEAR_MS = 5000; // amarela local so conta como nova depois de 5 s sem nenhuma
const LMU_SECTOR_YELLOW = 1; // valor de mSectorFlag com bandeira amarela
const TIMED_STATES = new Set([1, 2, 3, 6]); // treino, teste, classificacao, time attack
const RACE_QUIET_LAPS = 2; // corrida: sem aviso de melhor volta nas voltas 1 e 2

function isDnf(e) {
  return e.raceState === 4 || e.raceState === 5 || e.raceState === 6;
}

function inPitLane(e) {
  const phase = e.pit && e.pit.phase;
  return phase === "in" || phase === "out" || (e.pitMode >= 1 && e.pitMode <= 5);
}

function avg(list) {
  const nums = (list || []).filter((x) => typeof x === "number");
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

// compostos montados: as 4 rodas (LMU) ou dianteiro/traseiro
function tyreSet(e) {
  if (Array.isArray(e.tyres) && e.tyres.some(Boolean)) return e.tyres.map((t) => t || "?");
  const set = [e.tyreFront, e.tyreRear].filter(Boolean);
  return set.length ? set : null;
}

function sameSet(a, b) {
  return !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
}

// classOf(entry): classe do carro (a do RLT quando ha temporada, senao a do jogo)
function createSessionLog(opts) {
  const classOf = (opts && opts.classOf) || ((e) => e.carClass || "—");
  const clock = (opts && opts.clock) || Date.now;

  let sessionKey = null;
  let startAt = null; // largada
  let events = [];
  let nextId = 1;
  let confirmed = new Map(); // nome -> posicao confirmada
  const rawPos = new Map(); // nome -> { pos, since }
  const bests = new Map(); // nome -> melhor volta (ms) ja vista
  const pits = new Map(); // nome -> parada em andamento
  const penalties = new Map(); // nome -> punicoes pendentes
  const penaltyKinds = new Map(); // nome -> tipo da punicao pendente (AMS2), ou null
  const disqualified = new Set();
  const seen = new Set(); // carros ja vistos nesta corrida
  const yellowSince = new Map(); // nome -> desde quando esta com bandeira amarela
  const yellowLogged = new Map(); // nome -> quando entrou no log
  let scOut = null; // safety car / amarela geral na leitura anterior
  let fcy = null; // FCY ligado pelo painel (LMU) na leitura anterior
  let localYellow = { on: false, since: null, clearSince: null };
  let lastAt = null;
  let remainingSec = null; // da leitura atual
  let isRaceSession = false;

  function reset() {
    startAt = null;
    events = [];
    confirmed = new Map();
    rawPos.clear();
    bests.clear();
    pits.clear();
    penalties.clear();
    penaltyKinds.clear();
    disqualified.clear();
    seen.clear();
    yellowSince.clear();
    yellowLogged.clear();
    scOut = null;
    fcy = null;
    localYellow = { on: false, since: null, clearSince: null };
    lastAt = null;
  }

  function push(t, e, data) {
    events.push(
      Object.assign(
        {
          id: nextId++,
          lap: e ? (e.currentLap != null ? e.currentLap : (e.lapsCompleted || 0) + 1) : null,
          sessionMs: startAt != null ? Math.max(0, t - startAt) : 0,
          // tempo restante da sessao que o jogo informa (corrida por voltas: null)
          remainingSec,
          race: isRaceSession, // fora da corrida a overlay nao mostra posicoes ganhas/perdidas no box
        },
        data
      )
    );
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  }

  // ---- ultrapassagens
  function overtakes(t, list, byName) {
    const changed = [];
    list.forEach((e) => {
      const r = rawPos.get(e.name);
      if (!r || r.pos !== e.position) rawPos.set(e.name, { pos: e.position, since: t });
      else if (t - r.since >= POSITION_CONFIRM_MS && confirmed.get(e.name) !== e.position) changed.push(e.name);
      if (!confirmed.has(e.name)) confirmed.set(e.name, e.position);
    });
    if (!changed.length) return [];
    const before = new Map(confirmed);
    changed.forEach((n) => confirmed.set(n, rawPos.get(n).pos));
    const found = [];
    changed.forEach((gName) => {
      const g = byName.get(gName);
      if (!g || before.get(gName) <= confirmed.get(gName)) return; // so quem ganhou posicao
      if (isDnf(g) || inPitLane(g) || g.raceState === 3) return;
      before.forEach((oldPos, lName) => {
        if (lName === gName) return;
        if (!(oldPos < before.get(gName) && confirmed.get(lName) > confirmed.get(gName))) return;
        const l = byName.get(lName);
        // quem ficou para tras no box, abandonou ou ja terminou nao foi ultrapassado na pista
        if (!l || isDnf(l) || inPitLane(l) || l.raceState === 3) return;
        found.push({ g, l });
      });
    });
    found.forEach(({ g, l }) => push(t, g, { type: "overtake", gainer: g.name, loser: l.name, position: confirmed.get(g.name), lostPosition: confirmed.get(l.name) }));
    return found;
  }

  // ---- melhores voltas
  function fastestLaps(t, list) {
    const prev = new Map(bests);
    list.forEach((e) => {
      const ms = e.fastestLapMs;
      if (!(ms > 0)) return seen.add(e.name);
      const had = prev.get(e.name);
      bests.set(e.name, had ? Math.min(had, ms) : ms);
      // carro que acabou de aparecer (app aberto no meio da corrida): so guarda a marca
      if (!seen.has(e.name)) return;
      if (had && ms >= had) return;
      const cls = classOf(e);
      let overall = Infinity;
      let classBest = Infinity;
      prev.forEach((b, n) => {
        if (n === e.name) return;
        overall = Math.min(overall, b);
        const other = list.find((x) => x.name === n);
        if (other && classOf(other) === cls) classBest = Math.min(classBest, b);
      });
      const scope = ms < overall ? "overall" : ms < classBest ? "class" : "personal";
      if (!had && scope === "personal") return; // a primeira volta de cada um so entra se for a melhor da corrida ou da classe
      // corrida: nas voltas 1 e 2 toda volta e "a melhor" de alguem; nao entra no log
      // (a marca ja ficou guardada acima, entao a partir da 3a a comparacao vale)
      if (isRaceSession && (e.lapsCompleted || 0) <= RACE_QUIET_LAPS) return;
      push(t, Object.assign({}, e, { currentLap: e.lapsCompleted || e.currentLap }), { type: "fastest", driver: e.name, lapMs: ms, scope, classKey: cls });
    });
  }

  // ---- box
  function pitStops(t, list, dt) {
    list.forEach((e) => {
      const p = pits.get(e.name);
      const phase = e.pit && e.pit.phase;
      const inLane = phase === "in" || phase === "out";
      if (inLane && !p) {
        if (isDnf(e) || e.raceState === 3) return;
        pits.set(e.name, {
          position: e.position,
          stoppedMs: 0,
          tyres: tyreSet(e),
          wear: avg(e.tyreWear),
          ve: typeof e.virtualEnergy === "number" ? e.virtualEnergy : null,
          fuel: typeof e.fuelL === "number" ? e.fuelL : null,
          lastTyres: tyreSet(e),
          lastWear: avg(e.tyreWear),
          lastVe: typeof e.virtualEnergy === "number" ? e.virtualEnergy : null,
          lastFuel: typeof e.fuelL === "number" ? e.fuelL : null,
        });
        push(t, e, { type: "pitIn", driver: e.name, position: e.position });
        return;
      }
      if (!p) return;
      if (inLane) {
        if (typeof e.speedMs === "number" && e.speedMs < STOPPED_SPEED_MS) p.stoppedMs += dt;
        // ultimos valores ainda dentro do box (na saida o jogo pode ja ter zerado algo)
        if (tyreSet(e)) p.lastTyres = tyreSet(e);
        if (avg(e.tyreWear) != null) p.lastWear = avg(e.tyreWear);
        if (typeof e.virtualEnergy === "number") p.lastVe = e.virtualEnergy;
        if (typeof e.fuelL === "number") p.lastFuel = e.fuelL;
        return;
      }
      pits.delete(e.name);
      if (isDnf(e)) return; // foi para a garagem e abandonou
      const totalMs = e.pit && e.pit.phase === "done" && typeof e.pit.elapsedMs === "number" ? e.pit.elapsedMs : null;
      const stoppedMs = Math.round(p.stoppedMs);
      const tyresChanged =
        (p.tyres && p.lastTyres && !sameSet(p.tyres, p.lastTyres)) ||
        (p.wear != null && p.lastWear != null && Math.abs(p.lastWear - p.wear) >= WEAR_CHANGE);
      push(t, e, {
        type: "pitOut",
        driver: e.name,
        totalMs,
        stoppedMs,
        movingMs: totalMs != null ? Math.max(0, totalMs - stoppedMs) : null,
        positionBefore: p.position,
        positionAfter: e.position,
        tyres: tyresChanged ? { before: p.tyres, after: p.lastTyres } : null,
        energyAdded: p.ve != null && p.lastVe != null && p.lastVe - p.ve > 0.005 ? Math.round((p.lastVe - p.ve) * 100) : null,
        fuelAdded: p.ve == null && p.fuel != null && p.lastFuel != null && p.lastFuel - p.fuel > 0.5 ? Math.round(p.lastFuel - p.fuel) : null,
      });
    });
  }

  // ---- punicoes
  function penaltyEvents(t, list) {
    list.forEach((e) => {
      if (typeof e.penalties === "number") {
        const had = penalties.has(e.name) ? penalties.get(e.name) : null;
        penalties.set(e.name, e.penalties);
        if (had != null && e.penalties > had) push(t, e, { type: "penalty", driver: e.name, pending: e.penalties });
        if (had != null && e.penalties < had) push(t, e, { type: "penaltyServed", driver: e.name, pending: e.penalties });
      }
      // AMS2: tipo da punicao pendente de cada carro (drive-through, stop & go)
      if ("penaltyType" in e) {
        const kind = e.penaltyType || null;
        const had = penaltyKinds.has(e.name) ? penaltyKinds.get(e.name) : undefined;
        penaltyKinds.set(e.name, kind);
        if (had !== undefined && kind && kind !== had) push(t, e, { type: "penalty", driver: e.name, kind });
        if (had && !kind) push(t, e, { type: "penaltyServed", driver: e.name, kind: had });
      }
      if (e.raceState === 4 && !disqualified.has(e.name)) {
        disqualified.add(e.name);
        push(t, e, { type: "disqualified", driver: e.name });
      }
    });
  }

  // ---- bandeiras
  function flagEvents(t, list, session) {
    const leader = list.slice().sort((a, b) => a.position - b.position)[0] || null;
    // amarela geral / safety car (AMS2 e LMU)
    const sc = !!session.scOut;
    if (scOut !== null && sc !== scOut && (sc || !session.fcy)) push(t, leader, { type: sc ? "safetyCar" : "green" });
    scOut = sc;
    // FCY queimado (acima de 60 km/h depois da contagem): server/raceControl.js.
    // Antes da bandeira verde: quem ainda estava acima fecha quando o FCY acaba.
    (session.fcyBreaches || []).forEach((b) => {
      const e = list.find((x) => x.name === b.name) || leader;
      push(t, e, { type: "fcyBreach", driver: b.name, overMs: b.overMs, afterMs: b.afterMs, maxKmh: Math.round(b.maxKmh) });
    });
    const f = !!session.fcy;
    if (fcy !== null && f !== fcy && (f || !sc)) push(t, leader, { type: f ? "fcy" : "green" });
    fcy = f;

    // AMS2: o carro lento dentro da bandeira amarela
    list.forEach((e) => {
      if (!e.causedYellow || isDnf(e) || inPitLane(e)) {
        yellowSince.delete(e.name);
        return;
      }
      if (!yellowSince.has(e.name)) yellowSince.set(e.name, t);
      const last = yellowLogged.get(e.name);
      if (t - yellowSince.get(e.name) >= YELLOW_CONFIRM_MS && (last == null || t - last >= YELLOW_REPEAT_MS)) {
        yellowLogged.set(e.name, t);
        push(t, e, { type: "yellow", driver: e.name, position: e.position });
      }
    });

    // LMU: amarela local em algum setor
    if (Array.isArray(session.sectorFlags)) {
      const on = session.sectorFlags.some((v) => v === LMU_SECTOR_YELLOW);
      if (on) {
        localYellow.clearSince = null;
        if (localYellow.since == null) localYellow.since = t;
        if (!localYellow.on && t - localYellow.since >= YELLOW_CONFIRM_MS) {
          localYellow.on = true;
          push(t, leader, { type: "localYellow" });
        }
      } else {
        localYellow.since = null;
        if (localYellow.clearSince == null) localYellow.clearSince = t;
        if (localYellow.on && t - localYellow.clearSince >= LOCAL_YELLOW_CLEAR_MS) localYellow.on = false;
      }
    }
  }

  // Devolve true quando entrou evento novo.
  function apply(payload) {
    const t = clock();
    const session = (payload && payload.session) || {};
    // corrida por tempo: o relogio do jogo, que para em 0:00 quando o tempo acaba
    // (a volta extra depois do tempo continua com 0:00). Por voltas: null.
    const byLaps = Number(session.lapsInEvent) > 0;
    remainingSec = !byLaps && typeof session.timeRemainingSec === "number" ? Math.max(0, Math.round(session.timeRemainingSec)) : null;
    const key = `${session.state}|${session.trackLocation || ""}|${session.trackVariation || ""}`;
    let cleared = false;
    if (key !== sessionKey) {
      sessionKey = key;
      cleared = events.length > 0;
      reset();
    }
    // corrida, e tambem treino, teste, classificacao e time attack
    isRaceSession = Number(session.state) === 5;
    if (!isRaceSession && !TIMED_STATES.has(Number(session.state))) return cleared;
    const list = ((payload && payload.standings) || []).filter((e) => e && e.name && e.position > 0);
    if (startAt == null) {
      if (!list.some((e) => typeof e.speedMs === "number" && e.speedMs > START_SPEED_MS)) return cleared;
      startAt = t;
    }
    const dt = lastAt != null ? Math.min(2000, t - lastAt) : 0;
    lastAt = t;
    const count = events.length;
    const firstId = nextId;
    const byName = new Map(list.map((e) => [e.name, e]));
    // ultrapassagem so em corrida: fora dela a posicao muda pelo tempo de volta
    if (isRaceSession) overtakes(t, list, byName);
    fastestLaps(t, list);
    list.forEach((e) => seen.add(e.name));
    pitStops(t, list, dt);
    penaltyEvents(t, list);
    flagEvents(t, list, session);
    return cleared || nextId !== firstId || events.length !== count;
  }

  function getEvents() {
    return events.slice();
  }

  return { apply, getEvents, reset };
}

module.exports = { createSessionLog };
