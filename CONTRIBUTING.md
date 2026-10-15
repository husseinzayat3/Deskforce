# Contributing to Deskforce

Thank you for wanting to help. Bug reports, fixes, documentation and new features are all welcome.

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Before you start

- **A bug or a small fix:** open a pull request directly.
- **A new feature or a larger change:** open an issue first and describe what you want to build, so we can agree on the approach before you spend time on it.
- **A security problem:** do not open an issue. See [SECURITY.md](SECURITY.md).
- **A version made for your company:** that is paid work rather than a contribution; see [the README](README.md#need-a-custom-version).

## Setting up

You need Node.js 22 or newer (`nvm use` picks the version from `.nvmrc`).

```bash
git clone https://github.com/husseinzayat3/Deskforce.git
cd Deskforce
npm install
cp .env.example .env.local   # optional: without keys, providers return mock responses
npm run dev
```

Open `http://localhost:3000`. No API key is needed to work on the interface: a provider without a key answers with mock responses, and [Ollama](https://ollama.com) gives you a real model for free.

The office keeps its database and the generated projects in `workspace/`, which git ignores. To start again from an empty office, stop the server and delete `workspace/office_state.db*`.

## Where things are

| Path | What it holds |
| --- | --- |
| `src/app/api/` | The HTTP API. Routes check the request and call into `src/lib/server/`. |
| `src/lib/server/engine.ts` | The engine that takes tasks from the queue and runs them. |
| `src/lib/server/llm.ts` | The providers (OpenAI, Anthropic, Gemini, Grok, Ollama) and tool calling. |
| `src/lib/server/workspace.ts`, `git.ts` | Project files on disk and their history. |
| `src/lib/server/guard.ts`, `src/lib/netGuard.ts` | Which requests the office accepts, and which addresses agents may fetch. |
| `src/lib/officeConfig.ts` | Limits, default roles and model prices. |
| `src/components/` | The interface. |
| `electron/`, `scripts/` | The desktop app and its build. |
| `tests/` | Unit tests. |

## Documentation

The docs in `docs/` are published as a website with [VitePress](https://vitepress.dev). They have their own packages, so the app does not install them. To see your changes as they will look:

```bash
cd docs
npm install
npm run dev      # http://localhost:5173/Deskforce/
```

A new page also needs an entry in the sidebar in `docs/.vitepress/config.mts`. The build fails on a link to a page that does not exist.

## Before you open a pull request

```bash
npm run lint
npm run typecheck
npm test
```

All three run on every pull request and must pass.

- **Add a test** for new logic in `src/lib/`. Tests use Node's built-in runner; copy the style of the files in `tests/`.
- **Changes to the security code** (`guard.ts`, `netGuard.ts`, path handling in `workspace.ts`, the sandbox in `checks.ts`, `electron/main.js`) need a test that shows what is refused, and a sentence in the pull request on why the change is safe.
- **Match the code around you:** small functions, a comment that says why rather than what, and messages a non-programmer can understand, since they are shown to the user.
- **Update the docs** (the README, or the page in `docs/` it belongs to) when you add a setting, a command or a behaviour someone using the office would notice.
- **Adding a model:** add its price to `MODEL_PRICING` in `src/lib/officeConfig.ts`, or its cost shows as unknown.
- **Keep a pull request to one subject.** Two unrelated fixes are easier to review as two pull requests.
- **Never commit** `.env.local`, anything from `workspace/`, or a real API key in a test or a screenshot.

## Licence of contributions

Deskforce is released under the [MIT License](LICENSE). By opening a pull request you agree that your contribution is released under the same licence.
