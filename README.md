# Personal Dashboard

A set of small, self-contained HTML apps that share a top bar.

## Deploy your own copy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FParchy1%2Ffern-dashboard)

One click → Vercel signs you in, copies the repo to your GitHub, and deploys it. ~30 seconds to a live URL.

## How to use

Open any `.html` file directly in your browser — no build step, no install.

| File | What it is |
|---|---|
| [index.html](index.html) | Goals tracker (Day Ring, Goal Ticker, To Do list) — the home page |
| [health.html](health.html) | Supplement / daily stack tracker |
| [po-water.html](po-water.html) | Water intake tracker |
| [finance.html](finance.html) | Finances |
| [gym.html](gym.html) | Progressive overload gym tracker |
| [notes.html](notes.html) | Freeform notes |
| [reading.html](reading.html) | Reading & learning list (books, courses, articles, videos) |
| [business.html](business.html) | Side hustles & revenue tracker (affiliate marketing, freelance editing clients) |
| [topbar.js](topbar.js) | Shared top bar — auto-injected into pages that `<script src="topbar.js">` |

Each app stores its own state in browser `localStorage`. No accounts, no server.

## Tests

`npm test` runs the Node test suite in [tests/](tests/) (the serverless `api/*.js` functions,
plus gym.html's config-migration logic) — no browser, no external services. Runs automatically
on every push/PR via [.github/workflows/tests.yml](.github/workflows/tests.yml).

## Building from scratch

[BUILD_DASHBOARD.md](BUILD_DASHBOARD.md) is the prompt I gave Claude to generate `index.html` — paste it into Claude if you want to rebuild that page yourself.
