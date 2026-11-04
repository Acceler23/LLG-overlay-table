const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createLibrary, slug, removeRegion } = require("../server/carsetLibrary");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const USER_XML = `<?xml version="1.0" encoding="utf-8" ?>
<USER_OVERRIDES>
<!-- minha pintura -->
<LIVERY_OVERRIDE LIVERY="52" NAME="Minha" BASELIVERY="51">
  <TEXTURE NAME="BODY" PATH="minha\\body.dds"/>
</LIVERY_OVERRIDE>
</USER_OVERRIDES>
`;

const CARSET_XML = `<USER_OVERRIDES>
<!-- Piloto A -->
<LIVERY_OVERRIDE LIVERY="51" NAME="Time A" BASELIVERY="51">
  <TEXTURE NAME="BODY" PATH="time_a\\body51.dds"/>
  <TEXTURE NAME="WINDOWS" PATH="time_a\\windows.dds"/>
  <PREVIEWIMAGE PATH="time_a\\preview.dds"/>
</LIVERY_OVERRIDE>
<!-- Piloto B: o ID 52 ja e do piloto -->
<LIVERY_OVERRIDE LIVERY="52" NAME="Time B" BASELIVERY="51">
  <TEXTURE NAME="BODY" PATH="time_b\\body52.dds"/>
</LIVERY_OVERRIDE>
<!-- Piloto C: sem a textura BODY no pacote -->
<LIVERY_OVERRIDE LIVERY="53" NAME="Time C" BASELIVERY="51">
  <TEXTURE NAME="BODY" PATH="time_c\\body53.dds"/>
</LIVERY_OVERRIDE>
</USER_OVERRIDES>
`;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llg-carset-lib-"));
  const ov = path.join(root, "jogo", "Overrides");
  write(path.join(ov, "bmw", "bmw.xml"), USER_XML);
  write(path.join(ov, "bmw", "minha", "body.dds"), "minha");
  write(path.join(ov, "bmw", "bmw_dist.xml"), "<do jogo/>");
  // pacote da liga, ja extraido: uma pasta por carro
  const pkg = path.join(root, "pacote", "Carset Liga");
  write(path.join(pkg, "bmw", "bmw.xml"), CARSET_XML);
  write(path.join(pkg, "bmw", "time_a", "body51.dds"), "a");
  write(path.join(pkg, "bmw", "time_a", "preview.dds"), "p");
  write(path.join(pkg, "bmw", "time_b", "body52.dds"), "b");
  write(path.join(pkg, "audi", "audi.xml"), CARSET_XML.replace(/51/g, "61"));
  write(path.join(pkg, "audi", "time_a", "body61.dds"), "a");
  const lib = createLibrary(path.join(root, "biblioteca"));
  return { root, ov, pkg, lib };
}

test("slug igual ao do Paint Shop", () => {
  assert.equal(slug("Liga X 2026"), "liga_x_2026");
  assert.equal(slug("Copa Clássica B - Temporada 2!"), "copa_classica_b_temporada_2");
});

test("ligar junta as pinturas entre marcadores; desligar devolve o XML como era", () => {
  const { root, ov, pkg, lib } = setup();
  try {
    const info = lib.importDir(pkg, "Liga X 2026", ov);
    assert.equal(info.cars, 2);
    assert.equal(info.active, false);

    const r = lib.activate("Liga X 2026", ov);
    assert.equal(r.applied, 1, "so o Time A entra");
    assert.ok(r.skipped.some((s) => s.includes("ID 52") && s.includes("ocupado")));
    assert.ok(r.skipped.some((s) => s.includes("ID 53") && s.includes("BODY")));
    assert.ok(r.skipped.some((s) => s.startsWith("audi") && s.includes("nao esta instalado")));
    assert.ok(r.warnings.some((s) => s.includes("windows.dds")), "textura que falta sai do bloco");

    const xml = fs.readFileSync(path.join(ov, "bmw", "bmw.xml"), "utf8");
    assert.ok(xml.includes("<!-- TRANSPLANTE-CARSET:liga_x_2026 -->"));
    assert.ok(xml.includes("<!-- /TRANSPLANTE-CARSET:liga_x_2026 -->"));
    assert.ok(xml.includes('PATH="carset_liga_x_2026\\time_a\\body51.dds"'));
    assert.ok(!xml.includes("windows.dds"));
    assert.ok(xml.includes('NAME="Minha"'), "a pintura do piloto continua");
    assert.ok(xml.includes("<!-- Piloto A -->"), "o comentario do dono vai junto");
    assert.ok(fs.existsSync(path.join(ov, "bmw", "carset_liga_x_2026", "time_a", "body51.dds")));
    assert.ok(fs.existsSync(path.join(ov, "bmw", "bmw.xml.pre-transplante")), "copia de seguranca");
    assert.equal(fs.readFileSync(path.join(ov, "bmw", "bmw_dist.xml"), "utf8"), "<do jogo/>");
    assert.equal(lib.isActive("Liga X 2026", ov), true);

    // ligar de novo nao duplica
    lib.activate("Liga X 2026", ov);
    const twice = fs.readFileSync(path.join(ov, "bmw", "bmw.xml"), "utf8");
    assert.equal(twice.split("TRANSPLANTE-CARSET:liga_x_2026 -->").length - 1, 2, "um par de marcadores so");

    lib.deactivate("Liga X 2026", ov);
    assert.equal(fs.readFileSync(path.join(ov, "bmw", "bmw.xml"), "utf8"), USER_XML, "XML do piloto intacto");
    assert.ok(!fs.existsSync(path.join(ov, "bmw", "carset_liga_x_2026")));
    assert.ok(fs.existsSync(path.join(ov, "bmw", "minha", "body.dds")));
    assert.equal(lib.isActive("Liga X 2026", ov), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("carro sem XML no jogo ganha um novo; dois carsets convivem", () => {
  const { root, ov, pkg, lib } = setup();
  try {
    fs.mkdirSync(path.join(ov, "audi"), { recursive: true });
    lib.importDir(pkg, "Liga X", ov);
    lib.importDir(pkg, "Outra Liga", ov);
    lib.activate("Liga X", ov);
    const audi = fs.readFileSync(path.join(ov, "audi", "audi.xml"), "utf8");
    assert.ok(audi.startsWith("<?xml"));
    assert.ok(audi.includes("TRANSPLANTE-CARSET:liga_x"));
    // a segunda liga usa os mesmos IDs: ficam de fora, sem estragar a primeira
    const r2 = lib.activate("Outra Liga", ov);
    assert.ok(r2.skipped.some((s) => s.includes("ocupado")));
    lib.deactivate("Outra Liga", ov);
    assert.ok(fs.readFileSync(path.join(ov, "audi", "audi.xml"), "utf8").includes("TRANSPLANTE-CARSET:liga_x"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tirar regiao: so o que esta entre os marcadores daquele carset", () => {
  const xml = "<USER_OVERRIDES>\n<!-- TRANSPLANTE-CARSET:a -->\nX\n<!-- /TRANSPLANTE-CARSET:a -->\n<!-- TRANSPLANTE-CARSET:b -->\nY\n<!-- /TRANSPLANTE-CARSET:b -->\n</USER_OVERRIDES>\n";
  assert.equal(removeRegion(xml, "a"), "<USER_OVERRIDES>\n<!-- TRANSPLANTE-CARSET:b -->\nY\n<!-- /TRANSPLANTE-CARSET:b -->\n</USER_OVERRIDES>\n");
  assert.equal(removeRegion(xml, "c"), null);
});
