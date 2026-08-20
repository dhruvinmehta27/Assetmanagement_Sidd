"use strict";

/**
 * Electron main process for the Asset Manager desktop build.
 *
 * The app is the same Next.js server that runs on Vercel, only hosted inside
 * the .app bundle and bound to 127.0.0.1 on a random free port. The window is
 * a plain browser view onto that local origin, so `/api/extract` and friends
 * keep running server-side with the API keys never reaching the renderer.
 *
 *   dev  — `next dev` is already running (see the desktop:dev script); we just
 *          point the window at it and get hot reload.
 *   prod — spawn `.next/standalone/server.js` with Electron's bundled Node.
 */

const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require("electron");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

const config = require("./config");

const isDev = !app.isPackaged;
const DEV_URL = process.env.DESKTOP_DEV_URL || "http://127.0.0.1:3000";

// Without this, Electron derives the app name from package.json's "name" and
// stores config under ".../Application Support/stock-asset-management". Must be
// set before any app.getPath("userData") call.
app.setName("Asset Manager");

/** @type {import('node:child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let settingsWindow = null;
/** Resolved origin the main window loads, e.g. http://127.0.0.1:51234 */
let appOrigin = DEV_URL;

/** Ask the OS for a port nobody is using, then hand it to Next. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Resolve once the server accepts a TCP connection, or reject after `timeoutMs`. */
function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Next server did not start within ${timeoutMs / 1000}s.`));
        } else {
          setTimeout(attempt, 150);
        }
      });
    };
    attempt();
  });
}

/**
 * Boot the bundled Next standalone server.
 *
 * `server.js` resolves `.next/static` relative to its own directory, so the
 * child's cwd must be the standalone root — not the app bundle root.
 */
async function startServer(envFromConfig) {
  const standaloneDir = path.join(process.resourcesPath, "standalone");
  const serverJs = path.join(standaloneDir, "server.js");
  const port = await findFreePort();

  serverProcess = spawn(process.execPath, [serverJs], {
    cwd: standaloneDir,
    env: {
      ...process.env,
      ...envFromConfig,
      // Without this, spawning Electron's binary launches a second GUI app
      // instead of running server.js as a Node script.
      ELECTRON_RUN_AS_NODE: "1",
      // Unlocks the folder-import routes, which read and move files at a path
      // the client supplies. Safe here because the server and the user are the
      // same person on the same machine; it must stay off for any hosted deploy.
      DESKTOP_APP: "1",
      // Everything the app extracts is written to a SQLite file next to
      // config.json, so no portfolio data ever leaves this machine. The web
      // build keeps using Supabase; nothing here affects it.
      STORAGE_DRIVER: "sqlite",
      LOCAL_DB_PATH: path.join(app.getPath("userData"), "portfolio.db"),
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Surface server output in the terminal when launched from one; silent otherwise.
  serverProcess.stdout.on("data", (d) => process.stdout.write(`[next] ${d}`));
  serverProcess.stderr.on("data", (d) => process.stderr.write(`[next] ${d}`));

  serverProcess.on("exit", (code) => {
    serverProcess = null;
    // A crash after startup leaves an empty window; tell the user rather than
    // letting them stare at a dead page. Code 0 means we killed it on quit.
    if (code !== 0 && code !== null && !app.isQuitting) {
      dialog.showErrorBox(
        "Asset Manager stopped",
        `The local server exited unexpectedly (code ${code}). Please restart the app.`
      );
    }
  });

  await waitForPort(port);
  return `http://127.0.0.1:${port}`;
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "Asset Manager",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0b0f1a",
    show: false,
    webPreferences: {
      // A minimal bridge for the native folder picker used by the importer.
      // Everything else the window needs it gets over HTTP from the local
      // server, so the sandbox stays on.
      preload: path.join(__dirname, "main-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadURL(appOrigin);

  // Keep the window on the local app; anything external belongs in the browser.
  const externally = (url) => {
    if (!url.startsWith(appOrigin)) {
      shell.openExternal(url);
      return true;
    }
    return false;
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (externally(url)) return { action: "deny" };
    return { action: "allow" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (externally(url)) event.preventDefault();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 620,
    height: 720,
    title: "Settings",
    resizable: false,
    minimizable: false,
    parent: mainWindow ?? undefined,
    backgroundColor: "#0b0f1a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: createSettingsWindow,
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow?.webContents.reload(),
        },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC used by the Settings window ------------------------------------

ipcMain.handle("dialog:pickFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: "Choose your contract notes folder",
    message: "Pick the folder that holds (or will hold) your inbox/ folder.",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Use this folder",
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("shell:reveal", (_event, target) => {
  if (typeof target === "string" && target) shell.openPath(target);
});

ipcMain.handle("config:fields", () => config.FIELDS);
ipcMain.handle("config:read", () => config.read(app));
ipcMain.handle("config:path", () => config.configPath(app));
ipcMain.handle("config:dbPath", () => config.dbPath(app));

// Reveal the database in Finder, not open it — double-clicking a .db would hand
// it to whatever app claims the extension.
ipcMain.handle("config:revealDb", () => shell.showItemInFolder(config.dbPath(app)));

ipcMain.handle("config:write", async (_event, values) => {
  const saved = config.write(app, values);

  // The running Next server captured the old keys in its env when it was
  // spawned, so saving alone changes nothing for it. Relying on the user to
  // quit and reopen is a trap: everything looks configured, extraction still
  // fails, and a folder import can move an entire batch into failed/ before
  // anyone works out why. So respawn the server here and point the window at
  // the new port.
  if (isDev) {
    // In dev the user owns the `next dev` process; we cannot restart it.
    return { ok: true, complete: config.isComplete(saved), needsRestart: true };
  }

  Object.assign(process.env, config.toEnv(saved));

  try {
    stopServer();
    appOrigin = await startServer(config.toEnv(saved));
    await mainWindow?.loadURL(appOrigin);
    return { ok: true, complete: config.isComplete(saved), needsRestart: false };
  } catch (err) {
    // Could not bring it back up — say so plainly rather than reporting success
    // and leaving a dead window behind.
    return {
      ok: false,
      complete: config.isComplete(saved),
      needsRestart: true,
      error: String(err?.message || err),
    };
  }
});

// ---- Lifecycle -----------------------------------------------------------

app.whenReady().then(async () => {
  buildMenu();

  const stored = config.read(app);

  if (isDev) {
    appOrigin = DEV_URL;
  } else {
    try {
      appOrigin = await startServer(config.toEnv(stored));
    } catch (err) {
      dialog.showErrorBox("Could not start Asset Manager", String(err?.message || err));
      app.quit();
      return;
    }
  }

  createMainWindow();

  // First launch has no credentials; open Settings rather than letting the
  // user hit an opaque 500 from /api/extract.
  if (!config.isComplete(stored)) {
    createSettingsWindow();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("before-quit", () => {
  app.isQuitting = true;
  stopServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

process.on("exit", stopServer);
