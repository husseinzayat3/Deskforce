# My Office — AI Agent Simulation

A virtual office where AI agents work as a team. Hire employees, give the CEO a goal, and watch it get broken down, delegated, and turned into files on your machine — all shown on an animated 2D floorplan.

## Features

- **Visual office map** — each agent is a clickable avatar on the floorplan (click to open its tasks), with a speech bubble showing what it is working on and trips to the coffee machine, break room and toilet.
- **Roles and delegation** — CEO, Tech Lead, Designer, HR and Junior Dev. Agents hand work down the hierarchy, and every sub-task is linked to the task that created it.
- **Task board** — a nested view of each task and its sub-tasks, with progress, tokens used, estimated cost, the agent's summary and the files it wrote.
- **Shared context** — every agent sees the original request, its manager's plan, what colleagues already finished and the current project files, so work is built on rather than overwritten.
- **Final review and report** — when all delegated work is done, the task owner checks the whole project and fixes gaps. Each task you assign then gets a report, and its output can be downloaded as a `.zip`.
- **Spending guardrails** — a budget in dollars per task (set when you assign it), limits on delegation depth and sub-tasks, plus duplicate detection. Anything over a limit waits for your approval instead of running.
- **Keep working on a task** — continue a finished project with a new request, send a finished task back with feedback, or retry a failed one. A file the model forgot to close is requested again automatically.
- **Real output** — agents write files into a per-task project folder under `workspace/projects/`, and can scaffold a Flutter or Node project to work in.
- **Multiple AI providers** — OpenAI, Grok (xAI), or a local model through Ollama. Each employee can use a different one.
- **Runs on the server** — tasks are executed by the server, not the browser tab. Close the page and the work carries on; reopen it, or open it in several tabs, and you see the current state. After a server restart, interrupted tasks go back in the queue.
- **Persistent state** — agents, tasks and history are stored in a local SQLite database (`workspace/office_state.db`).

## Getting started

### 1. Prerequisites

- Node.js 18.17 or newer
- At least one AI provider:
  - an OpenAI API key, or
  - an xAI (Grok) API key, or
  - [Ollama](https://ollama.com) running locally with the `llama3` model (`ollama pull llama3`) — set `OLLAMA_MODEL` to use a different one
- Optional: the Flutter SDK, if you want agents to scaffold Flutter projects

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

### 4. Run

```bash
npm run dev
```

Open `http://localhost:3000`, hire a few employees, and assign a task to the most senior one.

## How it works

The office engine (`src/lib/server/engine.ts`) starts with the server and checks the queue every second. Each task is sent to the employee's AI provider together with the list of colleagues and the files already in the project. The agent replies in plain text and can use these tags:

| Tag | Effect |
| --- | --- |
| `[PROJECT: short-name]` | Names the project folder (first response of a new task) |
| `[ASSIGN: colleague_id \| Short title] task [/ASSIGN]` | Delegates a sub-task to a more junior colleague |
| `[FILE: path/name.ext] contents [/FILE]` | Writes a file into the project folder |
| `[SCAFFOLD: flutter]` or `[SCAFFOLD: node]` | Initialises a project in the folder |
| `[SUMMARY] text [/SUMMARY]` | Records a summary for you to review |

The guardrail limits and the per-model prices used for cost estimates live in `src/lib/officeConfig.ts`. Costs are estimates from list prices; local Ollama models count as free.

| Part | Technology |
| --- | --- |
| Frontend | Next.js (React), `framer-motion` |
| Backend | Next.js API routes, plus an in-process engine that runs the tasks |
| Database | `better-sqlite3` |
| AI | OpenAI SDK (OpenAI and Grok), Ollama HTTP API |

## Docker

```bash
docker build -t my-office .
docker run -p 3000:3000 -v $(pwd)/workspace:/app/workspace --env-file .env.local my-office
```

Mount `/app/workspace` as shown to keep the generated files and the database. To use Ollama from the container, point `OLLAMA_URL` at the host, for example `-e OLLAMA_URL=http://host.docker.internal:11434`.

## Security

This app is built to run on your own machine. The API routes have no authentication: anyone who can reach the server can hire employees and assign tasks, which spends your API credits and writes files into `workspace/`. Do not expose it to the internet without adding authentication first.

The browser cannot call a model or write a file directly; it can only queue tasks. Files are written by the engine, and only inside the task's project folder.

## Custom offices

Want an office built around your own team and workflow — different roles, your own tools and integrations, other AI providers, a custom floorplan, or a hosted multi-user version? I build customised versions on request.

Get in touch: **Hussein Zayat** — [husseinzayat10@hotmail.com](mailto:husseinzayat10@hotmail.com)
