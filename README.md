# My Office — AI Agent Simulation

A virtual office where AI agents work as a team. Hire employees, give the CEO a goal, and watch it get broken down, delegated, and turned into files on your machine — all shown on an animated 2D floorplan.

## Features

- **Visual office map** — each agent is a clickable avatar on the floorplan (click to open its tasks). The speech bubble shows what the model is writing as it writes it, and agents walk to the meeting room, the coffee machine and the break room.
- **Runs on the server** — tasks are executed by the server, not the browser tab. Close the page and the work carries on; after a restart, interrupted tasks go back in the queue.
- **Roles you define** — an office starts with eight roles (CEO, Tech Lead, Designer, QA, DevOps and more). Edit their instructions and seniority or add your own; an agent can only delegate to more junior roles.
- **A model per employee** — OpenAI, Anthropic (Claude), Google Gemini, Grok (xAI) or a local model through Ollama, and the exact model for each hire: a strong one for managers and reviewers, a cheap one for juniors.
- **Shared context** — every agent sees the original request, its manager's plan, what colleagues already finished and the current project files, so work is built on rather than overwritten.
- **Meetings** — when two agents are asked to change the same file, they meet first, agree who does what, and then work one after the other.
- **Questions** — an agent that cannot do a task without information only you have asks, and carries on when you answer.
- **Final review and report** — when all delegated work is done, the task owner checks the whole project and fixes gaps. Each task you assign then gets a report.
- **Files, history and undo** — browse a project's files in the app. Every task is a git commit in the agent's name: see exactly what it changed and undo it with one click.
- **Preview** — projects with a web page (`index.html`) open in a preview, served from their own local address.
- **Task board** — a nested view of each task and its sub-tasks, with progress, tokens, estimated cost, live output, and buttons to retry, request changes or continue the project.
- **Costs** — spending per day, per employee and per model, a budget per task, and a monthly cap that stops new work when it is reached.
- **Templates and schedules** — save a task to run again with a click, or every day or week at a set time.
- **Real tools, real output** — agents read, write and edit the project's files through tool calls, into a per-task folder under `workspace/projects/`. Models that cannot call tools fall back to a tagged text format.
- **Web access** — agents search the web and read pages for current facts instead of inventing them. They can only reach public websites.
- **Attachments** — give a task files or images to work from, or a whole folder to start the project from.
- **Edit, archive, delete** — change an employee's role or model without losing their history; hide finished tasks or delete them with their files.
- **Checks (opt-in)** — the office can check the syntax of a project's files and run its tests, and have failures fixed. Off by default; on macOS it runs sandboxed.
- **Office files** — export the roles, employees and templates of an office as one file and import it elsewhere.
- **Notifications** — a system notification when a report is ready, an employee has a question, or a task fails.
- **Desktop app** — one command packages the whole thing as a macOS app for Apple Silicon and Intel, with a settings screen for your API keys.

## Getting started

### 1. Prerequisites

