// server/carsetLibrary.js
//
// Ligar e desligar carsets no Automobilista 2 sem tocar nas pinturas do piloto.
// E a mesma logica do Cubic Paint Shop (codigo_rust/src/carset.rs), no mesmo
// formato de arquivos, entao os dois programas se entendem: um carset ligado
// por um aparece ligado no outro, e qualquer um desliga.
//
// Um carset e uma pasta com, por carro, um <carro>.xml (um LIVERY_OVERRIDE por
// pintura) e as texturas que ele cita. Ele fica guardado numa biblioteca
// (pasta do LLG Overlay), sem mexer no jogo.
//   LIGAR     copia so as texturas usadas para Overrides\<carro>\carset_<nome>\
//             e junta os blocos no <carro>.xml do jogo, entre marcadores
//             <!-- TRANSPLANTE-CARSET:<nome> --> ... <!-- /TRANSPLANTE-CARSET:<nome> -->
//   DESLIGAR  tira exatamente isso (os marcadores, o que esta entre eles e a pasta carset_<nome>)
// As pinturas do piloto (fora dos marcadores) nunca sao tocadas, um ID de
// pintura ja ocupado nunca e sobrescrito e o <carro>_dist.xml do jogo nunca e lido nem escrito.
// Uma excecao: a pintura fora dos marcadores que e a MESMA do carset (mesmo ID,
// mesmo nome e a textura BODY igual, byte a byte) e uma copia dele instalada
// por fora (instalador antigo, a mao). Ao ligar, ela passa para dentro dos
// marcadores, e o carset assume: desligar tira ela tambem. As texturas dessa
// copia antiga ficam onde estavam.

const fs = require("fs");
const path = require("path");

const TAG = "TRANSPLANTE-CARSET"; // o mesmo do Paint Shop
const HEADER = '<?xml version="1.0" encoding="utf-8" ?>\n<USER_OVERRIDES>\n';
const FOOTER = "</USER_OVERRIDES>\n";

// ---------------------------------------------------------------- leitura do XML
// Sem biblioteca: o formato e simples e os arquivos dos pilotos sao baguncados.

// Valor de um atributo na primeira tag do texto (NAME="...", aspas simples ou duplas)
function attr(text, name) {
  const end = text.indexOf(">");
  const tag = end < 0 ? text : text.slice(0, end);
  const pat = `${name}=`;
  let from = 0;
  for (;;) {
    const p = tag.indexOf(pat, from);
    if (p < 0) return null;
    if (p === 0 || /\s/.test(tag[p - 1])) {
      const q = tag[p + pat.length];
      if (q === '"' || q === "'") {
        const rest = tag.slice(p + pat.length + 1);
        const e = rest.indexOf(q);
        return e < 0 ? null : rest.slice(0, e);
      }
    }
    from = p + pat.length;
  }
}

// Blocos LIVERY_OVERRIDE fora de comentarios: [inicio, fim, ultimo comentario antes dele]
function blocks(xml) {
  const close = "</LIVERY_OVERRIDE>";
  const out = [];
  let i = 0;
  let last = "";
  for (;;) {
    const p = xml.indexOf("<", i);
    if (p < 0) break;
    if (xml.startsWith("<!--", p)) {
      const e = xml.indexOf("-->", p + 4);
      if (e < 0) break;
      const c = xml.slice(p + 4, e).trim().split(/\s+/).join(" ");
      if (!c.startsWith(TAG) && !c.startsWith(`/${TAG}`)) last = c;
      i = e + 3;
    } else if (xml.startsWith("<LIVERY_OVERRIDE", p)) {
      const e = xml.indexOf(close, p);
      const end = e < 0 ? xml.length : e + close.length;
      out.push([p, end, last]);
      last = "";
      i = end;
    } else {
      i = p + 1;
    }
  }
  return out;
}

// <TEXTURE .../> e <PREVIEWIMAGE .../> de um bloco: { ini, fim, nome, path }
function elements(block) {
  const out = [];
  let i = 0;
  for (;;) {
    const p = block.indexOf("<", i);
    if (p < 0) break;
    const rest = block.slice(p);
    if (rest.startsWith("<PREVIEWIMAGE") || rest.startsWith("<TEXTURE")) {
      const e = rest.indexOf(">");
      const end = e < 0 ? block.length : p + e + 1;
      const el = block.slice(p, end);
      const pth = attr(el, "PATH");
      if (pth != null) {
        const nome = rest.startsWith("<PREVIEWIMAGE") ? "PREVIEW" : String(attr(el, "NAME") || "").toUpperCase();
        out.push({ ini: p, fim: end, nome, path: pth });
      }
      i = Math.max(end, p + 1);
    } else if (rest.startsWith("<!--")) {
      const e = rest.indexOf("-->");
      i = e < 0 ? block.length : p + e + 3;
    } else {
      i = p + 1;
    }
  }
  return out;
}

