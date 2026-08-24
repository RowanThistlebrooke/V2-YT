# Overseer-1 · Claude Working File

> **Read this before touching any code.** Update the relevant module changelog at the bottom of every session before committing. This file is the authoritative trace of what changed, when, and why — the first place to look when something breaks.

---

## Change Protocol

**Before any change:**
1. Read the changelog section for every module you are about to touch.
2. Identify any recent changes that could interact with your change.
3. State your plan in one sentence. If it touches `sync.js` behavior or `localStorage` keys, re-read the Architecture Invariants section first.

**While changing:**
- One logical change per commit. Do not bundle unrelated fixes.
- Never change a shared module (`sync.js`, `topbar.js`) without considering every page that loads it.
- If a function is called from both an IIFE and from outside it, check scope — functions defined inside an IIFE are invisible to outside scripts.

**After every change:**
- Append an entry to every affected module's changelog (bottom of this file). Format: `YYYY-MM-DD | commit hash | what changed | what it could break`.
- Push immediately after committing.
- If the change touches the coach, bump `COACH_PROMPT_BUILD` in `topbar.js` (search for that constant) so stale proactive scans are invalidated same-day.

**Pre-push bug sweep (run before every commit):**
After implementing any change, scan all touched files for these common failure classes before committing:
1. **Array direction bugs** — `slice(-N)` takes the last N (oldest if sorted newest-first). Verify intended direction for every array slice in `dashboardData()` and render paths.
2. **`applyRemote` race conditions** — any new `save()` or write that doesn't immediately `fetch('/api/db', ...)` will lose data if a 30s poll fires within the 250ms debounce window (Invariant §9).
3. **IIFE scope breaks** — any helper called from `onApplied` must be defined in the same IIFE (Invariant §1). Check after any restructuring.
4. **Silent catch blocks** — every `catch` must `console.warn/error` (Invariant §12). Grep for `catch(` in changed files and confirm none are empty.
5. **`COACH_PROMPT_BUILD` not bumped** — if dashboardData(), PROACTIVE_SYS(), or CHAT_SYS() changed, old scan is still cached. Always bump.
6. **New localStorage key not in registry** — if a new key is written, add it to the Project Map key table and appKey registry if it needs syncing.
7. **Stale data passed to AI** — any array trimmed for the AI context (`slice`, `.map`, `.filter`) must use the correct end of the array. Newest-first arrays need `slice(0, N)`, not `slice(-N)`.

If any of the above is found while working on an unrelated change, fix it in the same session and add it to the changelog.

---

## Architecture Invariants

These rules encode bugs that were already discovered and fixed. Breaking any of them will reproduce the same class of bug.

### 1. initCloudSync scope
`initCloudSync()`'s `onApplied` callback runs inside `sync.js`. Any helper function it calls (`rollover`, `getActiveDateString`, `storeListKeys`, `processStreak`, `loadToday`, etc.) must be in scope — i.e., the `initCloudSync` call must be **inside the same IIFE** that defines those helpers.

