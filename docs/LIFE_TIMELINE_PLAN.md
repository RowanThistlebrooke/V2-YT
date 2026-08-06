# Life Timeline — design note (Phase 3.2)

**Task:** Build a new, read-only page (`life-timeline.html`) that aggregates existing timestamped events from across the dashboard into one chronological, filterable, searchable feed.

**Planning + implementation owner:** Claude. **Review owner:** Codex. **Merge approval:** Fernando.

**Relationship to prior planning:** `docs/COMMAND_CENTER_PLAN.md` §7 already scoped this as Phase 3, item 2 ("new page aggregating existing per-domain timestamped events... read-only, no new write paths") and flagged the reusable constraints below. This note is the concrete spec for that item; it does not repeat §1-6 of that document.

---

## 1. Data inventory (verified against the actual code, not assumed)

Nine domains, each with real, different shapes. This is the load-bearing fact the whole design has to work around: **there is no existing unified event log** — every domain stores its own thing, in its own format, for its own reasons.

| Domain | Storage key(s) | Entry shape | Timestamp | Synced? |
|---|---|---|---|---|
| Workouts | `po_coach_v1.logs` | `{weight, reps, date}` per set | `date`: ISO string (exact) | yes |
| Body weight | `po_coach_weights` | `{dateKey, weight}` | `dateKey`: `YYYY-MM-DD` (day-only) | yes |
| Meals | `cal:entries` | `{id, dateKey, items[], calories, ...}` | `ts`: epoch ms (exact) + `dateKey` | yes |
| Purchases | `purchases` | `{id, name, amount, date, ts}` | `ts`: epoch ms (exact) | yes |
| Net worth changes | `nw:activity` | `{ts, cat, name, delta, kind}` | `ts`: epoch ms (exact) | yes |
| Business revenue/payments | `biz:affiliate:revenue`, `biz:editing:payments` | `{id, date, amount, note, ts}` | `ts`: epoch ms (exact) | yes |
| Leverage task (daily) | `leverage_stats_v1.history` | `{date, text, done}`, **capped at 14** | `date`: day-only | yes |
| Habit check-ins | `habits:defs` + `habits:log` | `{habitId: {dateKey: true}}` | day-only, unbounded history | yes |
| Peak check-ins | `peak:checkins` | `{id, ts, dateKey, feeling, stress, note}` | `ts`: epoch ms (exact) | yes |
| Notes | `notes:items` | `{id, title, body, updatedAt}` | `updatedAt`: epoch ms (exact) | yes |
| Schedule appointments | `schedule:model_v1.appointments` | `{id, date, start, end, title, ...}` | `date` + `start`/`end` as `HH:MM` strings (exact, composed) | yes |
| Telegram assistant actions | Supabase `app_state` rows keyed `telegram-action:<id>` | `{id, row, before, after, description, ts}`, capped at 20, **not part of any page's `syncedKeys`** | `ts`: epoch ms (exact) | **no — separate fetch required** |

Three things this table makes unavoidable for the design:

