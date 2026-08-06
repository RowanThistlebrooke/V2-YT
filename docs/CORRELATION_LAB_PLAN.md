# Correlation Lab — design note (Phase 3.4)

**Implementation owner: Codex** (not Claude, per explicit handoff — see
`docs/AI_WORKFLOW.md` for the collaboration workflow this note follows).
**Review owner: Claude.** Branch: `codex/correlation-lab`.

GitHub Issues are disabled on this repository, so this plan lives here
instead of in an issue — treat it exactly as `docs/AI_WORKFLOW.md`'s
"Create or identify the issue" + "Plan" steps combined into one file. Codex
should open its PR referencing this file by path, the same way `PR #156`/`#158`
referenced `docs/LIFE_TIMELINE_PLAN.md`/`docs/PREDICTION_CENTER_PLAN.md`.

## User outcome

A page where Fernando picks two compatible metrics he already tracks and sees
whether they actually move together: direction, strength, sample size, date
range, and lag — with presets for the pairings he's most likely to want, and a
plain correlation-is-not-causation disclaimer so a coincidental relationship
doesn't get read as proven.

This is Stage 5.4 of the Phase 3 roadmap (`docs/COMMAND_CENTER_PLAN.md` §7).
Preceded by Stage 5.2 (Life Timeline, merged — see `docs/LIFE_TIMELINE_PLAN.md`)
and Stage 5.3 (Prediction Center, merged — see `docs/PREDICTION_CENTER_PLAN.md`).

## Real bug found during research — fix this as part of the extraction, not a footnote

`buildDayRows` — the function that turns raw storage rows into one row per
date for cross-metric analysis — is currently **duplicated six separate
times** with real behavioral drift between copies, not just cosmetic
differences:

| File | Late-caffeine logic |
|---|---|
| `insights-recovery.html` | Correct — uses `lateCaffeineSleepSessionDays()`, the sleep-session-aware version fixed in PR #154 (accounts for caffeine logged after midnight belonging to the prior night's sleep session) |
| `insights-triggers.html` | **Still has the old bug** — `d.getHours() >= 14` only, no midnight-crossing handling |
| `insights-patterns.html` | **Still has the old bug** — same as above |
| `insights-adherence.html` | No late-caffeine field at all |
| `insights-drift.html` | No late-caffeine field at all |
| `insights-mode.html` | No late-caffeine field at all |

PR #154 fixed this exact bug in `insights-recovery.html` and
`api/telegram-webhook.js` but the fix was never propagated to the other two
copies that also compute a late-caffeine flag. This means
`insights-triggers.html` and `insights-patterns.html` can currently
misattribute a caffeine dose to the wrong night. **Extracting `buildDayRows`
into one shared module and having every page (including these two) consume
the shared version fixes this as a side effect of the stage's own required
work** — it doesn't need a separate PR.

The six copies also diverge in which fields they compute (some include
`sleepHours`, some don't; the `factors` object's keys differ per page's own
needs — see the field table below). The shared module needs to be a superset
that gives every existing consumer everything it currently gets, so none of
the six pages regress when switched over.

## What "compatible metrics" means concretely

No generic "pick any two numbers" UI — that invites nonsense pairings (e.g.
correlating two metrics with only 2 overlapping days). Metrics are drawn from
a fixed catalog, each tagged with its real source so the page can honestly
report sample size / date range from real data:

| Metric | Source key(s) | Notes |
|---|---|---|
| Sleep hours / quality | `sleep:nights` (row `sleep`) | Already in `buildDayRows` |
| Workout done (day) | `po_coach_workout_done` (row `po-coach`) | Boolean per day; already used by `insights-drift.html`/`insights-mode.html`/`insights-patterns.html` |
| Caffeine dose / late-caffeine flag | `caf:logs` (row `caffeine`) | Use the CORRECT `lateCaffeineSleepSessionDays()` logic, not the buggy inline versions |
| Night Score (recovery proxy) | derived — `computeNightScore` from `insights-recovery.html` | No WHOOP-independent "recovery" field exists otherwise; WHOOP recovery score is available live via `/api/whoop-data` (see `command-center.js`) as an optional alternative if a device is connected, but don't require it |
| Feeling / stress (mood) | `peak:checkins` (row `peak`) | Already in `buildDayRows` as `outcomeFeeling`/`outcomeStress` |
| Habit / to-do completion rate | `habits:defs`/`habits:log`, `goals:<date>` (row `goals`) | Already in `buildDayRows` as `habitRate`/`todoRate` |
| Purchases (spending) | `purchases` (row `finance`) | Sum of `entered_amount` per day; not currently in any `buildDayRows` copy — new field, but reusing the same array `life-timeline.js`'s `adaptPurchases` already reads |
| Stretch completion | `stretch:log` (row `po-coach`) | Not currently in any `buildDayRows` copy — new field |

