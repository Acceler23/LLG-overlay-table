// server/rltBackup.js
//
// Backup do RLT: quando a API nao esta disponivel (chave vencida, sem chave),
// a temporada vem de uma pasta publica do Google Drive, com as exportacoes do
// Racing League Tools:
//   <pasta>/drivers.json                 pilotos da liga (nome no jogo: InGameName)
//   <pasta>/teams.json                   equipes (cores)
//   <pasta>/<temporada>/llg_standings_<...>_<aaaammdd>_<hhmm>.json
//                                        pontuacao exportada (SeasonStatistics, o mesmo
//                                        formato da API /seasons/{id}/standings)
//   <pasta>/<temporada>/lineups.json     vagas do lineup (quem ainda nao pontuou)
// Cada subpasta e uma temporada. Vale o standings mais novo da pasta (pela
// data no nome): para atualizar, e so subir um arquivo novo.
//
// O link da pasta fica criptografado aqui (server/secret.js, o mesmo da chave
// do RLT): nao aparece numa busca no codigo nem no GitHub.
//
// Tudo o que e baixado fica guardado em disco (rlt-backup.json na pasta de
// dados): sem internet, vale a ultima copia.

const fs = require("fs");
const path = require("path");
const secret = require("./secret");

const FOLDER_LINK = "llg1:PfBKIn2Cm4n/bbPN:N87Z7XDpjMVDnvOGnfduKA==:lcRwlOpFU7x6fl6/OVyr13wdiXWL69LQWtLcrQidYCFkSTair1+HlI9LblkVfJEikCSNugjY0cF1UBv915jzftJRyb2V8Yp8";
const ID_PREFIX = "drive:"; // seasonId das temporadas do backup: "drive:<id da pasta>"
const FETCH_TIMEOUT_MS = 20000;

function folderIdFromLink(link) {
  const m = /\/folders\/([A-Za-z0-9_-]+)/.exec(String(link || ""));
  return m ? m[1] : null;
}

function isBackupId(seasonId) {
  return typeof seasonId === "string" && seasonId.startsWith(ID_PREFIX);
}

// Itens de uma pagina de pasta publica do Drive: [{ id, name, mime }]
function parseFolderPage(html) {
  const m = /window\['_DRIVE_ivd'\]\s*=\s*'([\s\S]*?)';/.exec(String(html || ""));
  if (!m) return [];
  const raw = m[1]
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, "/")
    .replace(/\\\\/g, "\\");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    return [];
  }
  return ((data && data[0]) || [])
    .filter((it) => Array.isArray(it) && it[0] && it[2])
    .map((it) => ({ id: String(it[0]), name: String(it[2]), mime: String(it[3] || "") }));
}

const isFolder = (it) => /folder/.test(it.mime);
const findFile = (items, re) => items.find((it) => !isFolder(it) && re.test(it.name)) || null;

// O standings mais novo da pasta: a data vem no fim do nome (_aaaammdd_hhmm)
function newestStandings(items) {
  const stamp = (name) => {
    const m = /(\d{8})_(\d{4})\.json$/i.exec(name);
    return m ? m[1] + m[2] : "";
  };
  return (
    items
      .filter((it) => !isFolder(it) && /standings.*\.json$/i.test(it.name))
      .sort((a, b) => stamp(b.name).localeCompare(stamp(a.name)) || b.name.localeCompare(a.name))[0] || null
  );
}

// Cor do RLT (#AARRGGBB) como esta; o resto do app ja normaliza
const color = (c) => (c && String(c).trim()) || null;

// Pilotos do lineup no formato que rltClient.mergeLineupIntoStandings espera.
//   lineups: [{ Driver, Team, RaceNumber, ... }]   teams: [{ UniqueName, Name, FullName, Color, SecondaryColor }]
function lineupDrivers(lineups, teams, inGame) {
  const byTeam = new Map((teams || []).map((t) => [t.UniqueName, t]));
  return (lineups || [])
    .filter((s) => s && s.Driver)
    .map((s) => {
      const t = byTeam.get(s.Team) || null;
      const d = { driverName: s.Driver, driverInfo: { displayName: s.Driver, raceNumber: s.RaceNumber || null }, seatType: s.SeatType || null, classInfo: null, teamName: t ? t.Name : null };
      if (t) d.teamInfo = { fullName: t.FullName || t.Name, primaryColor: color(t.Color), secondaryColor: color(t.SecondaryColor) };
      const names = inGame.get(String(s.Driver).toLowerCase());
      if (names) d.inGameNames = names;
      return d;
    });
}

