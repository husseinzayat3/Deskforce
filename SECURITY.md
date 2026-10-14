# Security

Deskforce lets AI models write files on your computer, fetch web pages and, if you turn it on, run tests they wrote. Problems in how that is contained are taken seriously.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

- **Preferred:** [report it privately on GitHub](https://github.com/husseinzayat3/Deskforce/security/advisories/new) (the repository's **Security** tab → **Report a vulnerability**).
- **Or by email:** [husseinzayat10@hotmail.com](mailto:husseinzayat10@hotmail.com?subject=Deskforce%20security) with "Deskforce security" in the subject.

Include what you can of:

- the version or commit, and how you run it (desktop app, `npm`, Docker);
- the steps to reproduce it, or a proof of concept;
- what an attacker gains (reading a file, spending on an API key, running a command, …).

Remove real API keys and tokens from anything you send.

You will get an answer within 7 days. Once a report is confirmed, a fix is prepared in private, released, and then described in a published advisory that credits you unless you prefer otherwise. Please give it that time before you publish details.

## Supported versions

Only the latest release and the `main` branch receive security fixes.

## What counts

Deskforce has no login and is built to be used from the computer it runs on (see [the security model](docs/security.md)). Within that design, these are vulnerabilities:

- a website open in the user's browser, or a previewed project page, reading office data or changing anything (assigning tasks, changing settings, spending);
- a model, a fetched web page or an attached file causing a read or write outside the task's project folder;
- an agent reaching an address on the user's computer or private network through web access;
- code run by the checks escaping the macOS sandbox, or receiving the office's environment or keys;
- a saved API key or Slack token being sent back to the browser, written to a log, or included in a build;
- a Slack user who is not on the allowed list getting the office to act;
- the desktop app's window loading or running content from anywhere other than its own server.

These are known limits, not vulnerabilities:

- Anyone who can already run programs as you on the computer can read the office database, including saved keys, which are stored unencrypted.
- Exposing the office to a network without putting authentication in front of it, or adding hosts to `OFFICE_ALLOWED_HOSTS` that should not be trusted.
- Checks on Linux and Windows run without a sandbox. This is documented and off by default.
- A model writing poor, wrong or insecure code inside its own project folder. Review what agents produce before you use it.
- A model being talked into wasting its own task's budget by text it read on the web, as long as it stays within the limits above.
