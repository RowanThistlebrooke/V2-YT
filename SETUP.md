# Dashboard — Setup Guide (fork → deploy in ~5 min)

This is a static dashboard (plain HTML/JS) that deploys on **Vercel** and syncs across your
devices with **Supabase**. WHOOP is an optional add-on.

**Shared styling** lives in one place: `design-system.css`, linked from every page's `<head>`
(`<link rel="stylesheet" href="design-system.css">`). It defines the color tokens, `.gm-card`/
`.tile`/`.bento`/button/input/modal classes, and the HUD visual theme (electric-cyan accents,
corner brackets, a fine instrument-panel grid) that most pages share — a page's own `<style>`
block should only contain CSS genuinely specific to that page. `template.html` still shows the
class reference/cheat sheet for building a new page. A handful of older pages (`health.html`,
`gym.html`, `finance.html`, `po-water.html`, `nova-lite.html`, `avatar-lab.html`) predate this
and use their own self-contained theming rather than the shared file — not yet migrated.

---

## 1. Fork & deploy

1. **Fork** this repo to your GitHub.
2. Go to **vercel.com → Add New → Project → Import** your fork.
3. Framework Preset: **Other**. Root Directory: **`./`**. Build/output: leave blank (static).
4. **Deploy.** You'll get a URL like `https://your-app.vercel.app`.

The dashboard opens to a **password screen** — the default password is in
[`lock.js`](lock.js) (`var PASSWORD = "qwer"`). Change it to whatever you want.

---

## 2. Supabase (cross-device sync) — required for sync

Create a free project at **supabase.com**, then run **both** SQL blocks in
**SQL Editor → New query → Run**.

### SQL #1 — `app_state` (all dashboard sync)
```sql
create table if not exists public.app_state (
  key        text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- The browser uses the ANON key, so allow it to read/write:
alter table public.app_state enable row level security;
create policy "anon full access app_state"
  on public.app_state for all
  to anon using (true) with check (true);

-- Instant cross-device updates:
alter publication supabase_realtime add table public.app_state;
```

### SQL #2 — progress-photo sync (Storage bucket)
Progress photos upload to a Supabase **Storage** bucket called `progress-photos` (only the
image URLs sync through `app_state`). Skip this if you don't need photos to sync across devices.
```sql
insert into storage.buckets (id, name, public)
values ('progress-photos', 'progress-photos', true)
on conflict (id) do nothing;

create policy "anon manage progress-photos"
  on storage.objects for all
  to anon
  using (bucket_id = 'progress-photos')
  with check (bucket_id = 'progress-photos');
```

### Connect YOUR Supabase — pick ONE way
Supabase → **Project Settings → API**. Copy the **Project URL** and the **anon / publishable** key.

