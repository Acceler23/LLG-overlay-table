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
    assert.deepEqual(before.drivers, [{ name: "Sem Classe", displayName: "Sem Classe", classUniqueName: null, autoClass: null }]); // sem categoria: nada automatico
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
    assert.deepEqual(rlt.classlessDrivers().drivers, [{ name: "Sem Classe", displayName: "Sem Classe", classUniqueName: "am", autoClass: null }]);
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

// temporada multiclasse por categoria (Pro/Amador/Estreiante) e por carro (Hyper/LMP2)
const PRO2 = { uniqueName: "profissional", name: "Profissional", abbreviation: "PRO", color: "#FF0000FF" };
const AM2 = { uniqueName: "amador", name: "Amador", abbreviation: "AM", color: "#FF00FF00" };
const R2 = { uniqueName: "estreiante", name: "Estreiante", abbreviation: "R", color: "#FFFF0000" };
const HY = { uniqueName: "hyper", name: "Hyper", abbreviation: "HY", color: "#FFFF0000" };
const P2 = { uniqueName: "lmp2", name: "LMP2", abbreviation: "P2", color: "#FF0000FF" };
const row = (name, cls) => ({ driverName: name, driverInfo: { displayName: name }, position: 1, points: "10", classInfo: cls });
const seat = (name, feat) => ({ driverName: name, driverInfo: { displayName: name }, classInfo: null, driverFeatures: feat });
function backupWith(classes, standingsRows, lineup) {
  return {
    listSeasons: async () => [],
    loadSeason: async () => ({
      seasonName: "Copa",
      classes,
      events: [],
      standings: { seasonStatistics: { driverStandings: standingsRows, classes: classes.map((c) => ({ classInfo: c, classStatistics: { driverStandings: [] } })) } },
      lineupDrivers: lineup,
      file: "x.json",
      exportedAt: null,
    }),
  };
}
const classOf = (name) => rlt.getOverlayPayload().standingsRows.find((r) => r.driverName === name).classUniqueName;

test("classe automatica pela categoria: aprende Rookie -> Estreiante com quem ja tem classe", async () => {
  rlt.setBackupSource(
    backupWith(
      [PRO2, AM2, R2],
      [row("Pro Um", PRO2), row("Am Um", AM2), row("Rook Um", R2)],
      [seat("Pro Um", "Pro"), seat("Am Um", "Amateur"), seat("Rook Um", "Rookie"), seat("Rook Novo", "Rookie"), seat("Am Novo", "Amateur"), seat("Sem Cat", null)]
    )
  );
  rlt.setManualClasses({});
  rlt.setAutoClassContext(["GT3"], {}); // uma classe de carro na pista
  try {
    await rlt.selectSeason("drive:S2");
    assert.equal(classOf("Rook Novo"), "estreiante", "Rookie -> Estreiante (aprendido; o nome nao parece)");
    assert.equal(classOf("Am Novo"), "amador");
    assert.equal(classOf("Sem Cat"), "—", "sem categoria: continua sem classe");
    const row1 = rlt.getOverlayPayload().standingsRows.find((r) => r.driverName === "Rook Novo");
    assert.equal(row1.autoClass, true);
    // o painel mostra a automatica; a escolha manual vence
    assert.equal(rlt.classlessDrivers().drivers.find((d) => d.name === "Rook Novo").autoClass, "estreiante");
    rlt.setManualClasses({ "drive:S2": { "Rook Novo": "amador" } });
    assert.equal(classOf("Rook Novo"), "amador");
    // quem ja tem classe no RLT fica com a dele
    assert.equal(classOf("Pro Um"), "profissional");
  } finally {
    rlt.setManualClasses({});
    rlt.setAutoClassContext([], {});
    rlt.clearSeason();
    rlt.stopRefresh();
    rlt.setBackupSource(null);
  }
});

test("classe automatica pela classe do carro quando ha mais de uma na pista", async () => {
  rlt.setBackupSource(backupWith([HY, P2], [row("Hyper Um", HY)], [seat("Hyper Um", "Pro"), seat("Novo P2", "Pro"), seat("Novo Hy", "Pro")]));
  rlt.setManualClasses({});
  try {
    await rlt.selectSeason("drive:S3");
    // duas classes de carro na pista: vale o carro de cada um, nao a categoria
    assert.equal(rlt.setAutoClassContext(["Hyper", "LMP2_ELMS"], { "Novo P2": "LMP2_ELMS", "Novo Hy": "Hyper" }), true);
    assert.equal(classOf("Novo P2"), "lmp2");
    assert.equal(classOf("Novo Hy"), "hyper");
    assert.equal(rlt.setAutoClassContext(["Hyper", "LMP2_ELMS"], { "Novo P2": "LMP2_ELMS", "Novo Hy": "Hyper" }), false, "nada mudou");
  } finally {
    rlt.setAutoClassContext([], {});
    rlt.clearSeason();
    rlt.stopRefresh();
    rlt.setBackupSource(null);
  }
});
