// server/demo.js
//
// Dados de exemplo para o "Editar na tela" do piloto: 30 s de uma corrida de Stock Car em
// Curitiba (gravada pelo Cubic Racing Analyser, nomes anonimizados: "Piloto 01"... e "Você"),
// em loop. Assim o piloto posiciona e dimensiona as overlays com elas mostrando algo de
// verdade, mesmo com o jogo fechado ou no menu.
//
// So toca enquanto o modo de edicao esta ligado E nenhum jogo esta mandando carros: com o
// jogo em sessao, valem os dados reais. Vai em mensagens proprias ("demo" e "demoTel"), que so
// as overlays do piloto em edicao usam: as do OBS ignoram, entao nunca aparece numa transmissao.
//
// O arquivo (server/demo/curitiba-stockcar.json.gz) e gerado por
//   node tools/replay-sessao.js <pasta da sessao> --demo=server/demo/curitiba-stockcar.json.gz --inicio=600 --dur=30

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const FILE = path.join(__dirname, "demo", "curitiba-stockcar.json.gz");
const TICK_MS = 33; // pedais e forca G: ~30x por segundo, como o pacote rapido do AMS2

function createDemo(opts) {
  const broadcast = opts.broadcast;
  const isLive = opts.isLive || (() => false);
  let data = null;
  let timer = null;
  let startedAt = 0;
  let lastFrame = -1;

  // relido a cada vez que a edicao liga (~120 KB): um arquivo de exemplo novo vale sem reiniciar
  function load() {
    try {
      data = JSON.parse(zlib.gunzipSync(fs.readFileSync(opts.file || FILE)).toString("utf8"));
    } catch (err) {
      console.warn("Dados de exemplo indisponiveis:", err.message);
      data = null;
    }
    return data;
  }

  // distancia de cada carro, 5x por segundo: os 60 s antes do trecho (data.hist) + o trecho ate o
  // quadro i. A ultima linha e o quadro de agora.
  function histUpTo(i) {
    const h = data.hist;
    if (!h || !Array.isArray(h.d)) return null;
    const step = Math.max(1, Math.round(data.hz / h.hz));
    const iName = data.cols.indexOf("name");
    const iDist = data.cols.indexOf("totalDistance");
    const d = h.d.slice();
    for (let k = i % step; k <= i; k += step) {
      const byName = new Map(data.frames[k].s.map((r) => [r[iName], r[iDist]]));
      d.push(h.names.map((nm) => (byName.has(nm) ? byName.get(nm) : null)));
    }
    return { hz: h.hz, names: h.names, d };
  }

  function entry(row) {
    const e = {};
    data.cols.forEach((c, i) => (e[c] = row[i]));
    e.inRace = true;
    return e;
  }

  function tick() {
    if (!data || isLive()) return;
    const n = data.frames.length;
    const pos = ((Date.now() - startedAt) / 1000) * data.hz;
    const loop = Math.floor(pos / n);
    const i = Math.floor(pos) % n;
    const j = (i + 1) % n;
    const f = pos - Math.floor(pos);
    const a = data.frames[i].car;
    const b = data.frames[j].car;
    const mix = (k) => (a[k] == null ? null : b[k] == null ? a[k] : a[k] + (b[k] - a[k]) * f);
    // pedais e forca G, entre um quadro e outro
    broadcast({ type: "demoTel", data: { thr: mix(0), brk: mix(1), str: mix(2), spd: mix(3), ax: mix(4), az: mix(5) } });
    if (i === lastFrame) return;
    const wrapped = lastFrame < 0 || i < lastFrame; // comeco do exemplo ou de mais uma volta do loop
    lastFrame = i;
    // historico dos intervalos: no comeco de cada volta do loop e a cada 3 s (para quem abriu no meio)
    const sendHist = wrapped || i % (data.hz * 3) === 0;
    const standings = data.frames[i].s.map(entry);
    const me = standings.find((e) => e.isPlayer);
    if (me && a[6] != null) me.fuelL = a[6];
    broadcast({
      type: "demo",
      data: {
        game: "ams2",
        demoLoop: loop, // a cada volta do loop o tempo "volta para tras": as overlays zeram os intervalos
        // ...e recebem os 60 s antes do trecho (distancia de cada carro), para os intervalos ja
        // aparecerem cheios em vez de "–" ate juntar historico
        hist: sendHist ? histUpTo(i) : undefined,
        session: data.session,
        standings,
        car: { throttle: a[0], brake: a[1], steering: a[2], speedMs: a[3], localAccel: [a[4], 0, a[5]] },
        ts: Date.now(),
      },
    });
  }

  function setActive(on) {
    if (on && !timer) {
      if (!load()) return;
      startedAt = Date.now();
      lastFrame = -1;
      timer = setInterval(tick, TICK_MS);
      if (timer.unref) timer.unref();
    } else if (!on && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { setActive, active: () => !!timer };
}

module.exports = { createDemo };