1. **A common `TimelineEntry` shape with an explicit precision flag.** Half these sources only know a day, not a moment. Faking a time (midnight, noon) to force everything onto one axis would silently misrepresent precision — the requirement says "honest handling of missing timestamps," so precision has to be a first-class field, not massaged away.
2. **No dedicated "PR" (personal record) events exist anywhere.** `gym.html` computes best-set/1RM on read from `po_coach_v1.logs`, it doesn't persist a "you hit a PR" event. A Timeline entry for a PR has to be *derived* at build time (scan an exercise's log history, flag the entries that were a new best when logged), not read from a new field — this stays "no new write paths," but it's compute, not just a pass-through.
3. **`goals:<date>` keys are deleted after daily rollover** (`main.html`'s `rollover()`), so **historical to-do completions genuinely do not exist** past today/tomorrow. The only durable daily-task signal is `leverage_stats_v1.history` (14-day cap) and `habits:log` (real history, day-only). The "Tasks and completed habits" domain in the Timeline is therefore honestly limited to those two — not a full to-do history that was never kept.

---

## 2. Architecture

**One new page, one new shared module, zero new storage.**

```
life-timeline.js          — pure aggregation module (adapters + normalize + filter + search)
  ├── ADAPTERS: one function per domain, each `(rawData) => TimelineEntry[]`
  │     adaptWorkouts, adaptBodyWeight, adaptMeals, adaptPurchases, adaptNetWorthActivity,
  │     adaptBusinessRevenue, adaptLeverageHistory, adaptHabitCheckins, adaptPeakCheckins,
  │     adaptNotes, adaptAppointments, adaptTelegramActions
  ├── deriveWorkoutPRs(logs)   — the one non-pass-through adapter (see §1.2)
  ├── mergeAndSort(entries[])  — stable sort: exact-time entries by ts, day-only entries
  │                              grouped within their day (see §4 for exact tie-break rule)
  ├── filterByRange(entries, {from, to})
  ├── filterByCategory(entries, categories[])
  └── searchEntries(entries, query)  — substring match over title/summary, reuses the
                                        tokenization approach already in search-index.js
                                        rather than inventing a second one

life-timeline.html        — day/week/month view, category filter chips, search box,
                             grouped-by-day list with a one-line daily summary
```

`TimelineEntry` shape (every adapter returns this, nothing else touches the DOM):

```js
{
  id,              // stable, derived from source id/date/domain — see §5 dedup rule
  domain,          // 'workout' | 'bodyweight' | 'meal' | 'purchase' | 'networth' |
                    // 'business' | 'task' | 'habit' | 'checkin' | 'note' | 'appointment' | 'telegram'
  ts,              // epoch ms if precision is 'exact', else null
  dateKey,         // 'YYYY-MM-DD', ALWAYS present (derived from ts if exact, stored directly if day-only)
  precision,       // 'exact' | 'day'
  title,           // short headline, e.g. "Bench press · 185×5"
  summary,         // one line of detail, e.g. "New best (prev. 180×5)"
  sourcePage,      // 'gym.html', 'health.html', ... — rendered as a visible source label
  deepLink,        // href back to the source page, deep-linked where the source page
                    // supports it (e.g. gym.html?ex=<id>), else just the page
  isPR: false,     // only true on the derived PR entries
}
```

**Why a shared module and not inline page logic:** every one of these 12 adapters is pure data transformation with zero DOM dependency, so it follows this repo's established "duplicate for testing, but factor out for reuse" pattern the same way `search-index.js` was extracted from `search.html` (per `COMMAND_CENTER_PLAN.md` Phase 0) — except here the module is genuinely shared from day one, not duplicated, because nothing else in the app currently needs this aggregation.

**The Telegram-action exception:** `telegram-action:*` rows aren't in any page's `syncedKeys`, so they don't arrive via the normal `initCloudSync()` pull. `life-timeline.html` does one extra, explicit read: `GET /rest/v1/app_state?select=key,data&key=like.telegram-action:*`, the same direct-Supabase-REST pattern `insights-recovery.html` already uses for its own page-load fetch (not a new architecture — an existing pattern applied to a new table filter). If that fetch fails (offline, or cloud sync not configured), the Telegram domain is simply omitted from the feed with a small "Telegram actions unavailable — check connection" note, rather than blocking the rest of the page, which is fully renderable from local `syncedKeys` data alone.

---

## 3. Filtering, search, deep links

- **Day / Week / Month views** — a date-range picker anchored on "today," identical interaction pattern to `schedule.html`'s existing view switcher (reuse, not reinvent).
- **Category filter** — chips for each `domain` value, multi-select, persisted in the URL query string (`?domains=workout,meal`) so a filtered view is linkable/bookmarkable.
- **Search** — a single text box, debounced, matching against `title`+`summary`; reuses `search-index.js`'s tokenization helper rather than writing a second implementation.
- **Deep links** — every entry links back to its source page. Where the source page has no addressable anchor for a single item (e.g., `notes.html` has no per-note URL), the link goes to the page itself rather than a broken deep link — never a dead link.
- **Source labels** — every entry visibly shows which page it came from (small pill/tag), since the requirement is explicit about this ("clear source labels") and it's also the natural way to make the category filter self-explanatory.

---

## 4. Grouping and daily summaries

Entries render grouped by `dateKey`, most recent day first. Within a day: exact-precision entries sort by `ts`; day-only entries render in a fixed, domain-based order at the top of that day's group (not interleaved unpredictably with timed entries, since they have no real position to interleave at) — labelled visually as "sometime today" rather than implying a specific moment.

Each day group gets a one-line auto-summary, generated from simple counts already available post-aggregation (no new inference engine): e.g. *"3 workouts logged · $42 spent · 2 notes · habit streak intact"* — a plain template over `entries.filter(e => e.dateKey === day)`, grouped by domain, not a new "smart" summarizer.

---

## 5. No duplicated events

Two concrete de-dup rules, both necessary given real overlaps in the data:

1. **Body weight vs. workout weigh-ins:** `po_coach_weights` is the single source for body-weight entries — nothing else in the inventory duplicates it, so no merge logic needed there, just don't also surface weight numbers from inside `po_coach_v1.logs` (those are lift weights, a different `domain`).
2. **Stable `id` per adapter, derived not generated:** each adapter builds `id` deterministically from its own source data (e.g. `workout:<exerciseKey>:<date>` , `purchase:<purchases[].id>`), never `Date.now()`/`Math.random()` — so re-running the aggregation (e.g. on every page load, or after a cloud sync pull) produces the identical `id` for the identical underlying record, making "no duplicated events" a property of the id scheme itself rather than something checked at render time.

---

## 6. What this explicitly does NOT do (v1 scope)

- **No new write paths.** Nothing on this page edits, deletes, or annotates source data — verified by the acceptance criteria in §7 (no `localStorage.setItem`/Supabase write calls anywhere in `life-timeline.js`/`life-timeline.html` outside the standard `initCloudSync` read-only pull).
- **No PR detection for domains other than workouts.** "Personal record" is a workout-specific concept in this codebase; not extended to, e.g., "biggest purchase" or "longest note" — that would be inventing new semantics, not aggregating existing ones.
- **No retroactive to-do history.** As established in §1.3, it doesn't exist to aggregate. The Timeline is honest about this rather than backfilling a fake history.
- **No mobile-native swipe/infinite-scroll gestures beyond what's already standard on this dashboard's other list-heavy pages** (e.g. `notes.html`, `calendar.html`) — reuse existing patterns, don't invent new interaction models for this one page.

---

## 7. Acceptance criteria

- Renders correctly (day/week/month, all filters, search) using only data that already exists in a fresh, empty-for-this-feature dashboard — i.e., every one of the 12 domains gracefully renders "no events" rather than crashing when its source key is absent.
- Zero new `localStorage`/Supabase keys created; zero write calls anywhere in the new files.
- Every entry has a visible source label and a working deep link (never a 404/dead link).
- Filtering by category and by date range both narrow the visible set correctly and are reflected in the URL.
- Search matches substrings across title/summary, debounced, no layout jank.
- No duplicate entries when the same underlying record could theoretically appear via more than one adapter (see §5).
- Missing/day-only timestamps are visually distinguished from exact ones, never faked.
- Desktop + 375px mobile: no horizontal scroll, full legibility, all interactive elements keyboard-reachable with visible focus (per the shared `design-system.css` baseline).
- `prefers-reduced-motion: reduce` respected for any transition/animation this page adds (per the lesson from PR #155 — checked directly, not just assumed from the shared stylesheet).
- Full test suite (`npm test`) passes; new pure-logic module (`life-timeline.js`) ships with its own `tests/test_life_timeline.mjs` covering every adapter, the merge/sort/precision logic, the dedup id scheme, and the day-summary generator.

---

## 8. Risks

- **Telegram-action fetch is a new, separate network call** (§2) — must fail gracefully and must not block the rest of the page; must not leak the Supabase anon key any differently than every other page already does (same client-side key already public in `insights-recovery.html` etc., not a new exposure).
- **Volume:** `po_coach_v1.logs` and `cal:entries` can be large over a long history. v1 loads and renders the currently-selected range only (day/week/month), not the full all-time history at once, to keep this responsive — an "all time" view is explicitly deferred, not promised in v1.
- **This page adds a 13th place that reads nearly every domain's storage keys** (search-bar-adjacent in scope to `search-index.js`'s own ~13-domain read) — must reuse the already-synced localStorage mirror (`initCloudSync`'s local copy), not issue 12 fresh Supabase fetches on every load, matching the exact performance concern `COMMAND_CENTER_PLAN.md` §8 already raised for the Command Bar.

---

## 9. Handoff

Implementation order: `life-timeline.js` (all 12 adapters + merge/filter/search, pure functions, no DOM) → `tests/test_life_timeline.mjs` (written alongside, not after) → `life-timeline.html` (UI wiring only, no new logic) → wire a nav entry point (Command Bar `NAV_ITEMS`, and a tile/link from an appropriate hub page — `hub-insights.html` or `index.html`'s Browse section, to be decided at implementation time based on what reads cleanest). One PR, branch `claude/life-timeline`, requesting Codex review per the standard workflow.
