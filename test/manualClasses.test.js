const test = require("node:test");
const assert = require("node:assert/strict");
const rlt = require("../server/rltClient");

// temporada do backup com dois pilotos: um na classe Pro, outro so no lineup e sem classe
const PRO = { uniqueName: "pro", name: "Profissional", abbreviation: "PRO", color: "#FFBF0000" };
const AM = { uniqueName: "am", name: "Amador", abbreviation: "AM", color: "#FF267F00" };
const fakeBackup = {
  listSeasons: async () => [{ seasonId: "drive:S1", seasonName: "Copa", backup: true }],
  loadSeason: async () => ({
    seasonName: "Copa",
    classes: [PRO, AM],
    events: [],
    standings: {
      seasonStatistics: {
        driverStandings: [{ driverName: "Com Classe", driverInfo: { displayName: "Com Classe" }, position: 1, points: "10", classInfo: PRO }],
        classes: [{ classInfo: PRO, classStatistics: { driverStandings: [] } }],
      },
    },
    lineupDrivers: [{ driverName: "Sem Classe", driverInfo: { displayName: "Sem Classe" }, classInfo: null }],
    file: "x.json",
    exportedAt: null,
  }),
};

test("piloto sem classe: aparece para o painel e ganha a classe escolhida a mao", async () => {
  rlt.setBackupSource(fakeBackup);
  rlt.setManualClasses({});
  await rlt.selectSeason("drive:S1");
  try {
    const before = rlt.classlessDrivers();
    assert.deepEqual(before.drivers, [{ name: "Sem Classe", displayName: "Sem Classe", classUniqueName: null }]);
    assert.deepEqual(before.classes.map((c) => c.uniqueName), ["pro", "am"]);

    rlt.setManualClasses({ "drive:S1": { "Sem Classe": "am", "Com Classe": "am" } });
    const p = rlt.getOverlayPayload();
    const row = p.standingsRows.find((r) => r.driverName === "Sem Classe");
    assert.equal(row.classUniqueName, "am");
    assert.equal(row.className, "Amador");
    assert.equal(row.color, "#267F00");
    const drv = p.drivers.find((d) => d.driverName === "Sem Classe");
    assert.equal(drv.uniqueName, "am");
    // quem ja tem classe no RLT fica com a dele
    assert.equal(p.standingsRows.find((r) => r.driverName === "Com Classe").classUniqueName, "pro");
    // continua listado no painel, com a escolha
    assert.deepEqual(rlt.classlessDrivers().drivers, [{ name: "Sem Classe", displayName: "Sem Classe", classUniqueName: "am" }]);
  } finally {
    rlt.setManualClasses({});
    rlt.clearSeason();
    rlt.stopRefresh();
    rlt.setBackupSource(null);
  }
});

test("trocar para uma temporada da API que falha nao estraga a que estava aplicada", async () => {
  rlt.setBackupSource(fakeBackup);
  const savedKey = rlt.getApiKey();
  rlt.setApiKey(""); // sem chave: a busca falha na hora, sem ir a internet
  try {
    await rlt.selectSeason("drive:S1");
    await assert.rejects(rlt.selectSeason(40), /API key ausente/);
    const p = rlt.getOverlayPayload();
    assert.equal(p.seasonId, "drive:S1");
    assert.equal(p.seasonName, "Copa");
    assert.equal(p.source, "backup");
  } finally {
    rlt.clearSeason();
    rlt.stopRefresh();
    rlt.setBackupSource(null);
    rlt.setApiKey(savedKey);
    rlt.stopRefresh();
  }
});
