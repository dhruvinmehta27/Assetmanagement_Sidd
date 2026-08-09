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

ipcMain.handle("config:fields", () => config.FIELDS);
ipcMain.handle("config:read", () => config.read(app));
ipcMain.handle("config:path", () => config.configPath(app));

ipcMain.handle("config:write", (_event, values) => {
  const saved = config.write(app, values);

  // The running Next server captured the old keys in its env at spawn time, so
  // it has to be restarted for new credentials to take effect. In dev the user
  // owns that process; tell the renderer so it can say so.
  if (!isDev) {
    Object.assign(process.env, config.toEnv(saved));
  }
  return { ok: true, complete: config.isComplete(saved), needsRestart: true };
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