- Node.js 20.9 or newer (`nvm use` picks it up from `.nvmrc`)
- At least one AI provider:
  - an API key for OpenAI, Anthropic, Google Gemini or xAI (Grok), or
  - [Ollama](https://ollama.com) running locally with the `llama3` model (`ollama pull llama3`) — set `OLLAMA_MODEL` to use a different one

### 2. Install

```bash
git clone <this-repo-url>
cd my-office
npm install
```

### 3. Configure

Copy the example environment file and add the keys for the providers you plan to use:

```bash
cp .env.example .env.local
```

`.env.local` is ignored by git. A provider without a key returns mock responses, so you can explore the interface before adding one.

You can also enter keys, models and the Ollama address in the app itself: the gear button opens the settings. Values saved there are kept in the office database and take precedence over `.env.local`.

### 4. Run

```bash
npm run dev
```

Open `http://localhost:3000`, hire a few employees, and assign a task to the most senior one.

## How it works

The office engine (`src/lib/server/engine.ts`) starts with the server and checks the queue every second. Each task is given to the employee's model together with the client's request, the manager's plan, what colleagues finished, and the project's files. The model then works by calling tools until it replies with a summary:

| Tool | Effect |
| --- | --- |
| `name_project` | Names the folder of a new project |
| `list_files`, `read_file` | Look at the project as it is now |
| `write_file`, `edit_file`, `delete_file` | Create, change or remove a file in the project folder |
| `delegate` | Hands a sub-task to a more junior colleague |
| `ask_client` | Pauses the task and asks you |
| `web_search`, `fetch_url` | Look something up (Claude uses Anthropic's own web tools instead) |
| `run_checks` | Checks syntax and runs tests, when you turned that on |

Every task that changes files becomes one git commit in the employee's name. A model that cannot call tools (for example `llama3` on Ollama) is given the same abilities as tags in plain text, such as `[FILE: path] … [/FILE]`; it has no web access and cannot run checks.

The guardrail limits and the per-model prices used for cost estimates live in `src/lib/officeConfig.ts`. Costs are estimates from list prices; local Ollama models count as free.

| Part | Technology |
| --- | --- |
| Frontend | Next.js (React), `framer-motion` |
| Backend | Next.js API routes, plus an in-process engine that runs the tasks |
| Database | `better-sqlite3` |
| AI | OpenAI SDK (OpenAI and Grok), Anthropic SDK, Gemini and Ollama HTTP APIs, all streamed, with native tool calling |
| History | `isomorphic-git` (no `git` program needed) |

## Checks

In Settings, "Run checks and tests on this computer" lets the office verify a project: JSON, Python, JavaScript and Dart files are checked for syntax, and Python (`unittest`) and JavaScript (`node --test`) tests are run. When a task tree finishes with failing checks, its owner gets one round to fix them and the checks run again; the result is in the report. Agents can also call the checks themselves while working.

Tests are code that a model wrote. The commands are fixed (never chosen by a model), run without the office's environment, and on macOS inside a sandbox with no network, no writing outside the project, and no reading of your documents, keys or the office's own data. On other systems there is no sandbox, so leave it off unless the office already runs in a container. Nothing is installed: tests can only use what is already on the computer.

## Tests

```bash
npm test      # unit tests for the response parser, pricing, naming and schedules
npm run lint
```

## Desktop app (macOS)

```bash
npm run dist:mac                  # for this Mac's processor
MAC_ARCH=both npm run dist:mac    # one app for Apple Silicon, one for Intel
```

This builds `dist-desktop/My Office-<version>-<arch>.dmg`. Add `-- --dir` to build only the `.app`, which is quicker when you just want to try it.

The app contains the server and the engine, and listens on this computer only. Its data lives in `~/Library/Application Support/My Office/` (the database, a `projects` folder, and `server.log`); "Open folder" on a task shows the project in Finder. There is no `.env.local` in the app: enter your API keys in its settings. Closing the window keeps the agents working, and the app notifies you when something needs you; quit the app to stop them.

**Signing.** Without an Apple Developer ID the app is ad-hoc signed: it runs on the Mac that built it, and on another Mac it has to be opened the first time with right-click → Open. To distribute it properly, set these before building (see the top of `scripts/build-desktop.sh`):

```bash
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"   # the certificate in your keychain
export APPLE_ID=you@example.com APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx APPLE_TEAM_ID=TEAMID   # notarisation
```

**Updates.** A signed app can update itself. Tell the build where new versions will be, then upload the `.dmg`, the `.zip` and `latest-mac.yml` of each release there:

```bash
export MY_OFFICE_UPDATE_REPO=owner/repo        # a public GitHub repository's releases, or
export MY_OFFICE_UPDATE_URL=https://example.com/downloads
```

The app then checks at start and every few hours, downloads a newer version in the background, and installs it when it is next quit. Bump `version` in `electron/package.json` for each release.

## Docker

```bash
docker build -t my-office .
docker run -p 127.0.0.1:3000:3000 -v $(pwd)/workspace:/app/workspace --env-file .env.local my-office
```

Mount `/app/workspace` as shown to keep the generated files and the database. To use Ollama from the container, point `OLLAMA_URL` at the host, for example `-e OLLAMA_URL=http://host.docker.internal:11434`.

## Security

The office has no login, so it is built to be used from the computer it runs on:

- `npm run dev` and `npm start` listen on `127.0.0.1` only, and the API refuses requests addressed to any other host name. To reach it under another name (for example behind your own reverse proxy with authentication), list the names in `OFFICE_ALLOWED_HOSTS`.
- Requests that change anything are accepted only from the office page itself, so another website open in your browser cannot assign tasks or change settings.
- The browser cannot call a model or write a file directly; it can only queue tasks. Files are written by the engine, and only inside the task's project folder.
- A project preview is served from a separate local address: the page a model wrote cannot reach the office.
- Agents with web access can fetch public pages only. Addresses on this computer or a private network are refused, so an agent cannot be talked into reading the office's own API or a device on your network.
- Running checks is off by default; see [Checks](#checks) for what it does and how it is contained.
- Halting the office, or removing an employee, stops their model calls straight away.

Do not expose it to the internet without adding authentication first.

## Custom offices

Want an office built around your own team and workflow — different roles, your own tools and integrations, other AI providers, a custom floorplan, or a hosted multi-user version? I build customised versions on request.

Get in touch: **Hussein Zayat** — [husseinzayat10@hotmail.com](mailto:husseinzayat10@hotmail.com)
