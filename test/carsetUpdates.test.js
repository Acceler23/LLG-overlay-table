const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseList, updateDate, updateStatus, sameSource } = require("../server/carsets");
const { createLibrary } = require("../server/carsetLibrary");

const LINK = "https://drive.google.com/file/d/abc/view";
const remote = (extra) => Object.assign({ link: LINK, size: 100, lastModified: "Mon, 09 Nov 2026 18:27:13 GMT", filename: "carset.rar" }, extra);

test("lista da liga: a data da versao (Update, aaaammdd)", () => {
  const list = parseList([
    { Season: "A", Update: 20261109, CarSet: LINK },
    { Season: "B", Update: "20261104", CarSet: LINK },
    { Season: "C", CarSet: LINK },
    { Season: "D", Update: "09/11/2026", CarSet: LINK },
  ]);
  assert.deepEqual(list.map((x) => x.update), [20261109, 20261104, null, null]);
  assert.equal(updateDate(20261340), null, "mes invalido");
});

test("atualizacao: data da lista mais nova que a baixada", () => {
  const item = { season: "A", link: LINK, update: 20261109 };
  assert.equal(updateStatus(Object.assign(remote(), { update: 20261104 }), item, remote(), 20261104), "update");
  assert.equal(updateStatus(Object.assign(remote(), { update: 20261109 }), item, remote(), 20261109), "ok");
});

test("atualizacao: arquivo trocado no Drive sem mudar a data tambem conta", () => {
  const item = { season: "A", link: LINK, update: 20261109 };
  const saved = Object.assign(remote(), { update: 20261109 });
  assert.equal(updateStatus(saved, item, remote({ size: 999 }), 20261109), "update");
  assert.equal(updateStatus(saved, item, null, 20261109), "ok", "sem ler o Drive, vale a data");
  assert.equal(sameSource(saved, remote({ lastModified: "outra" })), false);
});

test("atualizacao: baixado antes do registro usa o dia da pasta", () => {
  const item = { season: "A", link: LINK, update: 20261109 };
  assert.equal(updateStatus(null, item, remote(), 20261104), "update");
  assert.equal(updateStatus(null, item, remote(), 20261110), "ok");
  assert.equal(updateStatus(null, { season: "A", link: LINK, update: null }, remote(), 20261104), "unknown");
});

test("biblioteca: guarda a origem, sabe o dia e apaga so dentro dela", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llg-carset-up-"));
  try {
    const libDir = path.join(root, "biblioteca");
    fs.mkdirSync(path.join(libDir, "Copa X", "bmw"), { recursive: true });
    fs.writeFileSync(path.join(libDir, "Copa X", "bmw", "bmw.xml"), '<LIVERY_OVERRIDE LIVERY="51" NAME="A"><TEXTURE NAME="BODY" PATH="a.dds"/></LIVERY_OVERRIDE>');
    fs.writeFileSync(path.join(root, "fora.txt"), "nao apagar");
    const lib = createLibrary(libDir);
    lib.setSource("Copa X", { link: LINK, update: 20261109 });
    assert.equal(lib.getSource("Copa X").update, 20261109);
    assert.ok(lib.downloadedDay("Copa X") >= 20260101);
    assert.throws(() => lib.remove("..", null), /invalido/);
    assert.throws(() => lib.remove("../fora.txt", null), /invalido/);
    assert.equal(lib.remove("Copa X", null), true);
    assert.equal(fs.existsSync(path.join(libDir, "Copa X")), false);
    assert.equal(fs.existsSync(path.join(root, "fora.txt")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
