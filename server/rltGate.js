// server/rltGate.js
//
// RLT so em sessao da liga. Com temporada aplicada, os nomes, equipes,
// classes e pontos do RLT so vao para as overlays numa sessao multijogador.
// Offline (contra a IA, treino sozinho) elas mostram so os dados do jogo.
//   LMU: o jogo informa (session.online, do mGameMode da Shared Memory).
//   AMS2, ACC e AC nao informam: vale ter pelo menos minLinked pilotos na
//   pista ligados ao lineup da temporada (offline a IA nao bate ninguem).
// Fora de sessao (jogo no menu, sem carros) a decisao anterior continua, para
// nao piscar entre uma sessao e outra.
//
//   hasSeason():   ha temporada aplicada?
//   linkedCount(): pilotos da sessao ligados ao lineup
//   onChange(live, why): chamado quando a decisao muda

function createRltGate({ hasSeason, linkedCount, onChange, minLinked = 2 }) {
  let live = false;
  let gameOnline = null; // true/false quando o jogo informa; null quando nao informa
  let cars = 0;

  function compute() {
    if (!hasSeason()) return false;
    if (!cars) return live;
    if (typeof gameOnline === "boolean") return gameOnline;
    return linkedCount() >= minLinked;
  }

  function why() {
    return typeof gameOnline === "boolean" ? (gameOnline ? "o jogo informa sessao online" : "o jogo informa sessao offline") : `${linkedCount()} pilotos do lineup na pista`;
  }

  // reavalia (temporada aplicada, lineup ligado, sessao nova)
  function refresh() {
    const next = compute();
    if (next === live) return;
    live = next;
    if (onChange) onChange(live, why());
  }

  // a cada pacote do jogo: quantos carros e se o jogo informa sessao online
  function noteSession(data) {
    const n = data && Array.isArray(data.standings) ? data.standings.length : 0;
    const online = data && data.session && typeof data.session.online === "boolean" ? data.session.online : null;
    if (n === cars && (n === 0 || online === gameOnline)) return;
    cars = n;
    if (n) gameOnline = online;
    refresh();
  }

  return { refresh, noteSession, isLive: () => live };
}

module.exports = { createRltGate };