// Nomes no jogo de cada piloto (drivers.json): InGameName e as entradas do InGameNamesJson
function inGameNames(drivers) {
  const map = new Map();
  (drivers || []).forEach((d) => {
    if (!d || !d.Name) return;
    const names = new Set();
    if (d.InGameName) names.add(String(d.InGameName));
    try {
      const j = d.InGameNamesJson ? JSON.parse(d.InGameNamesJson) : null;
      ((j && j.entries) || []).forEach((e) => e && e.name && names.add(String(e.name)));
    } catch (_) {}
    if (names.size) map.set(String(d.Name).toLowerCase(), [...names]);
  });
  return map;
}

// Calendario a partir das etapas de cada piloto (as ja corridas) e da proxima etapa.
function seasonEvents(stats) {
  const byRound = new Map();
  ((stats && stats.driverStandings) || []).forEach((d) =>
    (d.events || []).forEach((e) => {
      if (e.roundNumber == null || byRound.has(e.roundNumber)) return;
      byRound.set(e.roundNumber, {
        eventId: null,
        round: e.roundNumber,
        name: e.eventName || null,
        trackName: e.trackName || null,
        uniqueName: e.uniqueName || null,
        circuitOrigin: e.circuitOrigin || null,
        eventDate: e.eventDate || null,
        completedStatus: "Completed",
        country: null,
        races: (e.races || []).map((r) => ({ caption: r.sessionName || null, completed: true })),
        qualifications: (e.qualifications || []).map((q) => ({ caption: q.sessionName || null, completed: true })),
      });
    })
  );
  const st = (stats && stats.status) || {};
  if (st.nextRoundName) {
    const round = byRound.size ? Math.max(...byRound.keys()) + 1 : 1;
    byRound.set(round, { eventId: null, round, name: st.nextRoundName, trackName: st.nextRoundName, uniqueName: null, circuitOrigin: null, eventDate: st.nextRoundDate || null, completedStatus: null, country: null, races: [], qualifications: [] });
  }
  return [...byRound.values()].sort((a, b) => a.round - b.round);
}

// Classes da temporada no formato da API (multiclass.classes)
function seasonClasses(stats) {
  return ((stats && stats.classes) || [])
    .map((c) => c && c.classInfo)
    .filter(Boolean)
    .map((c) => ({ uniqueName: c.uniqueName, name: c.name, abbreviation: c.abbreviation || null, color: c.color || null }));
}

