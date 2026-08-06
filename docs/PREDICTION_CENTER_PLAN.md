# Prediction Center — design note (Phase 3.3)

`docs/COMMAND_CENTER_PLAN.md` §7 scopes this stage in one sentence: *"consolidates
existing forecasting functions ... into one page with confidence framing; new UI
over existing math, not new math."* This note takes that literally. Every number
Prediction Center shows must trace back to a function that already ships today,
verified against the actual source (file:line cited below), not a new algorithm
invented for this page.

## 1. Inventory of existing forecasting logic (verified against the actual code)

| Prediction | Canonical source | Algorithm | Confidence bands? | Min data |
|---|---|---|---|---|
| Weight trajectory | `gym.html:3606` `trajCompute` | Percentile (p25/median/p75) weekly-rate fan | Yes — Slow/Typical/Fast | 3 weigh-ins in 90d window |
| Net worth trajectory | `finance.html:2943` `computeNwScenarios` | Percentile monthly-rate fan (same shape as weight) | Yes — Slow/Typical/Fast | 3 snapshots in window |
| Sleep debt | `insights-recovery.html:224` `computeSleepDebt` | Sum of daily deficits vs. target, trailing 14d | No — accumulated total, backward-looking | 1+ logged night |
| Burnout risk | `insights-recovery.html:233` `computeBurnoutRisk` | Recent-7d vs. prior-7d threshold signals | Categorical tier only (Low/Moderate/Elevated) | comparable data on both sides |
| Habit/goal completion | `insights-adherence.html:135,141` `computeOverallAdherence` / `computeAdherenceTrend` | Window average + recent-14d vs. prior-14d | No — directional only | 5 samples each side for trend |
| Schedule adherence | **none exists** | — | — | — |

Net worth trend has three *other* live copies besides the canonical scenario
function above — a plain single-regression variant in `finance.html:2875`
(`computeNetWorthTrend`), duplicated again in `hub-today.html:319` and a third
time in `command-center.js:58`. None of the three add confidence bands; they're
the older, simpler forecast that `computeNwScenarios` was built to supersede on
finance.html itself. Reconciling those three copies into one is a real problem,
but it's a pre-existing one this stage did not create — see §8.

`tests/test_insights_predictive.mjs` contains a `computeWeightProjection` and a
generic `computeTimeToGoal` that back **no live page** — `insights.html` was
deleted in the Insights page split (commit `a8ce0db`) and this logic never got
a new home. It also uses a different algorithm (single regression) than
gym.html's actual live Weight Trajectory (percentile fan), so even if it were
live it would be a second, contradictory way to forecast the same metric.
**Decision: do not revive it.** Weight forecasting already has a superior,
shipped, tested implementation (`trajCompute`); resurrecting a second one is
exactly the "duplicate/contradictory forecasts" failure mode this stage exists
to avoid. The dead test file itself is left untouched — deleting or repurposing
it is a separate decision or the responsibility of whoever finds it dead in
this file. See "unrelated" note in the docs/AI_WORKFLOW.md sense (§8).

## 2. What Prediction Center actually shows, and why each one is honest

Two of the five roadmap-named forecast types already have real confidence bands
(weight, net worth). The other three do not, because no verified banded math
exists for them today — inventing percentile bands for sleep debt/burnout/adherence
just to make Prediction Center look uniform would be **new math dressed as reused
math**, and the roadmap explicitly rules that out ("no false confidence").
Instead:

