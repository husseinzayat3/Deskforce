# FAQ

## Is Deskforce free?

Yes. It is open source under the MIT license: free to use, change and redistribute, including commercially. You pay only your AI providers for the models you use — or nothing at all with local models through Ollama.

## How much does a task cost?

It depends on the models and the size of the work. As an example, the bakery landing page in the demo — planned, delegated to four employees on `gpt-4o`, and reviewed — cost $0.11. Every task has a budget ($0.50 unless you set one) and you can set a monthly cap. See [Costs & budgets](costs-and-budgets.md).

## Does my code or data leave my computer?

Project files stay on your computer. What is sent out is what the models need: the request, the plan and the relevant project files go to the provider of the employee doing the work, and searches go to the provider that runs them. With Ollama for every employee and web access off, nothing leaves your machine.

## Can it run fully offline?

Yes, with [Ollama](providers-and-models.md#ollama-free-and-fully-local) for every employee and web access turned off. Small local models do weaker work on bigger tasks than the large hosted ones.

## Which model should I use?

A strong model for whoever plans and reviews (the CEO, the Tech Lead) and cheaper ones for well-defined work. Use **Compare models** to try a request on several and decide. See [Providers & models](providers-and-models.md#choosing-a-model).

## Can agents break things on my computer?

Agents can only write inside their task's project folder, cannot reach your private network, and can only run tests if you turn that on (sandboxed on macOS). Every change is a git commit you can undo. See the [security model](security.md).

## Is the code it writes production-ready?

Treat it like work from a new colleague: often good, sometimes wrong. Read it, run it, and use **Request changes** for anything that needs fixing before you rely on it.

## Why does my Mac or Windows warn me when I open the app?

The apps are not yet signed with a paid certificate. See [Getting started](getting-started.md#desktop-app) for how to open them, and [Troubleshooting](troubleshooting.md#macos-says-the-app-is-damaged-or-cannot-be-checked) if macOS refuses.

## Can several people use one office?

It is built for one person on their own computer: there is no login, and it only answers on that computer. A team can share an office through [Slack](slack.md) (with a list of allowed users), or each person can import the same [office file](office-files.md). A hosted multi-user version with logins is available as a [custom build](custom-builds.md).

## Can I add my own tools or integrations?

The code is open: tools are defined in `src/lib/server/engine/runTask.ts`, and contributions are welcome ([CONTRIBUTING.md](https://github.com/husseinzayat3/Deskforce/blob/main/CONTRIBUTING.md)). If you would rather have it done for you, see [Custom builds](custom-builds.md).

## Can I change the office's look?

Yes: upload your own floorplan and avatars, and drag desks and rooms into place with **Arrange office**.