**No dedicated "pain" tracker exists anywhere in the codebase.** The
roadmap's "stretching vs pain" preset has no real pain metric to pull from.
Do not invent one. Use `outcomeStress` (or `outcomeFeeling`, inverted) as the
closest honest proxy and **say so explicitly in the UI** next to that preset
— e.g. "using self-reported stress as a proxy; no dedicated pain tracking
exists yet." This matches the "no false confidence" posture the last two
stages established — see `docs/PREDICTION_CENTER_PLAN.md` and
`docs/LIFE_TIMELINE_PLAN.md` for the tone/precedent to match.

Presets, mapped to real data:
- **Sleep vs workout** — sleep hours/quality vs. workout-done
- **Caffeine vs recovery** — late-caffeine flag vs. Night Score
- **Spending vs mood** — daily purchase total vs. feeling/stress
- **Stretching vs pain** — stretch completion vs. stress (explicitly labeled
  as a proxy, per above)

## Correlation math (this is genuinely new code, unlike Stages 5.2/5.3)

Unlike Life Timeline and Prediction Center, this stage's own math
(correlation coefficient + lag) does not already exist anywhere in the
codebase — `insights-patterns.html`'s `computeFactorEffect` is a
binary-group-difference test (days-with-factor vs. days-without), not a real
correlation between two continuous series, and it's the closest existing
precedent but is NOT the same computation. Implement the actual math for this
stage:

- **Pearson correlation coefficient (r)** between two numeric day-level
  series, joined on `dateKey`, using only days where BOTH metrics have a
  non-null value.
- **Minimum sample size guard** (suggest 8, matching the general "don't trust
  small-n stats" pattern this codebase already uses — e.g.
  `ADHERENCE_TREND_MIN_SAMPLES = 5`, `TRAJ_MIN_ENTRIES = 3`; pick a number
  and document why in the PR). Below the minimum: refuse and say why, don't
  compute a misleadingly precise r from 3 data points.
- **Strength bucketing**: standard |r| thresholds (e.g. <0.1 negligible,
  0.1–0.3 weak, 0.3–0.5 moderate, 0.5–0.7 strong, >0.7 very strong — cite
  whichever standard convention you use).
