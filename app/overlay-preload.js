// app/overlay-preload.js
// Ponte das janelas do piloto (tabela, telemetria) com o aplicativo: no modo de
// edicao, a barrinha de cada janela muda o tamanho dela. Fora do aplicativo
// (overlay aberta no navegador ou no OBS) window.llgOverlay nao existe.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("llgOverlay", {
  scaleBy: (delta) => ipcRenderer.send("pilot:scaleBy", delta),
  lock: () => ipcRenderer.send("pilot:lock"),
});
