// installer/gerar.mjs
// Gera o instalador dist/LLG-Overlay-Setup-vX.Y.Z.exe. Uso: npm run installer
//   1. monta o aplicativo (npm run build), a nao ser que receba --sem-build
//   2. chama o compilador do Inno Setup 6 (ISCC.exe) com a versao do package.json
// Precisa do Inno Setup 6: winget install JRSoftware.InnoSetup
// (ou a variavel ISCC com o caminho do ISCC.exe).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function findIscc() {
  const candidates = [
    process.env.ISCC,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 6", "ISCC.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Inno Setup 6", "ISCC.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Inno Setup 6", "ISCC.exe"),
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

const iscc = findIscc();
if (!iscc) {
  console.error("Nao achei o Inno Setup 6 (ISCC.exe).");
  console.error("Instale com:  winget install JRSoftware.InnoSetup");
  process.exit(1);
}

if (!process.argv.includes("--sem-build")) {
  execFileSync(process.execPath, [path.join(root, "app", "build.mjs")], { stdio: "inherit", cwd: root });
}

const source = path.join(root, "dist", "LLG Overlay-win32-x64");
if (!fs.existsSync(path.join(source, "LLG Overlay.exe"))) {
  console.error(`Nao achei o aplicativo montado em ${source}. Rode sem --sem-build.`);
  process.exit(1);
}

execFileSync(iscc, ["/Qp", `/DAppVersion=${version}`, `/DSourceDir=${source}`, path.join(here, "llg-overlay.iss")], {
  stdio: "inherit",
  cwd: here,
});

console.log("Instalador gerado:", path.join(root, "dist", `LLG-Overlay-Setup-v${version}.exe`));