**Way A — Vercel env vars (easiest, no code edits):**
In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_ANON_KEY` | your anon / publishable key |

Redeploy. The app reads these automatically via `/api/config`.

**Way B — edit the files:**
Replace the old URL/key in these files:
- [`sync.js`](sync.js)
- [`topbar.js`](topbar.js)
- [`gym.html`](gym.html)

> ⚠️ Only the **anon** key (public) is used here. **Never** put the `service_role` key in code
> or in these env vars.

---

## 3. WHOOP (optional)

1. **developer.whoop.com** → create an app.
2. Set its **Redirect URI** to exactly: `https://your-app.vercel.app/api/whoop-callback`
   (use your real Vercel domain — add every domain you'll open the site from).
3. Put your app's **Client ID** in [`health.html`](health.html) (`const CLIENT_ID = '...'`),
   and add these in Vercel → **Settings → Environment Variables**, then redeploy:

| Variable | Value |
|---|---|
| `WHOOP_CLIENT_ID` | your WHOOP app's Client ID |
| `WHOOP_CLIENT_SECRET` | your WHOOP app's Client Secret (**secret**) |

4. Open the site at that exact domain → Health page → **Connect WHOOP**.

> The callback auto-detects the domain, so you do **not** need a `WHOOP_REDIRECT_URI` env var.

> **Recovery-adaptive gym suggestions:** with WHOOP connected, the Gym tab shows a heads-up banner
> on days your recovery score is in WHOOP's own "red zone" (below 33%) — a suggestion to trim
> volume/intensity, never an automatic change to your actual program. Without WHOOP connected, it
> falls back to last night's manually-logged sleep quality (2/5 or below, from Sleep — see step 17)
> as the signal instead — the same "poor sleep" threshold that already delays the Telegram gym reminder.

---

## 4. Apple Health (optional)

Apple doesn't have a public web API for HealthKit the way WHOOP does OAuth — there's no
"connect" flow a website can hook into, full stop. The workaround is an **iOS Shortcut**
that reads your Health data and pushes it here on a schedule.

1. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `APPLE_HEALTH_SECRET` | any long random string — this is your shared secret |
| `APPLE_HEALTH_TIMEZONE` | optional, IANA tz name, default `America/New_York` |

   Redeploy after adding it.

2. On your iPhone, open **Shortcuts** → **+** → build a new shortcut:
   - Add a **Get Health Sample** action (or several) for whichever metrics you want —
     Steps, Active Energy, Exercise Minutes, Stand Hours, Resting Heart Rate, Sleep
     Analysis, Weight. For each one, add **Calculate Statistics** (Sum for steps/energy/
     exercise/stand, Average or the latest value for HR/sleep/weight) to turn it into a
     single number.
   - Add a **Text** action and build JSON by hand, e.g.:
     ```
     {"steps": [Steps result], "activeEnergyKcal": [Energy result], "sleepHours": [Sleep result]}
     ```
     (only include the fields you actually wired up — all fields are optional)
   - Add **Get Contents of URL**:
     - URL: `https://your-app.vercel.app/api/apple-health-ingest`
     - Method: **POST**
     - Headers: `Authorization` → `Bearer <your APPLE_HEALTH_SECRET>`, `Content-Type` → `application/json`
     - Request Body: **JSON** → the Text action's output
3. Tap the shortcut once to test it, then check the **Health** page on the dashboard —
   a stat card should appear with whatever fields you sent.
4. Automate it: **Automation** tab → **+** → **Personal Automation** → **Time of Day**
   (pick a few times a day, e.g. morning/midday/night) → **Run Shortcut** → your shortcut
   → turn off "Ask Before Running" so it fires silently in the background.

> Each POST only needs to carry the fields that changed — a same-day resend merges into
> that day's record instead of overwriting it, so an evening run with just sleep data
> won't erase the steps a morning run already sent.

---

## 5. Google — Calendar / Gmail / Drive (optional)

One connection covers all three (today's Calendar events, unread Gmail, recent Drive files)
on the **Google** tile (Today hub). Same OAuth pattern as WHOOP above.

1. **console.cloud.google.com** → create a project (or use an existing one).
2. **APIs & Services → Library** → enable these three: **Google Calendar API**, **Gmail API**,
   **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → External → fill in the basics → add these
   scopes: `calendar.events`, `gmail.readonly`, `drive.metadata.readonly` → add **yourself**
   as a test user → save. Leave it in **Testing** status — publishing/verification isn't
   needed for personal use, but see the caveat below. (`calendar.events` rather than
   `calendar.readonly` — the Telegram assistant can create/reschedule/cancel real events, not
   just read them; see step 8 below.)
4. **APIs & Services → Credentials** → **Create Credentials → OAuth client ID** → type
   **Web application** → Authorized redirect URI: `https://your-app.vercel.app/api/google-callback`
   (use your real Vercel domain).
5. Put the **Client ID** in [`google.html`](google.html) (`const CLIENT_ID = '...'`), and add
   these in Vercel → **Settings → Environment Variables**, then redeploy:

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | your OAuth client's Client ID |
| `GOOGLE_CLIENT_SECRET` | your OAuth client's Client Secret (**secret**) |

6. Open the site at that exact domain → **Today** hub → **Google** tile → **Connect Google**.

> **Testing-mode caveat:** while the OAuth consent screen is in "Testing" status, Google
> expires the connection after about 7 days regardless of activity — you'll just need to
> tap **Connect Google** again when that happens. Submitting the app for Google's (free,
> lightweight) verification review removes this limit, but isn't required to use it.

---

## 6. Nova (AI mentor / gym coach) — optional

No setup or key in the repo. Each user **pastes their own Anthropic API key** on the
**Nova** tile; it's stored only in their browser and sent straight to Anthropic. Get a key at
console.anthropic.com.

The same saved key also powers two things on the **Review** tab: the existing "🧠 Generate
Insight" card, and a **"✍️ Draft a starting point"** button next to the What went well/What do you
want to change reflection fields. It drafts two rough first-person paragraphs from that period's
real cross-tab stats — explicitly a starting point to rewrite, not a finished reflection, and it
asks for confirmation before overwriting anything you've already written by hand. Nothing new to
configure — if Nova already works, this does too.

There's also a **Your Year** page (`year-review.html`, linked from the Reflect hub) — a rolling
365-days-back retrospective (not tied to the calendar year, so it's meaningful any day you open
it): gym sessions and longest workout streak, habit/to-do completion and longest habit streak,
pages read, average sleep, average Peak/energy score, net worth change, and business revenue,
each card computed straight from data the rest of the dashboard already tracks — nothing new to
log. It also has its own "🧠 Generate Year Summary" button using the same saved Nova key, cached
so you're not re-spending an API call every time you revisit.

---

## 7. Text reminders (optional)

`main.html`'s "Recurring Items" list (Gym, Water, Read, etc.), any one-off to-do you've given a
time via the Schedule/Calendar time field, untimed to-dos, and undone Daily Habits (the separate
habit tracker on Main) can all text you — each as its own **separate** message, right around its
own moment, rather than one bundled text listing everything undone at once. This runs entirely
server-side on a schedule — it doesn't need the dashboard open in a browser. It reuses your
existing Supabase `SUPABASE_URL`/`SUPABASE_ANON_KEY` from step 2, so nothing extra needed there.
Pick **one** of the delivery methods below — if you've set up the **Telegram Assistant** (step 8),
it's already covered and you can skip this whole section: Telegram is preferred automatically over
Twilio, which is preferred over the email gateway, whenever more than one happens to be configured.

**How the timing works:** each recurring item can have a time set in the Recurring Items form
(and a one-off to-do can have one via the Schedule/Calendar view). If it doesn't:
- a name containing `(PM)` or "evening" defaults to shortly before your `BEDTIME_LOCAL` (below);
- a name containing `(AM)` or "morning" defaults to 8:00am;
- anything else with no time and no AM/PM hint — a generic recurring item, an untimed to-do, an
  undone habit — defaults to 9:00am instead.

Whichever bucket it falls into, every item still gets its own text and its own tappable **✅ Done**
button — nothing gets merged into someone else's message. If several things are undone at once,
only **one** goes out per scheduler tick (~15 minutes) rather than all of them firing together —
otherwise several separate messages would still land in the same minute and read like one big
burst. The rest stay due and get sent on the next tick(s) instead, so multiple undone things drip
out one at a time over the following stretch of ticks rather than arriving all at once.

A small (±10 minute) deterministic jitter is applied per item per day, so reminders don't land
at the exact same robotic minute every day. If something's still undone once its time arrives,
it nags again every 90 minutes until you mark it done or until `BEDTIME_LOCAL` passes, after
which it goes quiet for the day rather than pinging you overnight.

**Gym reminders are pushed back after a bad night's sleep:** if last night's sleep log (Sleep
page, step 17) recorded a sleep quality of 2 or lower, any recurring item that looks like a gym/workout
reminder (matching "gym", "workout", or "lift" in its name) has its effective time delayed by 90
minutes that day. The idea is to not nag you to hit the gym at your usual time when you're
clearly running on too little sleep — everything else on your list still reminds you at its
normal time.

**Feeling/stress check-ins (Peak tab) work differently on purpose:** unlike everything else
above, these are meant to happen several times a day, so a single "done today" flag doesn't fit.
Instead, starting at 9am, you get a prompt roughly every 4 hours whenever there hasn't been an
actual logged check-in (spontaneous or via the assistant) in that window — logging one resets
the 4-hour clock immediately, and it goes quiet once `BEDTIME_LOCAL` passes, same as everything
else.

**A reactive low-energy nudge** checks every tick (from 8am on) whether your energy is actually
dipping *right now* and whether caffeine would still help — a simplified server-side version of
the same circadian/lunch-dip/sleep-pressure curve `caffeine.html` uses, fed your real caffeine log
so it knows how much is already active in your system. It only fires when energy reads below the
"Dip" band, less than 30mg of caffeine is currently active (so there's real room for it to help),
you haven't logged caffeine or nicotine in the last 90 minutes, and it hasn't already nudged you
in the last 2 hours — tuned to avoid nagging you every 15-minute tick during a genuine multi-hour
slump. The message just suggests coffee/tea or a Zyn, whichever's your speed; it doesn't try to
guess which one you'd prefer.

**Two more auto-detectable recurring items:** `food` (a meal logged today via Health's calorie
tracker) and `weight` (a weigh-in logged today via Gym's weight tracker) — same self-completing
behavior as gym/reading/water/etc., so "Log a meal" and "Log weight" recurring items (seeded by
default on a fresh install) check themselves off instead of needing a manual tap. If you already
had a `recur:defs` list before this was added, add these two yourself from the Recurring Items
form's auto-check dropdown (or ask the Telegram assistant to add them — see step 8) since code
changes don't retroactively touch a list you've already saved.

**Subscription renewals (Finance tab) work differently too:** rather than a daily nag, you get a
one-time heads-up 3 days before each subscription's renewal date (and again isn't sent for that
same renewal once it's fired — the next one only fires ahead of the *following* cycle). Covers
every subscription with a renewal date set, whether or not it's linked to an account for
auto-deduct — a heads-up is still useful even for ones that charge automatically.

**A daily morning briefing** goes out once a day at `MORNING_BRIEFING_TIME` (24h `HH:MM`,
default `07:00`) — a single message listing everything scheduled today and still undone
(recurring items plus any timed one-off to-dos), last night's logged sleep quality if you've
been logging it on the Sleep page, and a nod to any subscription renewals coming up soon.
It's a one-shot per day (unlike the individual item reminders above, which repeat), so it won't send twice.

It can also add a 💡 line acting on a real pattern in your own history — e.g. "your sleep tends
to suffer after caffeine at/past 2pm, worth cutting it off early today" or "you tend to feel
better on workout days, worth fitting one in today" — the same caffeine/sleep and gym/mood
correlations Peak's Insights tab already surfaces, just turned into a same-day nudge instead of
a passive readout. Needs nothing extra to set up (same Peak/Caffeine/Gym data already synced);
it only shows up once there's at least 5 days of history on both sides of the comparison, and
picks at most one line so it doesn't turn into a stats dump.

It can also add a 🌊 line when Insights' drift detection fires — the last 14 days have slipped
from your last couple months' baseline across at least two of workouts/habits/to-dos/sleep
quality. Same data, no extra setup; computed inline during the same briefing check, no additional
Supabase reads.

**A separate "haven't heard from you" nudge** fires once nothing in the dashboard has changed for
`INACTIVITY_NUDGE_DAYS` days (default 3) — a quiet "no pressure, just checking in" message, not a
guilt trip. It looks across every synced domain, not just to-dos, so it stays accurate without
listing them out by hand. Repeats at most once every `INACTIVITY_NUDGE_DAYS` days while the
silence continues, rather than nagging every tick once triggered. Nothing to configure beyond the
optional env var.

**Option A — free, via your carrier's email-to-SMS gateway (recommended to start if you're not using Telegram):**

Every US carrier lets you "text" a phone by emailing a special address. A free service called
**Resend** sends that email on a schedule — no phone number to buy, no card required.

1. **resend.com** → sign up (email/password or GitHub, no card needed for the free tier) →
   **API Keys** → create one → copy it.
2. Find your phone's gateway address — `<your 10-digit number>@<carrier domain>`:

| Carrier | Domain |
|---|---|
| Verizon | `vtext.com` |
| T-Mobile | `tmomail.net` |
| AT&T | `txt.att.net` |
| Google Fi | `msg.fi.google.com` |
| Cricket | `sms.cricketwireless.net` |
| Boost Mobile | `sms.myboostmobile.com` |
| Metro by T-Mobile | `mymetropcs.com` |
| US Cellular | `email.uscc.net` |
| Visible | `vtext.com` |

   e.g. Verizon number `5551234567` → `5551234567@vtext.com`

3. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | from resend.com |
| `SMS_GATEWAY_TO` | your gateway address from step 2, e.g. `5551234567@vtext.com` |
| `REMINDER_TIMEZONE` | your IANA timezone, e.g. `America/New_York` (default if unset) |
| `BEDTIME_LOCAL` | 24h `HH:MM`, e.g. `23:00` (default if unset) — the cutoff for nagging, and the anchor for `(PM)`/evening items with no explicit time |
| `INACTIVITY_NUDGE_DAYS` | optional, default `3` — how many quiet days trigger the "haven't heard from you" nudge, and how often it repeats while the silence continues |
| `CRON_SECRET` | any random string — **strongly recommended**, see below |

> Carrier gateways aren't as instant or reliable as real SMS — texts can occasionally arrive
> late or not at all. If that becomes annoying, Option B below is the fix.

**Option B — paid, via Twilio (more reliable):**

1. **twilio.com** → sign up → buy a phone number (~$1/mo; texts cost fractions of a cent each).
   From the Console **Dashboard**, copy your **Account SID** and **Auth Token**.
2. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | from the Twilio console |
| `TWILIO_AUTH_TOKEN` | from the Twilio console (**secret**) |
| `TWILIO_FROM_NUMBER` | the Twilio number you bought, e.g. `+15551234567` |
| `TWILIO_TO_NUMBER` | your real phone, e.g. `+15559876543` |
| `REMINDER_TIMEZONE` / `BEDTIME_LOCAL` / `CRON_SECRET` | same as Option A above |

**Either way:**

3. Redeploy after adding the env vars above.
4. Scheduling runs on **GitHub Actions**, not Vercel Cron — see
   [`.github/workflows/reminders.yml`](.github/workflows/reminders.yml). Vercel's free Hobby
   plan only allows cron schedules that fire once a day each, which can't do this; a scheduled
   GitHub Actions workflow on a public repo is free at any frequency, so that's what pings
   `/api/send-reminders` every 15 minutes instead ([`vercel.json`](vercel.json) is intentionally
   empty). To turn it on:
   - Repo → **Settings → Secrets and variables → Actions → New repository secret** → name it
     `CRON_SECRET`, value = the **same** random string you set as the `CRON_SECRET` env var in
     Vercel (step 3 above). This is what lets the workflow call your endpoint without exposing
     it publicly.
   - That's it — the workflow is already scheduled every 15 minutes, roughly 6am-1am
     America/New_York during EDT (it skips a small 2am-6am dead zone overnight). It'll start
     firing on the next tick, or trigger it immediately yourself: repo → **Actions** tab →
     **Dashboard reminders** → **Run workflow**.
   - The function itself decides *whether anything's actually due right now* on every tick —
     each item's own scheduled time (explicit, bedtime-anchored, or the generic 9am default)
     is the real gate, not how often the workflow happens to ping the endpoint.

   > **Twice a year**, around DST changes (mid-March, early November), the workflow's fixed UTC
   > cron hours land an hour off from local time for about a week until manually nudged — ticks
   > just happen an hour later/earlier than intended for a few days rather than at the wrong
   > time entirely (15-minute granularity means it's a minor drift, not a missed day). If that
   > bothers you, edit the `cron:` line in `.github/workflows/reminders.yml` by ±1 hour.
5. Give your recurring items (Recurring Items panel, Main tab) and any one-off to-dos you want
   reminders for (Schedule/Calendar time field) a time — anything with no `CRON_SECRET` set is
   reachable by anyone who finds the URL, who could then spam your phone or burn through your
   quota, so set it.

---

## 8. Telegram Assistant (optional)

A two-way personal assistant, reachable from the regular Telegram app on your phone — not
just a one-way reminder text. It can see and act on essentially the whole dashboard (same
Supabase rows the dashboard itself reads/writes): to-dos, recurring items, daily habits, gym
(workout sets, exercises, cardio, stretch routines, body weight), water/supplements, finances
(net worth accounts, purchases, subscriptions, debts, orders, wishlist), side-hustle business
(affiliate commitments/revenue, editing clients/deliveries/payments), reading, Peak (morning
check-in — wake time/resting heart rate/sleep hours/sleep quality — and feeling/stress
check-ins, which it understands can happen several times a day rather than just once), the
food/calorie/macro log, caffeine and nicotine intake, and free-form notes. Ask it questions
about any of it, or tell it to log/change things directly — "log a $20 grocery run", "mark gym
done", "log 3 sets of bench at 135 for 8 reps", "cancel my Hulu subscription", "add $50 to
checking", "I finished chapter 3 of Atomic Habits", "good morning, slept 7.5 hours, sleep was a
4", "feeling a 3, stress at 4 right now", "track a Red Bull and a chicken burrito bowl", "note
that the landlord called about the lease" — names (exercises, clients, books, accounts, habits)
are matched loosely, so it doesn't need to be word-for-word. There's no hardcoded food/drink
database behind the calorie/caffeine/nicotine tools — the assistant estimates calories, macros,
and mg from its own general knowledge (the same way the dashboard's own AI photo-estimate
feature works), so you don't need to give it exact numbers for common items. It also takes over
the recurring-item reminder texts from step 7 above once configured, including the periodic
feeling-check-in prompts described there.

You can also just send a **photo** of food or a drink instead of typing it out — with or without
a caption — and it identifies what's in the photo and logs it the same estimate-from-general-
knowledge way. Add a caption if you want to steer the estimate (portion size, what's mixed in,
etc.); without one it just describes what it logged in its reply so you can correct it if the
guess is off.

You can also just send a **voice message** (the mic button in Telegram, not Siri) instead of
typing — it's transcribed via OpenAI's Whisper, then the transcript goes through the exact same
logic as if you'd typed it. The reply always starts with `🎤 "<what it heard>"` before the actual
answer, so a mishearing is immediately visible rather than silently acted on. Needs
`OPENAI_API_KEY` set on the server (same key as semantic note search below, if you set that up
too — one key covers both). Without it, voice messages get a clear "not configured" reply instead
of silently failing.

The Finance tab's currency pickers (net worth display, and every account/subscription/purchase/
order/wishlist/debt entry) now only offer **USD** (the default) and **DOP** — CHF/EUR/GBP were
removed as choices everywhere. Nothing about your already-saved data changed: every stored amount
is still converted through the same internal CHF-based exchange rate under the hood, so nothing
was recalculated or migrated. If you had something entered in CHF/EUR/GBP before this change,
editing it still shows and preserves its real original currency rather than silently relabeling
it to USD — you'd have to deliberately switch it yourself.

The Finance tab's **Debts** tab tracks loans/credit card balances separately from your net worth
accounts, with a payoff calculator (avalanche vs snowball, compares total interest and time to
debt-free for a given extra monthly payment). Add a debt from the tab directly or via chat
("add a car loan, $10k at 6% APR, $220 minimum"). Subscriptions also now flag **price creep** —
a badge shows up once a subscription's price has genuinely risen since you first started
tracking it, plus a running total of how much of your monthly subscription burn is drift rather
than the price you originally signed up for.

The Net Worth tab also has a **Forecast** card: it fits a trend line to your existing net-worth
history (the same data already behind the trend chart — no new setup needed) and projects
forward — a running "trending +$X/mo" readout, a milestone ("at this rate: $X by &lt;month&gt;"),
a custom goal amount you can type in for its own projected date, and a "what would spending this
cost my timeline" quick check for a hypothetical purchase. Needs a few days of real tracked
history before it has enough to fit a trend line — it says so plainly rather than guessing from
too little data.

Marking things done across the dashboard (to-dos, habits, gym days, stretch routines, logging
body weight) now also earns **XP** — a small toast pops up, levels climb on a steepening curve
(level 2 at 100 XP, level 5 at 1,500, level 10 at 5,500), and badges unlock for milestones (first
action logged, 100/500/1,000 total XP, 10/50 gym days, 25 habits/to-dos, reaching level 5/10,
etc.). It's a no-setup, always-on layer — nothing to configure, and it only fires on the
transition into "done," so unchecking and rechecking something can't farm XP. One honest
limitation: this state lives in `localStorage` only (not synced through Supabase like the rest of
the dashboard), so XP/levels/badges are currently per-device rather than shared between your
phone and laptop.

Marking gym day, a habit, or a stretch routine done tells you the current streak too (matching
the 🔥 counters already on the Main and Gym tabs) when it's more than a day or two — same
"today counts, or falls back to yesterday if today's not done yet" rule as those counters, so an
unlogged today doesn't look like a broken streak before the day's actually over.

If it logs something wrong — misheard a name, wrong amount, wrong exercise — just say "undo
that" or send `/undo`. It keeps the 20 most recent dashboard changes, so repeated undo requests
can step backward through more than one mistake. Each change has its own history record so two
messages arriving together cannot erase each other's undo entry. Before restoring a snapshot,
the bot verifies that the same dashboard section has not changed again; if it has, undo stops and
leaves the newer data untouched. `/recent` shows the latest 10 changes before you undo anything.
Google Calendar changes are external and are not part of this undo history.

Destructive actions do not run on Claude's judgment alone. Canceling a subscription or deleting
a real Google Calendar event first produces explicit **Confirm** and **Cancel** buttons; the
action only runs after Confirm is tapped, and each confirmation expires after 10 minutes and can
only be used once. The confirmation names the actual matched subscription or calendar event before
anything is removed. Telegram update IDs are claimed atomically and retained for seven days, so
even simultaneous webhook retries cannot accidentally log the same purchase, workout, meal, or
other change twice.

The bot has a small command menu for common zero-friction actions:

- `/today` — today's task, habit, water, and Google Calendar summary without an AI call
- `/recent` — the latest dashboard changes
- `/undo` — reverse the latest dashboard change
- `/status` — connection status, today's estimated Claude usage, and undo depth
- `/help` — examples and the command list

> Not covered: Avatar Lab and the weekly/monthly Review tab's reflection notes are local-feeling
> pages the assistant intentionally doesn't touch — the former has no synced data at all, and the
> latter's "what went well / what would you change" fields are meant to be a deliberate sit-down
> writing exercise rather than something to dash off in a text.

You can also ask it to set up new recurring reminders on the fly — e.g. "remind me to do a
morning check-in every day at 8am" — which adds a new entry to the Recurring Items panel
(Main tab) the same way filling out that form yourself would, without needing a redeploy.

For a **one-off** reminder on a specific day instead of something recurring — "remind me to
renew my passport in 3 months," "remind me to call the dentist next Tuesday at 2pm" — it adds a
to-do to that day's Schedule/Calendar entry directly (same as picking that date in the Calendar
tab and typing it in yourself), and it'll get reminded on its own once that day arrives.

Every individual item reminder (not the subscription heads-up or morning briefing, which are their
own separate summaries — just the "your time is up for this one thing" nudges) comes with a tappable
**✅ Done** button, so you don't have to type anything back to mark it done — one tap, and the
message updates in place to confirm it. It's exactly equivalent to texting "mark X done" — same
fuzzy name matching, same materialization of a not-yet-opened-today recurring item — just without
having to type.

Calendar/Gmail/Drive (step 5) can be included too — see the separate **"Connect Google to the
assistant"** steps further down, after the core setup below.

1. In the Telegram app, message **@BotFather** → `/newbot` → give it a name, then a
   username ending in `bot` (must be unique). It replies with a **bot token** —
   `123456789:AAExampleTokenStringHere`. Treat this like a password.
2. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the token from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | any random string you make up (20+ characters) — locks the webhook so only real Telegram requests get through |
| `ANTHROPIC_API_KEY` | an Anthropic API key (**console.anthropic.com** → API Keys) — this runs server-side, separate from the key saved in Nova's browser `localStorage` |
| `OPENAI_API_KEY` | optional — only needed for voice messages (see below); same key as semantic note search if you set that up too |

3. Redeploy so those env vars take effect.
4. Visit `https://your-app.vercel.app/api/telegram-set-webhook?secret=<your TELEGRAM_WEBHOOK_SECRET>`
   once, in your own browser — this registers the webhook and the bot's command menu with
   Telegram. You should get back a small JSON blob with `"ok":true`,
   `"webhookRegistered":true`, and `"commandsRegistered":true`. Because the setup secret is in
   the URL, close that tab afterward and do not share or screenshot the URL.
5. Open a chat with your bot in Telegram (search its username) and send it any message. Since
   `TELEGRAM_CHAT_ID` isn't set yet, it'll reply with **your chat ID** instead of doing anything
   else — copy that number.
6. Back in Vercel env vars, add `TELEGRAM_CHAT_ID` = that number, and redeploy. From then on,
   the bot only responds to messages from that chat — anyone else who finds its username gets
   silently ignored.
7. Message it again — it should now actually respond, using your real dashboard data.

> Every write the assistant makes goes through the exact same Supabase rows and data shapes the
> dashboard's own pages use, so anything it logs shows up in the normal UI immediately (and vice
> versa) — there's no separate/shadow data store.

