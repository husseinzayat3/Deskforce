#!/usr/bin/env node
// Starts a built desktop app with an empty data folder and checks that its office answers.
// This proves the parts that differ per system and processor: the app starts, the bundled
// server runs inside it, and the SQLite module loads.
//
//   node scripts/smoke-desktop.js "dist-desktop/mac-arm64/Deskforce.app/Contents/MacOS/Deskforce"
//   node scripts/smoke-desktop.js dist-desktop/win-unpacked/Deskforce.exe
//
// SMOKE_TIMEOUT_SECONDS gives a slow start more time (default 90).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_SECONDS || 90) * 1000;

const executable = process.argv[2];
if (!executable || !fs.existsSync(executable)) {
  console.error(`No app at ${executable}. Build it first (see scripts/build-desktop.sh).`);
  process.exit(1);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskforce-smoke-'));
const logFile = path.join(dataDir, 'server.log');
const env = { ...process.env, DESKFORCE_USER_DATA: dataDir };
// Set by editors built on Electron; with it the app would run as plain Node and exit at once
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(executable, [], { env, stdio: 'inherit' });

let exited = null;
app.on('exit', code => (exited = code));
app.on('error', error => (exited = error.message));

const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const finish = (ok, message) => {
  console.log(`${ok ? '✓' : '✗'} ${message}`);
  if (!ok) console.log(`--- server.log ---\n${readLog() || '(empty)'}`);
  app.kill();
  // Windows keeps the files open for a moment after the app is stopped
  setTimeout(() => {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    process.exit(ok ? 0 : 1);
  }, 1500);
};

(async () => {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited !== null) return finish(false, `The app stopped by itself (${exited}).`);

    // The server prints the address it listens on, e.g. "- Local: http://127.0.0.1:58711"
    const address = readLog().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (address) {
      try {
        const response = await fetch(`${address}/api/office`);
        const office = await response.json();
        if (response.status === 200 && Array.isArray(office.agents)) {
          return finish(true, `The office answers at ${address} with ${office.agents.length} employees.`);
        }
      } catch {
        // still starting
      }
    }
    await wait(500);
  }
  finish(false, `The office did not answer within ${TIMEOUT_MS / 1000} seconds (the app is still running).`);
})();