// Refaz o bloco: fn devolve o novo caminho de cada textura, ou null para tirar o elemento
function rewrite(block, fn) {
  let out = "";
  let pos = 0;
  for (const e of elements(block)) {
    out += block.slice(pos, e.ini);
    const novo = fn(e);
    if (novo != null) out += block.slice(e.ini, e.fim).replace(e.path, novo);
    pos = e.fim;
  }
  return out + block.slice(pos);
}

function livery(car, text, comment) {
  const id = parseInt(String(attr(text, "LIVERY") || "").trim(), 10);
  if (!Number.isFinite(id)) return null;
  return {
    car,
    id,
    name: String(attr(text, "NAME") || "").trim(),
    owner: comment,
    block: text,
    textures: elements(text).map((e) => e.path),
  };
}

function liveriesOf(car, xml) {
  return blocks(xml)
    .map(([a, b, c]) => livery(car, xml.slice(a, b), c))
    .filter(Boolean);
}

function marker(sl, end) {
  return `<!-- ${end ? "/" : ""}${TAG}:${sl} -->`;
}

// Tira a regiao de um carset do XML do jogo (os marcadores e tudo entre eles); null se nao ha
function removeRegion(xml, sl) {
  const mi = marker(sl, false);
  const mf = marker(sl, true);
  const a = xml.indexOf(mi);
  if (a < 0) return null;
  const bRel = xml.indexOf(mf, a);
  if (bRel < 0) return null;
  const b = bRel + mf.length;
  const lineStart = xml.lastIndexOf("\n", a - 1) + 1;
  const ini = xml.slice(lineStart, a).trim() === "" ? lineStart : a;
  const nl = xml.indexOf("\n", b);
  const fim = nl >= 0 && xml.slice(b, nl).trim() === "" ? nl + 1 : b;
  return xml.slice(0, ini) + xml.slice(fim);
}

// Trechos [inicio, fim] do XML que estao entre marcadores de algum carset
function regions(xml) {
  const out = [];
  const open = `<!-- ${TAG}:`;
  let i = 0;
  for (;;) {
    const a = xml.indexOf(open, i);
    if (a < 0) break;
    const nameEnd = xml.indexOf(" -->", a);
    if (nameEnd < 0) break;
    const sl = xml.slice(a + open.length, nameEnd);
    const close = xml.indexOf(`<!-- /${TAG}:${sl} -->`, nameEnd);
    const b = close < 0 ? xml.length : close;
    out.push([a, b]);
    i = b + 1;
  }
  return out;
}

// Tira um trecho do XML junto com a linha em branco que ele deixaria
function cut(xml, a, b) {
  const lineStart = xml.lastIndexOf("\n", a - 1) + 1;
  const ini = xml.slice(lineStart, a).trim() === "" ? lineStart : a;
  const nl = xml.indexOf("\n", b);
  const fim = nl >= 0 && xml.slice(b, nl).trim() === "" ? nl + 1 : b;
  return xml.slice(0, ini) + xml.slice(fim);
}

function sameFile(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch (_) {
    return false;
  }
}

// A pintura do jogo (fora dos marcadores) com o ID de `mine` e uma copia dela?
// Devolve [inicio, fim] do bloco no XML do jogo, ou null.
//   gameCar: pasta do carro no jogo; base: pasta do xml do carset
function findCopy(car, xml, mine, gameCar, base) {
  const inside = regions(xml);
  const myBody = elements(mine.block).find((e) => e.nome === "BODY");
  if (!myBody) return null;
  for (const [a, b, c] of blocks(xml)) {
    if (inside.some(([ra, rb]) => a >= ra && a < rb)) continue;
    const l = livery(car, xml.slice(a, b), c);
    if (!l || l.id !== mine.id || l.name.toLowerCase() !== mine.name.toLowerCase()) continue;
    const body = elements(l.block).find((e) => e.nome === "BODY");
    if (body && sameFile(join(gameCar, body.path), join(base, myBody.path))) return [a, b];
  }
  return null;
}

function insertBeforeEnd(xml, part) {
  const p = xml.lastIndexOf("</USER_OVERRIDES>");
  return p >= 0 ? `${xml.slice(0, p)}${part}\n${xml.slice(p)}` : `${HEADER}${part}\n${FOOTER}`;
}

// ---------------------------------------------------------------- caminhos e arquivos

