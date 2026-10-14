#!/usr/bin/env bash
# Builds the desktop app for the system it is run on:
#   macOS    dist-desktop/Deskforce-<version>-<arch>.dmg
#   Windows  dist-desktop/Deskforce-Setup-<version>.exe   (run it from Git Bash)
#
#   npm run dist:mac            build the .dmg for this Mac's processor
#   npm run dist:win            build the installer on Windows
#   npm run dist:mac -- --dir   build only the app, without an installer (faster, for trying it out)
#
# Releases are built by .github/workflows/release.yml, which runs this script on both systems.
#
# Options, as environment variables:
#
#   MAC_ARCH=arm64|x64|both     which processors to build for on macOS (default: this Mac's).
#                               "both" makes one app for Apple Silicon and one for Intel.
#   WIN_ARCH=x64|arm64          the processor to build for on Windows (default: x64).
#
#   Signing on macOS (needs an Apple Developer ID; without it the app is only ad-hoc signed and
#   has to be allowed under System Settings → Privacy & Security the first time on another Mac):
#     CSC_NAME="Developer ID Application: Your Name (TEAMID)"   a certificate in your keychain, or
#     CSC_LINK=/path/to/certificate.p12  CSC_KEY_PASSWORD=...
#   Notarisation, so Gatekeeper opens the app without a warning (only with signing):
#     APPLE_ID=you@example.com  APPLE_APP_SPECIFIC_PASSWORD=...  APPLE_TEAM_ID=TEAMID
#   Signing on Windows (optional; without it SmartScreen warns the first time):
#     CSC_LINK=/path/to/certificate.pfx  CSC_KEY_PASSWORD=...
#
#   Automatic updates. Where the app looks for new versions:
#     DESKFORCE_UPDATE_REPO=owner/repo      public GitHub releases, or
#     DESKFORCE_UPDATE_URL=https://...      any web folder holding the files from dist-desktop/
#   Upload the installers and the latest*.yml files of each new version there (on macOS also the .zip).
#   macOS only installs updates for a signed app, so an ad-hoc signed one never looks for them.
#
# Needs Node 22 or newer.
set -euo pipefail

cd "$(dirname "$0")/.."

BUILD_DIR=.next-desktop
STANDALONE="$BUILD_DIR/standalone"
RESOURCES=build-desktop

node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error(`Node 22 or newer is required (this is ${process.version}). Run: nvm use`); process.exit(1); }'

PLATFORM=$(node -p 'process.platform')
if [ "$PLATFORM" != darwin ] && [ "$PLATFORM" != win32 ]; then
  echo "The desktop app is built on macOS (for macOS) or on Windows (for Windows)." >&2
  exit 1
fi

ELECTRON_VERSION=$(node -p 'require("electron/package.json").version')
# Forward slashes, so the path also works in Git Bash on Windows. No literal "/" in the script:
# Git Bash rewrites a lone "/" argument into its install folder ("C:/Program Files/Git/").
SQLITE_DIR=$(node -p 'const path = require("path"); path.dirname(require.resolve("better-sqlite3/package.json")).split(path.sep).join(path.posix.sep)')
HOST_ARCH=$(node -p 'process.arch')
if [ "$PLATFORM" = darwin ]; then
  case "${MAC_ARCH:-$HOST_ARCH}" in
    both) ARCHS="arm64 x64" ;;
    arm64|x64) ARCHS="${MAC_ARCH:-$HOST_ARCH}" ;;
    *) echo "MAC_ARCH must be arm64, x64 or both." >&2; exit 1 ;;
  esac
else
  case "${WIN_ARCH:-x64}" in
    arm64|x64) ARCHS="${WIN_ARCH:-x64}" ;;
    *) echo "WIN_ARCH must be x64 or arm64." >&2; exit 1 ;;
  esac
fi

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