- **Direction**: sign of r, described in plain language ("as X goes up, Y
  tends to go up/down").
- **Lag**: recompute r after shifting the second series by each of a small
  range of day offsets (suggest -3 to +3), report the offset with the
  strongest |r| alongside the zero-lag r — so "caffeine today vs. sleep
  quality tonight" and "caffeine today vs. sleep quality tomorrow night" are
  both checkable.
- **Sample size and date range**: always shown next to the r value, not
  hidden in a tooltip.
- **Divide-by-zero / degenerate-input guard**: a metric that's constant
  across the whole window has zero variance — Pearson's r is undefined
  (0/0), not 0. Detect this and report "not enough variation in [metric] to
  compute a correlation," don't silently return 0 or NaN.
- **Correlation ≠ causation disclaimer**: shown on every result, not just
  once on page load — someone re-running a different pair shouldn't lose the
  disclaimer.
- **Deterministic and local**: pure function of the day-row data, no network
  calls, no randomness — testable the same way every other pure module in
  this repo is tested.

## Architecture (follow the established pattern from Stages 5.2/5.3)

- **`correlation-lab.js`** — pure module, no DOM/storage/network:
  - The extracted `buildDayRows`/`lastNDateKeys`/`dateKeyFromDate` (superset
    of all six existing copies' fields, see table above), fixing the
    late-caffeine bug as part of the extraction.
  - `pearsonCorrelation(seriesA, seriesB)` and the lag-scanning wrapper
    around it.
  - Card/result-assembly functions, mirroring `prediction-center.js`'s
    `buildAllCards`-style shape.
- **`correlation-lab.html`** — UI wiring only. Metric pickers (from the fixed
  catalog), preset buttons, result display. Same one-shot direct Supabase
  `app_state` fetch pattern as `life-timeline.html`/`prediction-center.html`
  (see either file for the exact fetch code to copy).
- **Wire into `hub-insights.html`** (new tile, following the existing `·07`
  → `·08` numbering pattern already there) **and `command-bar.js`**
  (`NAV_ITEMS`), exactly like the last two stages.
- **`tests/test_correlation_lab.mjs`** — cover: the correlation math against
  hand-computable fixtures (e.g. perfectly correlated/anti-correlated/
  uncorrelated synthetic series with known r), the minimum-sample-size
  refusal, the zero-variance guard, the lag scan picking the right offset,
  and `buildDayRows` producing the superset of fields all six original pages
  need.

### Should the six existing pages be switched over to import the shared module in this PR?

Recommended: **yes, if it fits in one focused PR without ballooning scope** —
the whole point of "extract duplicated day-row aggregation into one tested
shared module" (the roadmap's own words for this stage) is that the six
pages stop drifting. If it turns out to be too much surface area for one PR,
it's acceptable to ship `correlation-lab.js`/`.html` first and open a
clearly-linked follow-up for switching the six existing pages over — but if
you do that, still fix the late-caffeine bug directly in
`insights-triggers.html` and `insights-patterns.html` in THIS PR regardless
(that's a real, already-identified bug, not new scope), and say explicitly in
the PR description which path you took and why.

## Explicitly out of scope

- No "pain" tracking feature — use the stress proxy, labeled as such (see
  above).
- No changes to WHOOP integration.
- No new storage keys, no new write paths — this stage is entirely read-only,
  same as the last two stages.
- Scenario Simulator (Stage 5.7) is a separate future stage that sits on top
  of this and Prediction Center's math — don't build what-if interactivity
  here.

## Acceptance criteria

- [ ] `correlation-lab.js` ships with `tests/test_correlation_lab.mjs`
  covering the correlation math (known-r fixtures, min-sample refusal,
  zero-variance guard, lag scan) and the day-row builder.
- [ ] Every result shows: direction (plain language), strength category, r
  value, sample size, date range, and the correlation-≠-causation disclaimer.
- [ ] Lag is shown, not just zero-lag correlation.
- [ ] All four presets work against real (or realistic synthetic test) data;
  the stretching-vs-pain preset visibly labels itself as using a stress
  proxy.
- [ ] The late-caffeine bug in `insights-triggers.html`/`insights-patterns.html`
  is fixed (either via the shared-module switchover or directly, per the
  decision above).
- [ ] Below the minimum sample size, or with zero-variance input, the page
  says so — never a fabricated/misleading r.
- [ ] Zero new storage keys, zero new write paths.
- [ ] Responsive: desktop + narrow mobile verified, no horizontal scroll.
- [ ] `npm test` passes with no regressions to any of the six source pages'
  own test coverage.
- [ ] Wired into `hub-insights.html` and `command-bar.js`.

## Data / migration risks

None expected — entirely read-only, reusing existing storage keys. The only
risk is behavioral: if the six pages ARE switched to the shared
`buildDayRows`, verify each page's own rendering still matches its
pre-change behavior for every field it uses (the late-caffeine fix is an
intentional behavior change; everything else should be identical output for
identical input — a good place for a quick before/after manual diff on
synthetic data, not just relying on each page's own existing test file
continuing to pass, since those test files also currently duplicate the
buggy logic and would need updating alongside the source page).

## Agent handoff

- Task: Roadmap Stage 5.4 — Correlation Lab
- Implementation owner: Codex
- Review owner: Claude
- Branch: `codex/correlation-lab`
- Pull request: (open as draft when ready; reference this file in the description)
- Current status: Planned, not yet implemented. This file is the design note
  for this stage — GitHub Issues are disabled on this repo, so it stands in
  for the issue `docs/AI_WORKFLOW.md` would normally ask for.
- Files changed: (none yet)
- Acceptance criteria completed: (none yet)
- Tests run: (none yet)
- Browser checks: (none yet)
- Known risks or limitations: see "Data / migration risks" above; no
  dedicated pain metric exists (see "compatible metrics" section)
- Open decisions: whether to switch all six existing `buildDayRows`
  consumers over in this PR or as a fast-follow (late-caffeine bug fix in
  `insights-triggers.html`/`insights-patterns.html` is required either way)
- Requested next action: Codex plans + implements per
  `docs/AI_WORKFLOW.md`'s lifecycle (plan → implement → validate → draft PR
  → Claude review → Fernando approval). Do not merge without Fernando's
  explicit approval.
