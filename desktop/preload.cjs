const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "lanternDesktop",
  Object.freeze({
    info: () => ipcRenderer.invoke("desktop:info"),
    pause: () => ipcRenderer.invoke("desktop:pause"),
    hide: () => ipcRenderer.invoke("desktop:hide"),
    quit: () => ipcRenderer.invoke("desktop:quit"),
  }),
);
