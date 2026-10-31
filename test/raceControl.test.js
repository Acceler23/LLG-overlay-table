const test = require("node:test");
const assert = require("node:assert/strict");
const { createRaceControl: create, hashPassword, checkPassword, matchMessage, splitChat, lappedInQueue, resolveScCar, DEFAULT_MESSAGES } = require("../server/raceControl");

// senha "abcd" nos testes (a fixa da liga nao fica em texto no repositorio)
const TEST_HASH = hashPassword("abcd");
// sem contagem da bandeira verde, a nao ser nos testes dela (encerrar desliga na hora)
const createRaceControl = (settings, opts = {}) => {
  if (settings.get("lmuGreenCountdown") === undefined) settings.set("lmuGreenCountdown", 0);
  return create(settings, Object.assign({ passwordHash: TEST_HASH }, opts));
};

function fakeSettings() {
  const data = {};
  return { get: (k) => data[k], set: (k, v) => (v == null ? delete data[k] : (data[k] = v)), data };
}

test("senha: so o hash fica salvo e confere", () => {
  const stored = hashPassword("senha-xyz"); // letras fora do hexadecimal: nunca aparecem no hash por acaso
  assert.ok(!stored.includes("senha-xyz"));
  assert.ok(checkPassword("senha-xyz", stored));
  assert.ok(!checkPassword("senha-abc", stored));
});

test("senha fixa: so ela desbloqueia; a senha criada na versao antiga e apagada", () => {
  const settings = fakeSettings();
  settings.set("lmuControlPass", hashPassword("antiga"));
  const rc = createRaceControl(settings, { sendChat: async () => {} });
  assert.equal(settings.data.lmuControlPass, undefined);
  assert.equal(rc.unlock("antiga").ok, false);
  assert.equal(rc.unlock("").ok, false);
  const ok = rc.unlock("abcd");
  assert.ok(ok.ok && ok.token);
});

test("FCY: manda a mensagem no chat e marca a sessao do LMU", async () => {
  const sent = [];
  const rc = createRaceControl(fakeSettings(), { sendChat: async (t) => sent.push(t) });
  assert.equal((await rc.setFcy("token-falso", true)).ok, false); // bloqueado
  const { token } = rc.unlock("abcd");
  const payload = { game: "lmu", session: { state: 5, trackLocation: "Spa" }, standings: [] };
  rc.apply(payload);
  await rc.setFcy(token, true);
  assert.equal(rc.apply(payload).session.fcy, true);
  await rc.setFcy(token, false);
  assert.equal(rc.apply(payload).session.fcy, false);
  assert.deepEqual(sent, ["FCY EM 20S - 60KMH", "BANDEIRA VERDE"]);
});

test("mensagem nao chegou no jogo: o FCY nao liga na tabela", async () => {
  const rc = createRaceControl(fakeSettings(), {
    sendChat: async () => {
      throw new Error("jogo fechado");
    },
  });
  const { token } = rc.unlock("abcd");
  await assert.rejects(rc.setFcy(token, true));
  assert.equal(rc.status().fcy, false);
});

test("sessao nova desliga o FCY; outro jogo nao recebe o campo", async () => {
  const rc = createRaceControl(fakeSettings(), { sendChat: async () => {} });
  const { token } = rc.unlock("abcd");
  rc.apply({ game: "lmu", session: { state: 5, trackLocation: "Spa" } });
  await rc.setFcy(token, true);
  assert.equal(rc.apply({ game: "lmu", session: { state: 1, trackLocation: "Spa" } }).session.fcy, false);
  assert.equal(rc.apply({ game: "ams2", session: { state: 5 } }).session.fcy, undefined);
});

test("mensagens editadas pelo painel", async () => {
  const sent = [];
  const rc = createRaceControl(fakeSettings(), { sendChat: async (t) => sent.push(t) });
  const { token } = rc.unlock("abcd");
  rc.setMessages(token, { fcyOn: "  FCY   agora ", fcyOff: "" });
  await rc.setFcy(token, true);
  await rc.setFcy(token, false);
  assert.deepEqual(sent, ["FCY agora", "BANDEIRA VERDE"]);
});

