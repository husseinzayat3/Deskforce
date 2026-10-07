// Finishes the app bundle after electron-builder has laid it out (macOS only).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.default = async context => {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = path.join(appPath, 'Contents', 'Resources');

  // The shell needs no packages of its own; electron-builder adds the web app's anyway.
  fs.rmSync(path.join(resources, 'app', 'node_modules'), { recursive: true, force: true });

  // The server bundle is copied here rather than through `extraResources`, which would
  // leave out its node_modules and dot-folders.
  const standalone = path.join(context.packager.projectDir, '.next-desktop', 'standalone');
  execFileSync('cp', ['-R', standalone, path.join(resources, 'standalone')]);

  // No Apple Developer ID is used. Apple Silicon still refuses to run code with no
  // signature at all, so the finished bundle gets an ad-hoc one.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
