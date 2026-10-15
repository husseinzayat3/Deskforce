# How it works

The office engine (`src/lib/server/engine/`) starts with the server and checks the queue every second. Each task is given to the employee's model together with the client's request, the manager's plan, what colleagues finished, and the project's files. The model then works by calling tools until it replies with a summary:

| Tool | Effect |
| --- | --- |
| `name_project` | Names the folder of a new project |
| `list_files`, `read_file` | Look at the project as it is now |
| `write_file`, `edit_file`, `delete_file` | Create, change or remove a file in the project folder |
| `delegate` | Hands a sub-task to a more junior colleague |
| `ask_manager` | Asks the manager who assigned the task; the answer comes back at once |
| `ask_client` | Pauses the task and asks you |
| `save_note` | Writes down a lesson for future projects |
| `web_search`, `fetch_url` | Look something up (Claude uses Anthropic's own web tools instead) |
| `post_to_slack` | Tells you something in Slack, when it is connected |
| `run_checks` | Checks syntax and runs tests, when you turned that on |

Every task that changes files becomes one git commit in the employee's name. A model that cannot call tools (for example `llama3` on Ollama) is given the same abilities as tags in plain text, such as `[FILE: path] … [/FILE]`; it has no web access and cannot run checks.

The guardrail limits, the per-model prices and the discounts for cached input used for cost estimates live in `src/lib/officeConfig.ts`. Costs are estimates from list prices; local Ollama models count as free.

## Technology

| Part | Technology |
| --- | --- |
| Frontend | Next.js (React), `framer-motion` |
| Backend | Next.js API routes, plus an in-process engine that runs the tasks |
| Database | `better-sqlite3` |
| AI | OpenAI SDK (OpenAI and Grok), Anthropic SDK, Gemini and Ollama HTTP APIs, all streamed, with native tool calling |
| History | `isomorphic-git` (no `git` program needed) |

How the server, the engine, the providers and the project folders fit together is described in [ARCHITECTURE.md](https://github.com/husseinzayat3/Deskforce/blob/main/ARCHITECTURE.md). Where each part lives in the code is described in [CONTRIBUTING.md](https://github.com/husseinzayat3/Deskforce/blob/main/CONTRIBUTING.md#where-things-are).
