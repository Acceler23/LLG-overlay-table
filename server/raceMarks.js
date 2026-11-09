// server/raceMarks.js
//
// Marcadores da direcao de prova: quem queimou o FCY e quem ultrapassou com
// SC/FCY. Diferente das infracoes da sessao (que zeram a cada sessao), o
// marcador fica na linha do piloto ate:
//   - a direcao limpar no botao (um piloto ou todos), ou
//   - o piloto receber um drive-through (o jogo informa o tipo da punicao:
//     entry.penaltyType, do listener do LMU). Um DT novo limpa os marcadores
//     dele: a infracao foi punida.
// Ficam salvos (settings "lmuMarks"), entao sobrevivem a troca de sessao e a
// reiniciar o aplicativo.
//
//   settings: { get, set }   now: () => ms

const MAX_PER_DRIVER = 50; // nenhuma lista cresce sem fim

function createRaceMarks({ settings, now = Date.now }) {
  // nome -> { fcy: [{ fcy, at }], passes: [{ passed, under, countdown, at }] }
  const marks = new Map(Object.entries((settings && settings.get("lmuMarks")) || {}));
  const lastType = new Map(); // nome -> tipo da punicao pendente na ultima leitura
  let lastPassAt = 0; // ultima ultrapassagem ja marcada (a lista do jogo e refeita a cada leitura)

  const save = () => settings && settings.set("lmuMarks", marks.size ? Object.fromEntries(marks) : null);
  const of = (name) => {
    if (!marks.has(name)) marks.set(name, { fcy: [], passes: [] });
    return marks.get(name);
  };
  const cap = (list) => (list.length > MAX_PER_DRIVER ? list.slice(-MAX_PER_DRIVER) : list);

  // um trecho acima do limite no FCY, ja fechado
  function addFcy(breach) {
    if (!breach || !breach.name) return;
    const m = of(breach.name);
    m.fcy = cap(m.fcy.concat({ fcy: breach.fcy, at: breach.at || now() }));
    save();
  }

  // ultrapassagens com SC/FCY (lista do incidents.status(), qualquer ordem):
  // marca so as novas e nao as de retardatario liberado
  function addPasses(overtakes) {
    let changed = false;
    let newest = lastPassAt;
    (overtakes || []).forEach((o) => {
      if (!o || !o.passer || !(o.at > lastPassAt)) return;
      newest = Math.max(newest, o.at);
      if (o.allowed) return;
      const m = of(o.passer);
      m.passes = cap(m.passes.concat({ passed: o.passed, under: o.under, countdown: !!o.countdown, at: o.at }));
      changed = true;
    });
    lastPassAt = newest;
    if (changed) save();
  }

  // a cada leitura do jogo: quem acabou de receber um drive-through perde os marcadores
  function noteStandings(standings) {
    let changed = false;
    (standings || []).forEach((e) => {
      if (!e || !e.name) return;
      const type = e.penaltyType || null;
      const before = lastType.has(e.name) ? lastType.get(e.name) : null;
      lastType.set(e.name, type);
      if (type === "driveThrough" && before !== "driveThrough" && marks.has(e.name)) {
        marks.delete(e.name);
        changed = true;
      }
    });
    if (changed) save();
  }

  // limpar no botao: um piloto, ou todos (sem nome)
  function clear(name) {
    if (name) marks.delete(String(name));
    else marks.clear();
    save();
  }

  function list() {
    return [...marks.entries()]
      .filter(([, m]) => m.fcy.length || m.passes.length)
      .map(([name, m]) => ({ name, fcy: m.fcy.slice(), passes: m.passes.slice() }));
  }

  return { addFcy, addPasses, noteStandings, clear, list };
}

module.exports = { createRaceMarks };