// relogio falso e uma corrida no LMU com as velocidades dadas
function fcySetup(countdown = 10) {
  let t = 1000000;
  const settings = fakeSettings();
  settings.set("lmuFcyCountdown", countdown);
  settings.set("lmuChatCountdown", false); // sem os timers da contagem no chat
  const rc = createRaceControl(settings, { sendChat: async () => {}, now: () => t });
  const tick = (ms, speeds) => {
    t += ms;
    return rc.apply({
      game: "lmu",
      session: { state: 5, trackLocation: "Spa" },
      standings: Object.entries(speeds).map(([name, kmh], i) => ({ name, carNumber: String(i + 1), speedKmh: kmh, raceState: 2 })),
    });
  };
  return { rc, tick, token: rc.unlock("abcd").token };
}

test("FCY: acima de 60 km/h depois da contagem vira infracao, com duracao e tempo apos a contagem", async () => {
  const { rc, tick, token } = fcySetup(10);
  tick(0, { A: 150, B: 150 });
  const sent = await rc.setFcy(token, true);
  assert.equal(sent.countdownLeft, 10);
  assert.equal(tick(5000, { A: 120, B: 55 }).session.fcyCountdown, 5); // na contagem: nao conta
  tick(5000, { A: 90, B: 55 }); // fim da contagem: A acima
  tick(3000, { A: 58, B: 55 }); // A reduziu 3 s depois
  const s = tick(1000, { A: 58, B: 70 }); // B acelera 4 s depois da contagem
  assert.equal(s.session.fcyCountdown, 0);
  const st = rc.status();
  assert.equal(st.breaches.length, 2);
  assert.deepEqual(
    { name: st.breaches[0].name, overMs: st.breaches[0].overMs, afterMs: st.breaches[0].afterMs, maxKmh: st.breaches[0].maxKmh, live: st.breaches[0].live },
    { name: "A", overMs: 3000, afterMs: 0, maxKmh: 90, live: undefined }
  );
  assert.equal(st.breaches[1].name, "B");
  assert.equal(st.breaches[1].live, true); // ainda acima
  assert.equal(st.breaches[1].afterMs, 4000);
});

test("FCY: cada infracao vai para o log uma vez so; encerrar o FCY fecha quem ainda estava acima", async () => {
  const { rc, tick, token } = fcySetup(0);
  tick(0, { A: 50 });
  await rc.setFcy(token, true);
  assert.deepEqual(tick(1000, { A: 80 }).session.fcyBreaches, []);
  assert.equal(tick(2000, { A: 50 }).session.fcyBreaches.length, 1);
  assert.deepEqual(tick(1000, { A: 50 }).session.fcyBreaches, []);
  tick(1000, { A: 100 });
  await rc.setFcy(token, false);
  const out = tick(1000, { A: 200 }).session.fcyBreaches;
  assert.equal(out.length, 1);
  assert.equal(rc.status().breaches.length, 2);
  assert.equal(rc.status().breaches.filter((b) => b.live).length, 0); // FCY desligado: nada mais conta
});

test("FCY: carro fora da corrida nao conta", async () => {
  const { rc, token } = fcySetup(0);
  await rc.setFcy(token, true);
  rc.apply({ game: "lmu", session: { state: 5, trackLocation: "Spa" }, standings: [{ name: "DNF", speedKmh: 200, raceState: 4 }] });
  assert.equal(rc.status().breaches.length, 0);
});

