// server/avatars.js
// Fotos dos pilotos para o driver card. Ficam numa pasta local, fora do
// aplicativo (padrao: Documentos\LLG Overlay\Fotos dos pilotos), com o caminho
// escolhido no painel. O servidor serve as fotos em /overlay/avatars/ e manda a
// lista de arquivos para as overlays, que acham a foto pelo nome
// (overlay/shared/avatars.js): "<nome no RLT>__<nome no jogo>.png".

const fs = require("fs");
const os = require("os");
const path = require("path");

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const DEFAULT_DIR = path.join(os.homedir(), "Documents", "LLG Overlay", "Fotos dos pilotos");

// Arquivos de imagem da pasta e a data da mudanca mais recente (para as
// overlays recarregarem uma foto trocada com o mesmo nome).
function list(dir) {
  let files = [];
  let version = 0;
  try {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      if (!e.isFile() || !IMAGE_RE.test(e.name)) return;
      files.push(e.name);
      try {
        version = Math.max(version, fs.statSync(path.join(dir, e.name)).mtimeMs);
      } catch (_) {}
    });
  } catch (_) {
    files = [];
  }
  return { files: files.sort(), version: String(Math.round(version)) };
}

// A pasta padrao e criada na primeira vez (para o usuario saber onde por as fotos)
function ensureDefault() {
  try {
    fs.mkdirSync(DEFAULT_DIR, { recursive: true });
  } catch (_) {}
  return DEFAULT_DIR;
}

module.exports = { DEFAULT_DIR, list, ensureDefault };
