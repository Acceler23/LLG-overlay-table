// server/raceState.js
// Estado da sessao que precisa sobreviver a um recarregamento da overlay:
// posicao de largada, paradas/stint, tempo de box e instante da bandeirada
// de cada piloto. Antes isso vivia na pagina do OBS e se perdia no reload.
// apply() recebe o payload do listener e devolve o mesmo payload enriquecido.

const PIT_TRACKING_DELAY_MS = 10000; // ignora o "box" do grid nos 10 s iniciais

function isInPit(entry) {
  // 1=entrando, 2=no pitlane, 4=garagem
  return entry.pitMode === 1 || entry.pitMode === 2 || entry.pitMode === 4;
}

function isExitingPit(entry) {
  // 3=saindo do pit, 5=saindo da garagem
  return entry.pitMode === 3 || entry.pitMode === 5;
}

// Todo o estado (aqui e nas overlays) e guardado por nome do piloto. Quando
// dois carros tem exatamente o mesmo nome, um atropela o estado do outro: o
// box de um deixava o outro preso em "OUT", por exemplo. Para evitar isso, do
// segundo carro em diante o nome ganha caracteres invisiveis (U+200B) no fim.
// Na tela o nome continua igual, e o casamento com o RLT ignora esses
// caracteres. A ordem vem do `slot` (indice na Shared Memory), que nao muda
// quando os carros trocam de posicao.
const INVISIBLE = "\u200B";

function uniquifyNames(standings) {
  const byName = new Map();
  (standings || []).forEach((e, i) => {
    if (!e || typeof e.name !== "string") return;
    if (!byName.has(e.name)) byName.set(e.name, []);
    byName.get(e.name).push({ e, order: typeof e.slot === "number" ? e.slot : i });
  });
  byName.forEach((list) => {
    if (list.length < 2) return;
    list
      .sort((a, b) => a.order - b.order)
      .forEach((item, n) => {
        if (n > 0) item.e.name = item.e.name + INVISIBLE.repeat(n);
      });
  });
  return standings;
}

// Chave do estado de cada carro. Quando o jogo informa o numero do carro (ACC,
// LMU), o estado pertence ao CARRO: numa troca de piloto o nome muda, mas a
// posicao de largada, as paradas e o stint continuam os mesmos. Sem numero
// (AMS2), vale o nome do piloto, como sempre foi.
function stateKey(entry) {
  if (entry.carNumber != null && entry.carNumber !== "" && entry.slot != null) return `car:${entry.slot}#${entry.carNumber}`;
  return entry.name;
}

