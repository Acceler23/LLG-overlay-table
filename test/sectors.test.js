const test = require("node:test");
const assert = require("node:assert/strict");
const { createSectorTracker, HOLD_MS } = require("../overlay/shared/sectors");

const cls = (e) => e.carClass;
function car(name, sector, s1, s2, s3, extra) {
  return Object.assign({ name, carClass: "GT3", currentSector: sector, sector1Ms: s1, sector2Ms: s2, sector3Ms: s3, pitMode: 0, lapInvalidated: false }, extra);
}
const colors = (v) => v.map((x) => x.color);
const times = (v) => v.map((x) => x.ms);

test("parcial so aparece depois de fechada; primeira da classe e roxa", () => {
  const t = createSectorTracker();
  t.update([car("A", 0, null, null, null)], cls, 0);
  assert.deepEqual(times(t.view("A", 0)), [null, null, null]);
  t.update([car("A", 1, 30000, null, null)], cls, 100);
  assert.deepEqual(times(t.view("A", 100)), [30000, null, null]);
  assert.deepEqual(colors(t.view("A", 100)), ["purple", null, null]);
});

test("verde quando melhora a propria marca, amarelo quando piora, roxo quando bate a classe", () => {
  const t = createSectorTracker();
  const fast = { bestSector1Ms: 29000, bestSector2Ms: 31000, bestSector3Ms: 28000 };
  const rival = () => car("Rival", 1, 29000, null, null, fast);
  // A ja tem marcas: S1 30.0, S2 32.0
  const mine = { bestSector1Ms: 30000, bestSector2Ms: 32000, bestSector3Ms: 29000 };
  t.update([car("A", 0, null, null, null, mine), rival()], cls, 0);
  t.update([car("A", 1, 29500, null, null, mine), rival()], cls, 100); // melhor que a propria, pior que a do rival
  assert.deepEqual(colors(t.view("A", 100)), ["green", null, null]);
  t.update([car("A", 2, 29500, 32500, null, mine), rival()], cls, 200); // pior que a propria
  assert.deepEqual(colors(t.view("A", 200)), ["green", "yellow", null]);
  t.update([car("A", 0, null, null, 27900, mine), rival()], cls, 300); // bate a melhor da classe
  assert.deepEqual(colors(t.view("A", 300)), ["green", "yellow", "purple"]);
  assert.deepEqual(times(t.view("A", 300)), [29500, 32500, 27900]);
});

test("roxo e por classe: outra classe mais rapida nao tira o roxo", () => {
  const t = createSectorTracker();
  const proto = car("Proto", 1, 20000, null, null, { carClass: "LMP1", bestSector1Ms: 20000 });
  t.update([car("A", 0, null, null, null), proto], cls, 0);
  t.update([car("A", 1, 30000, null, null), proto], cls, 100);
  assert.equal(t.view("A", 100)[0].color, "purple");
});

test("volta invalidada fica toda vermelha e nao vira marca do piloto", () => {
  const t = createSectorTracker();
  t.update([car("A", 0, null, null, null)], cls, 0);
  t.update([car("A", 1, 25000, null, null, { lapInvalidated: true })], cls, 100);
  assert.deepEqual(colors(t.view("A", 100)), ["red", null, null]);
  // parcial valida anterior tambem fica vermelha quando a volta e invalidada depois
  const u = createSectorTracker();
  u.update([car("B", 0, null, null, null)], cls, 0);
  u.update([car("B", 1, 30000, null, null)], cls, 100);
  u.update([car("B", 1, 30000, null, null, { lapInvalidated: true })], cls, 200);
  assert.equal(u.view("B", 200)[0].color, "red");
  // volta seguinte, valida e mais lenta que a invalidada: roxa (a invalidada nao contou)
  t.update([car("A", 2, 25000, 26000, null, { lapInvalidated: true })], cls, 200);
  t.update([car("A", 0, null, null, 27000, { lapInvalidated: true })], cls, 300);
  assert.deepEqual(colors(t.view("A", 300)), ["red", "red", "red"]);
  t.update([car("A", 1, 26000, null, null)], cls, 400);
  assert.equal(t.view("A", 400)[0].color, "purple");
});

test("volta terminada fica na tela por um tempo e depois abre a nova", () => {
  const t = createSectorTracker();
  t.update([car("A", 0, null, null, null)], cls, 0);
  t.update([car("A", 1, 30000, null, null)], cls, 100);
  t.update([car("A", 2, 30000, 31000, null)], cls, 200);
  t.update([car("A", 0, null, null, 32000)], cls, 300);
  assert.deepEqual(times(t.view("A", 300)), [30000, 31000, 32000]);
  assert.deepEqual(times(t.view("A", 300 + HOLD_MS - 1)), [30000, 31000, 32000]);
  assert.deepEqual(times(t.view("A", 300 + HOLD_MS + 1)), [null, null, null]);
  // se a nova volta fechar o S1 antes do tempo, a nova volta ja aparece
  const u = createSectorTracker();
  u.update([car("A", 2, 30000, 31000, null)], cls, 0);
  u.update([car("A", 0, null, null, 32000)], cls, 100);
  u.update([car("A", 1, 29000, null, null)], cls, 200);
  assert.deepEqual(times(u.view("A", 200)), [29000, null, null]);
});

test("box e volta de saida ficam em branco", () => {
  const t = createSectorTracker();
  t.update([car("A", 0, null, null, null)], cls, 0);
  t.update([car("A", 1, 30000, null, null)], cls, 100);
  t.update([car("A", 1, 30000, null, null, { pitMode: 2 })], cls, 200);
  assert.deepEqual(times(t.view("A", 200)), [null, null, null]);
  t.update([car("A", 2, 40000, 41000, null, { pit: { outLap: true } })], cls, 300);
  assert.deepEqual(times(t.view("A", 300)), [null, null, null]);
  assert.deepEqual(times(t.view("Desconhecido", 0)), [null, null, null]);
});