// opts: { dataDir, fetchText(url) -> Promise<string> (testes), link (testes, sem criptografia) }
function createBackup(opts = {}) {
  const file = path.join(opts.dataDir || process.env.LLG_DATA_DIR || path.join(__dirname, ".."), "rlt-backup.json");
  let store = {};
  try {
    store = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch (_) {
    store = {};
  }
  const save = () => {
    try {
      fs.writeFileSync(file + ".tmp", JSON.stringify(store));
      fs.renameSync(file + ".tmp", file);
    } catch (_) {}
  };

  async function defaultFetch(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }
  const fetchText = opts.fetchText || defaultFetch;

  const rootId = () => folderIdFromLink(opts.link || secret.decrypt(FOLDER_LINK));

  // guarda so o que mudou (o arquivo inteiro e regravado a cada vez)
  function keep(key, value) {
    if (store[key] !== undefined && JSON.stringify(store[key]) === JSON.stringify(value)) return;
    store[key] = value;
    save();
  }

  // Lista de uma pasta; sem rede, a ultima guardada
  async function folder(id) {
    const key = `folder:${id}`;
    try {
      const items = parseFolderPage(await fetchText(`https://drive.google.com/drive/folders/${id}`));
      if (!items.length) throw new Error("pasta vazia ou sem acesso");
      keep(key, items);
      return items;
    } catch (err) {
      if (store[key]) return store[key];
      throw new Error(`Backup do Drive indisponivel: ${err.message}`);
    }
  }

  // Um JSON da pasta; sem rede, a ultima copia
  async function json(fileId) {
    const key = `file:${fileId}`;
    try {
      const data = JSON.parse(await fetchText(`https://drive.google.com/uc?export=download&id=${fileId}`));
      keep(key, data);
      return data;
    } catch (err) {
      if (store[key] !== undefined) return store[key];
      throw new Error(`Backup do Drive: nao foi possivel ler um arquivo (${err.message})`);
    }
  }

  // Temporadas do backup: [{ seasonId: "drive:<id>", seasonName }]
  async function listSeasons() {
    const id = rootId();
    if (!id) return [];
    const items = await folder(id);
    return items.filter(isFolder).map((f) => ({ seasonId: ID_PREFIX + f.id, seasonName: f.name, backup: true }));
  }

  // Tudo o que a temporada precisa, no formato da API do RLT:
  // { seasonName, classes, events, standings (com o lineup ainda nao juntado), lineupDrivers }
  async function loadSeason(seasonId) {
    const folderId = String(seasonId).slice(ID_PREFIX.length);
    const root = await folder(rootId());
    const items = await folder(folderId);
    const standingsFile = newestStandings(items);
    if (!standingsFile) throw new Error("Backup do Drive: a pasta da temporada nao tem o arquivo de standings");
    // as exportacoes antigas desta temporada nao servem mais: saem da copia guardada
    // (cada uma tem ~1 MB; sem isso o rlt-backup.json so cresceria)
    let pruned = false;
    items
      .filter((it) => !isFolder(it) && /standings.*\.json$/i.test(it.name) && it.id !== standingsFile.id)
      .forEach((it) => {
        if (store[`file:${it.id}`] !== undefined) {
          delete store[`file:${it.id}`];
          pruned = true;
        }
      });
    if (pruned) save();
    const lineupsFile = findFile(items, /^lineups\.json$/i);
    const driversFile = findFile(root, /^drivers\.json$/i);
    const teamsFile = findFile(root, /^teams\.json$/i);
    const [standings, lineups, drivers, teams] = await Promise.all([
      json(standingsFile.id),
      lineupsFile ? json(lineupsFile.id).catch(() => null) : null,
      driversFile ? json(driversFile.id).catch(() => null) : null,
      teamsFile ? json(teamsFile.id).catch(() => null) : null,
    ]);
    const stats = (standings && standings.seasonStatistics) || {};
    const inGame = inGameNames(drivers);
    // nome no jogo de quem esta na pontuacao (a exportacao nao traz)
    (stats.driverStandings || []).forEach((d) => {
      const names = inGame.get(String(d.driverName || "").toLowerCase());
      if (names && !d.inGameNames) d.inGameNames = names;
    });
    (stats.classes || []).forEach((c) =>
      ((c.classStatistics && c.classStatistics.driverStandings) || []).forEach((d) => {
        const names = inGame.get(String(d.driverName || "").toLowerCase());
        if (names && !d.inGameNames) d.inGameNames = names;
      })
    );
    const season = (standings && standings.season) || {};
    const folderName = ((root || []).find((f) => f.id === folderId) || {}).name;
    return {
      seasonName: season.seasonName || folderName || "Temporada (backup)",
      classes: seasonClasses(stats),
      events: seasonEvents(stats),
      standings,
      lineupDrivers: lineupDrivers(lineups, teams, inGame),
      file: standingsFile.name,
      exportedAt: (standings && standings.metadata && standings.metadata.exportedAt) || null,
    };
  }

  return { listSeasons, loadSeason };
}

module.exports = { createBackup, isBackupId, parseFolderPage, newestStandings, folderIdFromLink, seasonEvents, seasonClasses, lineupDrivers, inGameNames, ID_PREFIX };
