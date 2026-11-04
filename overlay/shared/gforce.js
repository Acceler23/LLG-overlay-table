// overlay/shared/gforce.js
// Aceleracao longitudinal e forca G lateral do carro em foco (overlay/g-force.html).
//
// De onde vem o dado, nesta ordem:
//  1. entry.localAccel: aceleracao real de cada carro (LMU, listener-lmu.ps1), no formato do rFactor 2.
//  2. data.car.localAccel: telemetria completa de UM carro so (AMS2, listener.ps1). Quem transmite costuma
//     estar parado, ou olhando outro carro, entao so vale quando a velocidade dela bate com a do carro em
//     foco (sameCar).
//  3. Estimativa, de qualquer carro e de qualquer jogo: com velocidade e posicao (speedMs, worldX, worldZ)
//     de ~10 leituras por segundo. Longitudinal = inclinacao da velocidade numa janela curta; lateral =
//     velocidade x taxa de giro do rumo. Conferida contra a telemetria real do AMS2 (Audi R8 no Spielberg e
//     Cruze em Velocitta, dados degradados para 10 Hz e posicao de 0,1 m): correlacao 0,88 (longitudinal) e
//     0,94 (lateral), erro tipico de 0,25 a 0,33 g. Sem posicao (Assetto Corsa), so a longitudinal.
// Os dados reais (1 e 2) sao conferidos contra a estimativa: se divergirem por alguns segundos (offset errado,
// eixo trocado), a overlay usa a estimativa ate voltarem a concordar.
//
// Convencao dos valores: latG positivo = para a DIREITA; longG positivo = acelerando (negativo = freando).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LLGGForce = api;
})(typeof self !== "undefined" ? self : this, function () {
  const G = 9.81;
  const WINDOW_MS = 600; // janela da regressao
  const MIN_POINTS = 5; // leituras na janela para a longitudinal valer
  const MIN_HEADINGS = 3; // rumos na janela para a lateral valer
  const MIN_STEP_M = 3; // o rumo so vale entre pontos afastados (a posicao tem 0,1 m de resolucao)
  const MIN_LAT_SPEED_MS = 8; // abaixo disso (~29 km/h) o rumo e so ruido
  const GAP_MS = 1000; // buraco maior que isso entre leituras: recomeca
  const MAX_G = 6; // acima disso e erro de leitura
  const SAME_CAR_MIN_TOL_MS = 2;
  const SAME_CAR_TOL_FRACTION = 0.12;
  // conferencia do dado real contra a estimativa
  const CHECK_MIN_SPEED_MS = 15;
  const CHECK_TAU_MS = 3000;
  const CHECK_MIN_MS = 1500; // tempo conferindo antes de decidir
  const DISTRUST_ABOVE_G = 0.5;
  const RETRUST_BELOW_G = 0.4;
  // Lado em que o rumo (atan2(dx, dz)) cresce, por jogo. Nos jogos de mundo "left-handed" (AMS2, LMU) crescer
  // e virar para a direita. AMS2 conferido em voltas gravadas; LMU pelo InternalsPlugin.hpp; ACC e AC ainda
  // nao conferidos: se a bolinha for para o lado errado, use ?flip=acc na URL da overlay.
  const LAT_SIGN = { ams2: 1, lmu: 1, acc: 1, ac: 1 };

  const finite = (n) => typeof n === "number" && Number.isFinite(n);
  const clampG = (g) => Math.max(-MAX_G, Math.min(MAX_G, g));

  // Inclinacao da reta que melhor passa por (ts, ys), minimos quadrados
  function slope(ts, ys) {
    const n = ts.length;
    let mt = 0;
    let my = 0;
    for (let i = 0; i < n; i++) {
      mt += ts[i];
      my += ys[i];
    }
    mt /= n;
    my /= n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const dt = ts[i] - mt;
      num += dt * (ys[i] - my);
      den += dt * dt;
    }
    return den > 0 ? num / den : 0;
  }

  // Angulos sem o salto de 2 pi (o rumo passa de +pi para -pi ao cruzar o Sul)
  function unwrap(angles) {
    const out = [angles[0]];
    for (let i = 1; i < angles.length; i++) {
      let d = angles[i] - angles[i - 1];
      d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      out.push(out[i - 1] + d);
    }
    return out;
  }

  // A telemetria do jogo e do carro em foco? Compara a velocidade dela com a da lista de carros.
  function sameCar(car, entry) {
    if (!car || !entry || !finite(car.speedMs) || !finite(entry.speedMs)) return false;
    const tol = Math.max(SAME_CAR_MIN_TOL_MS, SAME_CAR_TOL_FRACTION * entry.speedMs);
    return Math.abs(car.speedMs - entry.speedMs) <= tol;
  }

  // localAccel = [x lateral, y vertical, z longitudinal] em m/s2. AMS2 (Project CARS 2) e LMU (rFactor 2)
  // concordam: x negativo e para a direita (AMS2 conferido contra o volante e o rumo em voltas gravadas; LMU: +x
  // sai pela esquerda do carro) e z positivo e para tras (aceleracao para a frente e negativa), entao os
  // dois sinais sao invertidos aqui.
  function fromLocalAccel(localAccel) {
    if (!Array.isArray(localAccel) || localAccel.length < 3) return null;
    const ax = localAccel[0];
    const az = localAccel[2];
    if (!finite(ax) || !finite(az)) return null;
    return { latG: clampG(-ax / G), longG: clampG(-az / G) };
  }

  // Estimativa por carro: s = { name, t (ms), v (m/s), x, z }. Chame em ordem de tempo.
  function createEstimator(options) {
    const latSign = (options && options.latSign) || 1;
    let name = null;
    let hist = [];
    let result = null;

    function hasPos(s) {
      return finite(s.x) && finite(s.z) && !(s.x === 0 && s.z === 0);
    }

    function compute(s) {
      if (hist.length < MIN_POINTS) return null;
      const t0 = hist[0].t;
      const ts = hist.map((h) => (h.t - t0) / 1000);
      const out = { longG: clampG(slope(ts, hist.map((h) => h.v)) / G), latG: null };
      if (s.v >= MIN_LAT_SPEED_MS && hist.every(hasPos)) {
        const angles = [];
        const at = [];
        for (let k = 0; k + 2 < hist.length; k++) {
          const dx = hist[k + 2].x - hist[k].x;
          const dz = hist[k + 2].z - hist[k].z;
          if (Math.hypot(dx, dz) >= MIN_STEP_M) {
            angles.push(Math.atan2(dx, dz)); // rumo medido de +z para +x
            at.push(ts[k + 1]);
          }
        }
        if (angles.length >= MIN_HEADINGS) out.latG = clampG((latSign * s.v * slope(at, unwrap(angles))) / G);
      }
      return out;
    }

    function push(s) {
      if (!s || !finite(s.t) || !finite(s.v)) return result;
      if (s.name !== name) {
        name = s.name;
        hist = [];
        result = null;
      }
      const last = hist[hist.length - 1];
      if (last) {
        if (s.t <= last.t) return result; // leitura repetida
        const dt = (s.t - last.t) / 1000;
        const jump = hasPos(s) && hasPos(last) ? Math.hypot(s.x - last.x, s.z - last.z) : 0;
        // buraco, teletransporte (volta ao box, troca de camera) ou salto de posicao: recomeca
        if (s.t - last.t > GAP_MS || jump > Math.max(s.v, last.v) * dt * 1.5 + 6) {
          hist = [];
          result = null;
        }
      }
      hist.push(s);
      // janela de WINDOW_MS, mas nunca com menos de MIN_POINTS + 1 leituras (jogos que atualizam devagar)
      while (hist.length > MIN_POINTS + 1 && hist[0].t < s.t - WINDOW_MS) hist.shift();
      result = compute(s);
      return result;
    }

    return { push };
  }

  // Media exponencial pelo tempo (nao pelo numero de leituras). value null = sem dado.
  function createSmoother(tauMs) {
    let value = null;
    let at = null;
    return {
      push(v, t) {
        if (!finite(v)) return value;
        if (value === null || t - at > GAP_MS) value = v;
        else value += (v - value) * (1 - Math.exp(-(t - at) / tauMs));
        at = t;
        return value;
      },
      reset() {
        value = null;
        at = null;
      },
    };
  }

  // Maiores valores dos ultimos holdMs: lateral (modulo), freada e aceleracao
  function createPeaks(holdMs) {
    let items = [];
    return {
      push(t, latG, longG) {
        items.push({ t, lat: finite(latG) ? Math.abs(latG) : 0, brake: finite(longG) ? Math.max(0, -longG) : 0, accel: finite(longG) ? Math.max(0, longG) : 0 });
        items = items.filter((i) => i.t >= t - holdMs);
        return this.get();
      },
      get() {
        return items.reduce((p, i) => ({ lat: Math.max(p.lat, i.lat), brake: Math.max(p.brake, i.brake), accel: Math.max(p.accel, i.accel) }), { lat: 0, brake: 0, accel: 0 });
      },
      reset() {
        items = [];
      },
    };
  }

  // Confere o dado real contra a estimativa: a media (suavizada) da diferenca em g decide se ele vale.
  // Comeca valendo; so desconfia depois de CHECK_MIN_MS conferindo, e volta a valer com folga (histerese).
  function createCheck() {
    let err = null;
    let at = null;
    let observedMs = 0;
    let ok = true;
    return {
      push(real, est, speedMs, t) {
        if (!real || !est || !(speedMs >= CHECK_MIN_SPEED_MS)) return ok;
        const diffs = [Math.abs(real.longG - est.longG)];
        if (finite(real.latG) && finite(est.latG)) diffs.push(Math.abs(real.latG - est.latG));
        const e = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        if (err === null || t - at > GAP_MS) err = e;
        else {
          const dt = t - at;
          err += (e - err) * (1 - Math.exp(-dt / CHECK_TAU_MS));
          observedMs += dt;
        }
        at = t;
        if (observedMs >= CHECK_MIN_MS) {
          if (ok && err > DISTRUST_ABOVE_G) ok = false;
          else if (!ok && err < RETRUST_BELOW_G) ok = true;
        }
        return ok;
      },
      get ok() {
        return ok;
      },
    };
  }

  // Pedais do carro em foco, para as luzes de acelerador e freio: { throttle, brake (0 a 1), source }.
  //  - LMU: cada carro tem os pedais reais (entry.throttle/brake).
  //  - AMS2: so o carro do proprio jogador (data.car), e so quando e ele que esta em foco (sameCar).
  //  - Fora disso, deduzidos da aceleracao: desacelerando mais que o arrasto de tirar o pe e freio,
  //    ganhando velocidade e acelerador; no meio (tirou o pe, ou reta no limite) as duas apagadas.
  const PEDAL_ON = 0.05;
  const BRAKE_FROM_G = -0.35; // tirar o pe a 250 km/h desacelera ~0,2-0,3 g so com o arrasto
  const THROTTLE_FROM_G = 0.03;
  function pedalsFor(entry, car, longG) {
    const p = (v) => (finite(v) ? Math.max(0, Math.min(1, v)) : null);
    if (entry && finite(entry.throttle) && finite(entry.brake)) {
      return { throttle: p(entry.throttle), brake: p(entry.brake), source: "telemetry" };
    }
    if (car && finite(car.throttle) && finite(car.brake) && sameCar(car, entry)) {
      return { throttle: p(car.throttle), brake: p(car.brake), source: "telemetry" };
    }
    if (!finite(longG)) return { throttle: null, brake: null, source: "estimated" };
    const brake = longG <= BRAKE_FROM_G ? Math.min(1, 0.4 + (BRAKE_FROM_G - longG) / 1.2) : 0;
    const throttle = !brake && longG >= THROTTLE_FROM_G ? Math.min(1, 0.6 + longG / 0.6) : 0;
    return { throttle, brake, source: "estimated" };
  }

  // Tudo junto: recebe o payload "standings" do servidor e devolve o que a overlay desenha, ou null se ninguem
  // esta em foco. { name, source, latG, longG, speedKmh, peaks, entry }; latG/longG null = sem dado.
  // options: { smoothMs, peakHoldMs, flip: ["acc", ...] (jogos com o lado da lateral trocado) }
  function createTracker(options) {
    const opts = options || {};
    const flip = new Set((opts.flip || []).map((g) => String(g).toLowerCase()));
    const estimators = {};
    const smoothLat = createSmoother(opts.smoothMs || 120);
    const smoothLong = createSmoother(opts.smoothMs || 120);
    const peaks = createPeaks(opts.peakHoldMs || 10000);
    let check = createCheck();
    let focus = null;

    function estimatorFor(game) {
      if (!estimators[game]) {
        const sign = (LAT_SIGN[game] || 1) * (flip.has(game) ? -1 : 1);
        estimators[game] = createEstimator({ latSign: sign });
      }
      return estimators[game];
    }

    function update(data, nowMs) {
      const list = data && Array.isArray(data.standings) ? data.standings : [];
      const entry = list.find((e) => e && e.isPlayer);
      if (!entry) return null;
      if (entry.name !== focus) {
        focus = entry.name;
        smoothLat.reset();
        smoothLong.reset();
        peaks.reset();
        check = createCheck();
      }
      const t = finite(data.ts) ? data.ts : nowMs;
      const game = String((data && data.game) || "ams2").toLowerCase();
      // a estimativa roda sempre: confere o dado real e cobre quando ele nao vale
      const estimated = estimatorFor(game).push({ name: entry.name, t, v: entry.speedMs, x: entry.worldX, z: entry.worldZ });
      const real = fromLocalAccel(entry.localAccel) || (sameCar(data.car, entry) ? fromLocalAccel(data.car.localAccel) : null);
      const useReal = !!real && check.push(real, estimated, entry.speedMs, t);
      const raw = (useReal && real) || estimated || { latG: null, longG: null };
      const latG = smoothLat.push(raw.latG, t);
      const longG = smoothLong.push(raw.longG, t);
      return {
        name: entry.name,
        source: useReal ? "telemetry" : "estimated",
        latG: raw.latG === null ? null : latG,
        longG: raw.longG === null ? null : longG,
        pedals: pedalsFor(entry, data.car, raw.longG === null ? null : longG),
        speedKmh: finite(entry.speedMs) ? entry.speedMs * 3.6 : null,
        peaks: peaks.push(t, latG, longG),
        entry,
      };
    }

    return { update };
  }

  return { G, PEDAL_ON, pedalsFor, sameCar, fromLocalAccel, createEstimator, createSmoother, createPeaks, createCheck, createTracker };
});