# The SQLite module is compiled code. better-sqlite3 ships one per system and processor, built
# on Node-API so the same file loads in Node and in Electron; electron/after-pack.js puts the
# right one into each app.
rm -rf "$RESOURCES/native"
for ARCH in $ARCHS; do
  echo "▸ Taking the SQLite module for Electron $ELECTRON_VERSION ($PLATFORM $ARCH)"
  PREBUILD="$SQLITE_DIR/prebuilds/$PLATFORM-$ARCH.node"
  if [ ! -f "$PREBUILD" ]; then
    echo "✗ better-sqlite3 has no prebuilt module for $PLATFORM $ARCH ($PREBUILD)." >&2
    exit 1
  fi
  mkdir -p "$RESOURCES/native/$ARCH"
  cp "$PREBUILD" "$RESOURCES/native/$ARCH/better_sqlite3.node"
done
# The copies traced from this machine must not ship (they cover this processor only, and
# better-sqlite3 prefers them); each app gets its own in after-pack
rm -rf "$STANDALONE/node_modules/better-sqlite3/build" "$STANDALONE/node_modules/better-sqlite3/prebuilds"
# Image optimisation is not used, and its native library exists for one processor only
rm -rf "$STANDALONE/node_modules/@img" "$STANDALONE/node_modules/sharp"

echo "▸ Installing the desktop shell's own packages"
npm install --prefix electron --omit=dev --no-audit --no-fund --silent

echo "▸ Checking that no secrets are in the bundle"
if [ -f .env.local ]; then
  while IFS='=' read -r name value; do
    value=$(printf '%s' "$value" | tr -d "\"' \r")
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
if [ "$PLATFORM" = darwin ]; then
  ICONSET=$(mktemp -d)/icon.iconset
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" public/avatars/robot.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z "$((size * 2))" "$((size * 2))" public/avatars/robot.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$RESOURCES/icon.icns"
else
  # electron-builder turns the picture into an .ico itself
  cp public/avatars/robot.png "$RESOURCES/icon.png"
fi

echo "▸ Packaging"
BUILDER_ARGS=(--publish never)
for ARCH in $ARCHS; do BUILDER_ARGS+=("--$ARCH"); done

# Where the app looks for new versions, if anywhere
FEED_ARGS=()
if [ -n "${DESKFORCE_UPDATE_REPO:-}" ]; then
  FEED_ARGS=(-c.publish.provider=github "-c.publish.owner=${DESKFORCE_UPDATE_REPO%%/*}" "-c.publish.repo=${DESKFORCE_UPDATE_REPO##*/}")
elif [ -n "${DESKFORCE_UPDATE_URL:-}" ]; then
  FEED_ARGS=(-c.publish.provider=generic "-c.publish.url=$DESKFORCE_UPDATE_URL")
fi
UPDATES=0

if [ "$PLATFORM" = darwin ]; then
  BUILDER_ARGS+=(--mac)
  if [ "$SIGNED" = 1 ]; then
    echo "  signing with your Developer ID"
    if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
      echo "  and notarising with Apple (this takes a few minutes)"
      BUILDER_ARGS+=(-c.mac.notarize=true)
    else
      echo "  not notarising: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID are not all set"
      BUILDER_ARGS+=(-c.mac.notarize=false)
    fi
    # Updates are only installed by macOS when the app is signed; they are delivered as a .zip
    if [ "${#FEED_ARGS[@]}" -gt 0 ]; then
      UPDATES=1
      BUILDER_ARGS+=(-c.mac.target=dmg -c.mac.target=zip)
    fi
  else
    echo "  no Developer ID given: the app is ad-hoc signed and will not update itself"
    BUILDER_ARGS+=(-c.mac.identity=null)
  fi
else
  BUILDER_ARGS+=(--win)
  if [ "$SIGNED" = 1 ]; then
    echo "  signing with your certificate"
  else
    echo "  no certificate given: Windows SmartScreen will warn the first time the installer is opened"
  fi
  if [ "${#FEED_ARGS[@]}" -gt 0 ]; then UPDATES=1; fi
fi

if [ "$UPDATES" = 1 ]; then
  echo "  the app will update itself"
  BUILDER_ARGS+=("${FEED_ARGS[@]}" -c.extraMetadata.selfUpdates=true)
fi

DESKFORCE_SIGNED=$SIGNED npx electron-builder "${BUILDER_ARGS[@]}" "$@"

echo "✓ Done. See dist-desktop/"