test("chat: reconhece as mensagens de FCY (com a contagem) e de safety car", () => {
  assert.deepEqual(splitChat("P Costa#1596: FCY EM 10 SEGUNDOS"), { sender: "P Costa#1596", text: "FCY EM 10 SEGUNDOS" });
  assert.deepEqual(matchMessage("FCY EM 15S - 60KMH", DEFAULT_MESSAGES), { kind: "fcy", on: true, seconds: 15 });
  assert.deepEqual(matchMessage("fcy  em 5s -  60KMH", DEFAULT_MESSAGES), { kind: "fcy", on: true, seconds: 5 });
  assert.deepEqual(matchMessage("BANDEIRA VERDE", DEFAULT_MESSAGES), { kind: "fcy", on: false });
  assert.deepEqual(matchMessage("FCY - limitador de box ligado", DEFAULT_MESSAGES), { kind: "fcy", go: true });
  assert.deepEqual(matchMessage("FCY EM 9s - 60kmh", DEFAULT_MESSAGES), { kind: "fcy", on: true, seconds: 9 });
  assert.deepEqual(matchMessage("FCY 7S", DEFAULT_MESSAGES), { kind: "fcy", on: true, seconds: 7 });
  assert.deepEqual(matchMessage("VERDE 4S", DEFAULT_MESSAGES), { kind: "fcy", ending: true, seconds: 4 });
  assert.deepEqual(matchMessage("BANDEIRA VERDE EM 5 SEGUNDOS", DEFAULT_MESSAGES), { kind: "fcy", ending: true, seconds: 5 });
  assert.deepEqual(matchMessage("Safety Car na pista", DEFAULT_MESSAGES), { kind: "sc", on: true });
  assert.deepEqual(matchMessage("SAFETY CAR NESSA VOLTA - PREPARAR PARA RELARGADA", DEFAULT_MESSAGES), { kind: "sc", on: false });
  assert.equal(matchMessage("atencao galera ao chat FCY E SC", DEFAULT_MESSAGES), null);
  assert.deepEqual(matchMessage("FCY", { fcyOn: "FCY", fcyOff: "VERDE" }), { kind: "fcy", on: true, seconds: null }); // sem {s}: contagem daqui
});

// chat falso: cada leitura devolve o que estiver em "chat"
function followSetup() {
  let t = 1000000;
  const chat = [];
  const settings = fakeSettings();
  const rc = createRaceControl(settings, { sendChat: async () => {}, fetchChat: async () => chat.slice(), now: () => t });
  rc.setFollow({ enabled: true });
  const lmu = () => rc.apply({ game: "lmu", session: { state: 5, trackLocation: "Spa" }, standings: [] });
  const say = (message) => chat.push({ message, timestamp: chat.length + 1 });
  return { rc, chat, say, lmu, advance: (ms) => (t += ms) };
}

test("seguir o chat: o historico nao conta; mensagem nova liga e desliga o FCY", async () => {
  const { rc, say, lmu, advance } = followSetup();
  say("R Junior: FCY EM 10S - 60KMH"); // ja estava no chat ao entrar
  lmu();
  await rc.pollChat();
  assert.equal(rc.status().fcy, false);
  say("I Oliveira: FCY EM 5S - 60KMH");
  await rc.pollChat();
  let st = rc.status();
  assert.equal(st.fcy, true);
  assert.equal(st.fcyBy, "I Oliveira");
  assert.equal(st.countdownLeft, 5);
  advance(1000);
  lmu();
  say("R Junior: BANDEIRA VERDE");
  await rc.pollChat();
  assert.equal(rc.status().fcy, false);
});

test("seguir o chat: safety car de qualquer um liga e desliga; FCY virando SC desliga o FCY", async () => {
  const { rc, say, lmu } = followSetup();
  lmu();
  await rc.pollChat();
  say("J Souza#1234: FCY EM 10S - 60KMH");
  await rc.pollChat();
  assert.equal(rc.status().fcy, true);
  say("R Junior: SAFETY CAR NA PISTA");
  await rc.pollChat();
  let st = rc.status();
  assert.deepEqual([st.fcy, st.sc, st.scBy], [false, true, "R Junior"]);
  const p = lmu();
  assert.deepEqual([p.session.scCall, p.session.scOut, p.session.fcy], [true, true, false]);
  say("R Junior: SAFETY CAR NESSA VOLTA - PREPARAR PARA RELARGADA");
  await rc.pollChat();
  assert.equal(rc.status().sc, false);
  assert.equal(lmu().session.scOut, undefined); // o SC do jogo continua valendo sozinho
});

