# Security model

The office has no login, so it is built to be used from the computer it runs on:

- `npm run dev` and `npm start` listen on `127.0.0.1` only, and the API refuses requests addressed to any other host name. To reach it under another name (for example behind your own reverse proxy with authentication), list the names in `OFFICE_ALLOWED_HOSTS`.
- Requests that change anything are accepted only from the office page itself, so another website open in your browser cannot assign tasks or change settings.
- The browser cannot call a model or write a file directly; it can only queue tasks. Files are written by the engine, and only inside the task's project folder.
- A project preview is served from a separate local address: the page a model wrote cannot reach the office.
- Agents with web access can fetch public pages only. Addresses on this computer or a private network are refused, so an agent cannot be talked into reading the office's own API or a device on your network.
- Running checks is off by default; see [Checks](checks.md) for what it does and how it is contained.
- API keys and Slack tokens saved in the settings are stored unencrypted in the office database on this computer. The settings screen never sends a saved key back to the browser, only its last four characters.
- Halting the office, or removing an employee, stops their model calls straight away.

Do not expose it to the internet without adding authentication first.

To report a vulnerability, see [SECURITY.md](https://github.com/husseinzayat3/Deskforce/blob/main/SECURITY.md).
