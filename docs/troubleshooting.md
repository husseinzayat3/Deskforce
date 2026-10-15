# Troubleshooting

Can't find your problem here? [Open an issue](https://github.com/husseinzayat3/Deskforce/issues/new/choose) with what you did, what you expected, and the error.

## Answers start with "[Mock … Response]"

That provider has **no API key**, so it answers with mock text and builds nothing. Add the key in **Settings** (or `.env.local` when running from the source, then restart). The settings screen shows which keys are set.

## macOS says the app is damaged, or cannot be checked

The app is not signed with a paid Apple certificate yet. Try to open it once, then go to **System Settings → Privacy & Security**, scroll down, and choose **Open Anyway**.

If macOS says the app **"is damaged and can't be opened"**, it is the download quarantine, not real damage. Move the app to Applications and run once in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Deskforce.app
```

## Windows says "Windows protected your PC"

Choose **More info → Run anyway**. The installer is not signed with a paid certificate yet.

## Port 3000 is already in use

Another program uses the port. Stop it, or run the office on another port:

```bash
npm run dev -- -p 3001
```

## "Cannot reach Ollama at …"

- Check Ollama is running: `ollama list` should answer.
- Check the model is pulled: `ollama pull llama3` (or the model your employee uses).
- **From Docker**, the container cannot see `127.0.0.1` of your computer: set `OLLAMA_URL=http://host.docker.internal:11434`.
- Check the address in **Settings** if you changed it there.

## "Web search needs an Anthropic, OpenAI or Gemini API key"

Searches are answered by an OpenAI, Gemini or Anthropic model. Add one of those keys, or turn web access off in Settings. See [web access](providers-and-models.md#web-access).

## A task failed

Open the task on the board: the error is in its details. Then:

- **Retry** puts it back in the queue — useful after a provider hiccup or a fixed key.
- **Request changes** sends finished work back with your feedback.

Common causes are a wrong model name (check it on the provider's site), an exhausted key or provider quota, or a model that stopped at its length limit (the task then lists a problem).

## Sub-tasks are "waiting for approval"

Either the **task's budget** is used up, or a hand-off broke a rule (for example delegating to someone of the same rank). The reason is shown on the task. **Approve** runs it anyway; cancel it otherwise. See [Concepts](concepts.md#seniority-and-delegation) and [Costs & budgets](costs-and-budgets.md#task-budget).

## No new tasks start

- The office may be **paused** (the Pause button in the header).
- The **monthly cap** may be reached: Insights → Spending shows it. Raise it, or wait for the next month.

## The cost shows "cost unknown"

The office has no price for that model. Until you add one, its spending counts as **free** against budgets and the cap. See [adding a price](costs-and-budgets.md#adding-a-model-s-price).

## The result is weak

- Give the CEO and reviewers a **stronger model**.
- Write a **handbook** with your standards — it is given to every employee with every task.
- Use **plan first** and edit the plan before approving.
- Send the work back with **Request changes**, or **Continue project** with a follow-up request.

## Where are the logs and the data?

| How you run it | Data and projects | Server log |
| --- | --- | --- |
| From the source | `workspace/` in the checkout | The terminal running `npm run dev` |
| Docker | The volume mounted on `/app/workspace` | `docker logs <container>` |
| Desktop app, macOS | `~/Library/Application Support/Deskforce/` | `server.log` in that folder |
| Desktop app, Windows | `%APPDATA%\Deskforce\` | `server.log` in that folder |

## Start again with an empty office

Stop the office, then delete the database: `office_state.db` and the files next to it that start with that name, in the data folder above. Delete the `projects` folder too if you want the generated work gone. Export an [office file](office-files.md) first to keep your roles, employees and templates.