> **Memory:** the assistant remembers roughly your last 10 exchanges (its own Supabase row, not
> tied to any one device), so you can say "log another set of that" or ask a follow-up without
> repeating context. It doesn't remember indefinitely — very old messages roll off automatically
> once the limit is hit.

> **Checking off a recurring item (e.g. "mark Skin care done"):** works even if you haven't
> opened the Main tab yet today — the assistant matches it against the Recurring Items list
> directly rather than only searching today's already-generated to-do list.

> **Real sleep tracking instead of an estimate:** text it "going to bed" (or "heading to sleep",
> "night") right when you're about to fall asleep, and it marks the moment. The next time you
> text it anything that sounds like waking up — "good morning" alone is enough, no other details
> needed — it computes your actual sleep duration and wake time from the real elapsed time and
> logs them to the Sleep page's data (step 17), same as if you'd typed the numbers in yourself there.
> Mention resting heart rate or a sleep-quality rating in that same wake-up message and those get
> logged too. If you explicitly state a sleep-hours number yourself ("slept about 6"), that wins
> over the tracked time. Skipping `log_bedtime` entirely still works exactly like before — this is
> purely additive, not a requirement.

> **API cost tracking:** ask "how much have I spent on you this month" (or today, or all-time)
> and it'll answer from a running tally of every Anthropic call it's made — token counts in, an
> estimated USD cost out. The cost is only an ESTIMATE from configurable per-token prices
> (`ANTHROPIC_INPUT_PRICE_PER_MTOK` / `ANTHROPIC_OUTPUT_PRICE_PER_MTOK` env vars, default $3 / $15
> per million tokens), not a real invoice figure — Anthropic's actual pricing can change and this
> has no way to know that on its own, so update those env vars if it drifts. Check
> **console.anthropic.com**'s usage dashboard for the authoritative number.
>
> The assistant runs on **Claude Haiku** rather than a larger model, specifically because this
> whole loop is mostly structured tool-calling (pick the right tool, fill in the right fields)
> rather than deep reasoning — Haiku handles that well for a fraction of the cost. The
> $3/$15-per-MTok defaults above were originally calibrated for a pricier model; if you want the
> self-reported estimate to stay accurate, update those two env vars to Haiku's actual current
> rate from **anthropic.com/pricing**.
>
> It also uses **prompt caching**: the tool schema and instructions (a few thousand tokens, and
> identical on every single message) are marked as a cache breakpoint, so a call within a few
> minutes of the last one re-reads that part from cache at a steep discount instead of paying
> full price for it again. The usage tracker above accounts for this correctly — cache writes and
> cache reads are priced differently from a plain input token, not lumped in as if they were the
> same thing.

