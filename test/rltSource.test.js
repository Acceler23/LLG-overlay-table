// Fonte da temporada: API numa sessao da liga, backup do Drive em single player
// ou com a API fora do ar. A API e falsa (fetch trocado): nenhuma chamada sai daqui.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// pasta de dados temporaria ANTES de carregar o cliente (o cache da API fica nela)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "llg-source-"));
process.env.LLG_DATA_DIR = dataDir;
delete process.env.RLT_API_KEY;
const rlt = require("../server/rltClient");

const PRO = { uniqueName: "pro", name: "Profissional", abbreviation: "PRO", color: "#FFBF0000" };

// API falsa do RLT: so a temporada 40 ("Copa X"); "down" faz tudo responder 500
const api = { down: false, calls: 0 };
const realFetch = global.fetch;
global.fetch = async (url) => {
  if (!String(url).startsWith("https://www.racingleaguetools.com")) return realFetch(url);
  api.calls++;
  const p = String(url).replace("https://www.racingleaguetools.com", "");
  const reply = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  if (api.down) return reply(500, { message: "fora do ar" });
  if (p === "/api/public/v1/seasons/40") return reply(200, { data: { season: { seasonId: 40, fullName: "Copa X", multiclass: { classes: [PRO] }, events: [] } } });
  if (p === "/api/public/v1/seasons/40/standings")
    return reply(200, { data: { seasonStatistics: { driverStandings: [{ driverName: "Piloto API", driverInfo: { displayName: "Piloto API" }, position: 1, points: "99", classInfo: PRO }] } } });
  if (p === "/api/public/v1/seasons/40/lineups") return reply(200, { data: { seats: [] } });
  return reply(404, { message: "nao existe" });
};

// backup do Drive falso, com a mesma temporada pelo nome
const backup = {
  loads: 0,
  listSeasons: async () => [{ seasonId: "drive:COPA", seasonName: "Copa X", backup: true }],
  loadSeason: async () => {
    backup.loads++;
    return {
      seasonName: "Copa X",
      classes: [PRO],
      events: [],
      standings: { seasonStatistics: { driverStandings: [{ driverName: "Piloto Backup", driverInfo: { displayName: "Piloto Backup" }, position: 1, points: "50", classInfo: PRO }], classes: [] } },
      lineupDrivers: [],
      file: "x.json",
      exportedAt: null,
    };
  },
};

function reset() {
  rlt.clearSeason();
  rlt.stopRefresh();
  api.down = false;
  api.calls = 0;
  backup.loads = 0;
}
const who = () => rlt.getOverlayPayload().standingsRows[0].driverName;

test.after(() => {
  rlt.stopRefresh();
  global.fetch = realFetch;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("sessao da liga com a API respondendo: dados da API", async () => {
  reset();
  rlt.setBackupSource(backup);
  rlt.setApiKey("chave-de-teste");
  await rlt.setDesiredSource("api");
  const p = await rlt.selectSeason(40);
  assert.equal(p.source, "api");
  assert.equal(who(), "Piloto API");
  assert.equal(p.seasonId, 40);
});

test("single player: vai direto ao backup de mesmo nome, sem chamar a API", async () => {
  reset();
  rlt.setBackupSource(backup);
  rlt.setApiKey("chave-de-teste");
  await rlt.setDesiredSource("backup");
  const p = await rlt.selectSeason(40, "Copa X");
  assert.equal(p.source, "backup");
  assert.equal(p.backupReason, "single");
  assert.equal(p.seasonId, 40, "o id continua o da temporada escolhida (ligacoes e classes manuais valem)");
  assert.equal(who(), "Piloto Backup");
  assert.equal(api.calls, 0, "nenhuma chamada a API");
});

test("a sessao vira da liga: passa para a API; volta a single player: backup de novo", async () => {
  reset();
  rlt.setBackupSource(backup);
  rlt.setApiKey("chave-de-teste");
  await rlt.setDesiredSource("backup");
  await rlt.selectSeason(40, "Copa X");
  assert.equal(await rlt.setDesiredSource("api"), true);
  assert.equal(rlt.getOverlayPayload().source, "api");
  assert.equal(who(), "Piloto API");
  assert.equal(await rlt.setDesiredSource("backup"), true);
  assert.equal(rlt.getOverlayPayload().source, "backup");
  assert.equal(await rlt.setDesiredSource("backup"), false, "ja estava no backup");
});

test("API fora do ar na sessao da liga: backup; a API volta e a temporada volta para ela", async () => {
  reset();
  rlt.setBackupSource(backup);
  rlt.setApiKey("chave-nova"); // cache vazio: a API tem que responder
  api.down = true;
  await rlt.setDesiredSource("api");
  const p = await rlt.selectSeason(40, "Copa X");
  assert.equal(p.source, "backup");
  assert.equal(p.backupReason, "api");
  assert.equal(rlt.getStatus().apiFailing, true);
  api.down = false;
  await rlt.refresh(); // releitura: tenta a API de novo
  assert.equal(rlt.getOverlayPayload().source, "api");
  assert.equal(who(), "Piloto API");
  assert.equal(rlt.getStatus().apiFailing, false);
});

test("sem backup de mesmo nome: single player fica com a API (como antes)", async () => {
  reset();
  rlt.setBackupSource({ listSeasons: async () => [{ seasonId: "drive:OUTRA", seasonName: "Outra Copa" }], loadSeason: backup.loadSeason });
  rlt.setApiKey("chave-de-teste");
  await rlt.setDesiredSource("backup");
  const p = await rlt.selectSeason(40, "Copa X");
  assert.equal(p.source, "api");
});
