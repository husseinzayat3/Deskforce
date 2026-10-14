# Features

## The office

- **Your own office** — upload a floorplan and avatars, and drag the desks and rooms to where they are on it. Each desk can belong to a role.
- **Visual office map** — each agent is a clickable avatar on the floorplan (click to open its tasks). The speech bubble shows what the model is writing as it writes it, and agents walk to the meeting room, the coffee machine and the break room.
- **Roles you define** — an office starts with eight roles (CEO, Tech Lead, Designer, QA, DevOps and more). Edit their instructions and seniority or add your own; an agent can only delegate to more junior roles.
- **A model per employee** — OpenAI, Anthropic (Claude), Google Gemini, Grok (xAI) or a local model through Ollama, and the exact model for each hire: a strong one for managers and reviewers, a cheap one for juniors.
- **Edit, archive, delete** — change an employee's role or model without losing their history; hide finished tasks or delete them with their files.
- **Office files** — export the roles, employees and templates of an office as one file and import it elsewhere.

## How the team works

- **Runs on the server** — tasks are executed by the server, not the browser tab. Close the page and the work carries on; after a restart, interrupted tasks go back in the queue.
- **Plan first** — a task can start with the employee proposing a plan and a rough cost estimate. Nothing is built until you approve it, edit it, or ask for another.
- **Shared context** — every agent sees the original request, its manager's plan, what colleagues already finished and the current project files, so work is built on rather than overwritten.
- **Follow-up rounds** — when delegated work comes back, the manager reads the results, fixes gaps, and may delegate once more before the final review.
- **Questions up the chain** — an employee who is unsure asks the manager who assigned the task and gets the answer straight away; only what the manager cannot decide reaches you.
- **Questions** — an agent that cannot do a task without information only you have asks, and carries on when you answer.
- **Message a running task** — say something to an employee mid-task without halting it.
- **Meetings** — when two agents are asked to change the same file, they meet first, agree who does what, and then work one after the other.
- **Final review and report** — when all delegated work is done, the task owner checks the whole project and fixes gaps. Each task you assign then gets a report.
- **Company knowledge** — a handbook you write (conventions, tone, preferred tools) that every employee is given, plus notes employees save for future projects.

## Output

- **Real tools, real output** — agents read, write and edit the project's files through tool calls, into a per-task folder under `workspace/projects/`. Models that cannot call tools fall back to a tagged text format.
- **Files, history and undo** — browse a project's files in the app. Every task is a git commit in the agent's name: see exactly what it changed and undo it with one click.
- **Preview** — projects with a web page (`index.html`) open in a preview, served from their own local address.
- **Web access** — agents search the web and read pages for current facts instead of inventing them. They can only reach public websites.
- **Attachments** — give a task files or images to work from, or a whole folder to start the project from.
- **Checks (opt-in)** — the office can check the syntax of a project's files and run its tests, and have failures fixed. Off by default; on macOS it runs sandboxed. See [Checks](checks.md).

## Keeping track

- **Task board** — a nested view of each task and its sub-tasks, with progress, tokens, estimated cost, live output, and buttons to retry, request changes or continue the project.
- **Projects and search** — a page per project with its files, cost and requests, and a search across every task and every project file.
- **Costs** — spending per day, per employee and per model, a budget per task, and a monthly cap that stops new work when it is reached. Repeated context is cached at the provider, so each further step of a task costs a fraction.
- **Performance** — per employee and per model: success rate, how often the work had to be fixed afterwards, average cost and time.
- **Model comparison** — run the same request on two or three models, each alone in its own project, and compare result, time and cost side by side before deciding who to "hire".
- **Templates and schedules** — save a task to run again with a click, or every day or week at a set time.
- **Notifications** — a system notification when a report is ready, an employee has a question, or a task fails.

## Anywhere

- **Talk to it from Slack** — message the office and your most senior employee answers: it starts tasks, reports how things stand, and tells you when a plan, a question or a report is waiting. See [Slack](slack.md).
- **Desktop app** — the whole office packaged as an app for macOS (Apple Silicon and Intel) and Windows, with a settings screen for your API keys. See [Desktop app](desktop-app.md).
- **Docker** — an image for Intel and ARM machines with each release. See [Docker](docker.md).
