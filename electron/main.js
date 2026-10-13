// Desktop shell: starts the bundled Next.js server (which runs the office engine)
// on a private local port and shows it in a window.
const { app, BrowserWindow, Notification, dialog, ipcMain, shell, utilityProcess } = require('electron');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const SERVER_START_TIMEOUT_MS = 30_000;
/** How often the shell asks the office whether something worth a notification happened. */
const EVENT_POLL_MS = 5_000;
/** How often a published app looks for a newer version. */
const UPDATE_CHECK_MS = 6 * 60 * 60_000;
/** Kinds of office events shown as system notifications. */
const NOTABLE = new Set(['report', 'question', 'failed', 'limit']);

// Packaged: the server ships in the app's resources. Unpackaged: use the local build.
const SERVER_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'standalone')
  : path.join(__dirname, '..', '.next-desktop', 'standalone');

// Lets a test run keep its data away from the real office
if (process.env.DESKFORCE_USER_DATA) app.setPath('userData', path.resolve(process.env.DESKFORCE_USER_DATA));

const DATA_DIR = app.getPath('userData');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

let server;
let mainWindow;
let serverUrl;
let quitting = false;

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const waitForServer = url =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    const attempt = () => {
      const req = http.get(`${url}/api/office`, res => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error('The office server did not start in time.'));
      else setTimeout(attempt, 250);
    };
    attempt();
  });

const startServer = async () => {
  const port = await freePort();
  serverUrl = `http://127.0.0.1:${port}`;
  fs.mkdirSync(DATA_DIR, { recursive: true });

  server = utilityProcess.fork(path.join(SERVER_DIR, 'server.js'), [], {
    cwd: SERVER_DIR,
    stdio: 'pipe',
    serviceName: 'Deskforce server',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      // Reachable from this computer only
      HOSTNAME: '127.0.0.1',
      OFFICE_DATA_DIR: DATA_DIR,
    },
  });

  const log = fs.createWriteStream(path.join(DATA_DIR, 'server.log'), { flags: 'w' });
  server.stdout?.pipe(log);
  server.stderr?.pipe(log);

  server.once('exit', code => {
    server = undefined;
    if (quitting) return;
    dialog.showErrorBox('Deskforce', `The office server stopped unexpectedly (code ${code}).\nDetails: ${path.join(DATA_DIR, 'server.log')}`);
    app.quit();
  });

  await waitForServer(serverUrl);
};

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    title: 'Deskforce',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The window only ever shows the office; any other link opens in the user's browser
  const isOffice = url => url.startsWith(`${serverUrl}/`);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !isOffice(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isOffice(url)) event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
  mainWindow.loadURL(serverUrl);
};

const getJson = url =>
  new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });

/**
 * System notifications for what the office reports (a report is ready, an employee has a
 * question, a task failed), shown while the window is closed or in the background.
 */
const watchEvents = () => {
  let lastEvent = null;
  setInterval(async () => {
    if (!serverUrl || quitting) return;
    try {
      const data = await getJson(`${serverUrl}/api/office?events=1${lastEvent === null ? '' : `&afterEvent=${lastEvent}`}`);
      const watching = mainWindow && mainWindow.isFocused();
      if (lastEvent !== null && !watching && Notification.isSupported()) {
        for (const event of data.events || []) {
          if (!NOTABLE.has(event.kind)) continue;
          const notification = new Notification({ title: 'Deskforce', body: event.message });
          notification.on('click', () => {
            if (mainWindow) {
              if (mainWindow.isMinimized()) mainWindow.restore();
              mainWindow.show();
              mainWindow.focus();
            } else {
              createWindow();
            }
          });
          notification.show();
        }
      }
      if (typeof data.lastEventId === 'number') lastEvent = data.lastEventId;
    } catch {
      // the server is busy or restarting: try again on the next round
    }
  }, EVENT_POLL_MS);
};

/**
 * Updates itself when the build was given somewhere to look (see scripts/build-desktop.sh):
 * always possible on Windows, on macOS only for an app signed with a Developer ID.
 * A new version is downloaded in the background and installed when the app is next quit.
 */
const watchForUpdates = () => {
  // `selfUpdates` is set by the build only for an app that the system will let update itself
  if (!app.isPackaged || !require('./package.json').selfUpdates) return;
  if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return;
  try {
    const { autoUpdater } = require('electron-updater');
    const check = () => autoUpdater.checkForUpdatesAndNotify().catch(() => undefined);
    check();
    setInterval(check, UPDATE_CHECK_MS);
  } catch {
    // an update check must never stop the office from starting
  }
};

// "Open folder" on a project: only folders directly inside the projects folder
ipcMain.handle('open-project', async (_event, project) => {
  if (typeof project !== 'string' || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(project)) return;
  const folder = path.join(PROJECTS_DIR, project);
  if (fs.existsSync(folder)) await shell.openPath(folder);
});

// Windows shows notifications only for an app that names itself (the appId of electron-builder.yml)
if (process.platform === 'win32') app.setAppUserModelId('io.github.husseinzayat3.deskforce');

if (!app.requestSingleInstanceLock()) {
  // Two copies would mean two engines on one database
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      await startServer();
      createWindow();
      watchEvents();
      watchForUpdates();
    } catch (e) {
      dialog.showErrorBox('Deskforce could not start', `${e.message}\nDetails: ${path.join(DATA_DIR, 'server.log')}`);
      app.quit();
    }
  });

  // macOS: closing the window keeps the app (and the agents' work) running in the Dock.
  // Elsewhere closing the window quits, which stops the agents until the app is opened again.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (!mainWindow && serverUrl) createWindow();
  });

  app.on('before-quit', () => {
    quitting = true;
    server?.kill();
  });
}
