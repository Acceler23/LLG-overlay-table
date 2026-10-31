const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeName, createMatcher, buildPool } = require("../overlay/shared/names");

function driver(firstName, lastName, extra) {
  return Object.assign(
    { firstName, lastName, displayName: `${firstName} ${lastName}`, aliases: [] },
    extra || {}
  );
}

function nameOf(d) {
  return d ? d.displayName : null;
}

test("normalizeName remove tags, acentos e pontuacao", () => {
  assert.equal(normalizeName("Luís Guimarães[PRO]"), "luis guimaraes");
  assert.equal(normalizeName("J. Santos"), "j santos");
});

test("nome completo identico casa", () => {
  const m = createMatcher([driver("Willian", "Garcia"), driver("Leandro", "Santos")]);
  assert.equal(nameOf(m.lookup("Willian Garcia[PRO]")), "Willian Garcia");
});

test("mesmo sobrenome com inicial diferente nao casa", () => {
  const m = createMatcher([driver("Leandro", "Santos")]);
  assert.equal(m.lookup("J. Santos"), null);
});

test("mesmo sobrenome com primeiro nome diferente nao casa", () => {
  const m = createMatcher([driver("Leandro", "Santos")]);
  assert.equal(m.lookup("Marcos Santos"), null);
});

test("inicial escolhe o piloto certo entre dois com o mesmo sobrenome", () => {
  const m = createMatcher([driver("Leandro", "Santos"), driver("Joao", "Santos")]);
  assert.equal(nameOf(m.lookup("J. Santos")), "Joao Santos");
  assert.equal(nameOf(m.lookup("L. Santos")), "Leandro Santos");
});

test("so o sobrenome casa quando ele e unico", () => {
  const m = createMatcher([driver("Leandro", "Santos"), driver("Willian", "Garcia")]);
  assert.equal(nameOf(m.lookup("Santos")), "Leandro Santos");
});

test("so o sobrenome fica sem casar quando ha dois pilotos iguais", () => {
  const m = createMatcher([driver("Leandro", "Santos"), driver("Joao", "Santos")]);
  assert.equal(m.lookup("Santos"), null);
});

test("dois nomes do jogo nunca recebem o mesmo piloto", () => {
  const m = createMatcher([driver("Leandro", "Santos"), driver("Joao", "Santos")]);
  m.prime(["Leandro Santos", "Santos"]);
  assert.equal(nameOf(m.lookup("Leandro Santos")), "Leandro Santos");
  // o outro Santos sobra para o segundo nome, por eliminacao
  assert.equal(nameOf(m.lookup("Santos")), "Joao Santos");
});

test("nome mais especifico vence a disputa pelo mesmo piloto", () => {
  const m = createMatcher([driver("Willian", "Garcia")]);
  m.prime(["Garcia", "Willian Garcia"]);
  assert.equal(nameOf(m.lookup("Willian Garcia")), "Willian Garcia");
  assert.equal(m.lookup("Garcia"), null);
});

test("alias vindo do RLT (nome no jogo) casa exato", () => {
  const m = createMatcher([driver("Carlos", "Troiano", { aliases: ["catroi"] })]);
  assert.equal(nameOf(m.lookup("Catroi[Pro]")), "Carlos Troiano");
});

test("RLT_INGAME_MAP tem prioridade", () => {
  const m = createMatcher([driver("Leandro", "Santos"), driver("Joao", "Santos")], {
    explicitMap: { xXSpeedyXx: "Joao Santos" },
  });
  assert.equal(nameOf(m.lookup("xXSpeedyXx")), "Joao Santos");
});

test("nome composto no RLT casa com primeiro nome e sobrenome do jogo", () => {
  const m = createMatcher([driver("Luis Fernando", "Guimaraes")]);
  assert.equal(nameOf(m.lookup("Luís Guimarães")), "Luis Fernando Guimaraes");
});

test("Player e nomes desconhecidos nao casam", () => {
  const m = createMatcher([driver("Leandro", "Santos")]);
  assert.equal(m.lookup("Player"), null);
  assert.equal(m.lookup("Fulano Desconhecido"), null);
});

test("buildPool junta drivers e standingsRows sem duplicar", () => {
  const pool = buildPool({
    drivers: [driver("Leandro", "Santos")],
    standingsRows: [
      { displayName: "Leandro Santos", firstName: "Leandro", lastName: "Santos" },
      { displayName: "Joao Santos", firstName: "Joao", lastName: "Santos", classUniqueName: "GT4" },
    ],
  });
  assert.equal(pool.length, 2);
  assert.equal(pool[1].uniqueName, "GT4");
});