- **Weight** and **Net worth**: full Slow/Typical/Fast scenario cards, reusing
  `trajCompute` and `computeNwScenarios` verbatim (duplicated into the shared
  module per this repo's established IIFE-duplication convention — see §3).
- **Sleep debt**: shown as its actual shape — an accumulated deficit to date,
  explicitly labeled "current status, not a forecast" — plus the Burnout Risk
  tier as directional context, both reusing `computeSleepDebt`/`computeBurnoutRisk`
  unmodified. No fabricated "debt will reach X by [date]" line, because no
  verified rate-of-accumulation math exists to project that honestly.
- **Habit/goal completion**: shown as `computeAdherenceTrend`'s recent-vs-prior
  comparison, labeled "recent trend" (Improving/Declining/Flat + the two
  percentages), not as a numeric forecast — because `computeAdherenceTrend`
  itself is a two-window comparison, not an extrapolated trend line.
- **Schedule adherence**: **excluded from v1.** Confirmed via direct source
  search (`schedule.html`, `schedule-model.js`) that no adherence/reconciliation-rate
  calculation exists anywhere in the Weekly Schedule System (PRs #105-107 built
  the model, Google Calendar projection, and Telegram tools — none of them
  compute a followed-vs-planned percentage). Building that from scratch would be
  new forecasting math, which is out of scope for a consolidation stage. This is
  a deliberate, documented gap, not an oversight — same posture as Life
  Timeline's documented per-todo history gap.

Every card states: time horizon, confidence framing (banded scenario vs. single
point vs. categorical tier — never presented as more precise than it is),
underlying assumptions (window size, minimum data threshold), and a data-volume
note when a metric is running on a thin sample (e.g. "based on 3 weigh-ins" as
opposed to a healthy 20+). Every card links back to its source page
(gym.html's Trajectory section, finance.html's Forecast card, etc.) so a number
that looks surprising can be checked against its origin, not just trusted.

## 3. Architecture

New pure module: **`prediction-center.js`** — following the same shape as
`life-timeline.js`: one adapter per prediction type, no DOM, no storage, no
network, zero new write paths. Each source page's function is duplicated in
verbatim (matching this repo's established convention — `gym.html`, `finance.html`,
and `insights-recovery.html` are browser-global IIFEs with no exports, so there
is nothing to `import`; life-timeline.js's `estimate1RM` duplication from
gym.html is the direct precedent). A code comment above each duplicated
function names its source file/line so a future edit to the original is easy
to notice as needing a matching update here — same discipline the repo already
uses elsewhere (e.g. `api/telegram-webhook.js`'s sleep recap explicitly
cross-references insights-recovery.html's Night Score by name).

Functions duplicated in (unmodified except for being pure — no `$()`/DOM calls
were in the originals for these specific functions, so this is a straight copy,
not a rewrite):
- `trajPercentile`, `trajWeeklyRates`, `trajCompute` (from `gym.html`)
- `nwPercentile`, `nwMonthlyRates`, `computeNwScenarios` (from `finance.html`)
- `computeSleepDebt`, `computeBurnoutRisk` (from `insights-recovery.html`,
  which itself needs `buildDayRows`/`lastNDateKeys` as inputs — those two are
  also duplicated in, matching the exact copy already living in
  `insights-adherence.html` since the two pages already carry independent
  copies of the same day-row builder)
- `computeOverallAdherence`, `computeAdherenceTrend` (from `insights-adherence.html`)

New UI: **`prediction-center.html`**. Wiring only, no new logic — reads every
`app_state` row it needs via one direct Supabase REST fetch (the same one-shot
pattern `insights-recovery.html` and `life-timeline.html` already use), since it
spans data owned by five different pages (`po-coach`, `finance`, `sleep`,
`caffeine`, `peak`, `goals`). Renders one card per prediction type, in the fixed
order: Weight → Net Worth → Sleep Debt / Burnout → Habit/Goal Completion →
Schedule Adherence (shown as an explicit "not available yet" card rather than
silently omitted, so its absence reads as a documented decision, not a bug).

Wired into `hub-insights.html` (new tile) and the Command Bar (`command-bar.js`
`NAV_ITEMS`), same as Life Timeline.

## 4. No duplicate/contradictory forecasts (the specific risk this stage must not add to)

- Prediction Center reads `computeNwScenarios`, never `computeNetWorthTrend` —
  it does not introduce a fourth copy of the simple-regression variant, and it
  does not show both the banded and unbanded net-worth numbers side by side
  (which would itself read as contradictory — two different "trend" figures on
  one page).
- It does not touch, rename, or modify any of the five source pages' own
  copies. Prediction Center is a read-only consumer; the source pages remain
  the single place those numbers are actually computed and rendered live.
- It does not revive `test_insights_predictive.mjs`'s dead weight-projection
  logic (§1).
- It does not invent a schedule-adherence percentage (§2).

## 5. What this explicitly does NOT do (v1 scope)

- No schedule adherence forecast (§2) — genuinely no source math exists yet.
- No reconciliation of the three duplicate net-worth-trend copies
  (`finance.html`/`hub-today.html`/`command-center.js`) into one — flagged as a
  separate, pre-existing cleanup opportunity, not bundled into this PR per the
  standing "document unrelated findings separately" instruction.
- No new write paths, no new storage keys, no mutation of any source page's
  data.
- No "what-if" interactivity — that is explicitly Stage 5.7 (Scenario
  Simulator), scoped in `docs/COMMAND_CENTER_PLAN.md` §7 as sitting *on top of*
  Prediction Center's math, built after this stage ships.
- No probability numbers presented as more precise than their source
  (e.g. no invented "73% likely" style claims — the source functions return
  scenario values and categorical tiers, not probabilities, and Prediction
  Center will not add false precision on top of them).

## 6. Acceptance criteria

- New pure-logic module (`prediction-center.js`) ships with its own
  `tests/test_prediction_center.mjs` covering every duplicated function against
  known inputs/outputs, plus the card-assembly/ordering logic.
- Every card names its time horizon, confidence framing, assumptions, and a
  data-volume indicator.
- Every card links to its source page.
- Weight and Net Worth cards show real Slow/Typical/Fast bands, not point
  estimates.
- Sleep Debt, Burnout, and Habit/Goal Completion cards are honestly framed as
  point-estimate/categorical/trend — never dressed up with fabricated bands.
- Schedule Adherence renders as an explicit "not available" card with a one-line
  reason, not silently omitted.
- Zero new storage keys, zero new write paths.
- Responsive: desktop and narrow-mobile verified, no horizontal scroll.
- `npm test` passes with no regressions to any of the five source pages' own
  test coverage (their functions are duplicated, not modified).

## 7. Risks

- **Drift between the duplicated copy and the source page's own copy** if
  someone edits `trajCompute` in `gym.html` later without updating
  `prediction-center.js`'s copy. Mitigated by the file:line source comments
  above each duplicated function (§3) and by both copies having their own
  passing test suite that would independently start failing if the two
  diverged in a way that changed behavior against the same fixtures — though
  nothing enforces textual sync automatically. A future real extraction (each
  source page importing from `prediction-center.js` instead of keeping its own
  copy) would remove this risk entirely but is out of scope here, matching how
  `life-timeline.js` also does not currently refactor its five source pages to
  import back from it.
- **Five separate Supabase reads' worth of data on one page** — same shape of
  risk `life-timeline.html` already accepted and shipped; no new risk class.

## 8. Handoff

Implementation order: `prediction-center.js` (duplicated functions + card
assembly, pure, no DOM) → `tests/test_prediction_center.mjs` (written
alongside) → `prediction-center.html` (UI wiring only) → nav entry points
(hub-insights.html tile, command-bar.js NAV_ITEMS) → Playwright desktop/mobile
verification with synthetic mocked data → PR.

Two items surfaced during research that are explicitly **not** part of this
PR's scope, documented here per the standing "document unrelated findings
separately" instruction, for Fernando/Codex to decide on separately:
1. Net worth trend math is duplicated three ways outside of the canonical
   scenario function (`finance.html:2875`, `hub-today.html:319`,
   `command-center.js:58`) — worth consolidating at some point, not urgent.
2. `tests/test_insights_predictive.mjs` tests dead code with no live page
   backing it (§1) — worth a decision to either delete it or promote
   `computeTimeToGoal` into a real generic ETA primitive used by a future page;
   left untouched here.