### Connect Google to the assistant (optional, needs step 5 done first)

Everything above works without this — the assistant just won't know about your Calendar,
Gmail, or Drive. Adding it is a bit more setup than the rest of this guide, on purpose: a
Google OAuth token is a real credential that can read your actual inbox/calendar, and it
deserves better protection than the public key every other piece of dashboard data syncs
through. So Google's tokens live in their **own** Supabase table, locked down so only this
server-side function — never the browser, never the public key baked into the site's JS — can
read it.

1. In the **Supabase SQL Editor**, run once:
   ```sql
   create table if not exists google_tokens (
     id int primary key default 1,
     access text, refresh text, expires bigint,
     updated_at timestamptz default now()
   );
   alter table google_tokens enable row level security;
   -- No policies added on purpose — this blocks the public anon key entirely.
   -- Only the service_role key (next step) can read or write this table.
   ```
2. In Supabase → **Settings → API**, copy the **`service_role`** secret key (different from
   the `anon`/`publishable` key `sync.js` already uses — this one must never be pasted into
   any HTML/JS file or exposed to a browser).
3. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` key from step 2 — **server-side only** |
| `GOOGLE_SYNC_SECRET` | any random string you make up — a basic gate on the token-sync endpoint (not what protects confidentiality; the table having no anon policies is what does that) |

4. Redeploy. From then on, every time `google.html` saves a token (initial connect or a
   background refresh), it also pushes a copy to `/api/google-token-sync`, which lands in the
   locked-down table above. Nothing to do on your end beyond having Google connected (step 5) —
   the next time you open `google.html`, or the assistant runs, it picks this up automatically.
5. Message the assistant something like "what's on my calendar today" to confirm it's working.
   If Google isn't connected yet, or the connection has lapsed, it'll say so rather than
   guessing — reconnect via `google.html` in that case.

> **Calendar write access:** the assistant can also create, reschedule, and cancel REAL events
> on your actual Google Calendar — "schedule a dentist appointment Tuesday at 2pm", "move my 3pm
> to 4pm", "cancel the dentist thing" — not just to-dos on the dashboard's own Schedule/Calendar
> view (that's what `add_todo` is for). This needs the `calendar.events` scope from step 5 above;
> if you connected Google before this was added, the stored token only has the old read-only
> grant — hit **Disconnect** then **Connect Google** again on the Google tile to re-grant it.
> Unlike everything else the assistant does, these writes hit a real external account directly,
> not the dashboard's own Supabase data — `undo_last_action` does not cover them, so a mistaken
> delete/reschedule has to be fixed by hand (or from Google Calendar itself).

The **Today** hub (`hub-today.html`) now leads with a computed "Mission Control" strip above the
link tiles — today's goal completion, your best active streak (habits or gym, whichever's
longer), a net worth figure with its trend direction, what's next on today's schedule, and an
energy/mood read (your latest feeling/stress check-in today, or last night's sleep quality if you
haven't checked in yet). No setup needed — it's built entirely from data the dashboard already
syncs. Net worth here always shows in USD — the app's one primary currency (DOP is the only other
option, on the Finance tab's own currency pickers) — with its own small live exchange-rate fetch
to convert your accounts' internal base units correctly, separate from the Finance tab's own rate
fetch.

---

## 9. Voice logging & location Shortcuts (optional)

A voice/automation front door onto the exact same assistant the Telegram bot uses —
`api/shortcuts-webhook.js` calls the identical `buildContext()`/`callClaude()` logic, so
anything you can text the bot, you can also say out loud or trigger by location. This adds
no new AI logic of its own; it's purely a different way in.

1. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `SHORTCUTS_WEBHOOK_SECRET` | any long random string — this is your shared secret |

   `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` are the same ones the Telegram
   assistant already needs — nothing new there if that's already set up. Redeploy after adding
   the secret.

2. **Voice logging Shortcut** — say anything out loud and have it logged, same as texting the
   bot:
   - On your iPhone, **Shortcuts** → **+** → build a new shortcut:
     - Add **Dictate Text** (or **Ask for Input** → Text, if you'd rather type when Siri
       misfires).
     - Add **Get Contents of URL**:
       - URL: `https://your-app.vercel.app/api/shortcuts-webhook`
       - Method: **POST**
       - Headers: `Authorization` → `Bearer <your SHORTCUTS_WEBHOOK_SECRET>`, `Content-Type` →
         `application/json`
       - Request Body: **JSON** → one field, `text` → the Dictate Text result
     - Add **Get Dictionary Value** → key `reply`, from the previous action's result.
     - Add **Speak Text** → the dictionary value, so Siri actually says the confirmation back
       to you.
   - Name it something Siri recognizes well (e.g. "Log it") and you're done — "Hey Siri, log
     it" → say what happened → hear it confirmed, hands-free.
