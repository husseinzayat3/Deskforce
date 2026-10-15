# Costs & budgets

Every model call is counted: tokens in, tokens out, and an estimated cost. You decide how much a task and a month may spend.

::: info A real example
The bakery landing page in the [demo](/) — a plan, four employees on `gpt-4o`, delegation and a final review — cost **$0.11** in total.
:::

## How costs are estimated

Costs are **estimates from the providers' list prices**, per million tokens. They are not read from your bill, so they can differ a little from what the provider charges.

- **Cached input is cheaper.** The office sends each task's growing conversation so the provider can cache it, and counts cached input at the provider's discounted rate. Each further step of a task therefore costs a fraction of the first.
- **Ollama is free**, and mock answers (a provider without a key) cost nothing.
- **Web searches** count towards the task that made them.

Prices the office knows (USD per million tokens):

| Model | Input | Output |
| --- | --- | --- |
| `gpt-4o-mini` | 0.15 | 0.60 |
| `gpt-4o` | 2.50 | 10.00 |
| `grok-3` | 3.00 | 15.00 |
| `grok-3-mini` | 0.30 | 0.50 |
| `claude-fable-5-1` | 10.00 | 50.00 |
| `claude-opus-5-5` | 4.00 | 20.00 |
| `claude-sonnet-5-5` | 2.00 | 10.00 |
| `claude-haiku-4-5` | 1.00 | 5.00 |
| `gemini-2.5-pro` | 1.25 | 10.00 |
| `gemini-2.5-flash` | 0.30 | 2.50 |

A dated or suffixed name the provider reports (such as `gpt-4o-mini-2024-07-18`) uses the price of the listed name it starts with.

### Adding a model's price

A model that is not in the list shows **"cost unknown"**, and — important — **counts as free against budgets and the monthly cap**. If you use such a model, add its price to `MODEL_PRICING` in [`src/lib/officeConfig.ts`](https://github.com/husseinzayat3/Deskforce/blob/main/src/lib/officeConfig.ts) (and consider a pull request so others get it too).

## The plan's estimate

A plan comes with a rough cost: each step is sized small, medium or large, and priced with the model of the employee who will do it, plus a review when work is delegated. It is a guide to compare plans with, not a quote.

## Task budget

Each request you assign has a **budget** for the whole tree — the task, everything delegated from it, meetings, follow-ups and the review. The default is **$0.50**; set another in the box next to the request (up to $100).

When the budget is used up:

- work already running finishes;
- sub-tasks that have not started **wait for your approval** on the board, showing the amount spent — approve them to continue anyway;
- meetings and follow-up rounds are skipped.

## Monthly cap

**Insights → Spending → Monthly cap** sets a limit for the calendar month (0 means none). When it is reached:

- running tasks finish, but **no new task starts** until you raise the cap or the month ends;
- scheduled tasks are skipped, with a note;
- you get a notification, and a message in Slack if it is connected.

## Watching spending

**Insights** shows:

- **Spending** — this month against the cap, per day, per employee and per model.
- **Performance** — per employee and per model: tasks done, success rate, how often work had to be fixed afterwards, average cost and time.
- **Compare models** — see below.

Each task on the board also shows its tokens and cost, and the total for its tree against its budget.

## Comparing models

**Insights → Compare models** runs one request on two or three models, each in a project of its own, in the name and role of the employee you choose. When they finish, compare the result, the time taken and the cost side by side, and switch the employee to the model you prefer with one click.