Putting `initCloudSync` in a separate `<script>` block causes every `onApplied` call to throw a silent `ReferenceError` (swallowed by sync.js's try/catch), making `onApplied` a permanent no-op.

**Affected file:** `main.html` (goals module). Fixed in commit `088d1a3`.

### 2. sync.js applyRemote is REPLACE-ALL
`applyRemote(remote)` does two things:
- Sets every key from the server snapshot into localStorage.
- **Deletes** every local key that is NOT in the server snapshot (for keys that `matches()` returns true for).

This means: if rollover creates `goals:2026-07-14` locally, then sync fetches a server snapshot that only knows about `goals:2026-07-13`, it will **delete** `goals:2026-07-14`. Always account for this when designing what keys to sync.

### 3. Goals rollover timing
`rollover()` in `main.html` runs synchronously during HTML parsing (inside the main IIFE). `initCloudSync` runs in `DOMContentLoaded` (slightly later), and its `init()` fetch is async. The sequence is:

1. Page parses → IIFE executes → `rollover()` runs → creates `goals:today` from past keys.
2. DOMContentLoaded → `initCloudSync` init → fetch (async).
3. Fetch returns → `applyRemote(serverSnapshot)` → server only has yesterday's key → **deletes** `goals:today`.
4. `onApplied` fires → re-runs `rollover()` → re-creates `goals:today` → corrects state.

`onApplied` calling `rollover()` is intentional and load-bearing. But rollover must guard against running when there are no past keys (the `changed` flag, added in `216269a`).

### 4. onApplied must not clear an active UI session
If `onApplied` wipes DOM state (e.g. `feed.innerHTML = ''`) it will fire at any time — on a 30-second poll or on a slow init fetch — and destroy whatever the user is currently doing.

**Rule:** `onApplied` may update `localStorage`, call re-render functions, or dispatch events. It must **never** clear UI elements that the user may have populated (chat feed, form inputs, etc.).

**Lesson learned from:** `c2422fd` introduced a coach sync with `onApplied` that did `feed.innerHTML = ''` → caused conversations to be deleted mid-typing. Fixed in `6130451`.

### 5. strava activities: never pass raw date to Claude
When building the `dashboardData()` payload for the AI in `topbar.js`, strava activity entries must NOT include a raw `date`/timestamp field. Claude will re-derive relative time from the raw date and get it wrong. Instead, include only a precomputed `when` string (`'today'`, `'yesterday'`, `'2 days ago'`, etc.) computed in JS at call time.

**Affected function:** `dashboardData()` in `topbar.js`, the `strava_activities_v1` branch. Fixed in `6ef89dd`.

### 6. coach_proactive_* must NOT be synced
These are ephemeral per-day keys (`coach_proactive_YYYY-MM-DD = "1"`) that record whether the proactive scan ran today. Syncing them across devices prevents a fresh session from re-running the scan with the current prompt code. They must stay local-only.

**Rule:** never add `coach_proactive_` to any `syncedKeys` or `syncedPrefixes` in `initCloudSync`.

### 7. COACH_PROMPT_BUILD version key
When the coach scan prompt or `dashboardData()` formatting changes, bump the constant `COACH_PROMPT_BUILD` in `topbar.js`. On page load, `initCoach()` compares `localStorage.getItem('coach_prompt_build')` to this constant. If they differ, today's proactive key is cleared and the scan re-runs with the new code. Without this, users see the old (wrong) cached scan until the next calendar day.

### 8. Never share an appKey between pages that sync different key sets
`sync.js` `pushNow()` sends the **complete** `collect()` snapshot for a given `initCloudSync` instance — not just changed keys. If page A syncs `{stack:items, po_water_v1}` under `appKey: 'health'`, and page B syncs only `{po_water_v1}` under the same `appKey: 'health'`, then a push from page B sends `{po_water_v1: ...}` to the server — overwriting the entire `health` row and deleting `stack:items` from the server. The next `applyRemote` on page A then removes `stack:items` from localStorage.

**Rule:** Each `appKey` must be owned by one logical domain. If two pages need to sync overlapping but non-identical key sets, give each domain its own `appKey`. See the appKey registry table in the Project Map.

**Fixed in:** `po-water.html`, `index.html`, `health.html` — previously all shared `appKey: 'health'`. `po_water_v1` moved to `appKey: 'profile'`.

### 9. Every save function must fire an immediate push
`sync.js` debounces pushes 250 ms after `localStorage.setItem`. If `applyRemote` fires within that 250 ms window (e.g. a 30-second poll coincides with a save), the local write is overwritten by stale server data before the push fires.

**Rule:** Every `save()` / `savePlan()` / `savePurchases()` function must fire its own `fetch('/api/db', { method: 'POST' })` immediately after `localStorage.setItem` — no `keepalive: true` (64 KB limit), use regular fetch with `.catch(function(e) { console.warn(..., e); })`. The debounced sync.js push still fires as a backup; both are idempotent.

**Anti-pattern to avoid:**
```js
function save(items) { localStorage.setItem(KEY, JSON.stringify(items)); } // ← missing immediate push
```
**Correct pattern:**
```js
function save(items) {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch(e) { console.error('[module] localStorage full:', e); }
  fetch('/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Secret': window.DASH_APP_SECRET || '' },
    body: JSON.stringify({ key: 'APPKEY', data: { [KEY]: items } }) }).catch(function(e) { console.warn('[module] push failed:', e); });
}
```

### 10. processStreak must run before rollover
`rollover()` deletes past-date goal keys from localStorage. `processStreak()` reads those same keys to decide whether to increment the streak. Calling them in the wrong order means `processStreak` always sees an empty set of past keys → streak count never increments.

**Rule:** Always call `processStreak()` BEFORE `rollover()` at boot and inside `onApplied`. This applies both to the boot sequence in `main.html` and to `topbar.js`'s `rolloverGoals()` if it ever gains streak logic.

### 11. persistActive must be applyRemote-resilient
If `applyRemote` fires while a note (or any record) editor is open, it can wipe the item from localStorage. A naive `load().find(x => x.id === activeId)` then returns `null`, and an early `return` silently loses everything the user typed.

**Rule:** If the item is not found in localStorage, re-add it from the editor's current DOM state rather than returning early. `onApplied` must call `persistActive()` (or equivalent) before re-rendering so in-progress edits survive every poll cycle.

### 12. Never swallow errors with empty catch blocks
`try { ... } catch(e) {}` and `.catch(function() {})` hide failures permanently. Users see nothing; developers see nothing. This was the root cause of both the keepalive 64 KB failure (coach history) and the processStreak order bug being undetected for weeks.

**Rule:** Every catch block must do at least one of:
- `console.error('[module] what failed:', e)` — for unrecoverable internal errors
- `console.warn('[module] what failed:', e)` — for recoverable/retry-able operations (like fetch)
- Show a user-visible status message (for errors the user needs to act on)

Never use a bare `catch(e) {}` or `.catch(function() {})` with no body.

### 13. updatedAt timestamps for optimistic concurrency
When a page has a large object that the coach can also write (e.g. `marathon_plan_v1`), `applyRemote` can overwrite a coach-written value with a stale server snapshot if the push is still in-flight. Fix: stamp `updatedAt = Date.now()` on every write (both user-saves and coach-writes); in `onApplied`, compare `incoming.updatedAt` vs `plan.updatedAt` — if incoming is older, skip the apply.

**Rule:** Any page where the coach writes to the same localStorage key that `applyRemote` also writes must maintain an `updatedAt` timestamp and guard `onApplied` with `if (incomingTs < currentTs) return`.

**Affected file:** `marathon.html`. Fixed in session 2026-07-23.

---

## Project Map

| File | Module | What it does |
|------|--------|--------------|
| `topbar.js` | **Topbar / Coach / Usage** | Injected on every page. Renders the top bar (water, supplements, XP). Contains the entire Coach (JARVIS-style AI panel), proactive scan, voice, history. Also runs goal rollover on pages that aren't `main.html`. |
| `sync.js` | **Cloud Sync** | Shared library. `initCloudSync({appKey, syncedKeys, syncedPrefixes, onApplied})` per page. Patches `localStorage.setItem/removeItem` to schedule pushes. Polls server every 30 s. REPLACE-ALL on `applyRemote`. |
| `main.html` | **Goals / To-Do** | Goals list, drag-reorder, streaks, tomorrow planning, push-to-tomorrow. Calls `initCloudSync` inside the main IIFE so `onApplied` has access to helper functions. |
| `index.html` | **Home / Bento Grid** | Dashboard landing page with bento tiles linking to all modules. |
| `gym.html` | **Workout Tracker** | PPL plan builder, set/rep logger, progressive overload, rest timer, 1RM goals. Synced via `initCloudSync`. |
| `finance.html` | **Finance** | Net worth, budget, jobs/income, account transfers, activity feed. |
| `saved-links.html` | **Saved Links** | Paste/share links, AI auto-categorize via Claude. |
| `health.html` | **Supplements** | Daily supplement stack tracker. |
| `marathon.html` | **Marathon** | Marathon training plan, long-run tracking. |
| `brain.html` | **Notes / Brain** | Obsidian-connected notes and observations. |
| `mail.html` | **Mail** | Gmail inbox viewer, shipping tracker, compose. Reads `gmail_summary_v1` from localStorage (populated by `topbar.js`). Compose calls `window.sendGmailNow()`. |
| `internship.html` | **Internships / Research** | AI opportunity search, manual opportunity list, email template, AI email personalization, Gmail send modal. Stores data under `appKey: 'internships'`. |
| `calendar.html` | **Calendar** | Google Calendar viewer + OAuth flow. Holds the Google `SCOPE` constant — must be updated here when new OAuth scopes are needed. Users must reconnect after any scope change. |
| `api/db.js` | **DB Proxy** | Server-side Supabase proxy. All sync reads/writes go through `/api/db`. |
| `api/ai/ai-chat.js` | **AI Chat Proxy** | Server-side proxy to Anthropic API. Used by coach and link auto-categorize. |
| `api/integrations/google.js` | **Google Proxy** | Handles OAuth token refresh and forwards API calls. Routing: `/userinfo` → Google OAuth2; `/users/*` → Gmail API; all others → Google Calendar API. POST with `?path=` param → API write; POST without → token refresh. |
| `api/push-send.js` | **Push Notification Cron** | Vercel cron handler. `morning` (8 AM), `reminders` (9 AM) cases. Reads goals and marathon plan from Supabase; falls back to `goals:yesterday` when `goals:today` is absent. |
| `middleware.js` | **Auth** | Vercel edge middleware. Checks `x-app-secret` header on all `/api/*` routes. |

**localStorage key namespaces** (important for sync scoping):

| Prefix | Module | Synced? | appKey |
|--------|--------|---------|--------|
| `goals:YYYY-MM-DD` | Goals | Yes (prefix `goals:`) | `goals` |
| `goals_history_v1` | Goals | No (local archive only) | — |
| `coach_chat_history` | Coach | Yes (exact key) | `coach` |
| `coach_proactive_YYYY-MM-DD` | Coach | **No** — must never be synced | — |
| `coach_prompt_build` | Coach | No | — |
| `apiusage:log` | Usage | Yes (exact key) | `apiusage` |
| `strava_activities_v1` | Strava | No (pulled fresh by integration) | — |
| `gmail_summary_v1` | Mail / Coach | **No** — local-only cache, refreshed on demand | — |
| `gmail_last_sync` | Mail / Coach | No — ephemeral throttle timestamp | — |
| `po_coach_v1` | Workout Coach | No | — |
| `po_coach_workout_done` | Workout | No | — |
| `savedlinks:items` | Saved Links | Yes (exact key) | `savedlinks` |
| `stack:items`, `stack:version`, `stack:low`, `stack:taken:*` | Supplements | Yes (keys + prefix) | `health` |
| `po_water_v1` | Profile / Water | Yes (exact key) | `profile` |
| `subs`, `wishlist`, `nw:*` etc. | Finance | Yes | `finance` |
| `caf:logs`, `caf:custom` | Caffeine | Yes | `caffeine` |

**appKey registry** — each appKey must be unique to its data domain. Never share an appKey between two pages that sync different sets of keys (Invariant §8).

| appKey | Owner pages | Keys synced |
|--------|-------------|-------------|
| `goals` | `main.html` | prefix `goals:` |
| `coach` | `topbar.js` (all pages) | `coach_chat_history` |
| `apiusage` | `topbar.js` (all pages) | `apiusage:log` |
| `health` | `health.html` | `stack:items`, `stack:version`, `stack:low`, prefix `stack:taken:` |
| `profile` | `health.html`, `index.html`, `po-water.html` | `po_water_v1` |
| `finance` | `finance.html` | `subs`, `wishlist`, `nw:*`, etc. |
| `savedlinks` | `saved-links.html` | `savedlinks:items` |
| `caffeine` | `caffeine.html` | `caf:logs`, `caf:custom` |
| `marathon` | `marathon.html` | `PLAN_KEY` |
| `nutrition` | `nutrition.html` | store key |
| `notes` | `notes.html` | store key, cat key |
| `shopping` | `shopping.html` | purchase key |
| `personalcare` | `personal-care.html` | store key |
| `skincare` | `skincare.html` | store key |
| `chores` | `chores.html` | store key |
| `internships` | `internship.html` | `internship:resume_ctx`, `internship:opportunities`, `internship:applied`, `internship:email_template`, `internship:sent_log` |
| *(none)* | `mail.html` | No sync — reads `gmail_summary_v1` populated by topbar.js; sends via `window.sendGmailNow()` |

---

## Module Changelogs

Entries are newest-first within each section. Add a new entry at the **top** of the relevant section after every change.

---

### `topbar.js` — Topbar / Coach

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-08-23 | `16e28d8` | Fixed `loadGmailSummary` exiting early for legacy Google accounts (connected before scope tracking was added). Root cause: `if (!account.scope \|\| !account.scope.includes('gmail.readonly')) return` blocks any account without a stored `scope` field — even if the token actually has Gmail access. Fix: `if (account.scope && !account.scope.includes('gmail.readonly')) return` — only block when scope is explicitly set and doesn't include gmail.readonly. This matches `hasGmailScope()` logic in mail.html. | Accounts without a scope field will now always attempt Gmail fetch. If the token genuinely lacks Gmail scope, the fetch will fail with 403 and be caught silently — no worse than before. |
| 2026-07-27 | `c7a3677` | Fixed `[COACH_ACTION:...]` JSON parse failing with "Expected property name or '}' at position 1". Root cause: AI was emitting JS-style objects with unquoted property names (`{module:"marathon"}` instead of `{"module":"marathon"}`). Fix: if `JSON.parse` fails, attempt repair by adding double-quotes around unquoted property names before retrying. Also: (1) logs the raw extracted JSON string (first 400 chars) to `console.warn` on parse failure so the AI output can be directly inspected; (2) separates JSON parse errors from `executeCoachAction` runtime errors — errors are no longer all labeled "Invalid action JSON" regardless of cause. | Regex repair `([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:` assumes property names don't contain special characters — correct for all current action schemas. Won't help if the AI emits completely broken JSON (e.g., truncated payload or double-brace wrapping `{{...}}`). |
| 2026-07-27 | `7e1eb60` | Fixed coach marathon (and goal) writes being silently lost when a reply contained multiple `[COACH_ACTION:...]` blocks. Root cause: `ask()` ran all actions via `Promise.allSettled(actionJsons.map(...))` — fully parallel. Each `executeCoachAction` read the same stale `marathon_plan_v1` from localStorage before any previous action had written back; mutations applied to the same base; last write won and all earlier changes were discarded. Most critical case: `replace_plan` (20 entries) + `append_entries` (20 more) in one reply — `append_entries` saw the pre-replace plan and overwrote the 20 new entries. Fix: replaced `Promise.allSettled` with a sequential `for...of` / `await` loop so each action reads the localStorage state the previous action already wrote. Also fixed `marathon.html` `onApplied`: when a stale server snapshot is rejected (`incomingTs < currentTs`), `applyRemote` had already overwritten localStorage with stale data before calling `onApplied`. Added `saveJSON(PLAN_KEY, plan)` before the early return to restore localStorage from in-memory state, preventing a page refresh from loading the old plan. | Sequential execution adds ~200–400ms latency when a reply has multiple action blocks (each push is awaited in order). Acceptable tradeoff for correctness. Calendar and water actions now also serialize with marathon/goals actions if they appear in the same reply — previously they could have parallelized. |
| 2026-07-27 | `508ef56` | Four fixes: (1) dashboardData() trim loop was trimming `marathon_plan_v1` first (largest key), sending `"[trimmed]"` to the coach — coach couldn't see entry dates/types for write ops. Fix: trim all other keys by size first; only reduce entries_upcoming to 20 as a secondary step; trim marathon entirely last. (2) Mileage discrepancy (chart shows 22.8 vs 26.89 Strava total): `matchStravaToSchedule` skipped entries with `completed:true, source:'manual', manualOverride:false` (imported or coach-written entries) — they never got GPS distance refreshed. Fix: removed the `!en.completed||en.source==='strava'` gate on the non-manualOverride path; always update with Strava GPS. (3) Added `supaFetchWithRetry()` to api/db.js — retries once after 600ms on Supabase 5xx or network error (never on AbortError). Reduces transient Supabase failures appearing in Vercel High Severity monitoring. (4) favicon 404: created `favicon.svg` (⚡) + vercel.json rewrite `/favicon.ico` → `/favicon.svg`. | Strava now always wins for non-manualOverride entries, even if they were previously manually marked complete with a different distance. manualOverride:true entries still respected (completion status untouched; GPS distance updated if completed). |
| 2026-07-27 | `98d7877` | Fixed marathon plan not being replaced when coach writes. Two root causes: (1) `_pendingMarathonPlan` in-memory buffer added — `executeCoachAction` reads from it if set instead of localStorage. Between sequential actions (replace_plan → append_entries), sync.js's 30s `applyRemote` poll could overwrite localStorage with a stale server snapshot before the push propagated; action 2 then read the stale base and appended to the wrong plan. `_pendingMarathonPlan` is immune to `applyRemote` since it's a JS variable. Cleared to null before/after the for loop in `ask()`. (2) Added `coach:marathon:updated` CustomEvent dispatched after each successful marathon push; marathon.html listener immediately re-reads localStorage and re-renders — fixes display not updating until the next 30s sync poll. | `_pendingMarathonPlan` is cleared after EACH `ask()` invocation so it only bridges actions within one reply. If a user sends a second message before the first reply's push completes (impossible since busy=true), the buffer is correctly reset. The custom event only fires when the coach panel is on the same page as marathon.html (same window) — other tabs/devices still wait for the 30s poll. |
| 2026-07-27 | `2c8688b` | `loadGmailSummary()` now pushes a compact `gmail_alerts` object to Supabase after every successful Gmail fetch: `{unreadCount, importantCount, shippingCount, topImportant:[{from,subject,when}], updatedAt}`. This key is read by `api/push-send.js` so the morning and reminders crons can surface important email counts in notifications without a separate OAuth flow. | `gmail_alerts` is pushed on every Gmail fetch (every 15 min when coach opens). If Supabase is unreachable at that moment, the push silently fails and the cron uses stale alert data. The key is NOT synced via `initCloudSync` — direct POST only. |
| 2026-07-27 | *(this session)* | Added file attachment to coach: 📎 button opens file picker (images up to 5 MB, text/markdown/JSON/CSV up to 500 KB). Images sent as Claude vision content blocks; text files prepended as fenced blocks. Attachment preview bar with thumbnail (for images) and ✕ dismiss. `callAI()` gains optional `attachment` param; history stores text summary (not raw base64). `api/ai/ai-chat.js` bumps `max_tokens` to 2048 when `hasAttachment:true`. |  base64 image data is NOT stored in `coach_chat_history` — each image is single-turn only; follow-up messages can't refer back to a previously attached image. If the file picker is dismissed without selecting a file, the existing attachment is preserved. |
| 2026-07-27 | *(this session)* | Four fixes: (1) Added `replace_plan` op to marathon `executeCoachAction()` — replaces ALL `plan.entries` atomically with a new set. (2) Fixed proactive status sweep running on every page load when localStorage is full. Root cause: `localStorage.setItem('coach_prompt_build', ...)` failed silently on quota → version check fired on every load → proactive key deleted every load → scan triggered every open. Fixes: `pruneOldStorage()` called before the COACH_PROMPT_BUILD check; retry-on-quota for `coach_prompt_build` save; proactive key set BEFORE `addMsg()` in `runProactiveScan()`. `COACH_PROMPT_BUILD` bumped to `'2026-07-27-v4'`. (3) Fixed `[COACH_ACTION:...]` JSON parsing truncating payloads with nested `]` chars (e.g. entries arrays). Simple lazy regex stops at first `]` inside the JSON. Replaced with bracket-depth parser (`extractCoachActions` / `stripCoachActions`). (4) Added `append_entries` op — additive batch that adds entries WITHOUT clearing existing ones. Use after `replace_plan` for subsequent batches when a full plan is too large for one AI reply. `CHAT_SYS()` updated with LARGE PLAN RULE: max 20 entries per block, batch with explicit user confirmation between batches. | `replace_plan` discards ALL existing entries including completed runs — coach should only use it for the first batch of a fresh plan, then use `append_entries` for subsequent batches. After a `replace_plan`, completed run history is lost from the plan (Strava remains the source of truth). |
| 2026-07-27 | `747aaf7` | Fixed coach marathon/goals changes being overwritten by concurrent `primeCoachData`. Root cause: `_coachLastMarathonWrite` and `_coachLastGoalsWrite` were set AFTER the push `await`, not after the localStorage write. `primeCoachData()` runs concurrently when the panel opens — if its server fetch returned while the push was in-flight, the `forEach` wrote stale server data to localStorage before the session guard was active. Three fixes: (1) Move both session guards to immediately after `localStorage.setItem`, before `await fetch`. (2) Add `_coachLastMarathonWrite` time-based check as primary guard in `primeCoachData` marathon block (matches goals pattern). (3) Fix `updatedAt` comparison from `>` to `>=` and protect when only local has `updatedAt` (previously fell through). `COACH_PROMPT_BUILD` bumped to `'2026-07-27-v3'`. | If `_coachLastMarathonWrite` and `_coachLastGoalsWrite` are non-zero, `primeCoachData` will not overwrite those keys for 5 minutes. If the user makes changes in marathon.html or main.html within that window on another device, those cross-device changes won't sync to this session until the guard expires. Acceptable — user-initiated cross-device changes during an active coach session are rare. |
| 2026-07-27 | `1c43cfb` | Fixed daily scan running on every coach open (two root causes): (1) `ask()` success path was calling `localStorage.removeItem(proactiveDayKey())` after every COACH_ACTION write — reset the once-per-day gate after every goal/plan/water change, so next open always re-scanned. Removed. (2) `pruneOldStorage()` was deleting ALL `coach_proactive_*` keys including today's — if called during a quota-full event mid-session, the daily gate was reset. Fixed to preserve today's key. Fixed marathon plan visibility: `entries_upcoming` was capped at 30 entries (~30 days) — Toledo race Sep 20 is ~55 days away, making race week and taper invisible. Cap raised to 90 and array explicitly sorted. Added `race_countdown_days` and `race_when` (precomputed) so coach reports race countdown without re-deriving from raw `raceDate`. `COACH_PROMPT_BUILD` bumped to `'2026-07-27-v2'`. | Scan now only re-runs via explicit user rescan request (↻ button or "redo status sweep" command) or on `COACH_PROMPT_BUILD` change. If data changes critically mid-day and the user wants the coach to re-evaluate, they must click ↻. |
| 2026-07-27 | `284e483` | Four bugs fixed: (1) Added `snooze`/`unsnooze` goal ops to `executeCoachAction()`. Fuzzy case-insensitive substring match so "ignore math 223" matches "MATH 223 assignment". `dashboardData()` annotates snoozed goals with `snoozed:true`; `PROACTIVE_SYS` DATA RULE (5) excludes them from counts, bullets, alerts. `CHAT_SYS()` documents the op schema. (2) Hydration data fix: `po_water_v1` was passed raw (all date-keyed logs) — coach had to guess today's key and got it wrong (Invariant §5 violation). Now precomputed in `dashboardData()` to `{today_bottles, today_target, today_pct, unit, recent_7d}` using same formula as `getWaterProgress()`. (3) Water push now `await`ed with `res.ok` check (was fire-and-forget `.catch()` — a 504 looked like success, next `primeCoachData()` restored stale server data). (4) Extended `INSTR_RE` to catch `ignore `, `skip `, `until <month>` phrases so "ignore X until August" is saved to `coach_memory`. `COACH_PROMPT_BUILD` bumped to `'2026-07-27-v1'`. | Snoozed goals still visible in `main.html` UI (just hidden from coach briefings). User can un-snooze via coach or by directly editing localStorage. Water precompute uses same formula as `getWaterProgress()` — if `po-water.html` ever changes its target formula, this must be updated in parallel. |
| 2026-07-23 | `73daca8` | Fixed coach action errors being silently buried after AI success claims. (1) `ask()` changed from `Promise.allSettled().then()` (non-blocking) to `await Promise.allSettled()` so all actions complete before anything is displayed. Errors now prepend the reply as `"🚫 N changes could not be saved:\n• reason\n\n<reply>"` — error is the first thing the user sees, can't be missed after an AI "I've done it!" message. (2) `move_entry`: removed the hard-fail return when `fromDate` entry is not found even after ±1 day fuzzy match. Now always creates a placeholder entry at `toDate` using provided `type`/`label`/`distance`, or `'other'`/`'Run'` as minimum. A placeholder is better than an error — plan can be immediately refined. (3) `COACH_PROMPT_BUILD` bumped to `'2026-07-23-v8'` so updated `move_entry` schema (type/label/distance required as fallback) takes effect and today's stale scan key is cleared. | `await` in `ask()` means `busy` stays `true` slightly longer (duration of the writes, ~300-500ms). Negligible UX cost for the reliability gain. `move_entry` no longer returns an error if source date not found — a placeholder is created silently. If the coach asks to move a rest day (no type/label provided), a generic "Run" entry is created at toDate; user must manually delete or update it. |
| 2026-07-23 | `0e4aaeb` | Fixed coach claiming read-only for calendar/water; added `calendar` and `water` modules to `executeCoachAction()`. `calendar` op `add_event` routes through `addGoogleCalendarEvent()` — coach now uses `[COACH_ACTION:{module:"calendar",...}]` unified format. `water` ops `set` (absolute count) and `add` (increment) update `po_water_v1.logs[date]` and push immediately to `appKey:'profile'`. `CHAT_SYS()` rewritten with explicit "YOU ARE NOT READ-ONLY" header listing all writable systems; CRITICAL WRITE RULE updated to forbid "can only read" phrasing. After successful `COACH_ACTION` writes, `proactiveDayKey()` is cleared so the next panel open re-runs the status sweep to verify changes. `COACH_PROMPT_BUILD` bumped to `'2026-07-23-v6'`. | Coach water write uses `po_water_v1.logs[date]` — matches the format read by `po-water.html` and `dashboardData()`. If the user's Google token lacks `calendar.events` scope, the calendar action will 403; user must reconnect in `calendar.html`. Clearing `proactiveDayKey()` after every write means the scan re-runs on the next panel close/reopen — intended for verification, acceptable overhead. |
| 2026-07-23 | *(this session)* | Added Gmail integration. `loadGmailSummary(secret)` fetches up to 14 primary inbox threads (excluding promotions/social/updates), extracts metadata (subject, from, when, snippet, isUnread, isImportant, isShipping), stores as `gmail_summary_v1`. Called from `primeCoachData()` with 15-min throttle; throttle bypassed (same as Strava) on daily scan. `buildRawEmail()` + `sendGmailNow()` construct RFC 2822 base64url message and POST to Gmail API. `showGmailConfirmation(draft)` renders inline confirmation card — **actual send only fires when user clicks Send** (option B explicit confirmation). `executeCoachAction()` gmail handler: `op:'send'` → shows confirmation card → returns `{pendingConfirm:true}`. `ask()` detects `pendingConfirm` and shows "Review the draft" instead of "Changes saved". `dashboardData()` slim handler for `gmail_summary_v1` (10 threads, 5 shipping, unreadCount). `CHAT_SYS()` updated with Gmail write schema. `PROACTIVE_SYS()` section 5 covers email; section 6 covers alerts. Gmail CSS styles added to coach CSS block. `COACH_PROMPT_BUILD` bumped to `'2026-07-23-v2'`. New module: `mail.html` (inbox, shipping tracker, stats, compose). Added mail tile to `index.html` bento grid (·23). `api/integrations/google.js` routes `/users/*` paths to Gmail API. `calendar.html` scope updated to include `gmail.readonly` + `gmail.send`. | User must reconnect Google account in `calendar.html` for Gmail scopes to apply — old tokens only have calendar scope. If Strava throttle isn't cleared before daily scan, Gmail (15-min throttle) may also use stale cache; forced cleared same as Strava in `openPanel()`. Coach send confirmation card is rendered inline — if the coach feed resets mid-session, any pending confirmation card is lost (user must re-ask). `gmail_summary_v1` is local-only (not synced to Supabase). |
| 2026-07-23 | *(this session)* | Fixed `executeCoachAction()` marathon/goals push race on mobile: push is now awaited with one automatic retry (1.5s delay). Added `plan.updatedAt = Date.now()` stamp on every coach write; `marathon.html` `onApplied` rejects server snapshots older than current in-memory plan (stale `applyRemote` during in-flight push no longer overwrites coach changes). `savePlan()` also stamps `updatedAt`. | `onApplied` rejecting stale snapshots means a legitimate rollback from another device won't apply if the local plan is newer. This is acceptable — the push is awaited, so the server should always be at least as current as local state. |
| 2026-07-23 | *(this session)* | Fixed DEP0169 `url.parse()` deprecation warning from `web-push` showing as Vercel function errors. Installed `patch-package`; patch replaces both `url.parse()` calls in `web-push/src/web-push-lib.js` with WHATWG `new URL()` — `.path` (pathname+search combined) replaced with `.pathname + .search`. Patch re-applies on every `npm install` via `postinstall` script. | If `web-push` is upgraded, the patch will need to be regenerated (`npx patch-package web-push`). The `.pathname + .search` replacement is semantically equivalent to the old `.path`. |
| 2026-07-23 | *(this session)* | Fixed morning push notification not showing goals (said "nothing to do" even with goals set). Root cause: `goals:today` only created in browser after user opens `main.html`; at 9 AM the cron fires before the app is opened. Fix: `reminders` and `morning` cron cases now fall back to `goals:yesterday` when `goals:today` is empty — rollover copies pending goals, so yesterday's uncompleted goals are identical to today's. `morning` notification now includes pending goal count and today's run in the body. | If the user has genuinely completed all goals by morning and today's key doesn't exist yet (e.g., cleared cache), the fallback to yesterday's goals may show already-done items (done=true items are filtered out, so this is safe). |
| 2026-07-23 | *(this session)* | Fixed `strava_activities_v1` slice direction bug. `dashboardData()` was using `v.slice(-30)` which takes the **last** 30 elements of a newest-first array, giving the coach the 30 oldest runs instead of the 30 most recent. Fixed to `v.slice(0, 30)`. Bumped `COACH_PROMPT_BUILD` to `'2026-07-23-v3'` to clear stale scan cached with wrong data. | Any future array trim in dashboardData() must verify direction — newest-first arrays require `slice(0, N)`. |
| 2026-07-23 | *(this session)* | Fixed marathon data not reaching coach (false "43-day gap" alert). `dashboardData()` now precomputes `marathon_plan_v1.last_logged_run` — the most recent past entry where `completed=true` or `actualDistanceMi>0` and `type!='rest'`, with precomputed `when`. `entries_completed` replaced by `entries_recent_history` (last 30 past entries newest-first). `PROACTIVE_SYS()` updated to use `last_logged_run` as primary run source; falls back to `strava_activities_v1` only if null; forbidden from reporting a long Strava gap if marathon plan shows scheduled activity. `COACH_PROMPT_BUILD` bumped. | `last_logged_run` is null if no marathon entries have `completed=true` and no `actualDistanceMi>0` — coach then uses Strava fallback. If user runs without logging in either system, no source shows recent runs. |
| 2026-07-22 | *(this session)* | Added coach write access to marathon and goals modules. Coach can now emit `[COACH_ACTION:{...}]` blocks (one or more per reply) that `ask()` intercepts and executes via `executeCoachAction()`. Marathon: update_entry, move_entry, add_entry, remove_entry, set_race — writes to `marathon_plan_v1` in localStorage and pushes to server. Goals: add, complete, remove, update — writes to `goals:YYYY-MM-DD` key and pushes to server. `dashboardData()` now includes `date` field on marathon entries so coach has the ISO date for targeting write ops (still uses `when` for display per Invariant §5). Multiple action blocks in one reply execute in parallel via `Promise.allSettled`. `CHAT_SYS()` updated with full write-access schema and rules. COACH_PROMPT_BUILD bumped to `'2026-07-22-v1'`. | Coach writes directly to localStorage — if the marathon/goals page is open in another tab at the same time, its in-memory state won't see the change until it re-reads localStorage (reload or next applyRemote poll). The "✅ Changes saved. Reload the page." confirmation message reminds the user. |
| 2026-07-21 | *(this session)* | Fixed stale Strava data causing false coach alerts. `strava_activities_v1` was only refreshed when `marathon.html` was open; if the user hadn't visited in days, coach saw old runs and fired false "no recent activity" alerts. Fix: added `primeStravaActivities()` to `topbar.js`, called inside `primeCoachData()` with a 30-minute throttle (`strava_last_sync` guard). Reads `strava_tokens_v1`, auto-refreshes expired tokens via `/api/integrations/strava`, fetches last 60 activities, filters to runs, and writes fresh data to `strava_activities_v1`. | Adds one extra Strava API call when coach panel opens (if >30 min since last sync). Token is stored under `strava_tokens_v1` by marathon.html — if key name ever changes there, this breaks silently. If user is not connected to Strava, function exits immediately. |
| 2026-07-21 | *(this session)* | Added Google Calendar write access for coach. (1) `/api/integrations/google.js` now forwards POST/PATCH/DELETE requests to the Google Calendar API (previously GET-only); distinguished from token-refresh POSTs by presence of `path` query param. (2) `calendar.html` SCOPE upgraded from `calendar.readonly` to `calendar.events calendar.readonly` — user must reconnect account to grant write permission. (3) `addGoogleCalendarEvent(opts)` added to `topbar.js`, exposed as `window.addGoogleCalendarEvent`. Reads `google_accounts_v1` from localStorage, refreshes token if expired, POSTs event to `/calendars/primary/events`. (4) Coach reply parser in `ask()` scans for `[CALENDAR_ADD:{...}]` block; if found, strips it from displayed text, calls `addGoogleCalendarEvent`, shows 📅 confirmation or error inline. (5) `CHAT_SYS()` updated with CALENDAR WRITE instructions including user's live IANA timezone. Bumped COACH_PROMPT_BUILD to `'2026-07-21-v2'`. | Existing google_accounts_v1 tokens only have `calendar.readonly` scope — write will return 403 until user reconnects in calendar.html. If coach emits malformed JSON in the CALENDAR_ADD block, `JSON.parse` will throw and the catch shows a calendar error message. |
| 2026-07-21 | *(this session)* | Fixed coach memory not persisting across sessions. Root causes: (1) `coach_memory` was never in `syncedKeys` — lost whenever localStorage cleared or on a different device. Fix: added to coach `initCloudSync` `syncedKeys` and immediate push after every save. (2) `CHAT_SYS()` was reading from localStorage each call — applyRemote could wipe it mid-session. Fix: `memArr` in-memory authority (same pattern as `msgArr`), initialized at startup, always used for CHAT_SYS(). (3) `onApplied` now merges server + local memories (union, never drops either side). (4) `INSTR_RE` regex widened to catch phrases anywhere in message, not just at start — e.g. "change your behavior", "you should always", "note that", "in the future". Bumped COACH_PROMPT_BUILD to `'2026-07-21-v1'`. | applyRemote merge is additive (union) — if the user explicitly wants to *remove* an instruction they previously gave, they still need to clear `coach_memory` in localStorage manually (or we add a future "forget this" command). |
| 2026-07-16 | *(this session)* | Full silent-catch audit across all files: every `.catch(function() {})` and `try{}catch(e){}` that wraps a write operation or non-trivial logic now logs `console.warn('[Module] what failed', e)`. Remaining empty catches are only JSON.parse reads with immediate fallback values, sync.js (read-only invariant), or hardware ops (camera/mic) where failure-is-acceptable. Added `// ===== SECTION =====` headers throughout topbar.js and main.html replacing `// -------- ... --------` for easier navigation. | No logic changes — only logging added to existing catch blocks and comment-only reorganization. |
| 2026-07-17 | `8c5107b` | Fixed localStorage quota filling up: (1) Added `pruneOldStorage()` — removes `coach_proactive_*` keys older than 3 days, called at every page boot and exposed on `window.pruneOldStorage`. (2) `persistMsg` retries after pruning + trimming history to 20 msgs on first quota failure, only shows error if both attempts fail. (3) `primeCoachData` now merges `po_water_v1` logs (take max per date key) instead of overwriting, so bottles logged this session survive a stale server snapshot. (4) `notes.html save()` prunes and retries on quota, alerts user only if still full — fixes "New note" button appearing to do nothing. | Each page boot now calls `pruneOldStorage()` which iterates localStorage (~O(n) keys). Negligible on typical dashboards. If the coach history trim (20 msgs) fires, users lose older messages from the in-memory array — they are still in the server snapshot and will be restored on next `applyRemote` if the server has them. |
| 2026-07-16 | `40038a2` | Fixed coach history not persisting. Root causes: (1) `persistMsg` read from localStorage each call — if `applyRemote` had overwritten it with stale server data within the 250ms debounce window, the new message was appended to stale data and pushed as-is, erasing the message. Fix: `msgArr` (in-memory array) is the authority; `persistMsg` appends there first and uses it for all writes. (2) `keepalive:true` fetch silently fails when body exceeds 64 KB browser limit — removed keepalive, using regular fetch with visible `.catch` error message in feed. (3) `runProactiveScan` catch silently removed spinner — now shows `⚠ Status scan failed` in feed. `onApplied` now compares `msgArr.length` vs server snapshot length: if local is ahead, restores and pushes; if server is ahead, adopts server state. | `msgArr` is initialized to `null` and set in `loadChatHistory`. If `persistMsg` is ever called before `loadChatHistory` (only possible if a message fires before the panel opens — e.g. proactive scan on auto-open), `msgArr` is initialized to `[]` at that point, losing any history that was in localStorage. This can't happen with current flow but would be a bug if `ask()` or `runProactiveScan` were called before `historyLoaded = true`. |
| 2026-07-16 | *(this session)* | Fixed `primeCoachData` skipping `goals:` keys on main.html (was overwriting user-added goals with stale server data, making goals appear to not save). | primeCoachData still writes goals: on non-main.html pages so coach has current data on other pages. |
| 2026-07-16 | *(this session)* | Added immediate keepalive push in `storeSet` for `goals:` keys so every goals change (add, check, delete) persists to server immediately, bypassing the 250ms debounce race window. | Each goals change now sends 2 pushes (immediate + debounced) — idempotent, server sees the same data twice. |
| 2026-07-16 | *(prev)* | Fixed `pushWaterMergedToSupabase` writing to `key:'health'` instead of `key:'profile'` (undid appKey fix). Added `primeCoachData()` — fetches goals/health/profile/marathon/caffeine/gym rows from server into localStorage when coach panel opens so dashboardData() always has current data. Added `coach_memory` persistent instructions: messages matching instruction patterns saved to localStorage and injected into CHAT_SYS at top of system prompt. Added `onApplied` to coach sync that reloads history if panel opened before server data arrived. Increased MAX_SAVED to 80, MAX_CTX to 40. Updated PROACTIVE_SYS: structured output (tasks first, then alerts), collects last 3 briefings to prevent any repetition, strict no-repeat rule. Bumped COACH_PROMPT_BUILD to '2026-07-16-v1'. | If primeCoachData writes keys watched by another page's initCloudSync, those syncs will schedule redundant pushes (idempotent, not harmful). coach_memory accumulates up to 20 instructions — stale instructions must be manually cleared from localStorage if user changes their mind. |
| 2026-07-14 | `6130451` | Removed `onApplied` body from coach sync (was clearing `feed.innerHTML` mid-conversation). Removed `coach_proactive_*` from syncedPrefixes. Added `COACH_PROMPT_BUILD = '2026-07-14-v3'` version key that clears today's proactive flag on deploy so scan re-runs with fixed code. | If COACH_PROMPT_BUILD is not bumped after future prompt changes, users will see stale scan results. |
| 2026-07-14 | `c2422fd` | Added `initCloudSync` for coach data inside `initCoach()`. Synced `coach_chat_history` and `coach_proactive_*`. `onApplied` cleared the feed and reloaded. | **INTRODUCED BUG** (fixed in `6130451`): onApplied fired mid-conversation and deleted what the user was typing. Syncing `coach_proactive_*` caused the proactive scan to never re-run after a bug fix. |
| 2026-07-14 | `6ef89dd` | Replaced `date: a.date` with `when: <human string>` in strava slim payload. Removed raw date entirely so Claude cannot re-derive timing. Updated CHAT_SYS and PROACTIVE_SYS notes to reference `when`. | If strava data format changes upstream, the `when` computation in `dashboardData()` may need updating. |
| 2026-07-14 | `8d06bd8` | Added `daysAgo` precomputed field to strava entries. Added system-prompt DATA NOTES instructing Claude to use `daysAgo` not raw date. Added po_coach_v1 slim handler (last 10 log entries, 60-day cutoff). Removed `po_coach_workout_done` from SKIP set so coach can see gym sessions. | (Later superseded by `6ef89dd` which dropped raw date entirely.) |
| 2026-07-14 | `f8e7d91` | Anti-repetition: reads last proactive briefing from history and includes it in PROACTIVE_SYS as context. Updated PROACTIVE_SYS with DATA NOTES (goals done=true means completed, daysAgo for strava, po_coach_workout_done format). | Coach may skip mentioning genuinely recurring issues if it looks like repetition. |

---

### `main.html` — Goals / To-Do

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-16 | *(this session)* | Fixed `processStreak()` / `rollover()` order: `processStreak` now runs BEFORE `rollover` at boot and in `onApplied`. `rollover` deletes past-date keys; calling `processStreak` after meant the past keys were gone before they could be counted → streak always stayed 0. | No regressions expected — `processStreak` is idempotent and guarded by `lastProcessedDate`. |
| 2026-07-16 | *(this session)* | Added immediate keepalive push in `storeSet` for `goals:` keys. Any goals write now immediately pushes to the server (bypassing the 250ms debounce window). Prevents applyRemote from wiping goals added between the debounce start and the push firing. | Two pushes per goals change (immediate + debounced) — idempotent. |
| 2026-07-14 | `088d1a3` | Moved `initCloudSync` call from a separate `<script>` block into the main IIFE. This gives `onApplied` access to `getActiveDateString`, `storeListKeys`, `rollover`, `processStreak`, `loadToday`, `loadTomorrow`. Also replaced separate `storage` event dispatch with direct `loadToday()`/`loadTomorrow()` calls in `onApplied`. Removed bounds check from delete handler (root cause was empty backing store, not stale index). | If helper functions are ever moved out of the IIFE, re-examine `onApplied` scope. |
| 2026-07-14 | `fd322af` | Added bounds check `if (idx < 0 \|\| idx >= list.length) return` to delete handler and `hasPastKeys` guard in `onApplied` to only call `rollover()` when sync genuinely restored past-date keys. | **INTRODUCED BUG** (fixed in `088d1a3`): `onApplied` was still out-of-scope in a separate `<script>` block, so `getActiveDateString` threw silently. Bounds check caused delete to do nothing because backing store was empty (wiped by applyRemote). |
| 2026-07-14 | `216269a` | Added `changed` flag to `rollover()` so `setGoals` is only called when goals were actually added (prevents writing empty array when `onApplied` calls rollover with no past keys). | If rollover is called in a context where `changed` logic is wrong, newly added goals could be silently discarded. |
| 2026-07-14 | `f0db269` | Added `rollover()` call to `onApplied` so rollover re-runs after sync restores old server state. Changed `saveToHistory` from skip-if-exists to upsert (fixes history showing incorrect data). | Rolling over in `onApplied` can have cascading effects if called without `changed` flag guard — see `216269a`. |

---

### `sync.js` — Cloud Sync

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| *(no changes — treat as read-only)* | — | sync.js has not been modified. All sync behavior is configured via `initCloudSync` callers. | Any change here affects ALL pages simultaneously. Read Architecture Invariants §1 and §2 before touching. |

---

### `gym.html` — Workout Tracker

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-21 | *(this session)* | Fixed seed exercises appearing alongside imported plan. Root cause: `pcApplyRemoteState` used an additive union of remote + local exercises by ID. After plan import (which removed seeds), the server snapshot still had seed IDs → 30s later `applyRemote` re-added them alongside the new plan. Fix: (1) `pcApplyRemoteState` exercise merge is now day-authoritative — local is authoritative for any day it has real (non-seed) exercises; remote only fills in days the local doesn't have yet. Seeds are never brought in from remote. (2) `applyCleanupV2` one-time migration (replaces v1 flag): removes seeds from any day that already has real exercises, then `pcPushNow()` to update the server. | Cross-device exercise additions for existing days no longer auto-sync (local always wins for its days). Workaround: re-import plan or manually add on each device. Exercises on brand-new days (from another device) still sync correctly. |
| 2026-07-14 | `fd5bb87` | Smart day matching on plan import (replaces accumulated days instead of appending). | Plan import could silently overwrite days if matching logic is too aggressive. |
| 2026-07-14 | `164962a` | Added rest timer, 1RM strength goals. | Rest timer state is in-memory only (no persistence). |
| 2026-07-14 | `1d50910` | One-time data cleanup: removed Sharms day, seeded exercises from PPL days. | One-time only — should not be re-run. |
| 2026-07-14 | `779a5eb` | Fixed localStorage quota crash. Seeds bodyweight exercises from last recorded weight. | If bodyweight key is missing, seeding silently skips. |
| 2026-07-14 | `cd28a1c` | Fixed plan days being lost on cross-device sync. | Sync merge strategy for plan days — check if days still interleave correctly after a sync conflict. |
| 2026-07-14 | `cdcb587` | Added coach review + change-request flow to plan import. | Requires `/api/ai/ai-chat` endpoint. If AI is unavailable, import should gracefully fall back. |

---

### `finance.html` — Finance

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-14 | `21212d0` | Fixed transfer cash bug. Transfers now logged to activity feed. | Activity feed display order depends on timestamp sort. |
| 2026-07-14 | `6116117` | Added account transfer feature to Net Worth tab. | Transfer between same account is not guarded — could silently no-op or create duplicate entries. |
| 2026-07-14 | `3e84dbb` / `147d424` / `895702d` | Three successive fixes for OTI Log Payment button not responding. Final fix: standalone synchronous script block with `onclick` + `window` exposure. | Button relies on global `window.logPayment` — if the function is ever moved inside a module/IIFE, it will break again. |
| 2026-07-14 | `9725837` | Fixed one-time income destination dropdown not showing bank accounts. | Dropdown is populated at render time. If accounts change after render, dropdown needs a refresh. |
| 2026-07-14 | `ab85581` | Added one-time income logging and next-paycheck date to Jobs tab. | — |

---

### `saved-links.html` — Saved Links

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-15 | *(this session)* | Fixed sync race condition: moved `initCloudSync` to before `handleSharedParams` so setItem patch is active when the share is saved. Added `pendingSharedLink` — `onApplied` re-inserts the link if `applyRemote` REPLACE-ALL wiped it before the push fired. Claude response handler also re-adds if not found by ID. Fixed Shortcut setup card steps (Text + Open URLs, `?url=` in copy URL). | If `pendingSharedLink` is not cleared (fetch never resolves), `onApplied` will re-insert on every 30s poll. Both `.then` and `.catch` clear it to prevent this. |
| 2026-07-14 | `36dda8b` | Added iOS Shortcut setup card. | — |
| 2026-07-14 | `164962a` | Added AI auto-categorize on share sheet receive. | Requires `/api/ai/ai-chat`. If Claude returns unexpected JSON shape, category defaults to `'Saved'`. |

---

## Debugging Playbook

When something breaks, start here before reading code.

### "Goals all disappeared / wrong goals showing"
1. Check `main.html` changelog — any recent change to `initCloudSync`, `rollover`, or `onApplied`?
2. Was `initCloudSync` called from INSIDE the main IIFE? (Invariant §1)
3. Did `applyRemote` delete `goals:today`? (Invariant §2 + §3) — check if server snapshot has today's key.
4. Is `onApplied` calling `rollover()` with the `changed` flag guard in place?

### "Delete one goal wipes all goals"
Root cause: `getGoals(key)` returned `[]` at click time, so `splice` on empty array + `setGoals(key, [])` wiped all goals. This happens when `applyRemote` deleted `goals:today` from localStorage BEFORE the delete click. Fix: ensure `onApplied` re-runs `rollover()` to restore today's key.

### "Coach says 'yesterday' for an activity 2+ days ago"
Check `dashboardData()` in `topbar.js`, the `strava_activities_v1` branch. The entry must have a `when` string and NOT a raw `date` field. If `date` is present, Claude will re-derive timing and get it wrong.

### "Coach says last run was 43+ days ago but user ran recently"
Two possible causes:
1. **Array slice direction** (most likely): `dashboardData()` `strava_activities_v1` branch used `v.slice(-30)` instead of `v.slice(0, 30)`. Since Strava returns newest-first, `slice(-30)` gives the 30 oldest runs. Fix: `slice(0, 30)`. Fixed in `2026-07-23-v3`.
2. **`last_logged_run` is null**: marathon entries don't have `completed: true` or `actualDistanceMi > 0` — coach falls back to Strava. Check if runs are being marked complete in marathon.html.
3. **Strava token expired**: `primeStravaActivities()` token refresh silently fails — check browser console for `[Coach] Strava token refresh failed` or `[Coach] primeStravaActivities failed`. User may need to reconnect Strava in marathon.html.

### "Coach conversation deleted when I send a message"
`onApplied` for the coach sync is clearing the feed. `onApplied` must never touch `feed.innerHTML`. See Invariant §4 and commit `6130451`.

### "Coach scan re-runs every page load / never re-runs after a fix"
- **Re-runs every load:** something deleted `coach_proactive_YYYY-MM-DD` from localStorage. Check if it was added to `syncedPrefixes` accidentally (Invariant §6).
- **Never re-runs after fix:** `COACH_PROMPT_BUILD` was not bumped after the change (Invariant §7).

### "Clicking a button does nothing (finance/other page)"
Check if the handler function is defined inside an IIFE but called via `onclick` attribute or `addEventListener` from outside. Handlers wired via `onclick` attributes or global calls need to be exposed on `window`. See the OTI Log Payment bug history in `finance.html` changelog.

### "Supplement stack data disappeared (stack:items, stack:taken:*)"
A page that only knows about `po_water_v1` pushed to the `health` server row, overwriting it with just `{po_water_v1: ...}`. On next `applyRemote` in health.html, stack keys weren't in the server snapshot → deleted locally. See Invariant §8. Fixed: `po_water_v1` now lives under `appKey: 'profile'`, stack data under `appKey: 'health'`.

### "Two pages syncing the same appKey are overwriting each other's data"
See Invariant §8. Check the appKey registry table in the Project Map. Each appKey must own a non-overlapping set of keys.

### "Data pushed to wrong server row / sync conflict between pages"
Each `initCloudSync` call must use an appKey from the registry in the Project Map. If adding a new sync, add a new row to the registry first and verify no existing page uses the same appKey with different keys.

### "Streak is always 0 even after completing all goals"
`processStreak()` ran AFTER `rollover()`, which deletes past-date goal keys before they can be counted. See Invariant §10. Fix: call `processStreak()` BEFORE `rollover()` in both boot and `onApplied`.

### "Note created but disappears / typed content not saved"
`persistActive()` returned early when `applyRemote` wiped the note from localStorage mid-edit. See Invariant §11. Fix: re-add the note from editor state if `load().find(id)` returns null, then call `persistActive()` at the start of `onApplied` when `activeId` is set.

### "Create/add/log in any module doesn't persist after page interaction"
The `save()` function only called `localStorage.setItem`, relying on sync.js's 250ms debounce. If a 30s poll `applyRemote` fired within that window, the local change was wiped. See Invariant §9. Fix: every `save()` must fire an immediate fetch to `/api/db`.

### "Coach edit to marathon plan disappears on mobile after tab switch"
Mobile tab eviction causes the page to reload from scratch, which triggers `onApplied` before the push completed. Fix: `executeCoachAction()` awaits the push with retry; `marathon.html` guards `onApplied` with `updatedAt` check (Invariant §13). If the plan still reverts, check that `plan.updatedAt` is being set in the coach write path AND in `savePlan()`.

### "Gmail inbox empty / Mail module shows connection prompt"
1. Check that `google_accounts_v1` is set in localStorage (user must connect Google in `calendar.html`).
2. Check that `google_accounts_v1[0].scope` contains `gmail.readonly` — if it only has `calendar.*` scopes, user connected before the scope was upgraded. They must reconnect in `calendar.html`.
3. Check `gmail_summary_v1` in localStorage — if it has `threads: []` with no error, the Gmail API returned no results (possibly all mail is in filtered-out categories: promotions/social/updates).
4. If the coach shows stale Gmail data, check `gmail_last_sync` timestamp — clear it to force a refresh.

### "Coach tried to send email but nothing happened"
1. Check that `google_accounts_v1[0].scope` contains `gmail.send` — requires scope upgrade and reconnect.
2. The confirmation card only fires when `executeCoachAction` runs, which only runs when coach emits a `[COACH_ACTION:...]` block. Check that the coach actually emitted one.
3. If the confirmation card appeared but Send didn't work, check browser console for `sendGmailNow` error — likely a 403 (scope missing) or 401 (token expired; usually auto-refreshed).

---

### `health.html` — Supplements

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-14 | *(this session)* | Removed `po_water_v1` from `appKey: 'health'` syncedKeys. Added separate `initCloudSync({appKey: 'profile', syncedKeys: ['po_water_v1']})`. Prevents index.html/po-water.html pushes from wiping supplement stack data on the server. | If any future page needs to sync po_water_v1, it must use `appKey: 'profile'`, not `appKey: 'health'`. |

---

### `index.html` — Home / Bento Grid

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-23 | *(this session)* | Added tile ·23 (Mail, `mail.html`, accent #7DD3FC) to the bento grid. | Tile count is now 23. If adding more tiles, continue the numbering sequence. |
| 2026-07-14 | *(this session)* | Changed sync from `appKey: 'health'` to `appKey: 'profile'` for po_water_v1. Prevents profile saves from overwriting the supplement stack on the server. | — |

---

### `settings.html` — Settings

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-23 | *(this session)* | Added **Notification Schedule** section. Shows all 5 notification types (morning, reminders, nutrition, training, skincare) with local-time display (computed from UTC cron schedule via `Date.toLocaleTimeString`), enable/disable toggle per type, and Test button (fires real push to all subscribed devices immediately via `GET /api/push-send?type=X` + X-App-Secret). Prefs saved to `localStorage('notification_prefs')` + immediate push to Supabase under key `notification_prefs`. Disabling a type gates the cron send in `push-send.js`. Test buttons always fire regardless of enabled/disabled state. | `notification_prefs` is stored as its own Supabase row (key='notification_prefs') — NOT inside any appKey sync. If another page calls `initCloudSync({appKey:'profile'})` it will not overwrite this key. If push subscriptions expire, test button returns 0 devices; user needs to re-enable push notifications via the subscription UI. |

---

### `po-water.html` — Water Tracker

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-14 | *(this session)* | Changed sync from `appKey: 'health'` to `appKey: 'profile'` for po_water_v1. Same fix as index.html. | — |

---

### `notes.html` — Notes

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-16 | *(this session)* | Fixed create/import race: `persistActive()` now re-adds the note from editor state if `applyRemote` wiped it from localStorage while the editor was open (instead of returning early). `onApplied` now calls `persistActive()` before re-rendering when `activeId` is set. Added immediate push to `save()` and `saveCats()`. Added `console.error` on localStorage quota exceeded. | `persistActive` re-adds the note with `category: activeFolder` at re-add time, not at creation time — if user switched folders while editor was open, re-added note gets current folder instead of original. Acceptable edge case. |

---

### `apply-plan.html` — One-Shot Plan Applier

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-30 | `ef2d598` | Full rebuild from Jul 30 with safe 20mi peak progression. CUTOFF moved to 2026-07-30 (preserves Jul 27/28/29 as historical). Long run sequence: 12→14→16→14(cutback)→18→**20★ Sep 5**→10→race. Each step ≤+2mi. 20mi peak on Sep 5 (15 days before race; adaptation peaks Sep 15–19 = race week). Key changes: Week 4 cutback 13mi→14mi; Week 5 18mi now labeled "build to peak" not peak; Week 6 Sat 14mi taper→20mi PEAK; Week 6 Thu 4mi tempo→Easy 4mi+Strides (pre-peak protection). Speed variation maintained: 400m (Wk2/4), 800m (Wk1), 1mi (Wk3/7), 1200m (Wk5), mixed 1200m+400m (Wk6/taper). | Sep 3 Thu is easy+strides not tempo — purposely reduced to preserve legs for 20mi Sat. The 14→18 jump (cutback to rebuild) is +4mi, which is above the 10% rule, but body has 16mi base just 2 weeks prior. |
| 2026-07-30 | `7b96456` | Updated Week 5 peak long run from 18mi to 20mi. Aug 29 Saturday note updated: miles 1–16 @ 9:45/mi, miles 17–20 @ 9:07/mi if legs allow. Gel schedule updated (miles 5, 10, 14, 18). Weekly total updated to ~39mi. | Superseded by ef2d598 which fully rebuilds from Jul 30 with a proper safe progression. |
| 2026-07-27 | `c473503` | Rewrote with Strava-calibrated paces for sub-4:00 Toledo Marathon (Sep 20). 56 entries, Jul 27–Sep 20, 4-day schedule (Mon easy · Tue hard · Thu hard · Sat long). Paces derived from actual Strava history: mile PR 6:02, 5×800 session avg 7:24/mi, long runs 9:50–9:58/mi. Key paces: Easy 9:45/mi, Tempo 8:05/mi, 800m 3:30/rep (7:00/mi), 400m 1:42/rep (6:48/mi), 1mi rep 7:10/mi, 1200m 5:21/rep (7:09/mi). Preserves historical entries before 2026-07-27. Full per-rep splits, total time, and execution notes in every entry. | Visiting /apply-plan.html auto-applies the plan — there is no confirmation step. Run only once per plan version. If apply-plan.html is visited again with new entries, it will replace all entries from CUTOFF date onward again (historical data is always safe). |
| 2026-07-27 | `c7a3677` | Initial commit — 4-day structure with generic paces (superseded by c473503). | — |

---

### `marathon.html` — Marathon Training

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-27 | `7e1eb60` | Fixed `onApplied` leaving localStorage stale after rejecting a stale server snapshot. `applyRemote` overwrites localStorage with the server snapshot before calling `onApplied`; the `incomingTs < currentTs` early return correctly protects in-memory `plan` but left localStorage with the old data. A page refresh between that poll and the next would load the stale version. Fix: added `saveJSON(PLAN_KEY, plan)` before the early return so localStorage is immediately restored from the in-memory state. | `saveJSON` triggers sync.js's 250ms debounced push — the plan gets pushed again. Idempotent. |
| 2026-07-27 | `98d7877` | Added `coach:marathon:updated` event listener. When coach writes a new plan from topbar.js, marathon.html now re-renders immediately without waiting for the next 30-second sync poll. Guard: only re-renders if `freshTs >= currentTs` to avoid regressing to stale data. | — |
| 2026-07-27 | `508ef56` | Fixed weekly actual mileage not matching Strava totals in `matchStravaToSchedule`. See topbar.js changelog for full details. |
| 2026-07-27 | *(this session)* | Fixed weekly actual mileage not matching Strava totals in `matchStravaToSchedule`. Two bugs: (1) Multiple runs on the same day (double days, warmup+long) — `find()` returned the same plan entry for each run; later runs overwrote earlier ones instead of summing. Fixed by grouping all runs by date first and summing `distanceMi`/`movingSec` before writing. (2) `manualOverride` entries skipped GPS distance entirely — chart showed manually-set or placeholder miles instead of Strava GPS. Fixed: `manualOverride` still blocks completion-status flip, but now updates `actualDistanceMi` from Strava when the entry is already completed. | `manualOverride` + completed entries now always show Strava GPS distance, even if the user entered a different number manually. If the user deliberately logged a different distance (e.g., treadmill vs GPS), it will be overwritten by Strava. Edge case: if the user ran but Strava under-recorded (e.g., GPS failure), the GPS distance wins. |
| 2026-07-23 | *(this session)* | Added `updatedAt` timestamps for optimistic concurrency (Invariant §13). `savePlan()` stamps `plan.updatedAt = Date.now()` before every write. `onApplied` now compares `incoming.updatedAt` vs `plan.updatedAt`; if incoming is older, skips the apply to prevent a stale server snapshot from overwriting coach edits mid-push. Fixes coach-edited plan reverting on mobile after tab switch. | If two devices save the plan simultaneously, the later-timestamped write always wins regardless of content. Legitimate rollbacks from another device won't apply if local is newer — acceptable since push is awaited before returning. |

---

### `chores.html`, `personal-care.html`, `shopping.html`, `skincare.html`, `nutrition.html`, `caffeine.html`

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-16 | *(this session)* | Added immediate push to all save functions (Invariant §9). Each module now fires `fetch('/api/db', ...)` immediately after `localStorage.setItem`, bypassing the 250ms debounce race window. Added `try/catch` with `console.error` for localStorage quota errors. Two pushes per save (immediate + debounced) — idempotent. | Each save now makes 2 HTTP requests instead of 1. If the server is slow, this doubles the load from these modules. Still idempotent. |

---

### `api/db.js` — DB Proxy

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-27 | `508ef56` | Added `supaFetchWithRetry()` — wraps `supaFetch` with one automatic retry (600ms delay) on Supabase 5xx responses or network errors. AbortError (8s timeout) is never retried. Both GET and POST handlers use it. Reduces the rate of transient failures appearing in Vercel High Severity 5xx monitoring. | Total worst-case latency per request increases from 8s to ~9.2s (8s timeout + 0.6s + another 8s = 16.6s — but Vercel hard-kills at 10s total). In practice the 600ms retry only fires when Supabase is already slow; the second attempt has its own 8s timeout budget from the remaining ~1.4s. This means the retry on a timed-out connection may itself time out before completing. |
| 2026-07-20 | *(this session)* | Added `supaFetch()` wrapper with 8-second `AbortController` timeout on all Supabase calls. Previously, a slow/hung Supabase connection would wait until Vercel's 10-second function limit fired and returned an opaque 502. Now we abort cleanly and return 504 before Vercel kills us. Both GET and POST handlers catch `AbortError` and return `504 upstream timeout`. | None — if Supabase normally responds in <8s (it does), behavior is identical. If Supabase is slow, users now get a retryable 504 instead of a confusing 502. |

---

### `gym.html` — Workout Tracker (sync audit)

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-30 | `54581ca` | Two fixes: (1) `olOpenLogModal` new-session sets default changed from hardcoded `4` to last session's `sets` count (fallback 4 if no history) — prevents always showing 4 sets when user's actual sessions use a different count. (2) `olRenderOverloadCard` now uses `getRx()` result for weighted exercises: `rx.type==='up'` shows add-weight advice with correct `rx.weight × rx.reps`; `rx.type==='down'` shows deload; `rx.type==='hold'` shows same-weight push-for-more-reps. Previously always computed `last.weight + step` regardless of prescription result. | `rx.weight` for deload uses `roundToStep(weight * 0.9, step)` which may look unexpected (e.g. "drop to 121.5 lbs"). This is correct — 10% below current weight, rounded to the exercise's step size. |
| 2026-07-16 | *(this session)* | Full silent-catch audit: `saveState`, `saveDoneDays`, `wtSave`, `syncProfileWeight`, `migrateKgToLb` writes, `pcRerender`, and migration flag writes all now `console.warn` on failure. Previously these all swallowed errors silently, hiding data-loss bugs. | — |
| 2026-07-16 | *(prev session)* | Added `po_coach_strength_goals` to `PC_SYNCED_KEYS` and added its merge handler in `pcApplyRemoteState` (object spread, local wins). Strength goals were being written to localStorage but never pushed to the cloud — lost on cross-device or cross-session. | merge is `{...remote,...local}` per lift key; if two devices set conflicting goals simultaneously, local device always wins. |

---

### `api/push-send.js` — Push Notification Cron

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-27 | `2c8688b` | Three goals fixes + Gmail alert notifications. (1) Goals: 3-day rolling fallback (today→yesterday→2daysago) so notif fires before the app is opened. (2) Goals: snoozed goals (`snoozedUntil > today`) excluded from pending count — intentionally ignored goals no longer appear as overdue. (3) Morning notif body: includes the first pending goal's text (e.g. `"Study for MATH 223"`) not just a count. (4) Reads `gmail_alerts` from Supabase (pushed by topbar.js); `reminders` surfaces important email alerts when no goals are pending; `morning` appends important email count to body parts. | Gmail alerts in notifications require the user to have opened the coach panel at least once (which triggers `loadGmailSummary` → pushes `gmail_alerts`). If `gmail_alerts` has never been pushed, `fetchModuleData` returns null and email info is silently omitted. |
| 2026-07-23 | *(this session)* | Added per-type notification preferences gate. On cron calls, reads `notification_prefs` key from Supabase. If `notifPrefs[type] === false`, returns `{sent:0}` immediately without sending. Manual test calls (from settings.html test buttons) always fire regardless of prefs. Default is enabled for all types (only explicitly `false` skips). | If Supabase is unreachable when fetching prefs, `fetchModuleData` returns null and the gate is bypassed (notification fires anyway). This is safe — if anything, it over-sends rather than silently drops. |
| 2026-07-23 | *(this session)* | Fixed morning notification always saying "nothing to do": added `goals:yesterday` fallback when `goals:today` is absent in Supabase. At 9 AM cron time, the user hasn't opened the app yet so `goals:today` doesn't exist (rollover only runs in-browser). Since rollover copies uncompleted goals forward, yesterday's pending goals === today's pending goals. `morning` notification now includes pending goal count + today's marathon run in the body. `reminders` case received the same fallback. | If the user completes all goals the night before AND opens the app AND the cron fires before the new day's key is written — yesterday's key shows 0 pending, so fallback returns nothing. Acceptable edge case; notification body falls back to "Open coach for your full briefing." |

---

### `api/integrations/google.js` — Google API Proxy

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-08-23 | `16e28d8` | Fixed Calendar API `/users/me/calendarList` being misrouted to Gmail. Root cause: the `/users/` prefix check added in Jul 23 matched the Calendar API's own `/users/me/calendarList` endpoint, sending it to `gmail.googleapis.com` instead of `calendar.googleapis.com`. Gmail returned 404, silently caught in `fetchCalendarListForAccount` — calendar picker showed no calendars and synced only 'primary'. Fix: replaced `path.startsWith('/users/')` with a regex that only matches genuine Gmail API subpaths: `messages`, `threads`, `labels`, `drafts`, `profile`, `history`, `settings`, `watch`. `/users/me/calendarList` now correctly routes to Calendar API. | Any new Gmail API path added in the future must use one of these known subpath prefixes; otherwise it will be misrouted to Calendar. |
| 2026-07-23 | *(this session)* | Added Gmail API routing. `handleData()` now routes by path prefix: `/userinfo` → Google OAuth2, `/users/*` → `https://gmail.googleapis.com/gmail/v1`, all others → Google Calendar API. Previously all paths except `/userinfo` went to Calendar. Also passes through POST/PATCH/DELETE for Gmail sends. | If a new Google API path starts with `/users/` but is NOT a Gmail path, it will be misrouted to Gmail. Unlikely but possible if future APIs are added — use explicit routing in that case. |
| 2026-07-21 | *(this session)* | Added POST/PATCH/DELETE forwarding for Google Calendar API. Previously GET-only. Token-refresh POSTs distinguished from API-write POSTs by presence of `?path=` query param. | — |

---

### `calendar.html` — Google Calendar

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-23 | *(this session)* | Added `gmail.readonly` and `gmail.send` to OAuth SCOPE. Users who connected before this deploy only have calendar scopes — they must disconnect and reconnect in `calendar.html` to grant Gmail permissions. | If user doesn't reconnect, `gmail_summary_v1` will remain empty (coach silently skips if scope missing), and coach send attempts will show 403 error in the confirmation card. |
| 2026-07-21 | *(this session)* | Upgraded SCOPE from `calendar.readonly` to `calendar.events calendar.readonly` for calendar write access. | Existing tokens lack write scope until user reconnects. |

---

### `mail.html` — Mail Module (new)

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-30 | `1f675c9` | Connected Gmail account email now shown in page subtitle. `renderSummary()` appends `· email@...` to the thread-count subtitle; `init()` also shows "Connected: email@..." immediately as a placeholder before the first refresh completes. `doRefresh()` now triggers on load when `gmail_summary_v1` doesn't exist yet (not only when cache is stale), so stats load on first open after connecting. | Email address shown is `google_accounts_v1[0].email` which is populated by `calendar.html` at OAuth connect time. If the user connected before scope tracking was added and the email field is missing, no email is shown in the subtitle (non-fatal). |
| 2026-07-27 | `2c8688b` | Full redesign. (1) 4-stat bar: Unread · Important · Packages · Fetched. (2) ⭐ Priority Digest — amber-bordered card showing important+unread emails at the top, sorted by urgency. (3) SVG Activity chart — bar chart of email distribution over last 7 days parsed from `when` strings ("today" → 0, "yesterday" → 1, "N days ago" → N), today bar highlighted in accent blue. (4) Inbox sorted by priority (unread+important first). (5) Deterministic sender color avatars (name hash → 8 accent colors). (6) Shipping tab uses green-bordered cards. All functional behavior (refresh, auto-refresh, compose) unchanged. | `when` field used for chart is precomputed in topbar.js at fetch time — if user opens mail.html with a cached summary older than 7 days, "7 days ago" emails won't appear in the chart. Compose still requires `window.sendGmailNow` from topbar.js. |
| 2026-07-23 | *(this session)* | New file. Gmail inbox viewer, shipping tracker, compose form. Reads `gmail_summary_v1` from localStorage (no direct API calls — all Gmail fetching done by `topbar.js`). Stats row: unread count, shipping packages, thread count. Tabs: Inbox / Shipping / Compose. Refresh button clears `gmail_last_sync` and calls `window.loadGmailSummary()`. Compose calls `window.sendGmailNow()`. Shows connection prompt if `google_accounts_v1[0].scope` lacks `gmail.readonly`. Auto-refreshes on load if cache >15 min old. Dark theme, sky blue accent (#7DD3FC). | `mail.html` depends on `window.loadGmailSummary` and `window.sendGmailNow` being set by `topbar.js`. If topbar.js fails to load, these are undefined and the refresh/send buttons will throw. Since `topbar.js` is loaded on every page, this is only a risk if the script itself errors during parse. |

---

### `internship.html` — Internships / Research

| Date | Commit | Change | What could break |
|------|--------|--------|-----------------|
| 2026-07-23 | *(this session)* | Full rewrite. Added email template section (`internship:email_template`) — user pastes base template; AI fills in role/company/resume highlights per opportunity. Added bottom-sheet send modal with editable To/Subject/Body; actual Gmail send only fires when user clicks "Send email" (calls `window.sendGmailNow()`). `generateEmail(opp)` uses template + `EMAIL_GEN_SYS` prompt (returns JSON `{subject,body}`); falls back to `DRAFT_FALLBACK_SYS` (SUBJECT:/BODY: format) if no template saved. Draft & Send button on both manual opportunity rows and AI search result cards. Sent status tracked per-opportunity in `internship:sent_log` (`{sentAt, subject, to}`); sent rows get teal border and "✓ Sent [date]" badge. Added `initCloudSync`-style server load on page open (direct `fetch('/api/db?key=internships')`) — restores opportunities, sent log, template, and resume context across devices. Added `pushInternshipData()` after every write (opportunities, applied, sent log). PDF upload calls `/api/extract-resume-text` (if endpoint exists) or falls back to plain-text FileReader. Gmail connection notice shown if `google_accounts_v1[0].scope` lacks `gmail.send`. Added `internships` to appKey registry in this file. | `sendGmailNow` is set by `topbar.js` on load — if topbar.js errors, it is undefined and the send button shows an error. `/api/extract-resume-text` endpoint does not exist yet; PDF upload will 404 until implemented (text files work immediately via FileReader). The server load reads all internship keys at once from one Supabase row — if the `internships` row doesn't exist yet, the load silently no-ops and local state is used. |
