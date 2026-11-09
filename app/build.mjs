// app/build.mjs
// Gera a pasta do aplicativo (nao compactada) em dist/LLG Overlay-win32-x64,
// com o "LLG Overlay.exe" dentro. Uso: npm run build
// O codigo fica em resources/app, em arquivos normais: da pra editar o
// overlay/drivers-config.js direto na pasta gerada.

import { packager } from "@electron/packager";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// O que NAO vai para o aplicativo. O .env de quem compila pode ter outras
// coisas (senha do OBS, portas), entao ele nao e copiado. A chave do RLT tambem
// nao vai: o aplicativo pede a chave criptografada na primeira vez que abre.
const ignore = [
  /^\/dist($|\/)/,
  /^\/test($|\/)/,
  /^\/\.git($|\/)/,
  /^\/\.gitignore$/,
  /^\/\.vscode($|\/)/,
  /^\/\.claude($|\/)/,
  /^\/\.env$/,
  /^\/settings\.json$/,
  /^\/rlt-cache\.json(\.tmp)?$/,
  /^\/rlt-backup\.json(\.tmp)?$/,
  /^\/trackmaps\.json(\.tmp)?$/,
  /^\/server\/rlt-key\.enc$/,
  /^\/drivers-config_bak\.js$/,
  // headers dos jogos: so referencia para desenvolvimento, e os do LMU nao podem ser redistribuidos
  /^\/SharedMemory_LMU($|\/)/,
  /^\/SharedMemory_AMS2\.h$/,
  /^\/start\.bat$/,
  /^\/app\/build\.mjs$/,
  // script do instalador (o limpar.ps1 vai pelo proprio instalador)
  /^\/installer($|\/)/,
  // imagem original do icone e o script que gera app/icon.ico e app/icon.png
  /^\/icon\.png$/,
  /^\/app\/make-icon\.ps1$/,
  /^\/app\/make-voice-clips\.ps1$/,
  /^\/\.github($|\/)/,
  /^\/overlay\/assets\/\.git($|\/)/,
  /\.log$/,
];

// A pasta de saida nao pode estar em uso: com o LLG Overlay.exe aberto a
// partir dela, o Windows nao deixa apagar e o empacotamento falha.
process.on("uncaughtException", (err) => {
  if (err && (err.code === "EBUSY" || err.code === "EPERM")) {
    console.error("Nao foi possivel substituir a pasta dist: ela esta em uso.");
    console.error("Feche o LLG Overlay (e qualquer janela aberta nessa pasta) e rode de novo.");
    process.exit(1);
  }
  throw err;
});

const [outDir] = await packager({
  dir: root,
  name: "LLG Overlay",
  platform: "win32",
  arch: "x64",
  out: path.join(root, "dist"),
  overwrite: true,
  asar: false,
  prune: true,
  // icone do .exe (app/icon.ico, gerado por app/make-icon.ps1 a partir do icon.png)
  icon: path.join(root, "app", "icon.ico"),
  ignore,
});

// O Electron traz as traducoes do Chromium (menus de contexto, caixas de
// dialogo) em 55 idiomas, ~49 MB. Ficam so portugues, ingles e espanhol; num
// Windows em outro idioma o Chromium usa o en-US.
const KEEP_LOCALES = new Set(["en-US", "pt-BR", "pt-PT", "es", "es-419"]);
const localesDir = path.join(outDir, "locales");
for (const name of fs.readdirSync(localesDir)) {
  if (name.endsWith(".pak") && !KEEP_LOCALES.has(name.slice(0, -4))) fs.rmSync(path.join(localesDir, name));
}

fs.writeFileSync(
  path.join(outDir, "LEIA-ME.txt"),
  [
    "LLG Overlay",
    "===========",
    "",
    "1. Abra o \"LLG Overlay.exe\". A janela do painel de controle aparece.",
    "2. No painel, copie os links das overlays e cole como Fonte de Navegador no OBS.",
    "3. Abra o Automobilista 2, o Le Mans Ultimate ou o Assetto Corsa Competizione",
    "   e entre numa sessao.",
    "   Os dados aparecem sozinhos; o programa detecta qual jogo esta em sessao.",
    "",
    "Assetto Corsa Competizione: o jogo precisa estar com a API de transmissao ligada.",
    "Em Documentos\\Assetto Corsa Competizione\\Config\\broadcasting.json deixe",
    "\"updListenerPort\": 9000 e reabra o jogo.",
    "",
    "Racing League Tools: escolha a temporada no topo do painel e clique em Aplicar.",
    "A temporada fica salva para a proxima vez.",
    "",
    "Tabela do piloto: no painel, marque \"Mostrar sobre o jogo\". O jogo precisa",
    "estar em modo janela sem bordas (em tela cheia exclusiva a janela nao aparece).",
    "",
    "Cores, logos e tabela de pontos: edite resources\\app\\overlay\\drivers-config.js",
    "e reabra o programa. Nomes de pista do cabecalho: resources\\app\\overlay\\track-names.js",
    "",
    "Na primeira vez o Windows pode avisar que o aplicativo e desconhecido",
    "(SmartScreen), porque ele nao e assinado. Clique em \"Mais informacoes\" e",
    "\"Executar assim mesmo\".",
    "",
  ].join("\r\n")
);

console.log("Aplicativo gerado em:", outDir);
