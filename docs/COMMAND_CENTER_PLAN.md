# JARVIS Command Center — redesign specification & phased plan

**Task:** Evolve the dashboard's homepage (`index.html`) into a cinematic, predictive "command center," and design the visual/architectural foundation so the 9 future systems listed below can be built on top of it without rework.

**Planning owner:** Claude (this document). **Implementation owner:** Codex, once Fernando approves the plan. **Review owner:** Claude.

**Explicitly out of scope for this document:** PR #142 (Telegram command center) and its branch `codex/telegram-command-center` — not touched, not referenced as a dependency. No feature code is being written as part of this PR; it's the plan Codex implements from. (Repo Issues are disabled, so this plan ships as its own docs-only PR — the same pattern PR #141 used for the workflow docs — rather than a GitHub issue.)

---

## 1. Audit of the current visual system

Full detail lives in the research pass behind this issue; the load-bearing facts:

**Token inventory (`design-system.css:25-46`).** The existing HUD theme already has real bones:
```css
--text-primary:#F2FBFF; --text-secondary:#A9C4D6; --text-tertiary:#5E7A8C;
--success:#3FE0A8; --warning:#FFB84D; --danger:#FF5470;
--hud:#22D3F5; --hud-rgb:34,211,245; --hud-dim/--hud-line/--hud-line-soft/--hud-glow (0.45/0.20/0.10/0.35 alpha);
--font / --font-mono
```
**What's missing:** no spacing scale, no radius scale, no shadow scale, no z-index scale — those are hand-written literals per rule today. Phase 0 below adds them.

**HUD components already shipped and reusable** (not reinvented, extended):
- `.hud-ring` — conic-gradient arc-reactor gauge driven by `--ring-pct`, slow-rotating dashed outer ring. Already live on index.html's Today Score. **This is the visual anchor for the new "AI core."**
- `.hud-pulse-dot` — radar-blip status indicator.
- `.hud-scanline` — one linear scan sweep.
- `.gm-card` / `.tile` — glass panels with corner-bracket accents, `.tile` has a diagonal corner-cut.
- `.dash-title` — gradient text with a one-shot boot-flicker animation.
- `.bento` — the grid system index.html and every `hub-*.html` already use.

**Color semantics already established, not invented here:** `--warning` (amber `#FFB84D`) and `--danger` (red `#FF5470`) already exist and are already used this way. Amber-as-gold is *also* already claimed as player.html's "trophy card" accent (`--pc-gold:#E8C87A`) — the plan below keeps amber strictly for warnings/insight-callouts and does not reuse gold, to avoid a third meaning for the same hue family.

