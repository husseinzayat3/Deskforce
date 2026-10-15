# Working on Deskforce

Guidance for AI coding agents (and people) changing this repository. Start with [ARCHITECTURE.md](ARCHITECTURE.md) for how the parts fit together, and [CONTRIBUTING.md](CONTRIBUTING.md) for where things are.

## Commands

```bash
npm run dev            # the office at http://127.0.0.1:3000
npm run lint
npm run typecheck
npm test               # unit, provider and engine tests, no keys or network needed
npm run test:e2e       # the office in a browser (needs `npx playwright install chromium` once)
```

Run lint, typecheck and `npm test` before you call a change done. They run on every pull request.

## Rules of the house

- **No `any` in `src/`** (ESLint enforces it). Read errors with `errorMessage()` from `src/lib/errors.ts`; type rows, payloads and provider formats.
- **The server does the work.** The browser reads state and asks for changes through the API; it never calls a model or writes a file. Office state changes only through `src/lib/server/store.ts`.
- **Test new logic** in `src/lib/`. To test something a model does, script its answers with `tests/helpers/fakeProvider.ts`, as `tests/engine.test.ts` does. Never call a real provider from a test.
- **Security code needs a test that shows what is refused**: `guard.ts`, `netGuard.ts`, path handling in `workspace.ts`, the sandbox in `checks.ts`, `electron/main.js`. Explain in the pull request why the change is safe.
- **Messages are read by non-programmers.** Errors and notices in the interface say what happened and what to do, in plain words.
- **Comments say why, not what.** Match the code around you: small functions, the existing naming, no new dependencies without a reason.
- **Keep the docs true.** A change someone using the office would notice goes in the README or the page in `docs/` it belongs to; a new docs page also needs a sidebar entry in `docs/.vitepress/config.mts`.
- **Adding a model:** add its price to `MODEL_PRICING` in `src/lib/officeConfig.ts`, or its cost shows as unknown and counts as free against budgets.

## Never

- Commit `.env.local`, anything from `workspace/`, or a real API key (also not in tests or screenshots).
- Run the office against real providers to check a change: use the mock (no key) or the fake provider.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