test("seguir o chat: desligado ou sem o LMU aberto, nao le", async () => {
  const { rc, say, lmu, advance } = followSetup();
  lmu();
  await rc.pollChat();
  advance(10000); // LMU parou de mandar dados
  say("R Junior: FCY EM 10S - 60KMH");
  await rc.pollChat();
  assert.equal(rc.status().fcy, false);
});

test("seguir o chat: mensagem que chegou com o LMU parado nao liga quando ele volta", async () => {
  const { rc, say, lmu, advance } = followSetup();
  lmu();
  await rc.pollChat();
  advance(10000);
  await rc.pollChat(); // LMU parado
  say("R Junior: FCY EM 10S - 60KMH");
  lmu(); // voltou
  await rc.pollChat();
  assert.equal(rc.status().fcy, false);
});

test("contagem no chat: FCY Ns a cada segundo e a mensagem do fim", async () => {
  const sent = [];
  const settings = fakeSettings();
  settings.set("lmuFcyCountdown", 2);
  const rc = createRaceControl(settings, { sendChat: async (t) => sent.push(t) });
  const { token } = rc.unlock("abcd");
  await rc.setFcy(token, true);
  await new Promise((r) => setTimeout(r, 2300));
  assert.deepEqual(sent, ["FCY EM 2S - 60KMH", "FCY 1S", "FCY - LIMITADOR DE BOX LIGADO"]);
});

test("contagem no chat: encerrar o FCY no meio para a contagem", async () => {
  const sent = [];
  const settings = fakeSettings();
  settings.set("lmuFcyCountdown", 3);
  const rc = createRaceControl(settings, { sendChat: async (t) => sent.push(t) });
  const { token } = rc.unlock("abcd");
  await rc.setFcy(token, true);
  await new Promise((r) => setTimeout(r, 300));
  await rc.setFcy(token, false);
  await new Promise((r) => setTimeout(r, 3200));
  assert.deepEqual(sent, ["FCY EM 3S - 60KMH", "BANDEIRA VERDE"]);
});

test("seguir o chat: a mensagem do fim da contagem acerta o relogio daqui", async () => {
  const { rc, say, lmu } = followSetup();
  lmu();
  await rc.pollChat();
  say("R Junior: FCY EM 10S - 60KMH");
  await rc.pollChat();
  assert.equal(rc.status().countdownLeft, 10);
  say("R Junior: 9");
  say("R Junior: FCY - LIMITADOR DE BOX LIGADO");
  await rc.pollChat();
  assert.equal(rc.status().countdownLeft, 0); // limite valendo
});

test("botao de safety car: mensagem no chat; ligar o FCY depois desliga o SC sem bandeira verde", async () => {
  const sent = [];
  const settings = fakeSettings();
  settings.set("lmuChatCountdown", false);
  const rc = createRaceControl(settings, { sendChat: async (t) => sent.push(t) });
  const { token } = rc.unlock("abcd");
  assert.equal((await rc.setSc("token-falso", true)).ok, false); // bloqueado
  await rc.setSc(token, true);
  assert.equal(rc.status().sc, true);
  await rc.setFcy(token, true);
  assert.deepEqual([rc.status().sc, rc.status().fcy], [false, true]);
  assert.deepEqual(sent, ["SAFETY CAR NA PISTA", "PILOTOS PODEM ALCANÇAR O SAFETY CAR", "FCY EM 20S - 60KMH"]);
});

test("bandeira verde: encerrar conta no chat e so desliga o FCY no fim (o limite vale ate la)", async () => {
  const sent = [];
  const settings = fakeSettings();
  settings.set("lmuFcyCountdown", 0);
  settings.set("lmuGreenCountdown", 2);
  const rc = createRaceControl(settings, { sendChat: async (t) => sent.push(t) });
  const { token } = rc.unlock("abcd");
  await rc.setFcy(token, true);
  let st = await rc.setFcy(token, false);
  assert.deepEqual([st.fcy, st.greenLeft], [true, 2]);
  const lmu = () => rc.apply({ game: "lmu", session: { state: 5, trackLocation: "Spa" }, standings: [{ name: "A", speedKmh: 90, raceState: 2 }] });
  assert.equal(lmu().session.fcyGreenIn, 2);
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal(rc.status().fcy, false);
  assert.equal(rc.status().breaches.length, 1); // acima de 60 durante a contagem da verde
  assert.deepEqual(sent, ["FCY EM 0S - 60KMH", "BANDEIRA VERDE EM 2 SEGUNDOS", "VERDE 1S", "BANDEIRA VERDE"]);
});