test("delta: para a melhor parcial do lider da classe; o lider compara com a propria marca", () => {
  const t = createSectorTracker();
  const leader = (sector, s1) => car("Lider", sector, s1, null, null, { fastestLapMs: 89000, bestSector1Ms: 29000, bestSector2Ms: 30000, bestSector3Ms: 30000 });
  const me = (sector, s1, s2) => car("A", sector, s1, s2, null, { fastestLapMs: 90000, bestSector1Ms: 29800, bestSector2Ms: 30500, bestSector3Ms: 30200 });
  t.update([me(0, null, null), leader(0, null)], cls, 0);
  t.update([me(1, 29400, null), leader(0, null)], cls, 100);
  assert.equal(t.view("A", 100)[0].deltaMs, 400); // 29.400 contra 29.000 do lider
  assert.equal(t.view("A", 100)[1].deltaMs, null); // S2 ainda aberto
  t.update([me(2, 29400, 29900), leader(0, null)], cls, 200);
  assert.equal(t.view("A", 200)[1].deltaMs, -100); // mais rapido que o lider no S2
  // o lider: contra a marca dele mesmo
  t.update([me(2, 29400, 29900), leader(1, 28800)], cls, 300);
  assert.equal(t.view("Lider", 300)[0].deltaMs, -200);
  // sem nenhuma referencia nao ha delta
  const u = createSectorTracker();
  u.update([car("Só", 0, null, null, null)], cls, 0);
  u.update([car("Só", 1, 30000, null, null)], cls, 100);
  assert.equal(u.view("Só", 100)[0].deltaMs, null);
});

test("so a melhor parcial da classe fica roxa: a roxa batida por outro carro vira verde", () => {
  const t = createSectorTracker();
  t.update([car("A", 0, null, null, null), car("B", 0, null, null, null)], cls, 0);
  // A fecha o S1 com 30.0: melhor da classe
  t.update([car("A", 1, 30000, null, null), car("B", 0, null, null, null)], cls, 100);
  assert.equal(t.view("A", 100)[0].color, "purple");
  // B fecha o S1 com 29.8: agora B e o roxo e A vira verde (continua a melhor dele)
  t.update([car("A", 1, 30000, null, null), car("B", 1, 29800, null, null)], cls, 200);
  assert.equal(t.view("B", 200)[0].color, "purple");
  assert.equal(t.view("A", 200)[0].color, "green");
  // outra classe mais rapida nao tira o roxo
  t.update([car("A", 1, 30000, null, null), car("B", 1, 29800, null, null), car("C", 1, 25000, null, null, { carClass: "LMP2" })], cls, 300);
  assert.equal(t.view("B", 300)[0].color, "purple");
});

test("diferenca para a MELHOR VOLTA do lider (setor a setor) e a soma das diferencas", () => {
  const t = createSectorTracker();
  // lider: melhor volta 89.0 = 29.5 + 30.0 + 29.5; melhores parciais soltas 29.0 / 29.8 / 29.4 (de outras voltas)
  const lider = (sector) => car("Lider", sector, null, null, null, { fastestLapMs: 89000, bestLapSector1Ms: 29500, bestLapSector2Ms: 30000, bestLapSector3Ms: 29500, bestSector1Ms: 29000, bestSector2Ms: 29800, bestSector3Ms: 29400 });
  const me = (sector, s1, s2, s3) => car("A", sector, s1, s2, s3, { fastestLapMs: 90500 });
  t.update([me(0, null, null, null), lider(0)], cls, 0);
  t.update([me(1, 29700, null, null), lider(0)], cls, 100);
  let v = t.view("A", 100);
  assert.equal(v[0].deltaMs, 200); // 29.7 contra 29.5 da melhor volta (nao contra o 29.0 solto)
  assert.equal(v[0].cumMs, 200);
  t.update([me(2, 29700, 29700, null), lider(0)], cls, 200);
  v = t.view("A", 200);
  assert.equal(v[1].deltaMs, -300); // ganhou 0.3 no S2
  assert.equal(v[1].cumMs, -100); // no total ate o S2: 0.1 na frente
  t.update([me(0, 29700, 29700, 29800), lider(0)], cls, 300); // cruzou a linha
  v = t.view("A", 300); // a volta terminada fica na tela
  assert.equal(v[2].deltaMs, 300);
  assert.equal(v[2].cumMs, 200); // a volta inteira: 89.2 contra 89.0
});

test("sem as parciais da melhor volta no jogo (AMS2): guarda as da volta que virou a melhor", () => {
  const t = createSectorTracker();
  const lider = (sector, s1, s2, s3, best) => car("Lider", sector, s1, s2, s3, { fastestLapMs: best, bestSector1Ms: 29000, bestSector2Ms: 29000, bestSector3Ms: 29000 });
  const me = (sector, s1) => car("A", sector, s1, null, null, { fastestLapMs: 92000 });
  t.update([lider(0, null, null, null, 0), me(0, null)], cls, 0);
  t.update([lider(1, 29500, null, null, 0), me(0, null)], cls, 100);
  t.update([lider(2, 29500, 30000, null, 0), me(0, null)], cls, 200);
  // o lider fecha a volta (89.0) e o jogo confirma que e a melhor dele
  t.update([lider(0, 29500, 30000, 29500, 89000), me(0, null)], cls, 300);
  t.update([lider(0, 29500, 30000, 29500, 89000), me(1, 29900)], cls, 400);
  assert.equal(t.view("A", 400)[0].deltaMs, 400); // contra o 29.5 da volta, nao o 29.0 solto
});
