const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createBackup, newestStandings, parseFolderPage, isBackupId, folderIdFromLink } = require("../server/rltBackup");
const secret = require("../server/secret");

// pagina de pasta do Drive com os itens no bloco _DRIVE_ivd (como o Drive manda)
function folderPage(items) {
  const data = [items.map((it) => [it.id, [], it.name, it.mime])];
  const escaped = JSON.stringify(data).replace(/"/g, "\\x22");
  return `<html><script>window['_DRIVE_ivd'] = '${escaped}';</script></html>`;
}
const FOLDER = "application/vnd.google-apps.folder";
const JSONM = "application/json";

const standings = (name, points) => ({
  metadata: { exportType: "SeasonStatistics", exportedAt: "2026-11-09T18:46:38Z" },
  season: { seasonName: "Copa X - Temporada 1" },
  seasonStatistics: {
    status: { nextRoundName: "Velopark", nextRoundDate: "2026-11-16" },
    driverStandings: [
      {
        driverName: name,
        driverInfo: { firstName: "Daniel", lastName: "Esparza", displayName: name },
        position: 1,
        points: String(points),
        teamName: "Chevrolet",
        teamInfo: { fullName: "Chevrolet Racing", primaryColor: "#FFEECA65" },
        classInfo: { uniqueName: "pro", name: "Profissional", color: "#FFBF0000" },
        events: [{ roundNumber: 1, eventName: "Goiania", trackName: "Goiania", eventDate: "2026-10-19", races: [{ sessionName: "Race" }], qualifications: [] }],
      },
    ],
    classes: [{ classInfo: { uniqueName: "pro", name: "Profissional", abbreviation: "PRO", color: "#FFBF0000" }, classStatistics: { driverStandings: [] } }],
  },
});

function fakeDrive(files) {
  const calls = [];
  const fetchText = async (url) => {
    calls.push(url);
    if (files.offline) throw new Error("sem internet");
    const folder = /folders\/([^?]+)/.exec(url);
    if (folder) return folderPage(files.folders[folder[1]] || []);
    const id = /id=([^&]+)/.exec(url)[1];
    return JSON.stringify(files.json[id]);
  };
  return { fetchText, calls };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llg-backup-"));
  const files = {
    folders: {
      ROOT: [
        { id: "SEASON1", name: "Copa X - Temporada 1", mime: FOLDER },
        { id: "DRV", name: "drivers.json", mime: JSONM },
        { id: "TEAMS", name: "teams.json", mime: JSONM },
      ],
      SEASON1: [
        { id: "OLD", name: "llg_standings_copa_x_20261101_1000.json", mime: JSONM },
        { id: "NEW", name: "llg_standings_copa_x_20261109_1546.json", mime: JSONM },
        { id: "LINE", name: "lineups.json", mime: JSONM },
      ],
    },
    json: {
      OLD: standings("Daniel Esparza", 10),
      NEW: standings("Daniel Esparza", 50),
      DRV: [{ Name: "Daniel Esparza", InGameName: "Cipher0023" }, { Name: "Reserva Um", InGameName: "Reserva1" }],
      TEAMS: [{ UniqueName: "chevrolet.x", Name: "Chevrolet", FullName: "Chevrolet Racing", Color: "#FFEECA65", SecondaryColor: "#FFFFFFFF" }],
      LINE: [{ Driver: "Daniel Esparza", Team: "chevrolet.x" }, { Driver: "Reserva Um", Team: "chevrolet.x", SeatType: "Primary" }],
    },
  };
  const drive = fakeDrive(files);
  const backup = createBackup({ dataDir: dir, fetchText: drive.fetchText, link: "https://drive.google.com/drive/folders/ROOT?usp=sharing" });
  return { dir, files, drive, backup };
}

test("link da pasta: guardado criptografado e o id sai do link", () => {
  const src = fs.readFileSync(path.join(__dirname, "../server/rltBackup.js"), "utf8");
  assert.ok(!/drive\.google\.com\/drive\/folders\/1/.test(src), "o link nao aparece em texto puro");
  const enc = /FOLDER_LINK = "([^"]+)"/.exec(src)[1];
  assert.equal(folderIdFromLink(secret.decrypt(enc)), "1ixvNX5DgTwXYU9zngFJFpOhReQDFQf87");
  assert.ok(isBackupId("drive:abc"));
  assert.ok(!isBackupId(40));
});

test("le a pagina da pasta do Drive e acha o standings mais novo pela data no nome", () => {
  const items = parseFolderPage(folderPage([{ id: "A", name: "x.json", mime: JSONM }]));
  assert.deepEqual(items, [{ id: "A", name: "x.json", mime: JSONM }]);
  const newest = newestStandings([
    { id: "1", name: "llg_standings_a_20261101_1000.json", mime: JSONM },
    { id: "2", name: "llg_standings_a_20261109_0900.json", mime: JSONM },
    { id: "3", name: "lineups.json", mime: JSONM },
  ]);
  assert.equal(newest.id, "2");
});

test("temporadas sao as subpastas; a temporada usa o standings novo, nome no jogo e lineup", async () => {
  const { dir, backup } = setup();
  try {
    const seasons = await backup.listSeasons();
    assert.deepEqual(seasons, [{ seasonId: "drive:SEASON1", seasonName: "Copa X - Temporada 1", backup: true }]);
    const s = await backup.loadSeason("drive:SEASON1");
    assert.equal(s.file, "llg_standings_copa_x_20261109_1546.json");
    const d = s.standings.seasonStatistics.driverStandings[0];
    assert.equal(d.points, "50");
    assert.deepEqual(d.inGameNames, ["Cipher0023"]);
    assert.deepEqual(s.classes, [{ uniqueName: "pro", name: "Profissional", abbreviation: "PRO", color: "#FFBF0000" }]);
    assert.deepEqual(s.events.map((e) => [e.round, e.trackName, e.completedStatus]), [[1, "Goiania", "Completed"], [2, "Velopark", null]]);
    const reserva = s.lineupDrivers.find((x) => x.driverName === "Reserva Um");
    assert.equal(reserva.teamName, "Chevrolet");
    assert.equal(reserva.teamInfo.primaryColor, "#FFEECA65");
    assert.deepEqual(reserva.inGameNames, ["Reserva1"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sem internet: vale a ultima copia guardada", async () => {
  const { dir, files, backup } = setup();
  try {
    await backup.loadSeason("drive:SEASON1");
    files.offline = true;
    const s = await backup.loadSeason("drive:SEASON1");
    assert.equal(s.standings.seasonStatistics.driverStandings[0].points, "50");
    assert.equal((await backup.listSeasons()).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
