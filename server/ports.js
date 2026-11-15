// server/ports.js
//
// Porta do aplicativo (painel e overlays, padrao 8080). Outro programa pode ja
// usar a 8080 (ex: o software do volante PNX); entao ela pode ser trocada, no
// painel (Ajustes > Sistema) ou ao abrir, quando a porta estiver ocupada.

const net = require("net");

const DEFAULT_HTTP_PORT = 8080;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

function validPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT ? n : null;
}

function canListen(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    if (host) probe.listen(port, host);
    else probe.listen(port);
  });
}

// So este computador (127.0.0.1) consegue abrir a porta? No Windows outro
// programa pode ouvir so em 127.0.0.1:8080 (ex: o painel do servidor AMS2) e o
// aplicativo ainda abriria a 8080 em todos os enderecos; ai o painel do app
// (que abre 127.0.0.1) mostrava a pagina do outro programa.
function isLocalPortFree(port) {
  return canListen(port, "127.0.0.1");
}

// A porta esta livre agora? Em todos os enderecos e tambem em 127.0.0.1.
async function isPortFree(port) {
  return (await canListen(port)) && (await isLocalPortFree(port));
}

// A primeira porta livre a partir de start (pulando as de avoid)
async function findFreePort(start, avoid = []) {
  for (let p = start; p <= Math.min(MAX_PORT, start + 200); p++) {
    if (avoid.includes(p)) continue;
    if (await isPortFree(p)) return p;
  }
  return null;
}

module.exports = { DEFAULT_HTTP_PORT, validPort, isPortFree, isLocalPortFree, findFreePort };
