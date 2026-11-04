// app/preload.js
// Ponte entre a pagina do painel e o aplicativo. Fora do aplicativo (painel
// aberto no navegador) window.llgApp nao existe e o painel esconde os
// controles que dependem dele.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("llgApp", {
  info: () => ipcRenderer.invoke("app:info"),
  openPath: (target) => ipcRenderer.invoke("app:openPath", target),
  // procura uma versao nova no GitHub; devolve o texto do resultado
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  driver: {
    get: () => ipcRenderer.invoke("driver:get"),
    set: (patch) => ipcRenderer.invoke("driver:set", patch),
  },
  // overlays do piloto (tabela, telemetria) e o modo de edicao na tela
  pilot: {
    get: () => ipcRenderer.invoke("pilot:get"),
    set: (patch) => ipcRenderer.invoke("pilot:set", patch),
    // a barrinha de uma janela em edicao mudou algo (tamanho, travou)
    onChange: (fn) => ipcRenderer.on("pilot:changed", (_e, s) => fn(s)),
  },
  // programas que abrem junto com o aplicativo (lista montada pelo usuario no painel)
  companion: {
    get: () => ipcRenderer.invoke("companion:get"),
    add: () => ipcRenderer.invoke("companion:add"),
    remove: (file) => ipcRenderer.invoke("companion:remove", file),
    launch: (file) => ipcRenderer.invoke("companion:launch", file),
    launchAll: () => ipcRenderer.invoke("companion:launchAll"),
  },
});
