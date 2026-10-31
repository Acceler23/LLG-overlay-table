// server/lmuIncidents.js
// Incidentes do proprio LMU e o replay, pela API local do jogo.
// - GET /rest/watch/getIncidentsList/{s}: [{ player, contactWith, et }], com
//   contactWith "Immovable" para muro. A lista nao traz a forca: ela vem da
//   telemetria de cada carro (mLastImpactET e mLastImpactMagnitude, so o ultimo
//   impacto; listener-lmu.ps1 manda como lastImpactEt e lastImpactMag). Este
//   modulo guarda cada impacto visto e casa com o incidente pelo tempo. Batida
//   anterior ao app abrir, ou ja coberta por outra do mesmo carro: sem forca.
// - Replay: POST /rest/replay/toggleactive e PUT /rest/watch/replaytime/{t}.
//   POST e PUT precisam de corpo (mesmo vazio): sem Content-Length o servidor
//   do jogo fica esperando e nao responde.

const PORT = process.env.LMU_API_PORT || 6397;
const BASE = `http://127.0.0.1:${PORT}`;
const MIN_GAP_S = 5; // contatos do mesmo carro mais perto que isso viram um so (parametro do jogo)
const MATCH_S = 1; // incidente e impacto a ate 1 s: e a mesma batida
const MAX_IMPACTS = 30; // por carro
const PREROLL_S = 5; // o replay comeca um pouco antes do momento
const ACTIVE_WAIT_MS = 3000;
const TIMEOUT_MS = 2000;

const WALL = "Immovable";
// sem o codigo da conta do online ("Felipe Antunes#1005")
const baseName = (s) => String(s == null ? "" : s).replace(/\s*#\d+\s*$/, "").trim();

function createGameIncidents(opts = {}) {
  const request = opts.fetch || fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const impacts = new Map(); // nome -> [{ et, mag }]
  let raw = [];
  let replayActive = false;

  function reset() {
    impacts.clear();
    raw = [];
  }

  // dados do LMU: guarda cada impacto novo de cada carro
  function apply(payload) {
    ((payload && payload.standings) || []).forEach((e) => {
      if (!e || !e.name || !(e.lastImpactEt > 0)) return;
      const list = impacts.get(e.name) || [];
      if (list.length && list[list.length - 1].et === e.lastImpactEt) return;
      list.push({ et: e.lastImpactEt, mag: Number(e.lastImpactMag) || 0 });
      if (list.length > MAX_IMPACTS) list.shift();
      impacts.set(e.name, list);
    });
  }

  function forceOf(et, names) {
    let best = null;
    names.forEach((n) => {
      (impacts.get(n) || []).forEach((i) => {
        if (Math.abs(i.et - et) <= MATCH_S && (best == null || i.mag > best)) best = i.mag;
      });
    });
    return best;
  }

  // mais recentes primeiro
  function list() {
    return raw
      .map((c) => {
        const player = baseName(c.player);
        const wall = c.contactWith === WALL;
        const other = wall ? null : baseName(c.contactWith);
        return { et: c.et, player, contactWith: other, wall, force: forceOf(c.et, other ? [player, other] : [player]) };
      })
      .sort((a, b) => b.et - a.et);
  }

  async function poll() {
    try {
      const res = await request(`${BASE}/rest/watch/getIncidentsList/${MIN_GAP_S}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const body = await res.json();
        if (Array.isArray(body)) raw = body.filter((c) => c && typeof c.et === "number");
      }
      const active = await request(`${BASE}/rest/replay/isActive`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (active.ok) replayActive = (await active.text()).trim() === "true";
    } catch (_) {
      // jogo fechando ou API indisponivel: fica o que ja tinha
    }
  }

  async function command(method, path) {
    const res = await request(`${BASE}${path}`, { method, body: "", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`O jogo respondeu HTTP ${res.status}`);
  }

  async function readActive() {
    const res = await request(`${BASE}/rest/replay/isActive`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`O jogo respondeu HTTP ${res.status}`);
    replayActive = (await res.text()).trim() === "true";
    return replayActive;
  }

  // Liga o replay, se precisar, e vai para pouco antes do momento
  async function jump(et) {
    if (!(await readActive())) {
      await command("POST", "/rest/replay/toggleactive");
      const until = Date.now() + ACTIVE_WAIT_MS;
      while (!(await readActive()) && Date.now() < until) await sleep(100);
      if (!replayActive) throw new Error("O jogo não entrou no replay");
    }
    await command("PUT", `/rest/watch/replaytime/${Math.max(0, et - PREROLL_S).toFixed(2)}`);
  }

  // Volta para o ao vivo
  async function exit() {
    if (await readActive()) {
      await command("POST", "/rest/replay/toggleactive");
      replayActive = false;
    }
  }

  return { apply, poll, list, reset, jump, exit, isReplayActive: () => replayActive };
}

module.exports = { createGameIncidents, PREROLL_S };