**Real constraints the plan must respect:**
- **`gym.html` and `po-water.html` don't use `design-system.css`** — they hand-roll their own `:root` block with *different variable names* for the same values (`--bg-card`/`--text-1`/`--accent` vs. the shared `--text-primary`/`--hud`). They are also the two largest, most-used pages. The Command Center itself doesn't need them migrated to ship v1, but any deep-linking of new shared components into them later requires a bridging pass first (Phase 2).
- **No `:focus-visible` anywhere in the codebase.** A keyboard-driven ⌘K command bar is unusable/inaccessible without this — it ships in Phase 0, not as a nice-to-have.
- **Reduced-motion allowlist is narrow** (5 selectors today) — every new animated element must be added to it explicitly.
- **The project has already, deliberately, rejected "demo reel" visual noise once** (design-system.css's own header comment: *"a HUD you can't comfortably read at 7am is a bad HUD"*). This spec treats that as a hard constraint, not a suggestion — see §4.

---

## 2. Proposed information architecture

`index.html` is already the true homepage (a bento hub-of-hubs: Today Score + Player Card strip + 5 tiles to `hub-today/hub-body/hub-money/hub-reflect/hub-insights`). The Command Center **replaces what's above the fold on `index.html`**, not a new page, and keeps the existing 5-hub navigation reachable directly below it (renamed "Browse" section) so nothing that exists today is lost or hidden more than one scroll away.

```
index.html (Command Center)
├── Header: greeting + system status + Focus Mode toggle + ⌘K trigger
├── AI Core (hud-ring, center) — today's composite score (reused computeTodayScore) + state
├── Recommended Next Action — ONE card, reusing/unifying:
│     · main.html's Daily Leverage Task (leverage_stats_v1)
│     · hub-today.html's nextUpPick()
│     · insights-patterns.html's computeBottleneck()
├── Schedule strip — today's timed goals + Google Calendar events (already fetched by hub-today.html's pattern)
├── Signals row — compact stat chips: recovery/sleep, water, net worth trend, streak (reused, not recomputed)
├── Proactive Insight — one short "why" sentence, sourced from existing insight functions (peak.html correlations, insights-drift.html, insights-recovery.html burnout risk) — text only in v1, no new inference engine
├── Alerts panel — ranked list, v1 = simple threshold rules over EXISTING data (low water, subscription renewal soon, overdue bill, elevated burnout risk) — each alert links to the relevant existing page
├── Recent Activity — v1 = last-changed timestamps already present in existing localStorage objects, rendered as a feed (NOT a new undo system — see §7 Phase 3)
├── Browse — the existing 5-tile bento grid, unchanged, just relocated below the fold
└── Footer: Focus Mode / Ambient Mode entry points (stubs in v1, real in later phases)
```

**Systems this issue designs the *foundation* for but does not build now** (§7 has the phased sequence): AI Daily Brief, Life Timeline, Prediction Center, Correlation Lab, Scenario Simulator, Automation Builder, a real Decision/Alert Center (persisted + dismissible), a real Activity/Trust Center (actual undo), Ambient full-screen mode.

**Open decision for Fernando (not decided unilaterally here):** whether `topbar.js`'s hardcoded bottom-tab-bar (Main/Health/Fitness) should gain a 4th "Focus" tab once Focus Mode ships, or stay 3 tabs with Focus reachable only from the Command Center header. Flagged, not resolved, in this plan.

---

## 3. Page-level wireframe — Command Center (`index.html`)

```
┌──────────────────────────────────────────────────────────────────┐
│  Good evening, Fernando          [●online]     [⌘K]   [Focus]     │  ← header, ~56px
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│              ╭───────────────╮      RECOMMENDED NEXT ACTION       │
│             ╱   hud-ring      ╲     ┌────────────────────────┐    │
│            │   82   TODAY      │    │ Finish the Q3 deck      │    │
│             ╲   score          ╱     │ Leverage pick · builds  │    │
│              ╰───────────────╯      │ momentum · [Mark done]  │    │
│                                      └────────────────────────┘    │
├──────────────────────────────────────────────────────────────────┤
│  SCHEDULE                                                          │
│  ● 9:00  Standup            ● 14:00  Dentist        ● 18:00 Gym    │
├──────────────────────────────────────────────────────────────────┤
│  SIGNALS                                                            │
│  [Recovery 71%] [Water 4/8] [Net worth ▲2.1%/mo] [Streak 12d]      │
├──────────────────────────────────────────────────────────────────┤
│  ⚡ Sleep debt is trending up 3 nights running — tonight matters.   │  ← proactive insight, 1 line
├──────────────────────────────────────────────────────────────────┤
│  ALERTS (2)                          │  RECENT ACTIVITY            │
│  ▲ Netflix renews in 2 days           │  · Logged 2 water bottles   │
│  ▲ Weekly spend $260 (target $250)    │  · Marked "Gym" done        │
├──────────────────────────────────────────────────────────────────┤
│  BROWSE                                                            │
│  [🏠 Today] [⚡ Body] [💰 Money] [🪞 Reflect] [🧭 Insights]         │  ← existing bento, unchanged
└──────────────────────────────────────────────────────────────────┘
```

Mobile (≤480px, matching the app's existing single-column tier): header collapses to greeting + icons only, AI core shrinks to a smaller ring above (not beside) the Next Action card, Schedule/Signals become horizontally-scrollable chip rows (same pattern gym.html already uses for its exercise pills), Alerts/Recent Activity stack instead of sitting side-by-side, Browse bento drops to the existing 2-column/1-column tiers unchanged.

---

## 4. Color, typography, spacing, panel, icon, animation specs

**Color — extends, does not replace, the existing token set:**
- Primary intelligence color: `--hud` (`#22D3F5`), unchanged.
- Warning: `--warning` (`#FFB84D`, existing) — subscription renewals, elevated burnout risk, approaching budget limits.
- Critical: `--danger` (`#FF5470`, existing) — reserved for genuinely urgent alerts only (overdue bill, missed critical deadline), per the user's own stated constraint. Not used decoratively.
- Success/positive trend: `--success` (`#3FE0A8`, existing).
- No new hues introduced. Amber is not reused as "gold" (that stays player.html-only).

**New tokens to add (Phase 0, additive — nothing existing is renamed):**
```css
/* spacing scale */
--space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
--space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;
/* radius scale */
--radius-sm: 10px; --radius-md: 14px; --radius-lg: 20px; --radius-full: 999px;
/* elevation */
--shadow-sm: 0 4px 12px rgba(0,0,0,0.25);
--shadow-md: 0 8px 24px rgba(0,0,0,0.35);
--shadow-glow: 0 0 24px var(--hud-glow);
/* z-index scale (documents, doesn't change, the existing magic numbers) */
--z-topbar: 40; --z-command-bar: 100; --z-modal: 120; --z-lock: 2147483647;
```

**Typography:** unchanged font stacks (`--font`/`--font-mono`). Command Center introduces one new scale step for the hero score number (`clamp(48px, 8vw, 72px)`, `--font-mono`, matching the existing large-numeric-readout pattern already used by `.gm-progress-num` at 36-56px elsewhere) — not a new typeface.

**Panels:** reuse `.gm-card`/`.tile` corner-bracket treatment exactly as-is for every new panel (Next Action, Schedule, Signals, Alerts, Recent Activity) — no new panel chrome invented.

**Icons:** continue the existing emoji-as-icon convention already used throughout (·01 🏠, ⚡, 💰, 🪞, 🧭) rather than introducing an icon font/SVG sprite system — keeps zero new asset dependencies.

**Animation — all GPU-cheap (`transform`/`opacity` only), all added to the reduced-motion allowlist:**
- AI Core: reuses `.hud-ring`'s existing 22s rotation + a new subtle breathing pulse (`transform: scale`) at rest, slightly faster when an alert is unread — communicates state, not decoration.
- Alert entrance: slide+fade in, one-shot, ~200ms.
- Recent Activity feed: new items fade in at the top, no continuous animation.
- Schedule "now" marker: a `.hud-pulse-dot` reused verbatim on the current/next event.
- Explicitly **not** doing: particle systems, 3D orb, voice waveform, ambient audio, continuous glow sweeps on static content — all rejected as exactly the "demo reel" noise this codebase has already deliberately avoided once.

---

## 5. Desktop and mobile behavior

- **Desktop (≥768px):** the wireframe in §3 as a single-column vertical stack of full-width panels (matching how hub-today.html's Mission Control strip already lays out), max content width capped (~960px, centered) so it doesn't stretch illegibly on ultrawide monitors — this is new; no existing page currently caps width, worth flagging as a deliberate departure.
- **Tablet (720-768px):** Signals/Alerts/Recent-Activity rows that are side-by-side on desktop stack to full-width, matching the existing `.bento` 2-column tier's own breakpoint.
- **Mobile (≤480px):** per §3. Bottom tab bar (topbar.js) stays exactly as-is (Main/Health/Fitness) in Phase 1; `body` padding-bottom already reserves space for it (`.has-bottombar`), so the Command Center's own bottom content needs no new spacing logic.
- **Focus Mode:** a full-screen overlay (new, similar z-index tier to existing modals) that hides the topbar/bottombar/Browse grid and shows only: current objective, a timer, directly-relevant info (e.g. the exercise if it's a gym task), and a minimal AI-core status dot. Exits via an explicit close control and `Escape`.
- **⌘K Command Bar:** desktop keyboard shortcut `⌘K`/`Ctrl+K`; mobile equivalent is a persistent search icon (topbar.js already has icon-button real estate next to the water pill) since there's no keyboard to bind to. Opens as a centered overlay on desktop, full-screen on mobile — this is a deliberate exception to "modals lock body scroll" (design-system.css's existing `.topbar-modal-open` MutationObserver pattern already covers this for free, since the command bar will use the same `.modal-bg`-style class it watches for).

---

## 6. Component and file-level implementation plan

**New files:**
| File | Purpose |
|---|---|
| `command-center.css` | Command-Center-only layout/components (hero, Next Action card, Alerts/Activity panels) — kept separate from `design-system.css` so homepage-only CSS doesn't bloat every other page's payload. |
| `command-bar.js` | ⌘K overlay: open/close, keyboard nav, result rendering. Self-injecting like `topbar.js`, included via a `<script defer>` tag. |
| `search-index.js` | Extracted from `search.html`'s existing `normalizeNotes/normalizeTodos/normalizeReading/normalizeFinance/normalizeBusiness/buildSearchIndex/searchIndex` — shared by both `search.html` (refactored to use it, zero behavior change) and `command-bar.js` (which needs the same index but can't assume `search.html` is loaded). This is a genuine shared-runtime extraction, not test-mirroring. |
| `next-action.js` | Pure-logic module that ranks the single "recommended next action" by reading (not rewriting) `leverage_stats_v1`-driven picks, `hub-today.html`'s `nextUpPick` logic, and `insights-patterns.html`'s `computeBottleneck` — v1 is a simple priority order (overdue timed item → today's Leverage pick → nextUp fallback), not new ML/scoring. |
| `tests/test_command_bar_index.mjs`, `tests/test_next_action.mjs`, `tests/test_search_index.mjs` | Following the existing pure-function-duplication convention. |

**Modified files:**
| File | Change |
|---|---|
| `index.html` | Replace above-the-fold content with the Command Center; existing 5-tile bento + Player Card strip relocated to a "Browse" section, not deleted. `computeTodayScore` reused unchanged. |
| `topbar.js` | Add the ⌘K trigger icon button next to the existing water/finance icons; include `command-bar.js`. No change to the bottom tab bar in Phase 1 (see open decision, §2). |
| `design-system.css` | Add the token scales from §4, expand the `prefers-reduced-motion` allowlist to cover new Command Center animations, add real `:focus-visible` rules dashboard-wide (this fixes a pre-existing gap, benefits every page, not just the Command Center). |
| `search.html` | Refactor to `import`-equivalent (via `<script src="search-index.js">`) instead of its own inline copy of the normalize/search functions — behavior-preserving, existing `tests/test_dashboard_search.mjs` must still pass unmodified against the extracted version. |

**Untouched, by design:** `sync.js`, `lock.js`, every `appKey`/`syncedKeys` list, every existing page not listed above, `gym.html`/`po-water.html`'s own token scheme (bridged, not migrated, until Phase 2).

---

## 7. Phased roadmap

**Phase 0 — Foundation (no visible change to any existing page).**
Token scales, `:focus-visible`, expanded reduced-motion allowlist, extract `search-index.js` from `search.html` with zero behavior change. Ships and merges independently; unblocks everything else with near-zero risk. *Estimated review surface: `design-system.css`, `search.html`, 1-2 new test files.*

**Phase 1 — Command Center v1 (this issue's primary deliverable).**
`index.html` redesign per §2-6, `command-bar.js` v1 scoped to `index.html` + the 5 `hub-*.html` pages only (not site-wide yet), Recommended Next Action v1 (rule-based, reads existing systems, doesn't replace them), Alerts v1 (fixed threshold rules, no persistence/dismissal yet — recomputed fresh each load), Recent Activity v1 (read-only feed of existing timestamped data, not a new undo system), Focus Mode v1. **Coordinate with task #90** ("Research + rework Daily Leverage Task") before or alongside this phase, since Recommended Next Action directly builds on `leverage_stats_v1` — reworking that system separately and unifying it here at the same time risks two agents fighting over the same file; recommend folding #90 into this phase's scope rather than sequencing it separately.

**Phase 2 — Rollout and unification.**
Command Bar expanded to every page via `topbar.js`. `gym.html`/`po-water.html` migrated onto `design-system.css` tokens (bridging aliases first, then true migration, verified via visual diff — reuses this project's existing Playwright-screenshot spot-check pattern). Day/night interface states (time-of-day-driven theme shift, reusing existing `tzNow()`-style conventions already established in `api/telegram-webhook.js` and mirrored client-side). Alerts gain persistence/dismissal (new small `app_state` row, following the exact `sync.js` merge-on-push pattern — no new architecture invented).

**Phase 3 — Advanced systems, each its own scoped follow-up issue, roughly in this order:**
1. **AI Daily Brief** — morning/evening text summary, built from data the Command Center already surfaces; lowest-risk of the advanced systems.
2. **Life Timeline** — new page aggregating existing per-domain timestamped events (workouts, purchases, meals, notes, mood) into one feed; read-only, no new write paths.
3. **Prediction Center** — consolidates existing forecasting functions (`gym.html`'s weight trajectory, `finance.html`'s net-worth/debt projections, `insights-recovery.html`'s sleep debt/burnout risk) into one page with confidence framing; new UI over existing math, not new math.
4. **Correlation Lab** — extracts the currently-5x-duplicated `buildDayRows` pattern across the Insights pages into one shared module, generalizes `peak.html`'s fixed correlation pairs into a small picker.
5. **Decision/Alert Center v2** — the real, persisted, ranked inbox (builds on Phase 2's alert persistence).
6. **System Activity/Trust Center** — a genuine dashboard-side action-history + undo. This is real new engineering (nothing like it exists on the dashboard side today — only the Telegram bot has one, and PR #142's version has known race conditions that must not be copied here) — needs its own dedicated design pass, not a quick add-on.
7. **Scenario Simulator** — interactive what-if UI over the Prediction Center's existing math.
8. **Automation Builder** — the largest, riskiest new system (a rules engine touching write paths across every domain); needs its own dedicated spec and almost certainly its own confirm/cancel-style safety rails, drawing lessons from the Telegram bot's confirmation-gate work.
9. **Ambient Display Mode** — full-screen kiosk view; mostly a new CSS layout over already-existing data, lowest engineering risk of the remaining items but sequenced last since it depends on the Command Center's visual language being stable first.

---

## 8. Risks, dependencies, acceptance criteria

**Risks:**
- `gym.html`/`po-water.html`'s divergent CSS tokens mean the Command Center must not deep-style-link into them before Phase 2 — mitigated by keeping Phase 1 navigation plain.
- `health` app_state row is shared between `health.html` and `po-water.html` — any new Signal/Alert reading water data must read it exactly as both existing pages already do, not invent a new key.
- Task #90 (Daily Leverage Task rework) overlaps with Recommended Next Action — see Phase 1 coordination note above.
- New Command Bar fetching ~13 domains' worth of `app_state` data (like `search.html` already does for 5) must use the existing `sync.js`-mirrored localStorage rather than always re-fetching from Supabase, to avoid new latency/cost on every ⌘K open.
- Any new persisted row (Alerts in Phase 2, Activity/Trust Center in Phase 3) must follow `sync.js`'s existing merge-on-push pattern (fixed for the water-sync race earlier this project) — not a naive full-row overwrite.
- GPU cost: all new animation is `transform`/`opacity`-only, added to the reduced-motion allowlist — no exceptions.

**Dependencies:** Phase 1 depends on Phase 0 merging first (token scales, focus-visible, extracted search index). Phase 2's Command Bar rollout depends on Phase 1's `command-bar.js` shipping and being stable. Phase 3 items depend on Phase 1/2 being live and the visual language proven, plus (item 6) explicitly must not reuse PR #142's action-history/duplicate-update patterns without first fixing the race conditions flagged in that review.

**Measurable acceptance criteria:**
- Zero renamed `localStorage`/Supabase keys (verified by diffing key names referenced before/after).
- All existing tests (62+ files) pass unmodified; new pure-logic modules ship with their own `test_*.mjs` following the established duplication convention.
- Command Center renders fully using only *existing* data — no blank/broken state for a user with zero new data entered.
- Every interactive element reachable from the Command Center has a visible `:focus-visible` state; ⌘K fully operable by keyboard alone (open, navigate, select, `Escape` to close).
- `prefers-reduced-motion: reduce` disables every newly-added animation.
- No horizontal scroll and full legibility at 375px width; Focus Mode fully hides the bottom tab bar and topbar.
- The existing 5-tile bento navigation remains reachable (relocated, not removed) unless Fernando explicitly approves retiring it later.
- Existing pages outside `index.html`/`search.html`/`topbar.js`/`design-system.css` render pixel-identical to before (no cascade regressions from the new token additions), spot-checked via the existing Playwright-screenshot pattern.

---

## 9. Handoff to Codex

**Do not start on Phase 1 until Phase 0 is merged and green.** Suggested order:

1. `design-system.css` — add the token scales + `:focus-visible` rules + expanded reduced-motion allowlist from §4/§6. No visual regression expected; verify with a spot-check screenshot of 3-4 existing pages before/after.
2. Extract `search-index.js` from `search.html`; refactor `search.html` to use it. `tests/test_dashboard_search.mjs` must pass unmodified.
3. Add `tests/test_search_index.mjs` covering the extracted module directly.
4. Open a draft PR for Phase 0 alone (small, low-risk, easy to review in isolation) — branch `codex/command-center-foundation`.
5. Once Phase 0 merges: build `next-action.js` + `tests/test_next_action.mjs` (pure logic first, no UI yet) — coordinate scope with task #90 before writing this, per §7.
6. Build `command-bar.js` + `tests/test_command_bar_index.mjs`, scoped to `index.html` + the 5 hub pages only.
7. Build `command-center.css` + redesign `index.html` per §2-6, wiring in `next-action.js` and `command-bar.js`.
8. Update `topbar.js` to add the ⌘K trigger icon and include `command-bar.js`.
9. Open the Phase 1 PR — branch `codex/command-center-v1` — request Claude review per the standard workflow. Include before/after screenshots (desktop + 375px mobile) and confirm the acceptance criteria in §8 in the PR description's Validation section.

Each phase is its own PR. Do not combine Phase 0 and Phase 1 into one PR — Phase 0 touches shared files used by every page and should be reviewable/revertable independently of the homepage redesign.
