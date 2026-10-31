// server/lmuIdentity.js
// Numero e equipe de cada carro no Le Mans Ultimate.
// A Shared Memory do LMU tira os dois do nome do veiculo ("BMW M Team WRT
// 2026 #15:LM"). Com pintura nao oficial esse nome e generico ("Lexus Custom
// Team 2026 #397"): todo carro assim aparecia como #397 "Custom Team". O
// numero e a equipe de verdade so vem na API local do jogo
// (GET /rest/watch/standings: carNumber e fullTeamName de cada slot). Este
// modulo consulta essa API enquanto o LMU for o jogo ativo e troca os dois
// em cada carro do payload.

const PORT = process.env.LMU_API_PORT || 6397;
const URL = `http://127.0.0.1:${PORT}/rest/watch/standings`;
const POLL_MS = 2000;
const IDLE_AFTER_MS = 5000; // sem dados do LMU por esse tempo: para de consultar
const STALE_AFTER_MS = 15000; // resposta mais velha que isso nao e usada

let timer = null;
let lastWantedAt = 0;
let bySlot = new Map(); // slot -> { driverName, carNumber, teamName }
let fetchedAt = 0;
let busy = false;

const clean = (s) => String(s == null ? "" : s).trim();
// nome para comparar: sem os caracteres invisiveis de nomes repetidos e sem o
// codigo da conta do online do LMU ("Felipe Antunes#1005")
const baseName = (s) => clean(s).replace(/​+$/, "").replace(/\s*#\d+\s*$/, "");

// Lista da API -> mapa por slot (so com o que tiver numero ou equipe)
function indexStandings(list) {
  const map = new Map();
  (Array.isArray(list) ? list : []).forEach((c) => {
    const slot = Number(c && c.slotID);
    if (!Number.isInteger(slot)) return;
    const carNumber = clean(c.carNumber);
    const teamName = clean(c.fullTeamName);
    if (!carNumber && !teamName) return;
    map.set(slot, { driverName: clean(c.driverName), carNumber, teamName });
  });
  return map;
}

// Troca numero e equipe de cada carro pelo que a API do jogo informa. So
// quando o slot e o piloto batem (slot reaproveitado por outro piloto: nao troca).
function mergeIdentity(standings, map) {
  (standings || []).forEach((e) => {
    const info = map.get(e.slot);
    if (!info) return;
    if (info.driverName && baseName(e.name) !== baseName(info.driverName)) return;
    if (info.carNumber) e.carNumber = info.carNumber;
    if (info.teamName) e.teamName = info.teamName;
  });
  return standings;
}

async function poll() {
  if (Date.now() - lastWantedAt > IDLE_AFTER_MS) {
    clearInterval(timer);
    timer = null;
    return;
  }
  if (busy) return;
  busy = true;
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      bySlot = indexStandings(await res.json());
      fetchedAt = Date.now();
    }
  } catch (_) {
    // jogo fechando ou API indisponivel: fica com o que a Shared Memory disser
  } finally {
    busy = false;
  }
}

function apply(payload) {
  lastWantedAt = Date.now();
  if (!timer) {
    timer = setInterval(poll, POLL_MS);
    poll();
  }
  if (!bySlot.size || Date.now() - fetchedAt > STALE_AFTER_MS) return payload;
  mergeIdentity(payload && payload.standings, bySlot);
  return payload;
}

module.exports = { apply, indexStandings, mergeIdentity };