3. **Location-triggered logging** (no interaction needed) — e.g. auto-logging that a workout
   started the moment you walk into the gym:
   - Build a second, simpler shortcut: just **Get Contents of URL** as above, but with a fixed
     `text` value instead of a dictation step — e.g. `"I just arrived at the gym, starting my
     workout"`. Skip the Speak Text step if you don't want it announcing itself.
   - **Automation** tab → **+** → **Personal Automation** → **Arrive** → pick the location →
     **Run Shortcut** → your shortcut → turn off "Ask Before Running" so it fires silently.
   - For something time-conditional (e.g. only log "heading to bed" if you get home after a
     certain hour), add an **If** action before the URL call: "Current Date" → "is after" →
     your cutoff time, wrapping the request inside the `If` block.
   - There's no fixed list of supported location triggers — it's genuinely just a sentence
     through the same assistant that already understands free-form logging, so anything it can
     already parse from a Telegram message works the same way here.

> Deliberately stateless: each Shortcut run is a one-off utterance, not a back-and-forth
> conversation, so it doesn't share the Telegram bot's own conversation memory. Two channels
> racing to update the same short-term memory at once wasn't worth the complexity for what's
> meant to be quick, one-line logging.

---

## 10. Semantic note search (optional)

Search **Notes** by meaning instead of exact words — "car trouble" finds a note that says
"the Civic's making a weird noise" even though no words match. Note *content* never leaves
localStorage/the normal sync row; `api/notes-embed.js` only ever sees a note's text
transiently to turn it into a vector, and the ranking math itself runs inside Postgres, not
this endpoint.

1. **Enable pgvector**: Supabase dashboard → **Database → Extensions** → search "vector" →
   enable it.
2. **SQL Editor → New query → Run**:
   ```sql
   create table if not exists public.note_embeddings (
     note_id    text primary key,
     embedding  vector(1536),
     updated_at timestamptz not null default now()
   );

   -- The browser calls the search/upsert endpoint using the ANON key, so allow it:
   alter table public.note_embeddings enable row level security;
   create policy "anon full access note_embeddings"
     on public.note_embeddings for all
     to anon using (true) with check (true);

   create or replace function match_notes(query_embedding vector(1536), match_count int default 20)
   returns table (note_id text, similarity float)
   language sql stable
   as $$
     select note_id, 1 - (embedding <=> query_embedding) as similarity
     from public.note_embeddings
     order by embedding <=> query_embedding
     limit match_count;
   $$;
   ```
3. Get an API key at **platform.openai.com** (embeddings cost about $0.02 per 1M tokens — your
   entire notes history is likely a fraction of a cent to embed, ongoing cost is negligible).
4. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `OPENAI_API_KEY` | your OpenAI key — server-side only |
| `NOTES_EMBED_SECRET` | any long random string — abuse-prevention only, same trade-off as `GOOGLE_SYNC_SECRET` (it's served to the browser, so it isn't a real secret; the point is stopping a stranger from running up your OpenAI bill, not protecting confidentiality) |

   Redeploy after adding both.
