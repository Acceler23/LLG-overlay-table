const test = require("node:test");
const assert = require("node:assert/strict");
const { createSessionHold } = require("../server/sessionHold");

const names = ["A", "B", "C", "D", "E", "F"];
function payload(state, order, extra) {
  return Object.assign({ game: "ams2", session: { state, trackLocation: "Velopark", trackVariation: "" }, standings: order.map((n, i) => ({ name: n, position: i + 1 })) }, extra);
}
const order = (p) => p.standings.map((e) => e.name).join("");

function setup() {
  const clock = { t: 0 };
  return { clock, hold: createSessionHold({ now: () => clock.t, maxMs: 60000 }) };
}

test("classificacao -> carregando -> corrida: segura a ordem da quali ate a corrida chegar", () => {
  const { clock, hold } = setup();
  hold.apply(payload(3, ["C", "A", "B", "D", "E", "F"])); // resultado da quali
  clock.t = 1000;
  let out = hold.apply(payload(0, [])); // carregando: sem carros
  assert.equal(order(out), "CABDEF", "a tabela nao some");
  assert.equal(out.session.holdingForRace, true);
  clock.t = 2000;
  out = hold.apply(payload(5, ["A", "B"])); // corrida chegando aos poucos (2 de 6)
  assert.equal(order(out), "CABDEF", "ainda a ordem da quali");
  clock.t = 3000;
  const race = payload(5, ["C", "A", "B", "D", "E", "F"]);
  out = hold.apply(race); // corrida inteira
  assert.equal(out, race, "agora a corrida");
  out = hold.apply(payload(5, [])); // um pacote vazio depois: nao volta para a quali
  assert.equal(out.standings.length, 0);
});

test("corrida com posicao invalida ainda espera", () => {
  const { hold } = setup();
  hold.apply(payload(3, names));
  const race = payload(5, names);
  race.standings[2].position = 0;
  assert.equal(hold.apply(race).session.holdingForRace, true);
});

test("no maximo o tempo limite; outra pista ou outra sessao soltam na hora", () => {
  let { clock, hold } = setup();
  hold.apply(payload(3, names));
  clock.t = 1000;
  assert.equal(hold.apply(payload(0, [])).session.holdingForRace, true);
  clock.t = 62000; // passou do limite (saiu para o menu)
  assert.equal(hold.apply(payload(0, [])).standings.length, 0);

  ({ clock, hold } = setup());
  hold.apply(payload(3, names));
  const other = payload(5, ["A"]);
  other.session.trackLocation = "Interlagos";
  assert.equal(hold.apply(other), other, "outra pista");

  ({ clock, hold } = setup());
  hold.apply(payload(3, names));
  const practice = payload(1, ["A"]);
  assert.equal(hold.apply(practice), practice, "foi para um treino");
});

test("fora da passagem quali -> corrida nao mexe em nada", () => {
  const { hold } = setup();
  const practice = payload(1, names);
  assert.equal(hold.apply(practice), practice);
  const empty = payload(0, []);
  assert.equal(hold.apply(empty), empty, "sem quali antes: a tabela pode sumir normalmente");
  const race = payload(5, ["A"]);
  assert.equal(hold.apply(race), race);
});

test("volta de formacao: a ordem do grid fica ate a bandeira verde", () => {
  const { clock, hold } = setup();
  hold.apply(payload(3, ["C", "A", "B", "D", "E", "F"])); // quali
  clock.t = 1000;
  // grid do jogo (D foi punido e larga em ultimo): a primeira formacao completa e o grid
  let out = hold.apply(payload(4, ["C", "A", "B", "E", "F", "D"]));
  assert.equal(order(out), "CABEFD");
  // na formacao os carros se embaralham: a ordem do grid continua
  out = hold.apply(payload(4, ["A", "C", "E", "B", "D", "F"]));
  assert.equal(order(out), "CABEFD");
  assert.deepEqual(out.standings.map((e) => e.position), [1, 2, 3, 4, 5, 6]);
  assert.equal(out.session.gridOrder, true);
  assert.equal(out.standings.find((e) => e.name === "A").gamePosition, 1, "a posicao do jogo continua no pacote");
  // carro que entra no meio da formacao vai para o fim
  out = hold.apply(payload(4, ["A", "C", "E", "B", "G", "D", "F"]));
  assert.equal(order(out), "CABEFDG");
  // bandeira verde: vale a posicao do jogo
  const race = payload(5, ["A", "C", "E", "B", "D", "F"]);
  assert.equal(hold.apply(race), race);
  // uma formacao nova (outra largada) pega o grid de novo
  out = hold.apply(payload(4, ["F", "E", "D", "C", "B", "A"]));
  assert.equal(order(out), "FEDCBA");
});

test("volta de formacao sem classificacao antes tambem usa o grid", () => {
  const { hold } = setup();
  let out = hold.apply(payload(4, ["B", "A", "C"]));
  assert.equal(order(out), "BAC");
  out = hold.apply(payload(4, ["A", "B", "C"]));
  assert.equal(order(out), "BAC");
});
