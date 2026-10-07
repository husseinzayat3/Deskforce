#!/usr/bin/env bash
# Builds the macOS desktop app: dist-desktop/My Office-<version>-<arch>.dmg
#
#   npm run dist:mac            build the .dmg for this Mac's processor
#   npm run dist:mac -- --dir   build only the .app (faster, for trying it out)
#
# Options, as environment variables:
#
#   MAC_ARCH=arm64|x64|both     which processors to build for (default: this Mac's).
#                               "both" makes one app for Apple Silicon and one for Intel.
#
#   Signing (needs an Apple Developer ID; without it the app is only ad-hoc signed and
#   has to be opened with right-click → Open the first time on another Mac):
#     CSC_NAME="Developer ID Application: Your Name (TEAMID)"   a certificate in your keychain, or
#     CSC_LINK=/path/to/certificate.p12  CSC_KEY_PASSWORD=...
#   Notarisation, so Gatekeeper opens the app without a warning (only with signing):
#     APPLE_ID=you@example.com  APPLE_APP_SPECIFIC_PASSWORD=...  APPLE_TEAM_ID=TEAMID
#
#   Automatic updates (only work in a signed app). Where the app looks for new versions:
#     MY_OFFICE_UPDATE_REPO=owner/repo      public GitHub releases, or
#     MY_OFFICE_UPDATE_URL=https://...      any web folder holding the files from dist-desktop/
#   Upload the .dmg, the .zip and latest-mac.yml of each new version there.
#
# Needs Node 20 or newer.
set -euo pipefail

cd "$(dirname "$0")/.."

BUILD_DIR=.next-desktop
STANDALONE="$BUILD_DIR/standalone"
RESOURCES=build-desktop

node -e 'if (Number(process.versions.node.split(".")[0]) < 20) { console.error(`Node 20 or newer is required (this is ${process.version}). Run: nvm use`); process.exit(1); }'

ELECTRON_VERSION=$(node -p 'require("electron/package.json").version')
SQLITE_DIR=$(node -p 'require("path").dirname(require.resolve("better-sqlite3/package.json"))')
HOST_ARCH=$(node -p 'process.arch')
case "${MAC_ARCH:-$HOST_ARCH}" in
  both) ARCHS="arm64 x64" ;;
  arm64|x64) ARCHS="${MAC_ARCH:-$HOST_ARCH}" ;;
  *) echo "MAC_ARCH must be arm64, x64 or both." >&2; exit 1 ;;
esac

SIGNED=0
if [ -n "${CSC_NAME:-}${CSC_LINK:-}" ]; then SIGNED=1; fi

echo "▸ Building the Next.js server"
rm -rf "$BUILD_DIR" dist-desktop
BUILD_DESKTOP=1 npx next build

echo "▸ Assembling the server bundle"
cp -R "$BUILD_DIR/static" "$STANDALONE/$BUILD_DIR/static"
cp -R public "$STANDALONE/public"
# Only the server itself ships. Anything else the bundler traced from the checkout
# (env files, office data, the git folder, sources, earlier builds) is dropped.
find "$STANDALONE" -mindepth 1 -maxdepth 1 \
  ! -name server.js ! -name package.json ! -name node_modules ! -name "$BUILD_DIR" ! -name public \
  -exec rm -rf {} +

# The server runs inside Electron, whose Node differs from the one on this machine, so the
# module compiled by `npm install` cannot be loaded there. One copy is fetched per processor;
# electron/after-pack.js puts the right one into each app.
NATIVE_TMP=$(mktemp -d)
trap 'rm -rf "$NATIVE_TMP"' EXIT
rm -rf "$RESOURCES/native"
for ARCH in $ARCHS; do
  echo "▸ Fetching the SQLite module for Electron $ELECTRON_VERSION ($ARCH)"
  rm -rf "$NATIVE_TMP/better-sqlite3"
  cp -R "$SQLITE_DIR" "$NATIVE_TMP/better-sqlite3"
  rm -rf "$NATIVE_TMP/better-sqlite3/build"
  (cd "$NATIVE_TMP/better-sqlite3" && npx --yes prebuild-install --runtime electron --target "$ELECTRON_VERSION" --arch "$ARCH" --platform darwin)
  mkdir -p "$RESOURCES/native/$ARCH"
  cp "$NATIVE_TMP/better-sqlite3/build/Release/better_sqlite3.node" "$RESOURCES/native/$ARCH/better_sqlite3.node"
done
# The copy built for this machine's Node must not ship; each app gets its own in after-pack
rm -rf "$STANDALONE/node_modules/better-sqlite3/build"
# Image optimisation is not used, and its native library exists for one processor only
rm -rf "$STANDALONE/node_modules/@img" "$STANDALONE/node_modules/sharp"

echo "▸ Installing the desktop shell's own packages"
npm install --prefix electron --omit=dev --no-audit --no-fund --silent

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
if [ -n "$(find "$STANDALONE" -name '.env*' -o -name '*.db' -o -name '.git' | head -1)" ]; then
  echo "✗ An env file, database or git folder was found in the bundle. Not packaging." >&2
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
BUILDER_ARGS=(--mac --publish never)
for ARCH in $ARCHS; do BUILDER_ARGS+=("--$ARCH"); done

if [ "$SIGNED" = 1 ]; then
  echo "  signing with your Developer ID"
  if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    echo "  and notarising with Apple (this takes a few minutes)"
    BUILDER_ARGS+=(-c.mac.notarize=true)
  else
    echo "  not notarising: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID are not all set"
    BUILDER_ARGS+=(-c.mac.notarize=false)
  fi
  # Updates are only installed by macOS when the app is signed
  if [ -n "${MY_OFFICE_UPDATE_REPO:-}" ]; then
    BUILDER_ARGS+=(-c.mac.target=dmg -c.mac.target=zip -c.publish.provider=github "-c.publish.owner=${MY_OFFICE_UPDATE_REPO%%/*}" "-c.publish.repo=${MY_OFFICE_UPDATE_REPO##*/}")
  elif [ -n "${MY_OFFICE_UPDATE_URL:-}" ]; then
    BUILDER_ARGS+=(-c.mac.target=dmg -c.mac.target=zip -c.publish.provider=generic "-c.publish.url=$MY_OFFICE_UPDATE_URL")
  fi
else
  echo "  no Developer ID given: the app is ad-hoc signed and will not update itself"
  BUILDER_ARGS+=(-c.mac.identity=null)
fi

MY_OFFICE_SIGNED=$SIGNED npx electron-builder "${BUILDER_ARGS[@]}" "$@"

echo "✓ Done. See dist-desktop/"
