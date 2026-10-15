# Same request, three models

One request run with **Insights → Compare models** on three models at once. Each model worked alone, in its own project, in the name of the same employee (the CEO). Nothing was edited afterwards.

> Build a one-page landing page for 'Tidy', a mobile app that scans receipts and sorts them into folders for taxes and expenses.

![The three landing pages side by side: gpt-4o-mini, gpt-4o and grok-3](side-by-side.jpg)

| Model | Cost | Time | Tokens | Result |
| --- | --- | --- | --- | --- |
| [`gpt-4o-mini`](gpt-4o-mini/) | $0.001 | 12 s | 6,718 | A plain page: heading, a list of features, a button. |
| [`gpt-4o`](gpt-4o/) | $0.021 | 11 s | 8,141 | Clean and simple, with a feature list and a call to action. |
| [`grok-3`](grok-3/) | $0.069 | 72 s | 12,658 | A finished landing page: hero with a phone mock-up, feature cards, "three steps", pricing note and app store buttons. |

Costs are the office's estimates from list prices. Runs were made on 15 October 2026; another run of the same request can come out differently.

## What it shows

For a visual, one-page job, the most expensive model here was clearly worth its seven cents. For well-specified work, such as implementing a design someone else wrote, the cheap model may be all an employee needs. Comparing before hiring is what the feature is for: the office shows result, time and cost side by side, and switches the employee to the model you pick with one click.

[The grok-3 page in full](grok-3-full-page.jpg) · open any `index.html` in a browser to see it live · each folder has the office's `REPORT.md` and the transcript of the work in `docs/`.

## The setup

The office had a short [handbook](https://husseinzayat3.github.io/Deskforce/concepts#company-knowledge) asking for polished, responsive pages, no image files that do not exist, and a README per project. Web access was off.
