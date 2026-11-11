// server/sessionHold.js
//
// Da classificacao para a corrida, o jogo passa por um carregamento: a lista de
// carros vem vazia (a tabela some), incompleta (o AMS2 descarta carros com
// estado invalido na corrida) ou fora de ordem ate a corrida "pegar". Nesse
// meio tempo as overlays continuam recebendo o ultimo retrato da
// classificacao, com as posicoes dela, e so passam para a corrida quando ela
// chega de verdade:
//   - pelo menos metade dos carros da classificacao, todos com posicao valida
// Vale so para a mesma pista e o mesmo jogo, e dura no maximo HOLD_MAX_MS (se a
// corrida nao comecar, por exemplo saiu para o menu, a tabela volta ao normal).
// So o que vai para as overlays e segurado: mapa, log e engenheiro usam os
// dados reais.
//
// Volta de formacao: os carros andam embaralhados e o jogo pode ir trocando as
// posicoes. Enquanto ela dura, as overlays recebem os dados ao vivo, mas com
// as posicoes do GRID (a ordem do primeiro pacote da volta de formacao, que e
// o grid do jogo: pode ser diferente da classificacao, com punicao ou grid
// invertido). Na bandeira verde (corrida), volta a valer a posicao do jogo.
// Carro que entra no meio da formacao vai para o fim, depois do grid.

const HOLD_MAX_MS = 3 * 60 * 1000;
const QUALI = 3;
const FORMATION = 4;
const RACE = 5;

function createSessionHold({ now = Date.now, maxMs = HOLD_MAX_MS } = {}) {
  let quali = null; // { data, cars, track }
  let holdSince = 0;
  let grid = null; // nome -> posicao no grid, durante a volta de formacao

  const trackOf = (data) => `${data.game || ""}|${(data.session && data.session.trackLocation) || ""}|${(data.session && data.session.trackVariation) || ""}`;

  function release(data) {
    quali = null;
    holdSince = 0;
    return data;
  }

  // Volta de formacao: os mesmos dados, com as posicoes do grid
  function gridOrder(data) {
    const list = Array.isArray(data.standings) ? data.standings : [];
    if (!grid) grid = new Map(list.filter((e) => e && e.name && Number(e.position) > 0).map((e) => [e.name, Number(e.position)]));
    const pos = (e) => (grid.has(e.name) ? grid.get(e.name) : grid.size + (Number(e.position) || 999));
    const standings = list
      .map((e) => Object.assign({}, e, { position: pos(e), gamePosition: e.position }))
      .sort((a, b) => a.position - b.position)
      .map((e, i) => Object.assign(e, { position: i + 1 })); // sem buracos (carro que saiu)
    return Object.assign({}, data, { standings, session: Object.assign({}, data.session, { gridOrder: true }) });
  }

  // Recebe o payload pronto do jogo e devolve o que as overlays devem ver
  function apply(data) {
    if (!data || !data.session) return data;
    const out = applyHold(data);
    // volta de formacao (depois da passagem da quali, se houve): ordem do grid
    if (out === data && Number(data.session.state) === FORMATION && Array.isArray(data.standings) && data.standings.length) return gridOrder(data);
    if (out === data && Number(data.session.state) !== FORMATION) grid = null; // largou (ou outra sessao)
    return out;
  }

  function applyHold(data) {
    const state = Number(data.session.state);
    const list = Array.isArray(data.standings) ? data.standings : [];
    const cars = list.length;

    // classificacao com carros: o retrato que fica guardado
    if (state === QUALI && cars) {
      quali = { data, cars, track: trackOf(data) };
      holdSince = 0;
      return data;
    }
    if (!quali) return data;

    const raceNow = state === RACE || state === FORMATION;
    const loading = !cars; // entre uma sessao e outra (menu, carregando)
    if (!raceNow && !loading) return release(data); // foi para outra sessao (treino, outra classificacao vazia...)
    if (cars && trackOf(data) !== quali.track) return release(data); // outra pista ou outro jogo

    if (raceNow) {
      const ready = cars >= Math.max(1, Math.ceil(quali.cars / 2)) && list.every((e) => e && Number(e.position) > 0);
      if (ready) return release(data);
    }
    if (!holdSince) holdSince = now();
    if (now() - holdSince > maxMs) return release(data);

    // ainda carregando: o retrato da classificacao, marcado
    return Object.assign({}, quali.data, {
      ts: now(),
      session: Object.assign({}, quali.data.session, { holdingForRace: true }),
    });
  }

  return { apply, isHolding: () => !!holdSince };
}

module.exports = { createSessionHold, HOLD_MAX_MS };
