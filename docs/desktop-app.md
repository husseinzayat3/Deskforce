# Desktop app

To install a ready-made app, see [Getting started](getting-started.md#desktop-app). This page is about how the app behaves and how to build and release it.

## Using the app

The app contains the server and the engine, and listens on this computer only. Its data (the database, a `projects` folder, and `server.log`) lives in `~/Library/Application Support/Deskforce/` on macOS, `%APPDATA%\Deskforce\` on Windows and `~/.config/Deskforce/` on Linux; "Open folder" on a task shows the project there. There is no `.env.local` in the app: enter your API keys in its settings, and the app notifies you when something needs you.

On macOS, closing the window keeps the agents working; quit the app to stop them. On Windows and Linux, closing the window quits the app, and unfinished tasks go back in the queue for the next start.

## Building it

The app is built on the system it is for:

```bash
npm run dist:mac                  # on a Mac, for its processor
MAC_ARCH=both npm run dist:mac    # one app for Apple Silicon, one for Intel
npm run dist:win                  # on Windows, from Git Bash
npm run dist:linux                # on Linux: an AppImage and a .deb for its processor
```

This builds `dist-desktop/Deskforce-<version>-<arch>.dmg` on macOS, `dist-desktop/Deskforce-Setup-<version>.exe` on Windows, and `dist-desktop/Deskforce-<version>-<arch>.AppImage` and `.deb` on Linux. Add `-- --dir` to build only the app without an installer, which is quicker when you just want to try it.

## Signing

Without an Apple Developer ID the app is ad-hoc signed: it runs on the Mac that built it, and on another Mac it has to be allowed the first time under System Settings → Privacy & Security → Open Anyway. To distribute it properly, set these before building (see the top of `scripts/build-desktop.sh`):

```bash
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"   # the certificate in your keychain
export APPLE_ID=you@example.com APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx APPLE_TEAM_ID=TEAMID   # notarisation
```

On Windows, set `CSC_LINK` to a code-signing certificate (`.pfx`) and `CSC_KEY_PASSWORD` to its password; without them the installer works but SmartScreen warns the first time.

## Updates

An installed app can update itself: on Windows always, on macOS only when it is signed, and on Linux as an AppImage (a .deb is updated by installing the new one). Tell the build where new versions will be, then upload the installers and the `latest*.yml` files of each release there (on macOS also the `.zip`):

```bash
export DESKFORCE_UPDATE_REPO=owner/repo        # a public GitHub repository's releases, or
export DESKFORCE_UPDATE_URL=https://example.com/downloads
```

The app then checks at start and every few hours, downloads a newer version in the background, and installs it when it is next quit.

## Releasing

Set the new `version` in `electron/package.json`, commit, and push a tag with the same number:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` then builds the macOS, Windows and Linux installers and attaches them to a draft release. Read the draft on the Releases page and publish it. The workflow signs the apps when the certificates are stored as repository secrets, which are listed at the top of that file.
