# Providers & models

Each employee runs on one **provider** and one **model**. You can mix them freely: a strong model for the people who plan and review, a cheaper one for those who carry out well-defined work.

## Providers

| Provider | Key | Get a key | Default model |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com/api-keys) | `gpt-4o-mini` |
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | [platform.claude.com](https://platform.claude.com) | `claude-opus-5-5` |
| Google Gemini | `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com/apikey) | `gemini-2.5-flash` |
| xAI (Grok) | `GROK_API_KEY` | [console.x.ai](https://console.x.ai) | `grok-3` |
| Ollama (local) | none | [ollama.com](https://ollama.com) | `llama3` |

Enter keys in the app's **Settings** (the gear button), or in `.env.local` when running from the source. A key saved in the app takes precedence over the environment.

A provider **without a key** answers with mock text instead of calling a model. It costs nothing and lets you try the interface, but nothing is built.

## Choosing a model

When you hire someone, pick the provider and type or choose a model. The hiring form suggests a few per provider; **any model name the provider accepts works**. Leave the model empty to use the provider's default, which you can change in Settings (or with `OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GEMINI_MODEL`, `GROK_MODEL`, `OLLAMA_MODEL`).

To change a model later, edit the employee: their history stays.

::: tip A starting point
- **CEO and Tech Lead** — they plan, delegate and do the final review, so their judgement matters most: give them your strongest model.
- **Designer, QA** — a mid-range model.
- **Junior Dev, Copywriter** — well-scoped work: a fast, cheap model is usually enough.

Not sure? Run the same request on two or three models with **Insights → Compare models** and look at result, time and cost side by side. See [Costs & budgets](costs-and-budgets.md#comparing-models).
:::

If you use a model the office has no price for, its cost shows as unknown; see [adding a price](costs-and-budgets.md#adding-a-model-s-price).

## Tools, and models without them

Employees work by calling **tools**: listing and reading files, writing and editing them, delegating, asking questions, searching the web ([the full list](how-it-works.md)).

Some models — many small local ones — cannot call tools. The office notices when a model refuses them, remembers it, and gives that model the same abilities as **tags in plain text** instead, such as `[FILE: path] … [/FILE]`. The work still gets done, with two differences: no web access, and no checks.

## Web access

With web access on (the default), employees can **search the web** and **read public pages** for current facts. How a search runs depends on the employee:

- **Claude** employees use Anthropic's own web search and fetch tools.
- **Everyone else** has their searches answered by a search-capable model: their own provider's if it is OpenAI or Gemini, otherwise any provider with a key. The defaults are `gpt-4o-mini-search-preview`, `gemini-2.5-flash` and `claude-haiku-4-5`; change them with `OPENAI_SEARCH_MODEL`, `GEMINI_SEARCH_MODEL` and `ANTHROPIC_SEARCH_MODEL`.

So web search needs an **OpenAI, Gemini or Anthropic key** somewhere in the office. Searches count towards the task's cost.

Turn web access off in Settings, or with `OFFICE_WEB_ACCESS=off`. Pages on your computer or private network can never be fetched; see the [security model](security.md).

## Ollama: free and fully local

[Ollama](https://ollama.com) runs models on your own computer: no key, no cost, and nothing leaves the machine.

1. Install Ollama and pull a model: `ollama pull llama3`
2. Hire an employee on **Ollama**, with that model name (or leave it empty for `llama3`).

| Setting | Default | What it does |
| --- | --- | --- |
| `OLLAMA_URL` (or Settings) | `http://127.0.0.1:11434` | Where Ollama runs. From Docker, use `http://host.docker.internal:11434`. |
| `OLLAMA_MODEL` (or Settings) | `llama3` | The model for Ollama employees hired without one. |
| `OLLAMA_NUM_CTX` | `8192` | The context window. The project's files are sent with every task, so raise it for larger projects if your model and memory allow. |

Small local models do noticeably weaker work on multi-step tasks than the large hosted ones. A practical mix is a hosted model for the CEO and reviewers, and local models for well-defined work.