test("nomes do jogo com etiqueta entre parenteses, grudados ou sem espaco", () => {
  const N = require("../overlay/shared/names");
  assert.equal(N.normalizeName("Daniel_Moura(AM)"), "daniel moura");
  assert.equal(N.normalizeName("LeonardoBorges[AM]"), "leonardo borges");
  assert.equal(N.normalizeName("JoãoCastro"), "joao castro");
  const pool = [
    { displayName: "Daniel Moura", firstName: "Daniel", lastName: "Moura", aliases: ["daniel moura"] },
    { displayName: "Leonardo Borges", firstName: "Leonardo", lastName: "Borges", aliases: ["leonardo borges"] },
    { displayName: "Jhonis Micael", firstName: "Jhonis", lastName: "Micael", aliases: ["jhonis micael"] },
  ];
  const m = N.createMatcher(pool);
  const names = ["Daniel_Moura(AM)", "LeonardoBorges[AM]", "jhonismicael", "Benevoid"];
  m.prime(names);
  assert.equal(m.lookup("Daniel_Moura(AM)").displayName, "Daniel Moura");
  assert.equal(m.lookup("LeonardoBorges[AM]").displayName, "Leonardo Borges");
  assert.equal(m.lookup("jhonismicael").displayName, "Jhonis Micael");
  assert.equal(m.lookup("Benevoid"), null); // apelido sem relacao com o nome: so pelo RLT_INGAME_MAP
});

test("nome no jogo identico vem antes da comparacao aproximada", () => {
  const N = require("../overlay/shared/names");
  // "Rafa" no jogo e o nome no jogo cadastrado do Rafael Silva, mas o nome
  // parece mais com o do Rafa Souza; o nome no jogo identico deve ganhar
  const pool = [
    { displayName: "Rafa Souza", firstName: "Rafa", lastName: "Souza", aliases: ["rafa souza", "rafa"] },
    { displayName: "Rafael Silva", firstName: "Rafael", lastName: "Silva", inGameName: "Rafa", aliases: ["rafael silva", "rafa"] },
  ];
  const m = N.createMatcher(pool);
  m.prime(["Rafa"]);
  assert.equal(m.lookup("Rafa").displayName, "Rafael Silva");
});

test("lista do painel: ligar a mao, ignorar e situacao da ligacao", () => {
  const N = require("../overlay/shared/names");
  const pool = [
    { displayName: "Joao Alonso", firstName: "Joao", lastName: "Alonso", inGameName: "joao2000alonso", aliases: ["joao alonso"] },
    { displayName: "Ana Lima", firstName: "Ana", lastName: "Lima", aliases: ["ana lima"] },
    { displayName: "Beto Reis", firstName: "Beto", lastName: "Reis", aliases: ["beto reis"] },
  ];
  const names = ["joao200alonso", "Ana Lima", "CAPITAOVIPS"];
  let m = N.createMatcher(pool);
  m.prime(names);
  let st = m.status();
  assert.deepEqual(st.unmatched.sort(), ["CAPITAOVIPS", "joao200alonso"]);
  assert.deepEqual(st.freeDrivers.map((d) => d.displayName).sort(), ["Beto Reis", "Joao Alonso"]);
  // no painel: joao200alonso e o Joao Alonso; CAPITAOVIPS ignorado
  m = N.createMatcher(pool, { explicitMap: { joao200alonso: "Joao Alonso", CAPITAOVIPS: "" } });
  m.prime(names);
  st = m.status();
  assert.equal(m.lookup("joao200alonso").displayName, "Joao Alonso");
  assert.equal(m.lookup("CAPITAOVIPS"), null);
  assert.deepEqual(st.unmatched, []);
  assert.deepEqual(st.ignored, ["CAPITAOVIPS"]);
  assert.deepEqual(st.freeDrivers.map((d) => d.displayName), ["Beto Reis"]);
});

test("codigo da conta do online do LMU no fim do nome nao atrapalha a ligacao", () => {
  const { normalizeName } = require("../overlay/shared/names");
  assert.equal(normalizeName("Felipe Antunes#1005"), normalizeName("Felipe Antunes"));
  assert.equal(normalizeName("Flavio Ribeiro #4089"), normalizeName("Flávio Ribeiro"));
  assert.equal(normalizeName("Piloto 44"), "piloto 44"); // numero sem # continua
});