test("bandeira verde: apertar de novo durante a contagem encerra na hora", async () => {
  const sent = [];
  const settings = fakeSettings();
  settings.set("lmuFcyCountdown", 0);
  settings.set("lmuGreenCountdown", 5);
  settings.set("lmuChatCountdown", false);
  const rc = createRaceControl(settings, { sendChat: async (t) => sent.push(t) });
  const { token } = rc.unlock("abcd");
  await rc.setFcy(token, true);
  await rc.setFcy(token, false);
  assert.equal(rc.status().fcy, true);
  await rc.setFcy(token, false);
  assert.equal(rc.status().fcy, false);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sent.slice(1), ["BANDEIRA VERDE EM 5 SEGUNDOS", "BANDEIRA VERDE"]);
});

test("seguir o chat: a contagem da verde aparece aqui e a mensagem de verde desliga", async () => {
  const { rc, say, lmu } = followSetup();
  lmu();
  await rc.pollChat();
  say("R Junior: FCY EM 10S - 60KMH");
  await rc.pollChat();
  say("R Junior: BANDEIRA VERDE EM 5 SEGUNDOS");
  await rc.pollChat();
  assert.deepEqual([rc.status().fcy, rc.status().greenLeft], [true, 5]);
  say("R Junior: BANDEIRA VERDE");
  await rc.pollChat();
  assert.deepEqual([rc.status().fcy, rc.status().greenLeft], [false, 0]);
});

test("contagem no chat: modelo da contagem sem {s} manda so os numeros", async () => {
  const sent = [];
  const settings = fakeSettings();
  settings.set("lmuFcyCountdown", 2);
  settings.set("lmuMessages", { fcyTick: "CONTAGEM" });
  const rc = createRaceControl(settings, { sendChat: async (t) => sent.push(t) });
  const { token } = rc.unlock("abcd");
  await rc.setFcy(token, true);
  await new Promise((r) => setTimeout(r, 2300));
  assert.deepEqual(sent, ["FCY EM 2S - 60KMH", "2", "1", "FCY - LIMITADOR DE BOX LIGADO"]);
});

test("mensagens salvas iguais a um padrao antigo passam para o padrao atual", () => {
  const settings = fakeSettings();
  settings.set("lmuMessages", { fcyOn: "FCY - FULL COURSE YELLOW", fcyOff: "BANDEIRA VERDE", fcyGo: "FCY" });
  const m = createRaceControl(settings).status().messages;
  assert.deepEqual([m.fcyOn, m.fcyGo, m.fcyOff], ["FCY EM {s}S - 60KMH", "FCY - LIMITADOR DE BOX LIGADO", "BANDEIRA VERDE"]);
});

// pista de 4000 m; lider (P1) na volta 10, a 1000 m da linha
const L = 4000;
const car = (name, position, laps, lapDistance, extra = {}) => Object.assign({ name, position, lapDistance, totalDistance: laps * L + lapDistance, raceState: 2, pitMode: 0 }, extra);

test("fila do SC: so retardatarios entre o SC e o lider, da frente para tras", () => {
  const standings = [
    car("Lider", 1, 10, 1000),
    car("Segundo", 2, 10, 900), // mesma volta, atras do lider
    car("Retardatario perto do SC", 9, 9, 1400),
    car("Retardatario logo a frente", 8, 9, 1100),
    car("Duas voltas atras", 12, 8, 1200),
    car("Retardatario atras do lider", 10, 9, 800), // ja esta atras: nao passa
    car("No box", 11, 9, 1300, { pitMode: 3 }),
    car("Abandonou", 13, 9, 1350, { raceState: 4 }),
  ];
  assert.deepEqual(
    lappedInQueue(standings, L).map((e) => e.name),
    ["Retardatario perto do SC", "Duas voltas atras", "Retardatario logo a frente"]
  );
  assert.deepEqual(lappedInQueue(standings, 0), []); // sem o tamanho da pista
});

