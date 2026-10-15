# Office files

An **office file** is your office's setup saved as one JSON file, so you can set up the same office on another computer, share it with a colleague, or keep a ready-made team for a kind of work.

Find **Export** and **Import** in **Settings**.

## What is in it

| Included | Not included |
| --- | --- |
| Roles: names, ranks and instructions | API keys and Slack tokens |
| Employees: name, role, provider, model, avatar | Tasks, plans, reports and history |
| Templates and their schedules | Project files |
| The company handbook | Saved notes |
| Where the desks and rooms are | The floorplan picture and uploaded avatars |

Because it holds no keys or work, an office file is safe to share.

## Importing

Importing **adds what is missing and never removes anything**. Two things are replaced, though: roles of the same name, and the desk positions — export your own office first if you want to keep them.

- Roles in the file are added; a role of the same name takes the rank and instructions from the file.
- Employees are added unless one with the same name is already there. An employee whose role does not exist is skipped.
- Templates are added unless one with the same name exists. A scheduled template whose employee is missing is kept, to run by hand.
- The handbook is taken over only if this office has none yet.
- Desk and room positions are taken over; your floorplan picture and avatars stay.

The office tells you how many roles, employees and templates it imported.

## Ideas

- **A starter office per kind of work** — a web agency (Designer, Copywriter, Junior Devs, QA), a research team, a content studio — each with a handbook written for it.
- **A team standard** — everyone in a company imports the same roles, handbook and templates.
- **Before an experiment** — export first, then change roles and models freely.