function createRaceState(clock) {
  const now = clock || Date.now;

  let sessionKey = null;
  let sessionStartedAt = 0;
  let isRace = false;
  let startPositions = new Map(); // nome -> posicao geral na largada
  let baselineLocked = false;
  const pit = new Map(); // nome -> { stops, wasInPit, stintStartLap, stintLaps, timer }
  const finished = new Map(); // nome -> instante (ms) em que recebeu a bandeirada
  let finalLapsTarget = null; // corrida por tempo: voltas do lider para receber a bandeirada (depois do relogio zerar)
  const bestLaps = new Map(); // nome -> { ms, lap }: em que volta saiu a melhor volta

  function reset() {
    finalLapsTarget = null;
    startPositions = new Map();
    baselineLocked = false;
    pit.clear();
    finished.clear();
    bestLaps.clear();
    sessionStartedAt = now();
  }

  // Numero da volta em que o piloto fez a melhor volta. Os jogos so informam o
  // tempo; aqui a volta e registrada quando a ultima volta completada e a
  // melhor (ultima = melhor, e o numero e o de voltas completadas). Se a
  // overlay abriu depois dessa volta, o numero fica desconhecido (null).
  function bestLapNumber(entry) {
    const best = entry.fastestLapMs;
    if (!(best > 0)) return null;
    const known = bestLaps.get(entry.name);
    if (known && known.ms === best) return known.lap;
    if (entry.lastLapMs === best && entry.lapsCompleted > 0) {
      bestLaps.set(entry.name, { ms: best, lap: entry.lapsCompleted });
      return entry.lapsCompleted;
    }
    return null;
  }

  // Corrida por tempo depois do relogio zerar: quantas voltas o lider ainda
  // precisa completar. Ele termina a volta em que estava quando o tempo acabou
  // e mais as voltas extras da sessao (o AMS2 informa em additionalLaps; os
  // outros jogos, nenhuma). null fora desse caso (o cabecalho mostra o relogio).
  function lapsLeftAfterTime(session, standings) {
    const timed = Number(session.state) === 5 && !(Number(session.lapsInEvent) > 0);
    const remaining = Number(session.timeRemainingSec);
    if (!timed || !Number.isFinite(remaining) || remaining > 0) {
      finalLapsTarget = null;
      return null;
    }
    const running = standings.filter((e) => e && !(e.raceState === 4 || e.raceState === 5 || e.raceState === 6));
    const leader = running.slice().sort((a, b) => (a.position || 999) - (b.position || 999))[0];
    if (!leader) return null;
    const done = Number(leader.lapsCompleted) || 0;
    if (finalLapsTarget == null) finalLapsTarget = done + 1 + Math.max(0, Number(session.additionalLaps) || 0);
    return Math.max(0, finalLapsTarget - done);
  }

  // Posicao do carro dentro da volta, em metros (null se nao der pra calcular).
  function lapDistance(entry, trackLength) {
    if (!(trackLength > 0) || typeof entry.totalDistance !== "number") return null;
    return entry.totalDistance - (entry.lapsCompleted || 0) * trackLength;
  }

  function updatePitTimer(st, entry, t, trackLength) {
    const lap = entry.currentLap != null ? entry.currentLap : entry.lapsCompleted || 0;
    const lapDist = lapDistance(entry, trackLength);
    const prevLapDist = st.lapDist;
    st.lapDist = lapDist;
    if (isInPit(entry) || isExitingPit(entry)) {
      if (!st.timer || st.timer.phase === "done") {
        st.timer = { enteredAt: t, phase: "in", finalMs: null, exitLap: null };
      }
      st.timer.phase = isExitingPit(entry) ? "out" : "in";
      return;
    }
    if (!st.timer) return;
    if (st.timer.phase === "in" || st.timer.phase === "out") {
      st.timer.finalMs = t - st.timer.enteredAt;
      st.timer.phase = "done";
      st.timer.exitLap = lap;
      return;
    }
    // "done": o OUT vale ate o carro cruzar a linha de chegada e abrir uma
    // volta. Em treino/classificacao o jogo nao conta a volta de saida do box:
    // o carro cruza a linha e segue na mesma "volta 1", que ja e a volta
    // rapida. Por isso nao basta esperar o numero da volta subir; a passagem
    // pela linha e detectada quando a distancia na volta volta para perto de 0.
    const crossedLine =
      lapDist != null && prevLapDist != null && prevLapDist - lapDist > trackLength / 2;
    if (lap > st.timer.exitLap || crossedLine) st.timer = null;
  }

  // t: agora. O stint tambem e contado em TEMPO (stintStartAt): comeca na
  // largada e recomeca quando o carro sai do box.
  function updatePitStats(st, entry, tracking, t) {
    const laps = entry.lapsCompleted || 0;
    const inPit = isInPit(entry);
    if (!tracking) {
      st.wasInPit = inPit;
      st.stintStartLap = laps;
      st.stintLaps = 0;
      st.stintStartAt = sessionStartedAt;
      return;
    }
    // quem ja recebeu a bandeirada e levado para o box pelo jogo: nao e parada
    if (entry.raceState === 3) return;
    if (inPit && !st.wasInPit) {
      st.stops += 1;
      st.wasInPit = true;
    } else if (!inPit && st.wasInPit) {
      st.wasInPit = false;
      st.stintStartLap = laps;
      st.stintStartAt = t;
    }
    st.stintLaps = Math.max(0, laps - st.stintStartLap);
  }

  function apply(payload) {
    if (!payload || Array.isArray(payload) || !Array.isArray(payload.standings)) return payload;
    const t = now();
    const session = payload.session || {};
    const standings = uniquifyNames(payload.standings);

    const key = `${session.state}|${session.trackLocation || ""}|${session.trackVariation || ""}`;
    if (key !== sessionKey) {
      sessionKey = key;
      isRace = Number(session.state) === 5;
      reset();
    }

    if (!baselineLocked) {
      startPositions = new Map(standings.map((e) => [stateKey(e), e.position]));
      // trava quando o pelotao se mexe; ate la o grid ainda pode mudar
      if (standings.some((e) => typeof e.speedMs === "number" && e.speedMs > 3)) baselineLocked = true;
    }

    const tracking = isRace && t - sessionStartedAt >= PIT_TRACKING_DELAY_MS;

    standings.forEach((entry) => {
      if (!entry || !entry.name) return;
      const name = stateKey(entry);
      entry.startPosition = startPositions.has(name) ? startPositions.get(name) : null;

      let st = pit.get(name);
      if (!st) {
        st = { stops: 0, wasInPit: false, stintStartLap: entry.lapsCompleted || 0, stintLaps: 0, stintStartAt: t, timer: null };
        pit.set(name, st);
      }
      updatePitTimer(st, entry, t, Number(session.trackLength) || 0);
      updatePitStats(st, entry, tracking, t);

      const timer = st.timer;
      const inPitNow = isInPit(entry) || isExitingPit(entry);
      entry.pit = {
        phase: timer ? timer.phase : null,
        elapsedMs: timer ? (timer.phase === "done" ? timer.finalMs : t - timer.enteredAt) : null,
        // o LMU informa as paradas de cada carro (entry.pitStops); o AMS2 nao, entao contamos
        stops: typeof entry.pitStops === "number" ? entry.pitStops : st.stops,
        stintLaps: st.stintLaps,
        // tempo do stint atual: parado em zero no box e congelado na bandeirada
        stintMs: !isRace || st.wasInPit ? 0 : Math.max(0, (finished.has(name) ? finished.get(name) : t) - st.stintStartAt),
        outLap:
          inPitNow ||
          (!!timer && timer.phase === "done") ||
          (tracking && st.stintLaps === 0 && st.stops > 0 && !st.wasInPit),
      };

      entry.fastestLapNum = bestLapNumber(entry);

      if (isRace && entry.raceState === 3 && !finished.has(name)) finished.set(name, t);
      entry.finishedAtMs = finished.has(name) ? finished.get(name) : null;
    });

    session.lapsLeft = lapsLeftAfterTime(session, standings);
    payload.ts = t;
    return payload;
  }

  return { apply, reset };
}

module.exports = { createRaceState, uniquifyNames };
