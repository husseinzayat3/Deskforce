# Getting started

There are three ways to run Deskforce: the desktop app, from the source with Node.js, or with Docker.

## Desktop app

Installers are on the [Releases page](https://github.com/husseinzayat3/Deskforce/releases/latest). Nothing else needs to be installed; enter your API keys in the app's settings.

| System | File |
| --- | --- |
| macOS, Apple Silicon (M1 and later) | `Deskforce-<version>-arm64.dmg` |
| macOS, Intel | `Deskforce-<version>-x64.dmg` |
| Windows 10 and 11 | `Deskforce-Setup-<version>.exe` |
| Linux, any distribution | `Deskforce-<version>-<arch>.AppImage` |
| Debian, Ubuntu and derivatives | `Deskforce-<version>-<arch>.deb` |

The apps are not yet signed with a paid certificate, so the system asks before it opens them the first time:

- **macOS:** after trying to open the app, go to **System Settings → Privacy & Security**, scroll down, and choose **Open Anyway**.
- **Windows:** when "Windows protected your PC" appears, choose **More info → Run anyway**.

On Linux (installers from version 0.3.0; for earlier versions use [Docker](docker.md)):

- **AppImage:** make it executable and start it: `chmod +x Deskforce-*.AppImage && ./Deskforce-*.AppImage`. On Ubuntu 22.04 and later it needs FUSE 2: `sudo apt install libfuse2` (`libfuse2t64` on 24.04).
- **.deb:** `sudo apt install ./Deskforce-*.deb`, then start Deskforce from your applications menu.

More on the app, building it yourself, signing and updates: [Desktop app](desktop-app.md).

## From the source

### 1. Prerequisites

- Node.js 22 or newer (`nvm use` picks it up from `.nvmrc`)
- At least one AI provider:
  - an API key for OpenAI, Anthropic, Google Gemini or xAI (Grok), or
  - [Ollama](https://ollama.com) running locally with the `llama3` model (`ollama pull llama3`) — set `OLLAMA_MODEL` to use a different one

### 2. Install

```bash
git clone https://github.com/husseinzayat3/Deskforce.git
cd Deskforce
npm install
```

### 3. Configure

Copy the example environment file and add the keys for the providers you plan to use:

```bash
cp .env.example .env.local
```

`.env.local` is ignored by git. A provider without a key returns mock responses, so you can explore the interface before adding one. Every setting is described in [`.env.example`](https://github.com/husseinzayat3/Deskforce/blob/main/.env.example).

You can also enter keys, models and the Ollama address in the app itself: the gear button opens the settings. Values saved there are kept in the office database and take precedence over `.env.local`.

> **Keys are stored unencrypted.** API keys and Slack tokens saved in the settings are written as plain text to the office database (`workspace/office_state.db`, or `office_state.db` in the desktop app's data folder), just as they are plain text in `.env.local`. Anyone who can read that file can read the keys, so keep it out of backups and folders you share, and never commit or send it.

### 4. Run

```bash
npm run dev
```

Open `http://localhost:3000`, hire a few employees, and assign a task to the most senior one.

## With Docker

```bash
docker run -p 127.0.0.1:3000:3000 -v $(pwd)/workspace:/app/workspace --env-file .env.local ghcr.io/husseinzayat3/deskforce
```

See [Docker](docker.md) for building the image yourself and using Ollama from the container.

## Next

- [Features](features.md) — everything the office can do
- [How it works](how-it-works.md) — the engine, the tools agents use, and the technology
- [Slack](slack.md) — talk to the office from Slack
- [Security model](security.md) — read this before exposing the office to anything but your own computer
