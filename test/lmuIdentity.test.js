const test = require("node:test");
const assert = require("node:assert/strict");
const { indexStandings, mergeIdentity } = require("../server/lmuIdentity");

// formato de GET /rest/watch/standings do LMU (reduzido), lido de um jogo aberto
const api = [
  { slotID: 0, driverName: "J voriz", carNumber: "88", fullTeamName: "Touriste one", vehicleName: "Lexus Custom Team 2026 #397" },
  { slotID: 1, driverName: "Tymoteusz Oleniacz", carNumber: "97", fullTeamName: "NQS Racing", vehicleName: "296GT3 Custom Team 2026 #397" },
  { slotID: 3, driverName: "Ronaldo Junior", carNumber: "3", fullTeamName: "DKR Engineering", vehicleName: "DKR Engineering #3:ELMS26" },
  { slotID: 4, driverName: "Sem Dados", carNumber: "", fullTeamName: "" },
];

test("pintura nao oficial: numero e equipe vem da API do jogo", () => {
  const standings = [
    { slot: 0, name: "J voriz", carNumber: "397", teamName: "Lexus Custom Team" },
    { slot: 1, name: "Tymoteusz Oleniacz", carNumber: "397", teamName: "296GT3 Custom Team" },
    { slot: 3, name: "Ronaldo Junior", carNumber: "3", teamName: "DKR Engineering" },
  ];
  mergeIdentity(standings, indexStandings(api));
  assert.deepEqual(
    standings.map((e) => `${e.carNumber} ${e.teamName}`),
    ["88 Touriste one", "97 NQS Racing", "3 DKR Engineering"]
  );
});

test("slot reaproveitado por outro piloto, ou sem dados na API: fica o da Shared Memory", () => {
  const standings = [
    { slot: 0, name: "Outro Piloto", carNumber: "397", teamName: "Lexus Custom Team" },
    { slot: 4, name: "Sem Dados", carNumber: "12", teamName: "Equipe X" },
    { slot: 9, name: "Fora da API", carNumber: "5", teamName: "Y" },
  ];
  mergeIdentity(standings, indexStandings(api));
  assert.deepEqual(
    standings.map((e) => `${e.carNumber} ${e.teamName}`),
    ["397 Lexus Custom Team", "12 Equipe X", "5 Y"]
  );
});

test("nome repetido (caractere invisivel no fim) ainda bate", () => {
  const standings = [{ slot: 1, name: "Tymoteusz Oleniacz​", carNumber: "397", teamName: "x" }];
  mergeIdentity(standings, indexStandings(api));
  assert.equal(standings[0].carNumber, "97");
});

test("nome com o codigo da conta do online: a troca de numero e equipe continua valendo", () => {
  const standings = [{ slot: 5, name: "Felipe Antunes", carNumber: "397", teamName: "Custom Team" }];
  mergeIdentity(standings, indexStandings([{ slotID: 5, driverName: "Felipe Antunes#1005", carNumber: "10", fullTeamName: "Racing Spirit of Léman" }]));
  assert.equal(standings[0].carNumber, "10");
  assert.equal(standings[0].teamName, "Racing Spirit of Léman");
});
