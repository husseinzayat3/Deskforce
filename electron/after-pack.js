// Finishes the app bundle after electron-builder has laid it out (macOS only).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// electron-builder's numbering of processor types
const ARCH_NAMES = { 1: 'x64', 3: 'arm64' };

exports.default = async context => {
  if (context.electronPlatformName !== 'darwin') return;

  const project = context.packager.projectDir;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = path.join(appPath, 'Contents', 'Resources');

  // The server bundle is copied here rather than through `extraResources`, which would
  // leave out its node_modules and dot-folders.
  const standalone = path.join(resources, 'standalone');
  execFileSync('cp', ['-R', path.join(project, '.next-desktop', 'standalone'), standalone]);

  // The SQLite module is compiled code: each app gets the one for its processor
  const arch = ARCH_NAMES[context.arch];
  const native = path.join(project, 'build-desktop', 'native', String(arch), 'better_sqlite3.node');
  if (!fs.existsSync(native)) throw new Error(`No SQLite module was prepared for ${arch}. Run the build through scripts/build-desktop.sh.`);
  const target = path.join(standalone, 'node_modules', 'better-sqlite3', 'build', 'Release');
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(native, path.join(target, 'better_sqlite3.node'));

  // With a Developer ID, electron-builder signs the finished bundle itself after this step.
  // Without one, Apple Silicon still refuses to run code with no signature at all,
  // so the bundle gets an ad-hoc one.
  if (process.env.MY_OFFICE_SIGNED !== '1') {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  }
};
