// server/wsServer.js
// Canal bidirecional:
//  - servidor -> clientes: telemetria em tempo real (broadcast)
//  - clientes -> servidor: comandos/inputs (troca de pagina da overlay,
//    forcar evento, pedir status do OBS, etc.)

const { WebSocketServer } = require("ws");

function createWsServer(httpServer, options) {
  const opts = options || {};
  const wss = new WebSocketServer({ server: httpServer, path: "/ws", verifyClient: opts.verifyClient });

  const clients = new Set();
  const commandHandlers = new Map(); // registrado por outros modulos (ex: obsController)

  let onConnectHook = null;

  wss.on("connection", (socket, req) => {
    // so quem pode mandar comandos (este computador); outros aparelhos da rede so recebem os dados
    socket.canCommand = typeof opts.canCommand === "function" ? !!opts.canCommand(req) : true;
    clients.add(socket);
    console.log(`Cliente conectado (${clients.size} ativos)`);
    if (typeof onConnectHook === "function") {
      try { onConnectHook(socket); } catch (e) { console.warn("onConnectHook", e.message); }
    }

    socket.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (err) {
        console.warn("Mensagem invalida recebida:", raw.toString());
        return;
      }

      // Formato esperado: { type: "command", name: "...", payload: {...} }
      if (msg.type === "command" && !socket.canCommand) return; // aparelho da rede: so le
      if (msg.type === "command") {
        if (msg.name && String(msg.name).startsWith("overlay.")) {
          // o servidor pode observar um comando das overlays (ex: guardar a opacidade
          // por jogo) sem deixar de repassar
          if (commandHandlers.has(msg.name)) {
            try {
              commandHandlers.get(msg.name)(msg.payload || {}, socket);
            } catch (err) {
              console.warn("Erro ao observar " + msg.name + ":", err.message);
            }
          }
          const payload = JSON.stringify({ type: "overlayCommand", name: msg.name, payload: msg.payload || {} });
          for (const c of clients) {
            if (c.readyState === c.OPEN) c.send(payload);
          }
          return;
        }
        if (commandHandlers.has(msg.name)) {
          commandHandlers.get(msg.name)(msg.payload, socket);
        } else {
          console.log("Comando sem handler registrado:", msg);
        }
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
      console.log(`Cliente desconectado (${clients.size} ativos)`);
    });
  });

  return {
    raw: wss,
    broadcast(obj) {
      const payload = JSON.stringify(obj);
      for (const c of clients) {
        if (c.readyState === c.OPEN) c.send(payload);
      }
    },
    // Permite que outros modulos (ex: obsController.js) reajam a comandos
    // vindos da overlay/painel sem acoplar tudo neste arquivo.
    onCommand(name, handler) {
      commandHandlers.set(name, handler);
    },
    onConnect(handler) {
      onConnectHook = handler;
    },
    // fecha as conexoes de quem nao e deste computador (rede local desligada)
    dropRemote() {
      for (const c of clients) {
        if (!c.canCommand) c.terminate();
      }
    },
  };
}

module.exports = { createWsServer };