test("fila do SC: lider perto da linha de chegada (a fila passa pela linha)", () => {
  const standings = [car("Lider", 1, 10, 3900), car("Ja cruzou a linha", 7, 10, 150)];
  assert.deepEqual(lappedInQueue(standings, L).map((e) => e.name), ["Ja cruzou a linha"]);
});

test("retardatarios: aviso agora e, depois do tempo, o nome de cada um", async () => {
  const sent = [];
  const settings = fakeSettings();
  const rc = createRaceControl(settings, { sendChat: async (t) => sent.push(t), waveDelayMs: 50 });
  const { token } = rc.unlock("abcd");
  assert.equal((await rc.waveBy(token)).ok, false); // sem SC
  await rc.setSc(token, true);
  rc.apply({ game: "lmu", session: { state: 5, trackLocation: "Spa", trackLength: L }, standings: [car("Lider", 1, 10, 1000), car("Felipe Antunes", 9, 9, 1300)] });
  await rc.waveBy(token);
  assert.equal(rc.status().waveLeft, 1);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(sent, ["SAFETY CAR NA PISTA", "PILOTOS PODEM ALCANÇAR O SAFETY CAR", "RETARDATARIOS PODEM ULTRAPASSAR", "Felipe Antunes PODE ULTRAPASSAR"]);
  assert.deepEqual(rc.status().waveLast.names, ["Felipe Antunes"]);
});

test("retardatarios: encerrar o SC antes do tempo cancela os nomes", async () => {
  const sent = [];
  const rc = createRaceControl(fakeSettings(), { sendChat: async (t) => sent.push(t), waveDelayMs: 50 });
  const { token } = rc.unlock("abcd");
  await rc.setSc(token, true);
  rc.apply({ game: "lmu", session: { state: 5, trackLocation: "Spa", trackLength: L }, standings: [car("Lider", 1, 10, 1000), car("X", 9, 9, 1300)] });
  await rc.waveBy(token);
  await rc.setSc(token, false);
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(!sent.includes("X PODE ULTRAPASSAR"));
});

test("carro do SC: o unico LMGTE; sem ou com mais de um, so o escolhido", () => {
  const gt3 = { name: "A", carClass: "GT3" };
  assert.deepEqual(resolveScCar([gt3, { name: "SC", carClass: "GTE" }]), { name: "SC", auto: true, problem: "" });
  assert.equal(resolveScCar([gt3]).name, null);
  assert.match(resolveScCar([gt3]).problem, /nenhum/);
  assert.match(resolveScCar([{ name: "X", carClass: "LMGTE" }, { name: "Y", carClass: "GTE" }]).problem, /mais de um/);
  assert.deepEqual(resolveScCar([gt3, { name: "Y", carClass: "GTE" }, { name: "Z", carClass: "GTE" }], "Z"), { name: "Z", auto: false, problem: "" });
  assert.equal(resolveScCar([gt3, { name: "SC", carClass: "GTE" }], "Saiu").name, "SC"); // escolhido fora da sessao: automatico
});

test("fila do SC com o carro do SC: lider geral sem o SC, e so quem esta entre o SC e o lider", () => {
  const standings = [
    car("Safety Car", 1, 10, 1600, { carClass: "GTE" }), // na frente de todos: seria P1
    car("Lider", 2, 10, 1000),
    car("Entre o SC e o lider", 9, 9, 1300),
    car("A frente do SC", 10, 9, 1900), // retardatario, mas fora da fila
  ];
  assert.deepEqual(lappedInQueue(standings, L, "Safety Car").map((e) => e.name), ["Entre o SC e o lider"]);
});

