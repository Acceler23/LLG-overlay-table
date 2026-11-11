// server/gameProfiles.js
//
// Opacidades por jogo. Cada jogo guarda as suas: no AMS2 a tabela a 100%, no
// LMU a 50%, e ao trocar de jogo o aplicativo aplica as daquele jogo sozinho.
//   transmissao (overlays do OBS, comando overlay.setOpacity):
//     table  fundo da tabela      rows  linhas da tabela      map  mapa
//   pilotar (janelas por cima do jogo, app/main.js):
//     tabela, telemetria, gforce
// Salvo no settings.json ("opacityByGame"). Jogo ainda sem nada salvo: nada
// muda ao trocar para ele (valem as que estao na tela) ate ajustar.
//   settings: { get, set }

const BROADCAST = ["table", "rows", "map"];
const PILOT = ["tabela", "telemetria", "gforce"];

const clamp = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
};

function createGameProfiles(settings) {
  const all = Object.assign({}, (settings && settings.get("opacityByGame")) || {});
  const save = () => settings && settings.set("opacityByGame", Object.keys(all).length ? all : null);
  const of = (game) => {
    if (!all[game]) all[game] = { broadcast: {}, pilot: {} };
    return all[game];
  };

  // valor que acabou de ser escolhido no painel, para o jogo ativo
  function noteBroadcast(game, target, value) {
    const v = clamp(value);
    if (!game || !BROADCAST.includes(target) || v == null) return false;
    of(game).broadcast[target] = v;
    save();
    return true;
  }

  function notePilot(game, id, value) {
    const v = clamp(value);
    if (!game || !PILOT.includes(id) || v == null) return false;
    of(game).pilot[id] = v;
    save();
    return true;
  }

  // { broadcast: { table?, rows?, map? }, pilot: { tabela?, ... } } ou null (nada salvo)
  function get(game) {
    const p = game && all[game];
    if (!p) return null;
    return { broadcast: Object.assign({}, p.broadcast), pilot: Object.assign({}, p.pilot) };
  }

  return { noteBroadcast, notePilot, get };
}

module.exports = { createGameProfiles, BROADCAST, PILOT };
