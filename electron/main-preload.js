"use strict";

/**
 * Preload for the main window.
 *
 * The window is otherwise a plain sandboxed browser view onto the local Next
 * server, so this bridge is deliberately tiny: a native folder picker and a
 * "reveal in Finder" helper. It exposes no filesystem read/write of its own —
 * the actual scanning and moving happens server-side in the Next process, which
 * already runs with the user's privileges.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  isDesktop: true,
  /** Native directory chooser. Resolves to an absolute path, or null if cancelled. */
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  /** Open a path in Finder. */
  reveal: (target) => ipcRenderer.invoke("shell:reveal", target),
});