test("FCY: o carro do SC nao queima o FCY", async () => {
  const settings = fakeSettings();
  settings.set("lmuFcyCountdown", 0);
  settings.set("lmuChatCountdown", false);
  const rc = createRaceControl(settings, { sendChat: async () => {} });
  const { token } = rc.unlock("abcd");
  await rc.setFcy(token, true);
  const apply = () =>
    rc.apply({ game: "lmu", session: { state: 5, trackLocation: "Spa" }, standings: [{ name: "SC", carClass: "GTE", speedKmh: 120, raceState: 2 }, { name: "B", carClass: "GT3", speedKmh: 90, raceState: 2 }] });
  apply();
  apply();
  assert.deepEqual(rc.status().breaches.map((b) => b.name), ["B"]);
  assert.equal(rc.status().scCar.name, "SC");
});

test("contagem no chat maior que 10 s: mensagem de ligar, pausa e so os ultimos 10 s", async () => {
  const sent = [];
  const at = [];
  const settings = fakeSettings();
  settings.set("lmuFcyCountdown", 12);
  const rc = createRaceControl(settings, { sendChat: async (t) => { sent.push(t); at.push(Date.now()); } });
  const { token } = rc.unlock("abcd");
  const t0 = Date.now();
  await rc.setFcy(token, true);
  await new Promise((r) => setTimeout(r, 2400));
  rc.setFcy(token, false); // para a contagem (a contagem da verde e 0 nos testes)
  assert.deepEqual(sent.slice(0, 2), ["FCY EM 12S - 60KMH", "FCY 10S"]);
  assert.ok(at[1] - t0 >= 1900, "FCY 10S so depois da pausa de 2 s");
});

test("seguir o chat: FCY Ns e VERDE Ns acertam as contagens daqui", async () => {
  const { rc, say, lmu, advance } = followSetup();
  lmu();
  await rc.pollChat();
  say("R Junior: FCY EM 15S - 60KMH");
  await rc.pollChat();
  advance(6000);
  lmu();
  say("R Junior: FCY 8S");
  await rc.pollChat();
  assert.equal(rc.status().countdownLeft, 8);
  advance(9000);
  lmu();
  say("R Junior: BANDEIRA VERDE EM 10 SEGUNDOS");
  await rc.pollChat();
  advance(3000);
  lmu();
  say("R Junior: VERDE 5S");
  await rc.pollChat();
  assert.equal(rc.status().greenLeft, 5);
});

test("acesso salvo: vale depois de reiniciar o app, ate bloquear; so o hash fica salvo", () => {
  const settings = fakeSettings();
  const { token } = createRaceControl(settings).unlock("abcd");
  assert.ok(!JSON.stringify(settings.data.lmuTokens).includes(token));
  const depois = createRaceControl(settings); // app reaberto
  assert.equal(depois.allowed(token), true);
  depois.lock(token);
  assert.equal(depois.allowed(token), false);
  assert.equal(createRaceControl(settings).allowed(token), false);
});

test("acesso salvo: trocar a senha no codigo invalida os acessos guardados", () => {
  const settings = fakeSettings();
  const { token } = createRaceControl(settings).unlock("abcd");
  const outraSenha = create(settings, { passwordHash: hashPassword("outra") });
  assert.equal(outraSenha.allowed(token), false);
});

test("replay: bloqueado sem acesso; com o proprio carro andando nao entra", async () => {
  const jumps = [];
  const gameIncidents = { apply() {}, poll() {}, reset() {}, list: () => [], isReplayActive: () => false, jump: async (et) => jumps.push(et), exit: async () => {} };
  const rc = createRaceControl(fakeSettings(), { sendChat: async () => {}, gameIncidents });
  const { token } = rc.unlock("abcd");
  assert.equal((await rc.replayJump("falso", 100)).ok, false);
  const send = (kmh) => rc.apply({ game: "lmu", session: { state: 5, trackLocation: "Spa" }, standings: [{ name: "Eu", isPlayer: true, speedKmh: kmh, raceState: 2 }] });
  send(120);
  assert.match((await rc.replayJump(token, 100)).error, /andando/);
  assert.deepEqual(jumps, []);
  send(0);
  assert.equal((await rc.replayJump(token, 100)).ok, true);
  assert.equal((await rc.replayJump(token, "x")).ok, false);
  assert.deepEqual(jumps, [100]);
});
