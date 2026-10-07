// Desktop shell: starts the bundled Next.js server (which runs the office engine)
// on a private local port and shows it in a window.
const { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } = require('electron');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const SERVER_START_TIMEOUT_MS = 30_000;

// Packaged: the server ships in the app's resources. Unpackaged: use the local build.
const SERVER_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'standalone')
  : path.join(__dirname, '..', '.next-desktop', 'standalone');

// Lets a test run keep its data away from the real office
if (process.env.MY_OFFICE_USER_DATA) app.setPath('userData', path.resolve(process.env.MY_OFFICE_USER_DATA));

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
    serviceName: 'My Office server',
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
    dialog.showErrorBox('My Office', `The office server stopped unexpectedly (code ${code}).\nDetails: ${path.join(DATA_DIR, 'server.log')}`);
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
    title: 'My Office',
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

// "Open folder" on a project: only folders directly inside the projects folder
ipcMain.handle('open-project', async (_event, project) => {
  if (typeof project !== 'string' || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(project)) return;
  const folder = path.join(PROJECTS_DIR, project);
  if (fs.existsSync(folder)) await shell.openPath(folder);
});

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
    } catch (e) {
      dialog.showErrorBox('My Office could not start', `${e.message}\nDetails: ${path.join(DATA_DIR, 'server.log')}`);
      app.quit();
    }
  });

  // macOS: closing the window keeps the app (and the agents' work) running in the Dock
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
