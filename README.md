# My Office — AI Agent Simulation

A virtual office where AI agents work as a team. Hire employees, give the CEO a goal, and watch it get broken down, delegated, and turned into files on your machine — all shown on an animated 2D floorplan.

## Features

- **Visual office map** — each agent is an avatar on the floorplan, with a speech bubble showing what it is working on and trips to the coffee machine, break room and toilet.
- **Roles and delegation** — CEO, Tech Lead, Designer, HR and Junior Dev. Agents hand work down the hierarchy, and every sub-task is linked to the task that created it.
- **Task board** — a nested view of each task and its sub-tasks, with progress, token usage, the agent's summary and the files it wrote.
- **Spending guardrails** — limits on delegation depth, sub-tasks per task and tokens per task tree, plus duplicate detection. Anything over a limit waits for your approval instead of running.
- **Real output** — agents write files into a per-task project folder under `workspace/projects/`, and can scaffold a Flutter or Node project to work in.
- **Multiple AI providers** — OpenAI, Grok (xAI), or a local model through Ollama. Each employee can use a different one.
- **Persistent state** — agents, tasks and history are stored in a local SQLite database (`workspace/office_state.db`).

## Getting started

### 1. Prerequisites

- Node.js 18.17 or newer
- At least one AI provider:
  - an OpenAI API key, or
  - an xAI (Grok) API key, or
  - [Ollama](https://ollama.com) running locally with the `llama3` model (`ollama pull llama3`)
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

Each task is sent to the employee's AI provider together with the list of colleagues and the files already in the project. The agent replies in plain text and can use these tags:

| Tag | Effect |
| --- | --- |
| `[ASSIGN: colleague_id] task [/ASSIGN]` | Delegates a sub-task to a more junior colleague |
| `[FILE: name.ext] contents [/FILE]` | Writes a file into the project folder |
| `[SCAFFOLD: flutter]` or `[SCAFFOLD: node]` | Initialises a project in the folder |
| `[SUMMARY] text [/SUMMARY]` | Records a summary for you to review |

The guardrail limits live in `src/lib/officeConfig.ts`.

| Part | Technology |
| --- | --- |
| Frontend | Next.js (React), `framer-motion` |
| Backend | Next.js API routes |
| Database | `better-sqlite3` |
| AI | OpenAI SDK (OpenAI and Grok), Ollama HTTP API |

## Docker

```bash
docker build -t my-office .
docker run -p 3000:3000 -v $(pwd)/workspace:/app/workspace --env-file .env.local my-office
```

Mount `/app/workspace` as shown to keep the generated files and the database. Ollama is expected at `127.0.0.1:11434`, so the Ollama provider needs extra network setup when the app runs in a container.

## Security

This app is built to run on your own machine. The API routes have no authentication: anyone who can reach the server can spend your API credits and write files into `workspace/`. Do not expose it to the internet without adding authentication first.

## Custom offices

Want an office built around your own team and workflow — different roles, your own tools and integrations, other AI providers, a custom floorplan, or a hosted multi-user version? I build customised versions on request.

Get in touch: **Hussein Zayat** — [husseinzayat10@hotmail.com](mailto:husseinzayat10@hotmail.com)
