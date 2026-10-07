#!/usr/bin/env bash
# Builds the macOS desktop app: dist-desktop/My Office-<version>-<arch>.dmg
#
#   npm run dist:mac            build the .dmg
#   npm run dist:mac -- --dir   build only the .app (faster, for trying it out)
#
# Needs Node 20 or newer. The app is not signed with an Apple Developer ID, so on another
# Mac it has to be opened with right-click → Open the first time.
set -euo pipefail

cd "$(dirname "$0")/.."

BUILD_DIR=.next-desktop
STANDALONE="$BUILD_DIR/standalone"
RESOURCES=build-desktop

node -e 'if (Number(process.versions.node.split(".")[0]) < 20) { console.error(`Node 20 or newer is required (this is ${process.version}). Run: nvm use`); process.exit(1); }'

ELECTRON_VERSION=$(node -p 'require("electron/package.json").version')
SQLITE_DIR=$(node -p 'require("path").dirname(require.resolve("better-sqlite3/package.json"))')
ARCH=$(node -p 'process.arch')

echo "▸ Building the Next.js server"
rm -rf "$BUILD_DIR"
BUILD_DESKTOP=1 npx next build

echo "▸ Assembling the server bundle"
cp -R "$BUILD_DIR/static" "$STANDALONE/$BUILD_DIR/static"
cp -R public "$STANDALONE/public"
# Nothing personal may ship: no env files, no local office data
rm -rf "$STANDALONE"/.env* "$STANDALONE/workspace" "$STANDALONE/functions"

echo "▸ Fetching the SQLite module for Electron $ELECTRON_VERSION ($ARCH)"
# The server runs inside Electron, whose Node differs from the one on this machine,
# so the module compiled by `npm install` cannot be loaded there.
NATIVE_TMP=$(mktemp -d)
trap 'rm -rf "$NATIVE_TMP"' EXIT
cp -R "$SQLITE_DIR" "$NATIVE_TMP/better-sqlite3"
rm -rf "$NATIVE_TMP/better-sqlite3/build"
(cd "$NATIVE_TMP/better-sqlite3" && npx --yes prebuild-install --runtime electron --target "$ELECTRON_VERSION" --arch "$ARCH" --platform darwin)
mkdir -p "$STANDALONE/node_modules/better-sqlite3/build/Release"
cp "$NATIVE_TMP/better-sqlite3/build/Release/better_sqlite3.node" "$STANDALONE/node_modules/better-sqlite3/build/Release/better_sqlite3.node"

echo "▸ Checking that no secrets are in the bundle"
if [ -f .env.local ]; then
  while IFS='=' read -r name value; do
    value=$(printf '%s' "$value" | tr -d "\"' ")
    if [ "${#value}" -ge 12 ] && grep -rqF -- "$value" "$STANDALONE"; then
      echo "✗ The value of $name from .env.local was found in the bundle. Not packaging." >&2
      exit 1
    fi
  done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=.' .env.local || true)
fi
if [ -n "$(find "$STANDALONE" -name '.env*' -o -name '*.db' | head -1)" ]; then
  echo "✗ An env file or database was found in the bundle. Not packaging." >&2
  exit 1
fi

echo "▸ Creating the app icon"
mkdir -p "$RESOURCES"
ICONSET=$(mktemp -d)/icon.iconset
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" public/avatars/robot.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" public/avatars/robot.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RESOURCES/icon.icns"

echo "▸ Packaging"
npx electron-builder --mac "$@"

echo "✓ Done. See dist-desktop/"
