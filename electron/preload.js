"use strict";

/**
 * Preload for the Settings window only. The main window runs with `sandbox:
 * true` and no preload at all — it is a plain browser view onto the local Next
 * server, so it has no business touching the filesystem or the credentials.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("settingsApi", {
  fields: () => ipcRenderer.invoke("config:fields"),
  read: () => ipcRenderer.invoke("config:read"),
  path: () => ipcRenderer.invoke("config:path"),
  save: (values) => ipcRenderer.invoke("config:write", values),
  dbPath: () => ipcRenderer.invoke("config:dbPath"),
  revealDb: () => ipcRenderer.invoke("config:revealDb"),
});