// O nome do carset nos marcadores e na pasta carset_<slug> (igual ao Paint Shop)
function slug(name) {
  const map = { á: "a", à: "a", â: "a", ã: "a", ä: "a", é: "e", è: "e", ê: "e", ë: "e", í: "i", ì: "i", î: "i", ï: "i", ó: "o", ò: "o", ô: "o", õ: "o", ö: "o", ú: "u", ù: "u", û: "u", ü: "u", ç: "c" };
  let s = "";
  for (const ch of String(name).toLowerCase()) {
    const c = map[ch] || ch;
    if (/^[a-z0-9]$/.test(c)) s += c;
    else if (s && !s.endsWith("_")) s += "_";
  }
  return s.replace(/_+$/, "");
}

// Junta um caminho do XML (pasta\arquivo.dds) a uma base; ignora .. para nunca sair dela
function join(base, rel) {
  return path.join(base, ...String(rel).split(/[\\/]+/).filter((c) => c && c !== "." && c !== ".."));
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    if (e.isDirectory()) copyDir(src, path.join(to, e.name));
    else if (!e.name.toLowerCase().endsWith("_dist.xml")) copyFile(src, path.join(to, e.name));
  }
}

// Os <carro>.xml com pinturas dentro de uma pasta (qualquer nivel, menos os _dist.xml do jogo)
function findXmls(root, depth = 0) {
  let out = [];
  let list;
  try {
    list = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of list) {
    const p = path.join(root, e.name);
    const low = e.name.toLowerCase();
    if (e.isDirectory() && depth < 8) out = out.concat(findXmls(p, depth + 1));
    else if (low.endsWith(".xml") && !low.endsWith("_dist.xml")) {
      try {
        if (fs.readFileSync(p, "utf8").includes("LIVERY_OVERRIDE")) out.push(p);
      } catch (_) {}
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------- a biblioteca

function createLibrary(libDir) {
  // os xmls guardados de um carset: [{ car, file }]
  function xmls(name) {
    return findXmls(path.join(libDir, name)).map((file) => ({ car: path.basename(file, path.extname(file)), file }));
  }

  function has(name) {
    return xmls(name).length > 0;
  }

  function isActive(name, overrides) {
    if (!overrides) return false;
    const m = marker(slug(name), false);
    return xmls(name).some(({ car }) => {
      try {
        return fs.readFileSync(path.join(overrides, car, `${car}.xml`), "utf8").includes(m);
      } catch (_) {
        return false;
      }
    });
  }

  function info(name, overrides) {
    const list = xmls(name);
    const liveries = list.reduce((n, { car, file }) => n + liveriesOf(car, fs.readFileSync(file, "utf8")).length, 0);
    return { name, cars: new Set(list.map((x) => x.car)).size, liveries, active: isActive(name, overrides) };
  }

  function list(overrides) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(libDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("."));
    } catch (_) {}
    return dirs.map((d) => info(d.name, overrides)).filter((c) => c.cars > 0).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Guarda uma pasta extraida como o carset `name` (substitui um de mesmo nome).
  function importDir(source, name, overrides) {
    const files = findXmls(source);
    if (!files.length) throw new Error("Nao achei nenhum <carro>.xml com pinturas nesse pacote.");
    const dest = path.join(libDir, name);
    if (fs.existsSync(dest)) {
      deactivate(name, overrides);
      fs.rmSync(dest, { recursive: true, force: true });
    }
    const copied = [];
    for (const file of files) {
      const dir = path.dirname(file);
      if (copied.includes(dir)) continue;
      const base = path.basename(dir) || "carro";
      let target = path.join(dest, base);
      for (let n = 2; fs.existsSync(target); n++) target = path.join(dest, `${base}__${n}`);
      copyDir(dir, target);
      copied.push(dir);
    }
    return info(name, overrides);
  }

  // Liga o carset no jogo. Pinturas com ID ja ocupado ou sem a textura BODY ficam de fora e sao listadas.
  function activate(name, overrides) {
    if (!overrides) throw new Error("Nao achei a pasta de pinturas do Automobilista 2.");
    deactivate(name, overrides);
    const sl = slug(name);
    const texDir = `carset_${sl}`;
    const report = { applied: 0, adopted: 0, skipped: [], warnings: [] };
    for (const { car, file } of xmls(name)) {
      const gameCar = path.join(overrides, car);
      if (!fs.existsSync(gameCar)) {
        report.skipped.push(`${car}: o carro nao esta instalado no jogo`);
        continue;
      }
      const base = path.dirname(file);
      const gameXml = path.join(gameCar, `${car}.xml`);
      let current = "";
      try {
        current = fs.readFileSync(gameXml, "utf8");
      } catch (_) {}
      const taken = liveriesOf(car, current).map((l) => l.id);
      const added = [];
      for (const l of liveriesOf(car, fs.readFileSync(file, "utf8"))) {
        const label = `${car} ID ${l.id} (${l.name})`;
        if (taken.includes(l.id)) {
          // a mesma pintura, instalada por fora: o carset assume (sai de la e entra nos marcadores)
          const copy = findCopy(car, current, l, gameCar, base);
          if (!copy) {
            report.skipped.push(`${label}: ID ja ocupado no jogo`);
            continue;
          }
          current = cut(current, copy[0], copy[1]);
          taken.splice(taken.indexOf(l.id), 1);
          report.adopted++;
        }
        const body = elements(l.block).find((e) => e.nome === "BODY");
        if (!body || !fs.existsSync(join(base, body.path))) {
          report.skipped.push(`${label}: falta a textura BODY`);
          continue;
        }
        const copies = [];
        const block = rewrite(l.block, (e) => {
          const src = join(base, e.path);
          if (!fs.existsSync(src)) {
            report.warnings.push(`${label}: faltava ${e.path} (tirada)`);
            return null;
          }
          const rel = e.path.replace(/\//g, "\\").replace(/^\\+/, "");
          copies.push([src, join(path.join(gameCar, texDir), rel)]);
          return `${texDir}\\${rel}`;
        });
        copies.forEach(([from, to]) => copyFile(from, to));
        taken.push(l.id);
        const owner = l.owner ? `<!-- ${l.owner.replace(/--/g, "-")} -->\n` : "";
        added.push(owner + block);
      }
      if (!added.length) continue;
      const region = `${marker(sl, false)}\n${added.join("\n\n")}\n${marker(sl, true)}`;
      if (fs.existsSync(gameXml)) {
        const bak = `${gameXml}.pre-transplante`; // copia de seguranca da primeira vez (igual ao Paint Shop)
        if (!fs.existsSync(bak)) {
          try {
            fs.copyFileSync(gameXml, bak);
          } catch (_) {}
        }
      }
      report.applied += added.length;
      fs.writeFileSync(gameXml, insertBeforeEnd(current, region));
    }
    return report;
  }

  // Tira do jogo tudo o que activate pos (blocos e texturas); o resto do XML fica como estava.
  function deactivate(name, overrides) {
    if (!overrides) return;
    const sl = slug(name);
    let cars = [];
    try {
      cars = fs.readdirSync(overrides, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch (_) {
      return;
    }
    for (const e of cars) {
      fs.rmSync(path.join(overrides, e.name, `carset_${sl}`), { recursive: true, force: true });
      const xml = path.join(overrides, e.name, `${e.name}.xml`);
      let text;
      try {
        text = fs.readFileSync(xml, "utf8");
      } catch (_) {
        continue;
      }
      const novo = removeRegion(text, sl);
      if (novo != null) fs.writeFileSync(xml, novo);
    }
  }

  // De onde o carset foi baixado: { link, size, lastModified, filename, downloadedAt }.
  // Fica num arquivo dentro da pasta do carset; serve para procurar atualizacao.
  const SOURCE_FILE = ".llg-source.json";
  function getSource(name) {
    try {
      return JSON.parse(fs.readFileSync(path.join(libDir, name, SOURCE_FILE), "utf8"));
    } catch (_) {
      return null;
    }
  }

  function setSource(name, source) {
    try {
      fs.writeFileSync(path.join(libDir, name, SOURCE_FILE), JSON.stringify(source, null, 2));
    } catch (_) {}
  }

  // Apaga o carset: tira do jogo (desliga) e da biblioteca. Pode ser baixado de novo.
  function remove(name, overrides) {
    const dir = path.join(libDir, name);
    // so uma pasta logo abaixo da biblioteca (nome com ".." ou barra nao sai dela)
    const rel = path.relative(libDir, dir);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || /[\\/]/.test(rel)) throw new Error("Nome de carset invalido.");
    deactivate(name, overrides);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  // Dia (aaaammdd) em que o carset entrou na biblioteca: para os baixados antes do
  // registro de versao (.llg-source.json), que nao sabem a data da versao
  function downloadedDay(name) {
    try {
      const st = fs.statSync(path.join(libDir, name));
      const t = Math.min(...[st.birthtimeMs, st.mtimeMs].filter((x) => x > 0));
      const d = new Date(t);
      return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    } catch (_) {
      return null;
    }
  }

  return { list, has, info, importDir, activate, deactivate, isActive, getSource, setSource, remove, downloadedDay };
}

module.exports = { createLibrary, slug, attr, blocks, elements, liveriesOf, removeRegion, TAG };