5. Open **Notes** — a **🧠 Semantic** button appears next to the search box (hidden entirely
   if the above isn't configured, so it never shows up broken). Every note you create or edit
   gets embedded automatically in the background as you type (debounced, fire-and-forget — a
   note always saves locally regardless of whether embedding succeeds). Type a query and hit
   **Semantic** to search by meaning instead of exact substring match; typing anything new in
   the search box afterward reverts to the normal live keyword filter.

> Notes that existed before you set this up won't have an embedding yet — open and re-save
> each one (even just a trivial edit) to backfill it, or start fresh; there's no bulk backfill
> button.

---

## 11. Bank auto-import via Plaid (optional)

Connect a real bank account and pull in transactions instead of typing every purchase by hand.
Same review-before-logging pattern as the Gmail-receipt scanner above — a synced transaction
shows up as a **suggestion** with "Add to Purchases" / "Dismiss" buttons; nothing hits your real
Purchases list or account balances until you confirm it. A bank feed can be miscategorized,
duplicated, or include a transfer between your own accounts, so this is deliberately not
automatic.

1. Sign up at **plaid.com/dashboard** (free to start). Plaid gates real bank connections behind
   their own review — you get **Sandbox** access immediately (fake test banks, real UI, good for
   building/trying the whole flow), but connecting an ACTUAL bank needs Plaid to approve
   **Production** access first, which is a separate request on their end, not something this app
   can skip around.
2. **SQL Editor → New query → Run** — this table holds the real bank credential (the Plaid
   access_token), so it's locked down the same way as `google_tokens`: no anon-key policies at
   all, only the service_role key (server-side only, never shipped to the browser) can touch it.
   ```sql
   create table if not exists public.plaid_items (
     id               int primary key default 1,
     access_token     text,
     item_id          text,
     institution_name text,
     cursor           text,
     updated_at       timestamptz default now()
   );
   alter table public.plaid_items enable row level security;
   -- No policies added on purpose — this blocks the anon key entirely.
   ```
3. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `PLAID_CLIENT_ID` | from your Plaid dashboard |
| `PLAID_SECRET` | your Sandbox (or Production, once approved) secret from the same page |
| `PLAID_ENV` | `sandbox` (default if unset), `development`, or `production` — match whichever secret you used above |
| `PLAID_SYNC_SECRET` | any random string — abuse-prevention only, same trade-off as `NOTES_EMBED_SECRET`/`GOOGLE_SYNC_SECRET` (served to the browser, so not a real secret; the point is stopping a stranger from spamming your Plaid account, not protecting confidentiality — the locked-down table above is what actually protects the real credential) |

   `SUPABASE_SERVICE_ROLE_KEY` is the same one from step 8 (Connect Google to the assistant) —
   nothing new there if you already set that up.
4. Redeploy, then open **Finance → Purchases** — a **🏦 Suggested from Bank** card appears
   (hidden entirely if the above isn't configured). Hit **Connect Bank**, which opens Plaid's own
   hosted Link widget — in Sandbox, use Plaid's test credentials (`user_good` / `pass_good` for
   most test institutions; Plaid's own docs list the full set). This app never sees or stores your
   actual bank login, only Plaid does.
5. Once connected, hit **🔄 Sync Bank** any time to pull in new transactions as suggestions.
   Syncing isn't automatic on a schedule in this version — you have to actually click it.

> Only transactions that are genuinely money leaving the account are suggested — refunds,
> deposits, and transfers between your own accounts are filtered out rather than mis-logged as
> purchases. Categories are a best-guess mapping from Plaid's own categorization, same "best
> guess if unclear" tone as the Gmail-receipt parser; recategorize after adding if it's off.

---

## 12. Voice journaling & AI reflection in Notes (optional)

Two more optional Notes features, both gated behind the same `NOTES_EMBED_SECRET` as semantic
search above — if that's already set up, these just need the API keys below and a redeploy,
nothing new to secure.

- **🎙️ Voice** — tap it in the note editor, speak as long as you want, tap again to stop. No
  length limit: it records in a continuous loop of ~55-second segments behind the scenes (each
  transcribed as it finishes, appended into the note live so you can see it capturing what you
  say as you talk), then does one pass at the end to rewrite the whole thing into clean prose in
  your own voice — fixing filler words and run-ons, not summarizing or changing what you said.
  Meant to make actually journaling regularly less friction than typing.
- **💭 Reflect** — on demand, never automatic. Tap it on any note and the assistant reads what
  you wrote plus real context from the rest of your dashboard (the same data the Telegram
  assistant sees — to-dos, gym, finances, health, etc.) and responds with a short, genuine
  reflection, not generic encouragement. It's deliberately not a therapist and won't diagnose —
  for anything that sounds like real crisis, it'll gently point toward a real person or a crisis
  line (988 in the US) alongside whatever else it says, without making that the whole response
  for an ordinary tough day.

1. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `OPENAI_API_KEY` | same key as semantic search (step 10) — powers the Whisper transcription |
| `ANTHROPIC_API_KEY` | same key as the Telegram Assistant (step 8) — powers both the writing polish and the reflection |

   `NOTES_EMBED_SECRET` is the same one from step 10 — nothing new there if that's set up.
   Redeploy after adding.
2. Open **Notes** → open (or start) any note — **🎙️ Voice** and **💭 Reflect** appear above the
   text box (hidden entirely if the above isn't configured). The mic button also hides itself on
   a browser without microphone/recording support.

> Note content for both of these is sent to OpenAI (for transcription) and/or Anthropic (for the
> polish/reflection) at the moment you use them — same trust model as the rest of this app's AI
> features (the Telegram assistant, the Gmail receipt scanner), not a new one.

A **Mood Trend** chart also appears above your notes list once you have at least 3 days with
detectable sentiment — no setup, no API calls, no cost. It's a plain local word-list heuristic
(entirely client-side) scoring each note's text, averaged per day and plotted as a line — good
enough to see whether journaling has trended up or down, not a clinical read. A note with no
sentiment-bearing words (a plain to-do list dropped into Notes) contributes nothing rather than
skewing the average toward "neutral".

---

## 13. Auto-fill audiobook runtime from a YouTube link (optional)

If you listen to audiobooks on YouTube, mark a book as an audiobook (step above), paste the
video's link in the **Link** field, and hit **🔗 Fetch length from YouTube** — it looks up the
real runtime instead of you finding and typing "14h 22m" by hand. It only fetches the *total*
length; how far you've actually listened stays a manual entry, same as before, since there's no
way to know that without watching alongside you.

1. Get a **YouTube Data API v3** key: **console.cloud.google.com** → create (or pick) a project →
   **APIs & Services → Library** → enable "YouTube Data API v3" → **Credentials** → **Create
   Credentials → API key**. Free tier is 10,000 units/day; this lookup costs 1 unit per call, so
   personal use never gets close.
2. In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `YOUTUBE_API_KEY` | the key from step 1 — server-side only |
| `YOUTUBE_LOOKUP_SECRET` | any random string — abuse-prevention only, same trade-off as `NOTES_EMBED_SECRET`/`PLAID_SYNC_SECRET` (served to the browser, so not a real secret; the point is stopping a stranger from burning your API quota) |

   Redeploy after adding.
3. On **Reading**, check **🎧 This is an audiobook** on any book, paste its YouTube link in
   **Link**, and hit **🔗 Fetch length from YouTube** (hidden entirely if the above isn't
   configured).

---

## 14. Data export / backup

No setup — works automatically once Supabase sync (step 2) is configured. On the main
dashboard page, tap the ⚙️ gear icon → **Backup → ⬇️ Export everything (JSON)** to download
every synced domain (todos, notes, finance, gym, reading, and the rest) as one file. It reads
directly from `app_state`, so it stays complete as new features add their own rows — nothing to
update here when they do. Login tokens (Google/WHOOP) aren't included since they're deliberately
unreadable this way (see `google_tokens`'s RLS policy in step 5) — reconnect those after a
restore rather than expecting them in the export.

---

## 15. Dashboard-wide search

No setup — works automatically once Supabase sync (step 2) is configured. Tap the 🔍 icon next
to the gear icon on the main page to open **search.html**, which searches across notes, to-dos
(recurring items, habits, and dated goals), reading, finance (purchases, subscriptions, wishlist,
orders), and business (clients, commitments) all at once — distinct from the notes-only semantic
search in step 10, this is plain keyword matching across everything, always available even
without `NOTES_EMBED_SECRET` configured. Reads fresh from Supabase on load (not just whatever's
cached in this browser's localStorage), so it's complete regardless of which pages you've
actually opened on this device.

---

## 16. Life Context (personal context for the assistant)

No setup — works automatically once Supabase sync (step 2) is configured. On the **Reflect**
hub, there's now a **🧠 Life Context** box: free-form text about anything ongoing you want the
Telegram Assistant and Notes' 💭 Reflect to just already know — relationships, current
situations, goals, preferences — instead of re-explaining it every conversation. It's synced
like everything else and gets passed to Claude as a `lifeContext` field alongside the rest of
your dashboard data.

Separately, both of those features already read your **recent notes** automatically — no setup
needed there either, and nothing changed about what you have to do. What did change: the raw
`notes:items` list used to be sent to Claude in full, on every single message, with no limit —
harmless at first, but a real, growing cost the more you journal (especially with voice
journaling, step 12, generating real text over time). It's now capped to your ~20 most recently
edited notes with long ones truncated, which is still plenty to pick up on what's actually been
on your mind lately without the per-message cost quietly climbing forever. `add_note` itself is
unaffected — it always reads/writes the real, complete notes list; only what gets shown to
Claude as background context is capped.

Third, and different from both of those: the Telegram Assistant can now **remember things on its
own**, across conversations, instead of only reading whatever's currently logged. When you tell
it something worth carrying forward — a plan, a preference, an ongoing situation — it can call a
`remember` tool to save a short note to its own memory, which then shows up in every future
conversation via an `assistantMemory` field, right alongside `lifeContext`. The difference:
`lifeContext` is what *you* write yourself; `assistantMemory` is what *it* picks up on
unprompted, the way a person's understanding of you builds up over time rather than needing
everything restated. If something remembered goes stale or turns out wrong, it can also call
`forget_memory` to remove it — just tell it "actually that's not true anymore" and it'll handle
the rest. Bounded to the 40 most recent entries (oldest dropped first) with each one capped to a
short observation, not a transcript, so this can't grow into the same unbounded cost problem the
notes cap above was fixed for. No setup — this is part of the Telegram Assistant (step 8).

---

## 17. Insights (optional-by-nature — needs history to say anything)

No setup — works automatically once Supabase sync (step 2) is configured, and once you've got
enough logged history for it to say anything real. Front page → **🧭 Insights** (its own tile,
not nested under Reflect) → 5 dedicated pages, each a focused view rather than one long stacked
scroll:

- **Patterns & Limiters** — generalizes the caffeine/sleep and gym/mood correlations already used
  in Peak's Insights tab and the morning briefing's 💡 line into a ranked comparison across
  several factors at once (sleep quality/hours, workouts, late caffeine, habit/to-do completion)
  against how you actually felt — same "two buckets, minimum 5 days each side, meaningful
  difference" statistical approach, just run over everything instead of a couple of hardcoded
  pairs. A hero callout names the single biggest limiter; below it, a diverging tornado chart
  ranks every factor that clears the bar, positive ones pushing right, negative ones pushing left.
- **Mode Breakdown** ("Alter Ego" system) passively classifies each logged day into one of four
  modes — no manual tagging, ever:
  - **Redline Mode** — poor sleep (2/5 or below) or high stress (4/5+): a day that called for
    easing off, checked first since it overrides everything else.
  - **Recovery Mode** — a logged workout day without also being Redline.
  - **Beast Mode** — high habit or to-do completion (80%+) with nothing rough going on.
  - **Steady Mode** — the default when nothing stands out either way.

  Shows your inferred mode right now, a donut of the last 60 logged days across all four, and a
  day-by-day calendar strip so WHEN each mode shows up is visible, not just the aggregate —
  days with zero real data logged are excluded rather than padding the Steady count.
- **Emotional Triggers** — maps day-ahead precursors instead of same-day correlations: does
  YESTERDAY's late caffeine, poor sleep, missed habits, etc. predict how TODAY actually feels?
  Reuses the exact same bucket-comparison engine as Patterns & Limiters, fed a day-shifted
  dataset, surfacing only the negative effects (positive same-day patterns already show up in
  Patterns). Shown as a radar of which factors hit hardest plus a day-of-week × time-of-day
  heatmap (built from Peak check-ins' real timestamps) so you can see when rough moments actually
  land, e.g. "Wednesdays around noon."
- **Drift Detection** — a longer-horizon companion to Burnout Risk: instead of "is this week worse
  than last week," it asks "have your own patterns quietly slipped from your own baseline" —
  comparing the last 14 days to the ~46 days before that across workouts, habit completion, to-do
  completion, and sleep quality, shown as small-multiple sparklines (one per metric, recent window
  shaded, baseline as a dashed reference), only calling it "drift" once a metric is down at least
  25% from baseline. The same check also runs server-side and, if it fires, adds a 🌊 line to the
  daily morning briefing/Telegram nudge — so a real slip surfaces proactively too.
- **Reality vs Plan** — a plain adherence check, distinct from everything above (those are about
  how you FELT; this is just about whether the plan actually happened): an overall adherence %
  (ring gauge) blending habit and to-do completion, a trend chart against your own prior-period
  average, a ranked bar list of which habits get skipped most, and a 90-day adherence heatmap.

A few more pieces used to live on this page and have since moved to where they fit better:

- **Recovery** (Night Score, Sleep Debt, Burnout Risk) moved to the **Body** hub, front page →
  **Body** → **🌙 Recovery** — it's a body/sleep gauge, not a correlation/pattern analysis like
  the rest of this page, so it made more sense sitting alongside Health/Water/Caffeine/Peak. Same
  three passively-derived gauges as before, nothing here requires logging anything new:
  - **Night Score** — the evening/night counterpart to the home screen's Today Score. Weighted
    composite of sleep hours vs. an 8-hour target, sleep quality, and whether caffeine was cut off
    before 2pm — shown as last night's score (ring gauge) plus a 7-night average. Same "leave a
    dimension out entirely rather than score it as a zero" principle as Today Score: the caffeine
    dimension only counts if you've logged caffeine at least once.
  - **Sleep Debt** — sums `(8 hours − actual sleep)` across your last 14 logged nights (from the
    Sleep page below), shown as a ring gauge, so you see the accumulated deficit rather than just
    one bad night. Needs at least 5 logged nights.
  - **Burnout Risk** — compares this week to last week across three signals (rising stress,
    falling sleep quality, slipping habit/to-do consistency), reported as Low/Moderate/Elevated
    plus this-week-vs-last-week comparison bars for each signal. Needs one comparable pair of
    weeks with overlapping data.
- **Weight Projection** moved into **Gym**'s Weight section as a **Trajectory** card — historical
  weigh-ins plus a Slow/Typical/Fast scenario fan (percentiles of your real week-to-week rate of
  change, not one brittle regression line) projected toward a goal weight you set right there.
  Needs at least 3 weigh-ins in the trailing 90 days.
- **Net Worth** projection moved into **Finance**'s existing Forecast card, gaining the same
  Slow/Typical/Fast scenario-fan chart alongside the goal amount + purchase-impact tools already
  there. Needs at least 3 net-worth snapshots in the trailing 180 days.

---

## 18. Daily Leverage Task

No setup — a ⭐ button on each to-do item in the main To Do List. Star one to mark it as today's
Leverage Task — "the one thing that matters most" today, distinct from the ⚡ queue button (which
is for a productivity-window queue, a different feature). Only one can be active per day — starring
a different item clears the previous pick automatically — and the marked task shows as a callout
above the list so it doesn't get lost among everything else. Syncs across devices the same way the
rest of your to-do list already does, since it's just a flag on the same goal object.

The callout now carries real feedback instead of just echoing the task text:

- **Clean/completion streak** — consecutive days you designated a leverage task AND finished it.
  Picking a different task doesn't break it; failing to finish one does, and so does a day with
  goals logged but no leverage task ever starred (the point is building the daily habit of
  picking one).
- **Follow-through rate** — completed ÷ designated, across your whole history.
- **A 7-day history strip** — a dot per recent day: green (done), dim red (starred but not
  finished), gray (never starred that day).
- **Nothing starred yet?** The callout still shows, prompting you to pick one instead of just
  disappearing.
- **Time-of-day urgency tint** — the callout stays neutral cyan early in the day, shifts amber
  once you're past ~40% of your waking hours with it still undone/unset, and red past ~75%,
  using the same wake/sleep hours as the day-progress ring elsewhere on this page.

This is computed once per day at rollover (the same moment yesterday's to-do list gets folded
into today's), not re-derived from raw history on every load, so it survives the fact that old
daily to-do lists themselves don't stick around.

---

## 19. Mistake / Risk Log

Reflect hub → **⚠️ Mistake Log**. Still a plain log at heart — what happened, what you learned, a
category (Financial/Health/Relationships/Work/Other), a severity (Minor/Moderate/Major) — but the
page now leads with three passively-computed sections above the log itself:

- **Clean Streak** — a ring showing days since your last Major-severity entry, with a
  none/low/moderate/elevated risk badge.
- **Where risk concentrates** — a ranked bar chart of entries by category, plus a Minor/Moderate/
  Major count breakdown.
- **Recurring Threads** — a word-frequency pass over your descriptions + lessons (stopwords
  filtered, each word counted at most once per entry so one long entry can't fake a pattern) that
  surfaces words showing up across two or more *separate* entries — a cheap way to notice "you
  keep writing about the same thing" without reading back through everything yourself.

Newest-first history list below still sorts and syncs like any other list on this dashboard.

---

## 20. Skill Stack Tracker

Reflect hub → **🏗️ Skill Stack**. Track any named skill you're deliberately building (a language,
an instrument, a tool, anything) with logged practice sessions, distinct from the dashboard's
existing global XP/level system (a single overall total across every action) — this is per-skill,
scoped to time you actually choose to log, with hour-based mastery staging:

- Novice (0h) → Beginner (10h+) → Intermediate (50h+) → Advanced (200h+) → Expert (1000h+)

The page now leads with a hero card for your most-practiced skill (a ring showing weekly-goal
progress, or mastery-stage progress if no goal is set), secondary cards for every other skill,
a practice-activity heatmap aggregating minutes across all skills, and a recent-sessions feed —
then the add-skill form and full manage list below. Skills can optionally carry a weekly-hour
goal, tracked against a rolling 7-day window, and each skill tracks its own current practice
streak (consecutive days practiced, ending today or yesterday).

---

## 21. Sleep

Front page → **Body** → **😴 Sleep**. Its own dedicated page for both halves of a night — going to
bed and waking up — rather than a couple of fields buried inside Peak's old morning check-in
(which this page fully replaces; Peak now just reads whatever's logged here for its energy curve,
the same way it already treats WHOOP as an optional override).

- **Wind-Down** — tap **🛌 Going to bed** to timestamp the moment (no need to remember a clock
  time), with an optional wind-down checklist (screens off, room cool, no late caffeine, wound
  down/read) and a free-text note.
- **Wake Up** — tap **☀️ I'm up** and, if you logged a bedtime, your sleep duration is computed
  automatically from the real elapsed time (capped at 16h so a forgotten wake-up doesn't log a
  bogus multi-day "sleep"). No bedtime logged? Enter a bedtime + wake clock time directly, or just
  type total hours slept — whichever's fastest. Also logs sleep quality (1-5), a groggy-to-sharp
  wake-feel scale, resting heart rate, and a wake-up note.
- **Recent Nights** — the last 10 logged nights at a glance (hours, quality, wake-feel, RHR), plus
  a link out to **Recovery** (Body hub) for the deeper trend analysis — Night Score, Sleep Debt,
  Burnout Risk — since that's an analysis page, not a logging one.
- The Telegram assistant's `log_bedtime`/`log_morning_checkin` tools write to this same data, so
  texting "going to bed" / "good morning" (see step 8 above) and using this page are two front ends
  onto one night's log, not two separate places sleep can live.
- **Wake-up Sleep Recap** — any wake-up signal to the bot ("good morning", "just woke up", a bare
  "I'm up") replies with a recap: duration, quality, and a Night Score using the exact same formula
  as Recovery's own gauge (so the number you get texted always matches what the dashboard would
  show for that night), a 7-night trend average and running sleep debt once there's enough history,
  and — if the score isn't already maxed — a one-line pointer at whichever factor (short on hours,
  low quality, or caffeine after 2pm) dragged it down the most. If neither hours nor quality end up
  logged for the night, there's nothing to score yet, so the bot just confirms normally instead.

No setup beyond Supabase sync (step 2) — this data syncs like everything else on the dashboard.

---

## 22. Player Card (overall rating & level)

Front page → the gold **Player Card** strip under your Today Score (also on the **Reflect** hub).
A FIFA/2K-style rating for you as a whole, built entirely from data the rest of the dashboard
already collects — nothing new to log, no setup beyond Supabase sync.

It deliberately splits into **two numbers that behave differently**:

**LEVEL / XP — your career progress. Only ever goes up.** Every real thing you've ever logged
earns XP: workouts (40), leverage tasks finished (20), work commitments (15), skill and reading
sessions (12), mistakes logged and nights slept (10), habit check-ins and days with food logged
(8), notes / days hydrated / days supplemented (6), weigh-ins and feeling check-ins (5). The level
curve is superlinear, so early levels come fast and later ones genuinely mean something. Because
it's a running total of work already done, it can never drop — a bad week costs you rating, not
progress. (To-dos are represented by the lifetime **Leverage Task** tally rather than raw
to-dos, because `main.html` deletes each past day's to-do list on rollover, so that history
genuinely isn't recoverable.)

**OVR + six attributes — your current form. Moves both ways.** A 1-99 rating over a rolling
30-day window, so it reflects how you're actually living right now:

| | Attribute | Built from |
|---|---|---|
| **PHY** | Physical | Training sessions vs ~4/week, plus how consistently you log food |
| **VIT** | Vitality | Sleep hours & quality (scaled by how much of the window you actually logged), water, supplements |
| **DIS** | Discipline | Habit check-in rate, plus how often you finish the Leverage Task you set |
| **HUS** | Hustle | Daily work commitments kept, plus days with income coming in |
| **WLT** | Wealth | Net worth trend over 90 days — a sustained +3%/mo (smoothed across every logged point, not just two snapshots) maxes it out, flat sits mid-table |
| **MND** | Mind | Reading days, skill practice, notes written, mistakes logged |

OVR is a weighted blend (Discipline and Physical 20 each, Vitality 18, Mind 16, Hustle 14, Wealth
12) and maps to a card tier: **Icon** 90+, **Elite** 85+, **World Class** 80+, **Quality** 72+,
**Solid** 62+, **Developing** 50+, **Rebuilding** below.

Wealth is deliberately the hardest attribute to max — it needs at least 3 logged net-worth
snapshots in the window and fits a trend line across all of them (the same regression
`finance.html`'s own Net Worth Forecast uses), rather than just comparing two points. A single
volatile day — a crypto swing, a one-time deposit — can't swing it to 99 on its own the way a raw
first-vs-last comparison would.

> **A domain you don't track is excluded from the rating entirely, not counted as a zero** — the
> same fairness rule the Today Score uses. So the card rates you on the things you actually do,
> and only starts counting a new area once you begin tracking it. The flip side is real: start
> tracking something you're currently bad at and your OVR will drop, because it's now measuring
> something true that it previously couldn't see.

Tap your name on the card to rename it. The page is read-only across every other domain — it owns
nothing but the display name and a small cached summary the home-screen strip reads, so it can't
corrupt anything another page writes.

---

## 23. Weekly / monthly grade

Front page → **Reflect** → **🪞 Review**, at the top of the Recap section. One letter — **A+
through F** — for the whole week or month, computed from the very same per-domain stats the recap
cards directly underneath it show, so the grade can never disagree with the numbers next to it.

Weighted across energy (15), habits (20), to-dos (15), training (20), supplements (10), water
(10) and work commitments (15), renormalized over whichever of those you actually track. Training
scales with period length, so 4 sessions is full marks in a week but a quarter of the mark across
a month. It shows the numeric score, the change vs the prior period, and calls out your weakest
tracked area — the actionable half of a grade. The letter is also handed to Nova when you generate
the period's insight, so its write-up knows how the period actually graded.

Same fairness rule as everywhere else: domains you don't track are left out rather than scored
zero, so a strong week at the one thing you track still grades well.

---

## 24. Rest timer — screen stays on + a notification when it ends

Front page → **Fitness** → **Gym**. Logging a set already starts a rest timer sized to that set
(rep range, compound vs isolation, how close it was to your best effort) with a countdown, a
progress bar, and a chime + vibration when it finishes. Two more things happen now, tap the 🔔 in
the rest timer to turn them on:

- **The screen stays on while resting** (the Screen Wake Lock API), so the countdown is actually
  glanceable instead of the phone auto-locking mid-rest.
- **A real system notification fires the moment rest ends** — "Rest's over 💪 · Next: <exercise>"
  — for whenever the screen dims anyway or you've switched to another app.

> **What this is NOT:** a live-updating countdown bubble on the *lock screen* itself, the way
> Apple Music's now-playing widget works. That's iOS's ActivityKit — a native-app-only API with no
> web equivalent, so no website (including one added to the Home Screen) can put a ticking timer
> on the lock screen. The wake lock + notification combo above is the closest a web app can
> actually get: the phone doesn't lock in the first place while you're resting, and if it does
> anyway, you get a real notification the second it's over.

Nothing to set up beyond tapping the bell once (it asks for notification permission right there,
a browser requirement) — the preference is saved per device, not synced, same as a permission
setting. If your browser has notifications blocked for this site already, the bell tells you to
fix that in your phone/browser settings rather than silently doing nothing.

**On iPhone, the bell only works from a Home Screen install.** iOS Safari doesn't expose
notifications at all to a regular browser tab — not just permission, the whole feature is absent.
Tap the bell in a normal Safari tab and it'll tell you to use the Share icon → **Add to Home
Screen**, then open the dashboard from that icon instead of the bookmark/tab. The bell stays
visible either way so the feature doesn't look like it's missing; it just explains itself the
first time it can't do anything yet.

---

## 25. Weekly Schedule

Front page → **Today** → **Weekly Schedule**, or **⌘K** → "Weekly Schedule". A real hourly
timetable (Mon–Sat by design — Sunday is intentionally outside the routine) built from one
versioned schedule model (`schedule-model.js`), seeded with the approved **Summer 2026** routine
(effective July 29 – August 31, 2026, `America/New_York`). Desktop shows all six days as columns
against one shared vertical time axis with a live current-time line; mobile shows one day at a
time behind accessible day tabs. Category colors (health, travel, work, study, business, creative,
meals, recovery, free) mark every block; appointments overlay the routine without ever hiding a
recurring block.

You can add, edit, and disable recurring blocks, and add a one-day-only override (move or skip a
single occurrence) without touching the recurring definition — the following week's occurrence is
untouched either way. Data lives in one `schedule:model_v1` localStorage key, synced like everything
else via `sync.js`'s existing race-safe merge-on-push (a new `schedule` appKey) — no naive
full-row overwrites.

A disabled `university-2026` profile placeholder ships alongside the summer one so a real class
schedule has somewhere to go once you have actual times — it never auto-activates and carries zero
invented blocks.

**Known limitations of this first pass (tracked as follow-up work):**
- No Google Calendar projection yet — the summer schedule doesn't push to Google Calendar, and
  Google events aren't overlaid on this page yet (calendar.html's existing read-only Google view is
  unaffected). That's a separate, explicitly-scoped follow-up.
- No Telegram assistant integration yet ("what am I doing at 10?", pause/resume reminders, etc.) —
  also a separate follow-up.
- No hourly Telegram reminders tied to this schedule yet.
- The "sync error" banner reflects `sync.js`'s own push-retry outcome (a new `dashboard:sync-error`
  / `dashboard:sync-ok` event it now dispatches alongside its existing toast); it does not yet
  reconcile a genuine multi-device edit conflict beyond showing a "reload" prompt if this schedule
  changed elsewhere while you had an edit open.

**Google Calendar projection (update):** the Weekly Schedule page now has its own **Google
Calendar** panel. It reuses the same Google connection `google.html` already sets up (nothing new
to configure) — one recurring dashboard block maps to one recurring Google event (a native weekly
RRULE), so editing or disabling a block updates or removes that single event, and Google itself
reflects the change across every future occurrence. A one-day override (move or skip a single
occurrence) becomes a Google **instance exception** on that one date only.

- **Nothing is ever sent to Google until you explicitly confirm.** The first push shows every event
  it's about to create, one row per block; every push after that shows only what actually changed.
- Manually-created Google events (or anything not created by this schedule) still show up on the
  page, read-only, clearly marked — the sync never touches or deletes an event it didn't create.
- If some events fail to push (offline, an expired connection, a Google error), the ones that
  succeeded are kept, the dashboard schedule itself is never rolled back, and a banner tells you
  how many are safe to retry with "Sync now."
- Known limitation: retrying automatically re-includes anything that failed, since a failed
  create/update never gets marked as synced — safe, but it means "Sync now" is currently the only
  way to retry rather than a per-item retry button.

**Telegram assistant + hourly reminders (update):** if you've set up the Telegram Assistant (step
8), it now understands the Weekly Schedule too — ask it "what am I doing at 10?", "what's next?",
"add a dentist appointment Thursday at noon", "skip the park tomorrow", "pause reminders for two
hours", and it reads/changes the same schedule the dashboard shows. Reading is instant; any real
change (adding/editing/disabling a recurring block, a one-day override, or an appointment) always
comes back as a confirmation button first — nothing changes until you tap Confirm. A new
appointment added this way is pushed straight to Google Calendar too when connected (recurring
block changes made through the assistant sync to Google the next time you open the Weekly Schedule
page and hit "Sync now" — they don't push immediately from Telegram).

You'll also get one concise message at the top of every hour while your schedule is active (nothing
overnight or outside your own wake-to-sleep window, and nothing at all on Sunday) — "8:00 —
Breakfast and gym prep. Next: walk to the gym at 8:15." A routine-block reminder has a **Skip
today** button (a one-day-only override, same as doing it from the dashboard) and a **Got it**
button to dismiss. Say "pause reminders" any time to stop them (for a stated duration, or
indefinitely until you say "resume reminders" or ask on the dashboard).

- Known limitation: "switch me to my university schedule" is intentionally refused — that profile
  ships disabled with zero blocks until you give it real class times, and the assistant will never
  activate or invent one on its own.

---

## TL;DR
1. Fork → import to Vercel → deploy.
2. New Supabase → run the **SQL** above → paste your **URL + anon key** into `sync.js`,
   `topbar.js`, `gym.html`.
3. (Optional) WHOOP: Client ID in `health.html` + the two env vars in Vercel.
4. (Optional) Apple Health: `APPLE_HEALTH_SECRET` env var + an iOS Shortcut, see step 4 above.
5. (Optional) Google: Client ID in `google.html` + the two env vars in Vercel, see step 5 above.
6. (Optional) Text reminders: Resend (free) or Twilio (paid) + the env vars in step 7 above —
   skip if using the Telegram Assistant, which covers this too.
7. (Optional) Telegram Assistant: bot token + env vars in step 8 above.
8. (Optional) Connect Google to the assistant: the `google_tokens` SQL + `SUPABASE_SERVICE_ROLE_KEY`/`GOOGLE_SYNC_SECRET` env vars, see step 8 above.
9. (Optional) Voice/location Shortcuts: `SHORTCUTS_WEBHOOK_SECRET` env var + iOS Shortcuts, see step 9 above.
10. (Optional) Semantic note search: enable pgvector + the SQL above + `OPENAI_API_KEY`/`NOTES_EMBED_SECRET` env vars, see step 10 above.
11. (Optional) Bank auto-import: Plaid account + the `plaid_items` SQL + `PLAID_CLIENT_ID`/`PLAID_SECRET`/`PLAID_ENV`/`PLAID_SYNC_SECRET` env vars, see step 11 above.
12. (Optional) Voice journaling & AI reflection in Notes: `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` env vars (same ones as steps 8 & 10), see step 12 above.
13. (Optional) Auto-fill audiobook runtime from YouTube: `YOUTUBE_API_KEY`/`YOUTUBE_LOOKUP_SECRET` env vars, see step 13 above.
14. Data export/backup: nothing to set up — gear icon → Backup on the main page, see step 14 above.
15. Dashboard-wide search: nothing to set up — 🔍 icon on the main page, see step 15 above.
16. Life Context: nothing to set up — 🧠 Life Context box on the Reflect hub, see step 16 above.
17. Insights: nothing to set up — 🧭 Insights, its own tile on the front page, see step 17 above.
18. Daily Leverage Task: nothing to set up — ⭐ button on any to-do item, see step 18 above.
19. Mistake / Risk Log: nothing to set up — ⚠️ Mistake Log on the Reflect hub, see step 19 above.
20. Skill Stack Tracker: nothing to set up — 🏗️ Skill Stack on the Reflect hub, see step 20 above.
21. Sleep: nothing to set up — 😴 Sleep on the Body hub, see step 21 above.
22. Player Card: nothing to set up — the gold strip on the front page, see step 22 above.
23. Weekly/monthly grade: nothing to set up — top of Review's Recap, see step 23 above.
24. Change the password in `lock.js`. Done.
