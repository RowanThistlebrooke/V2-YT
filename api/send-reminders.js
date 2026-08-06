import { resolveScheduleForDate, currentAndNextForDate, normalizeScheduleModel, formatTime12, SCHEDULE_TIMEZONE } from '../schedule-model.js';

// ============================================================
// GET/POST /api/send-reminders
//
// Triggered by a scheduler hitting this URL every ~15 minutes (see
// .github/workflows/reminders.yml — GitHub Actions, not Vercel Cron:
// Vercel's Hobby plan only allows once-a-day cron per job, which can't do
// this; Actions is free at any frequency on a public repo). Each call reads
// today's recurring items and any one-off to-dos with a time set straight
// from Supabase (the same rows the dashboard itself reads and writes — this
// function never talks to the browser, only to Supabase and the delivery
// provider), and sends an INDIVIDUAL message for whatever item's own
// scheduled time has just arrived — not one big hourly bundle of
// everything undone regardless of relevance.
//
// Where an item's time comes from, in priority order:
//   1. An explicit time set on the recurring item (Recurring Items form)
//      or on a one-off goal (Schedule/Calendar time field).
//   2. A name-based default: anything named/tagged "(PM)" or "evening"
//      defaults to shortly before BEDTIME_LOCAL; anything "(AM)" or
//      "morning" defaults to 8:00am.
//   3. Anything left with no time at all — generic recurring items,
//      untimed to-dos, and daily habits (main.html's separate habit
//      tracker) — defaults to GENERIC_ITEM_DEFAULT_MIN. Each one is still its own
//      separate individual message though, not bundled into one big list:
//      you get a text per undone thing, right up until bedtime, so nothing
//      you're behind on ever goes silently unmentioned all day.
//
// A deterministic (not truly random, so a given day is reproducible)
// +/-10 minute jitter is applied per item per day, so reminders don't land
// at the exact same robotic minute every day.
//
// Only MAX_INDIVIDUAL_SENDS_PER_TICK individual items are actually sent per
// invocation, even when several are simultaneously due (e.g. right after
// this whole feature goes untouched for a while, or several generic items
// all default to the same GENERIC_ITEM_DEFAULT_MIN) — otherwise they'd all
// fire in the same ~15-minute tick and arrive as a burst of texts within
// the same minute, which reads exactly like a bundled digest even though
// they're technically separate messages. Whatever doesn't make the cut
// stays undone (no state written) and gets sent on a later tick instead, so
// several undone things drip out one at a time, spaced by however often the
// scheduler runs, rather than landing together.
//
// If something's still undone once its time has passed, it nags again
// every RENAG_INTERVAL_MIN until it's done OR until BEDTIME_LOCAL, after
// which it goes quiet for the day rather than pinging you at 2am. Which
// items have been reminded about today (and how many times) is tracked in
// a small Supabase row ('reminder_state') so this survives across the
// stateless serverless calls between ticks.
//
// Separately, if peak.html (morning check-in / feeling-stress check-ins)
// is in use, this also sends a periodic "how are you feeling?" nudge every
// FEELING_CHECKIN_INTERVAL_MIN during waking hours — deliberately NOT tied
// to the once-a-day done/undone model above, since check-ins are meant to
// happen several times a day, not just once. It looks at the actual
// timestamps in peak:checkins (not just whether a reminder was sent), so a
// spontaneous check-in you log on your own resets the interval same as a
// prompted one would.
//
// Also separately, once a day at MORNING_BRIEFING_TIME a single "here's
// today" summary goes out — everything scheduled and still undone, last
// night's sleep quality if logged, and a nod to any subscription renewals
// coming up. One-shot per day (unlike the individual per-item reminders
// above, which repeat), tracked in the same reminder_state bucket.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_ANON_KEY   (same ones the dashboard already uses)
//
// Delivery — configure ONE of these three (checked in this priority order,
// so Telegram wins over Twilio wins over the email gateway if more than
// one happens to be configured):
//   Telegram (free, preferred — see api/telegram-webhook.js for the
//   two-way assistant this doubles up with):
//     TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   Twilio (paid, reliable):
//     TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//     TWILIO_FROM_NUMBER                your Twilio number, e.g. +15551234567
//     TWILIO_TO_NUMBER                  your personal phone, e.g. +15559876543
//   Email-to-SMS carrier gateway (free, via Resend):
//     RESEND_API_KEY                    from resend.com
//     SMS_GATEWAY_TO                    your phone's carrier gateway address,
//                                        e.g. 5551234567@vtext.com (Verizon)
//     RESEND_FROM                       optional, default 'onboarding@resend.dev'
//
// Optional:
//   REMINDER_TIMEZONE     IANA tz name, default 'America/New_York'
//   BEDTIME_LOCAL         24h HH:MM, default '23:00' — the cutoff after
//                         which reminders stop for the day, and the anchor
//                         "(PM)"/evening items with no explicit time default
//                         shortly before.
//   MORNING_BRIEFING_TIME 24h HH:MM, default '07:00' — when the once-daily
//                         "here's today" summary fires.
//   CRON_SECRET           if set, requests must carry
//                         Authorization: Bearer <CRON_SECRET> — Vercel
//                         sends this automatically on cron-triggered
//                         requests when CRON_SECRET is set as an env var.
//                         Strongly recommended so this endpoint can't be
//                         hit by randoms to spam your phone / burn your quota.
// ============================================================

const RENAG_INTERVAL_MIN = 90;       // how often to re-nag an undone item until it's done or bedtime
const MAX_INDIVIDUAL_SENDS_PER_TICK = 1; // cap on individual-item messages sent in one invocation, so several simultaneously-due items drip out one per tick instead of bursting all at once
const GENERIC_ITEM_DEFAULT_MIN = 9 * 60;   // default effective time for an item with no explicit time and no AM/PM name hint — still gets its own individual message and re-nag cadence like anything else, just anchored here instead of a real scheduled time. Independent of MORNING_BRIEFING_TIME on purpose, so the two features stay decoupled
const PM_BEDTIME_OFFSET_MIN = 30;    // "(PM)"/evening items with no explicit time default to this many minutes before bedtime
const DEFAULT_AM_MINUTES = 8 * 60;   // "(AM)"/morning items with no explicit time default to 8:00am
const JITTER_MAX_MIN = 10;           // deterministic +/- jitter applied per item per day
const FEELING_CHECKIN_INTERVAL_MIN = 240; // how often to nudge for a feeling/stress check-in (4 hours)
const FEELING_CHECKIN_START_MIN = 9 * 60;  // don't start nudging before 9am
const SUBS_REMIND_DAYS_BEFORE = 3;   // heads-up window before a subscription's renewal date
const SLEEP_POOR_THRESHOLD = 2;      // a logged sleepQuality at/below this counts as "slept poorly last night"
const SLEEP_POOR_GYM_DELAY_MIN = 90; // push the gym reminder back this much after a poor-sleep night — no benefit nagging first thing when recovery is what's actually needed
const MORNING_BRIEFING_DEFAULT_TIME = '07:00'; // when the once-daily "here's today" summary fires, unless MORNING_BRIEFING_TIME overrides it

const FEELING_CHECKIN_PROMPTS = [
  'Quick check-in — how are you feeling, and how\'s your stress? Just reply with a number 1-5 for each (or however you want to put it) and I\'ll log it.',
  'How you doing right now? Feeling + stress, 1-5 each, whenever you\'ve got a sec.',
  'Check-in time — mood and stress, 1-5. No rush, just curious how today\'s going.',
  'How\'s the day treating you? Feeling/stress 1-5 and I\'ll get it logged.',
];
function pickFeelingPrompt(dateKey, nowMin) {
  const seed = hashStr(dateKey + '|feeling|' + Math.floor(nowMin / FEELING_CHECKIN_INTERVAL_MIN));
  return FEELING_CHECKIN_PROMPTS[seed % FEELING_CHECKIN_PROMPTS.length];
}

// Pure decision function, mirrors shouldSendNow's style — no Date/network
// involved, so directly unit-testable with synthetic values.
export function shouldSendFeelingCheckin(peakData, nowMin, bedtimeMin, feelingState) {
  if (nowMin < FEELING_CHECKIN_START_MIN || nowMin >= bedtimeMin) return false;
  const checkins = (peakData && peakData['peak:checkins']) || [];
  const intervalMs = FEELING_CHECKIN_INTERVAL_MIN * 60 * 1000;
  const nowMs = Date.now();
  const hasRecentRealCheckin = checkins.some(c => typeof c.ts === 'number' && (nowMs - c.ts) < intervalMs);
  if (hasRecentRealCheckin) return false;
  if (feelingState && (nowMin - feelingState.lastMinutes) < FEELING_CHECKIN_INTERVAL_MIN) return false;
  return true;
}

// ---------- Subscription renewal reminders ----------
// Independent from the once-daily/timed-item model above, same reasoning as
// shouldSendFeelingCheckin: fires once per renewal (tracked in its own row,
// 'subs_reminders', keyed by "name|renewal date" — NOT the day-scoped
// reminder_state row, since that one intentionally drops everything except
// today's bucket on every write and would forget "already reminded" the
// very next tick). Pure function — todayDateStr and each sub's renewal are
// both plain YYYY-MM-DD, parsed identically (new Date(y,m-1,d), local to
// whatever runs this), so the day-difference between them is correct
// regardless of the server's actual timezone — no real wall-clock instant
// is involved, just calendar-date subtraction.
export function subsRenewalsDue(subs, todayDateStr, remindedMap) {
  const [ty, tm, td] = todayDateStr.split('-').map(Number);
  const todayMs = new Date(ty, tm - 1, td).getTime();
  const due = [];
  (subs || []).forEach(sub => {
    if (!sub || !sub.renewal || !/^\d{4}-\d{2}-\d{2}$/.test(sub.renewal)) return;
    const [y, m, d] = sub.renewal.split('-').map(Number);
    const renewalMs = new Date(y, m - 1, d).getTime();
    const daysUntil = Math.round((renewalMs - todayMs) / 86400000);
    if (daysUntil < 0 || daysUntil > SUBS_REMIND_DAYS_BEFORE) return;
    const remindKey = sub.name + '|' + sub.renewal;
    if (remindedMap && remindedMap[remindKey]) return;
    due.push({
      name: sub.name, renewal: sub.renewal, daysUntil, remindKey,
      amount: sub.entered_amount != null ? sub.entered_amount : sub.amount,
      currency: sub.entered_currency || 'CHF',
    });
  });
  return due;
}
function fmtSubAmount(n) {
  const num = Number(n) || 0;
  return num % 1 === 0 ? String(num) : num.toFixed(2);
}
export function composeSubsMessage(dueSubs) {
  const lines = dueSubs.map(s => {
    const when = s.daysUntil === 0 ? 'today' : s.daysUntil === 1 ? 'tomorrow' : 'in ' + s.daysUntil + ' days';
    return s.name + ' — ' + s.currency + ' ' + fmtSubAmount(s.amount) + ' renews ' + when + ' (' + s.renewal + ')';
  });
  return (dueSubs.length > 1 ? 'Upcoming renewals:\n' : 'Upcoming renewal: ') + lines.join('\n');
}

// ---------- Morning briefing ----------
// A single once-a-day summary, independent of the per-item nag model above
// (same reasoning as the feeling check-in / subs reminders: this doesn't fit
// the "one moment per item" shape). Fires once MORNING_BRIEFING_TIME has
// passed, tracked via todayState.__morning_briefing__ — fine to live in the
// day-scoped reminder_state row since it's inherently daily.
export function shouldSendMorningBriefing(nowMin, briefingMin, bedtimeMin, alreadySent) {
  if (alreadySent) return false;
  if (nowMin < briefingMin) return false;
  if (nowMin >= bedtimeMin) return false;
  return true;
}

// todayNames: everything scheduled today and not yet done (recurring +
// one-off timed to-dos) — a plain list of names is enough, no need to know
// their individual times for a summary. sleepQuality is last night's logged
// sleep (from sleep.html, null if not logged). dueSubsCount is how many
// subscriptions are coming up within the reminder window. actionableInsight
// is an optional one-line nudge from computeActionableInsight() below — a
// real pattern in your own history worth acting on today, not just a status
// report (see that function's comment for why it's at most one line).
// driftInsight is an optional one-line nudge from computeDriftInsight()
// further below — a longer-horizon "you've quietly slipped from your normal
// baseline over the last couple weeks" signal, distinct from
// actionableInsight's single-factor correlation callout.
export function composeMorningBriefing(todayNames, sleepQuality, dueSubsCount, actionableInsight, driftInsight) {
  const lines = ['Morning. Here\'s today:'];
  if (todayNames.length) {
    lines.push(todayNames.map(n => '- ' + n).join('\n'));
  } else {
    lines.push('Nothing on the list today — clean slate.');
  }
  if (sleepQuality != null) {
    lines.push(
      'Last night\'s sleep: ' + sleepQuality + '/5' +
      (sleepQuality <= SLEEP_POOR_THRESHOLD ? ' — rough one, take it easy today' : '')
    );
  }
  if (dueSubsCount > 0) {
    lines.push(dueSubsCount + ' subscription renewal' + (dueSubsCount > 1 ? 's' : '') + ' coming up soon.');
  }
  if (actionableInsight) {
    lines.push('💡 ' + actionableInsight);
  }
  if (driftInsight) {
    lines.push('🌊 ' + driftInsight);
  }
  return lines.join('\n\n');
}

// ---------- Correlation-driven actionable insight ----------
// A server-side port of peak.html's caffeine/sleep and gym/checkin-mood
// correlations (see that page's INSIGHTS section for the original client-side
// version, which only ever displayed these as a passive stats readout).
// Same "two buckets, minimum sample size per side" approach, reused here so
// the morning briefing can act on a real pattern in your own history —
// "cut caffeine early today" instead of just reporting "your sleep is worse
// after late caffeine" days after the fact. Deliberately picks AT MOST ONE
// line so the briefing doesn't turn into a wall of stats; caffeine/sleep is
// checked first since it's something today's choices can still change (the
// day's caffeine hasn't happened yet at briefing time), ahead of the
// gym/mood nudge, which only makes sense to show if a workout isn't already
// logged today.
const INSIGHT_MIN_SAMPLES = 5;
const INSIGHT_MEANINGFUL_DIFF = 0.4;
function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function shiftDateKeyPlain(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

export function computeCaffeineSleepInsight(caffeineData, sleepData) {
  const cafLogs = (caffeineData && caffeineData['caf:logs']) || [];
  const lateCaffeineDays = new Set();
  cafLogs.forEach(l => {
    if (!l || !l.ts) return;
    const d = new Date(l.ts);
    if (d.getHours() >= 14) lateCaffeineDays.add(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
  });
  const morning = (sleepData && sleepData['sleep:nights']) || {};
  const withLate = [], withoutLate = [];
  Object.keys(morning).forEach(dateKey => {
    const q = morning[dateKey] && morning[dateKey].sleepQuality;
    if (!q) return;
    const prevDay = shiftDateKeyPlain(dateKey, -1);
    (lateCaffeineDays.has(prevDay) ? withLate : withoutLate).push(q);
  });
  if (withLate.length < INSIGHT_MIN_SAMPLES || withoutLate.length < INSIGHT_MIN_SAMPLES) return null;
  return { avgWith: avg(withLate), avgWithout: avg(withoutLate), nWith: withLate.length, nWithout: withoutLate.length };
}

export function computeGymCheckinInsight(gymData, peakData, checkinField) {
  const doneDays = (gymData && gymData['po_coach_workout_done']) || {};
  const checkins = (peakData && peakData['peak:checkins']) || [];
  const byDay = {};
  checkins.forEach(c => {
    if (!c || !c[checkinField] || !c.dateKey) return;
    (byDay[c.dateKey] = byDay[c.dateKey] || []).push(c[checkinField]);
  });
  const withGym = [], withoutGym = [];
  Object.keys(byDay).forEach(dateKey => {
    const dayAvg = avg(byDay[dateKey]);
    (doneDays[dateKey] ? withGym : withoutGym).push(dayAvg);
  });
  if (withGym.length < INSIGHT_MIN_SAMPLES || withoutGym.length < INSIGHT_MIN_SAMPLES) return null;
  return { avgWith: avg(withGym), avgWithout: avg(withoutGym), nWith: withGym.length, nWithout: withoutGym.length };
}

export function computeActionableInsight(caffeineData, sleepData, peakData, gymData, workoutDoneToday) {
  const caf = computeCaffeineSleepInsight(caffeineData, sleepData);
  if (caf && (caf.avgWithout - caf.avgWith) >= INSIGHT_MEANINGFUL_DIFF) {
    return 'Your sleep tends to suffer after caffeine at/past 2pm (' + caf.avgWith.toFixed(1) + '/5 vs '
      + caf.avgWithout.toFixed(1) + '/5) — worth cutting it off early today.';
  }
  if (!workoutDoneToday) {
    const feeling = computeGymCheckinInsight(gymData, peakData, 'feeling');
    if (feeling && (feeling.avgWith - feeling.avgWithout) >= INSIGHT_MEANINGFUL_DIFF) {
      return 'You tend to feel noticeably better on workout days (' + feeling.avgWith.toFixed(1) + '/5 vs '
        + feeling.avgWithout.toFixed(1) + '/5 feeling) — worth fitting one in today.';
    }
    const stress = computeGymCheckinInsight(gymData, peakData, 'stress');
    if (stress && (stress.avgWithout - stress.avgWith) >= INSIGHT_MEANINGFUL_DIFF) {
      return 'Your stress tends to run lower on workout days (' + stress.avgWith.toFixed(1) + '/5 vs '
        + stress.avgWithout.toFixed(1) + '/5) — worth fitting one in today.';
    }
  }
  return null;
}

// ---------- Drift detection ----------
// A longer-horizon companion to computeActionableInsight above: instead of
// "here's a correlation in your history," this asks "have your OWN recent
// patterns quietly slipped from your own established baseline" — the last
// DRIFT_RECENT_DAYS vs. the DRIFT_BASELINE_DAYS before that, across several
// tracked rates at once. Entirely passive (no new logging — same raw rows
// the rest of this file already reads) and only fires when multiple metrics
// have moved together, so a single noisy day/metric doesn't trigger a false
// alarm.
const DRIFT_RECENT_DAYS = 14;
const DRIFT_BASELINE_DAYS = 60; // total lookback; baseline = the days before the recent window (46 days)
const DRIFT_MIN_SAMPLES = 7; // minimum days with real data required on each side of a given metric
const DRIFT_RELATIVE_DROP = 0.25; // a metric must be down at least 25% vs its own baseline to count
const DRIFT_MIN_METRICS = 2; // at least 2 metrics drifting together before calling it "drift"

function dateKeysBackFromPlain(n, todayPlain) {
  const [y, m, d] = todayPlain.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0'));
    dt.setDate(dt.getDate() - 1);
  }
  return out;
}

// dateKeys should be most-recent-first (see dateKeysBackFromPlain above).
export function computeDriftDayRows(dateKeys, goalsData, gymData, sleepData) {
  const doneDays = (gymData && gymData['po_coach_workout_done']) || {};
  const habitDefs = (goalsData && goalsData['habits:defs']) || [];
  const habitLog = (goalsData && goalsData['habits:log']) || {};
  const morning = (sleepData && sleepData['sleep:nights']) || {};

  return dateKeys.map(dateKey => {
    const habitTotal = habitDefs.length;
    const habitDone = habitTotal ? habitDefs.filter(h => habitLog[h.id] && habitLog[h.id][dateKey]).length : 0;
    const habitRate = habitTotal ? habitDone / habitTotal : null;
    const goalsToday = (goalsData && goalsData['goals:' + dateKey]) || [];
    const todoRate = goalsToday.length ? goalsToday.filter(g => g.done).length / goalsToday.length : null;
    const morningEntry = morning[dateKey];
    return {
      dateKey,
      workoutDone: doneDays[dateKey] ? 1 : 0,
      habitRate,
      todoRate,
      sleepQuality: morningEntry ? morningEntry.sleepQuality : null,
    };
  });
}

const DRIFT_METRICS = [
  { field: 'workoutDone', phrase: (r, b) => 'workouts (' + Math.round(r * 100) + '% of days vs ' + Math.round(b * 100) + '% before)' },
  { field: 'habitRate', phrase: (r, b) => 'habit completion (' + Math.round(r * 100) + '% vs ' + Math.round(b * 100) + '% before)' },
  { field: 'todoRate', phrase: (r, b) => 'to-do completion (' + Math.round(r * 100) + '% vs ' + Math.round(b * 100) + '% before)' },
  { field: 'sleepQuality', phrase: (r, b) => 'sleep quality (' + r.toFixed(1) + '/5 vs ' + b.toFixed(1) + '/5 before)' },
];

// dayRows must be most-recent-first, at least DRIFT_RECENT_DAYS + DRIFT_MIN_SAMPLES long to find anything.
export function computeDrift(dayRows) {
  const recent = dayRows.slice(0, DRIFT_RECENT_DAYS);
  const baseline = dayRows.slice(DRIFT_RECENT_DAYS, DRIFT_BASELINE_DAYS);
  const drifted = [];
  DRIFT_METRICS.forEach(m => {
    const recentVals = recent.map(r => r[m.field]).filter(v => v != null);
    const baselineVals = baseline.map(r => r[m.field]).filter(v => v != null);
    if (recentVals.length < DRIFT_MIN_SAMPLES || baselineVals.length < DRIFT_MIN_SAMPLES) return;
    const recentAvg = avg(recentVals), baselineAvg = avg(baselineVals);
    if (!(baselineAvg > 0)) return;
    const relDrop = (baselineAvg - recentAvg) / baselineAvg;
    if (relDrop >= DRIFT_RELATIVE_DROP) {
      drifted.push({ field: m.field, recentAvg, baselineAvg, relDrop, phrase: m.phrase(recentAvg, baselineAvg) });
    }
  });
  drifted.sort((a, b) => b.relDrop - a.relDrop);
  return drifted;
}

export function computeDriftInsight(dayRows) {
  const drifted = computeDrift(dayRows);
  if (drifted.length < DRIFT_MIN_METRICS) return null;
  const phrases = drifted.slice(0, 2).map(d => d.phrase);
  return 'You\'ve drifted from your usual pattern over the last ' + DRIFT_RECENT_DAYS + ' days — '
    + phrases.join(' and ') + '.';
}

// ---------- Reactive low-energy nudge (suggests caffeine/nicotine) ----------
// A simplified server-side port of caffeine.html's energy model — the same
// exponential-decay caffeine math (dose * 0.5^(elapsedHours/halfLife), summed
// across every log) and circadian/lunch-dip/sleep-pressure curve, just
// enough to answer one in-the-moment question: "is energy dipping right
// now, and is caffeine not already doing something about it?" Deliberately
// NOT the full multi-factor Peak curve (hydration/nutrition/supplements/
// workouts) — those don't have a fast-acting remedy the way a stimulant
// does, so they stay as a daily morning-briefing insight instead of a
// same-day nudge.
const ENERGY_LOW_THRESHOLD = 44; // matches caffeine.html's "Dip"/"Low" bands
const ENERGY_LOW_CAFFEINE_MG_CEILING = 30; // below this, caffeine still has real room to help
const ENERGY_NUDGE_START_MIN = 8 * 60; // don't fire before 8am regardless of timezone default
const ENERGY_NUDGE_MIN_GAP_MIN = 90; // don't suggest right after already logging one
const ENERGY_NUDGE_COOLDOWN_MIN = 120; // don't repeat the nudge more often than this
const ENERGY_CAF_HALF_LIFE_H = 5;
const ENERGY_DEFAULT_WAKE_HOUR = 8;

function gaussAt(x, mean, sd) { return Math.exp(-((x - mean) * (x - mean)) / (2 * sd * sd)); }
function circadianAt(t) { return 50 + 18 * Math.cos(2 * Math.PI * (t - 16.5) / 24); }
function lunchDipAt(t) { return 10 * gaussAt(t, 14, 1.4); }
function sleepPressureAt(awakeHours) { return Math.max(0, Math.min(24, awakeHours)) * 1.7; }
function morningBumpAt(t, wakeHour) {
  const d = t - wakeHour;
  return (d < 0 || d > 4) ? 0 : 10 * gaussAt(d, 1.2, 0.9);
}
function caffeineActiveAt(mg, logTs, atTs) {
  const hrs = (atTs - logTs) / 3600000;
  return hrs < 0 ? 0 : mg * Math.pow(0.5, hrs / ENERGY_CAF_HALF_LIFE_H);
}
function totalCaffeineActiveAt(cafLogs, atTs) {
  return (cafLogs || []).reduce((sum, l) => sum + (l && typeof l.ts === 'number' ? caffeineActiveAt(l.mg || 0, l.ts, atTs) : 0), 0);
}
function caffeineBoostAt(activeMg) { return 34 * (1 - Math.exp(-activeMg / 110)); }

// nowHour/wakeHour are decimal hours (e.g. 14.5 = 2:30pm). nowTs is a real
// epoch ms timestamp, used only for the caffeine decay math.
export function computeCurrentEnergy(cafLogs, wakeHour, nowHour, nowTs) {
  const activeCaffeineMg = totalCaffeineActiveAt(cafLogs, nowTs);
  const raw = circadianAt(nowHour) - lunchDipAt(nowHour) - sleepPressureAt(nowHour - wakeHour) + morningBumpAt(nowHour, wakeHour);
  const energy = Math.max(0, Math.min(100, raw + caffeineBoostAt(activeCaffeineMg)));
  return { energy, activeCaffeineMg };
}

// lastStimulantTs is the most recent caffeine OR nicotine log timestamp
// (whichever is more recent), or null if neither has ever been logged.
// nudgeState mirrors the { lastMinutes } shape already used by
// shouldSendFeelingCheckin's cooldown tracking.
export function shouldSendEnergyNudge(energyResult, nowMin, lastStimulantTs, nowTs, nudgeState) {
  if (nowMin < ENERGY_NUDGE_START_MIN) return false;
  if (energyResult.energy >= ENERGY_LOW_THRESHOLD) return false;
  if (energyResult.activeCaffeineMg >= ENERGY_LOW_CAFFEINE_MG_CEILING) return false;
  if (lastStimulantTs != null && (nowTs - lastStimulantTs) < ENERGY_NUDGE_MIN_GAP_MIN * 60000) return false;
  if (nudgeState && (nowMin - nudgeState.lastMinutes) < ENERGY_NUDGE_COOLDOWN_MIN) return false;
  return true;
}

export function composeEnergyNudge(energyResult) {
  return '🔋 Energy is dipping right now (' + Math.round(energyResult.energy) + '/100) and caffeine isn\'t doing much '
    + 'for you at the moment — might be worth a coffee, tea, or a Zyn if that\'s more your speed.';
}

function parseHM(hm) {
  const parts = String(hm || '').split(':').map(Number);
  const h = parts[0] || 0, m = parts[1] || 0;
  return h * 60 + m;
}

function minutesInTz(tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
  const h = Number(parts.find(p => p.type === 'hour').value) % 24;
  const m = Number(parts.find(p => p.type === 'minute').value);
  return h * 60 + m;
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Deterministic by (dateKey, name) rather than real randomness, so a given
// day's schedule is stable across repeated ticks instead of jumping around.
function jitterMinutes(seed) {
  const h = hashStr(seed);
  return (h % (JITTER_MAX_MIN * 2 + 1)) - JITTER_MAX_MIN;
}

function isGymItemName(name) { return /\bgym\b|workout|\blift/i.test(String(name)); }

// A generic item with no assignable time still gets its own effective time
// (GENERIC_ITEM_DEFAULT_MIN) rather than being bundled with anything else.
// sleepQuality (1-5, optional — last night's logged sleep from sleep.html)
// pushes a gym reminder later on a poor-sleep night rather than nagging first thing
// when the more useful thing might be extra recovery. Doesn't touch
// anything else — a to-do or a reading reminder doesn't have the same
// "pushing through" tradeoff a workout does.
export function effectiveTimeMinutes(name, explicitTime, bedtimeMin, dateKey, sleepQuality) {
  let base;
  if (explicitTime) {
    base = parseHM(explicitTime);
  } else {
    const n = String(name).toLowerCase();
    if (/\(pm\)|\bevening\b/.test(n)) base = bedtimeMin - PM_BEDTIME_OFFSET_MIN;
    else if (/\(am\)|\bmorning\b/.test(n)) base = DEFAULT_AM_MINUTES;
    // Nothing to key off of at all — still gets its own individual message
    // (not bundled with anything else), just starting from a generic
    // default time instead of something derived from its name.
    else base = GENERIC_ITEM_DEFAULT_MIN;
  }
  let eff = Math.max(0, base + jitterMinutes(dateKey + '|' + name));
  if (sleepQuality != null && sleepQuality <= SLEEP_POOR_THRESHOLD && isGymItemName(name)) {
    eff += SLEEP_POOR_GYM_DELAY_MIN;
  }
  return eff;
}

// Pure decision function — no Date/network involved — so this is the one
// most worth unit-testing thoroughly with synthetic values rather than
// fighting the real clock.
export function shouldSendNow(state, nowMin, effMin, bedtimeMin) {
  if (nowMin < effMin) return false;       // its time hasn't arrived yet
  if (nowMin >= bedtimeMin) return false;  // stop nagging for the day
  if (!state) return true;                 // never reminded — due for the first nudge
  return (nowMin - state.lastMinutes) >= RENAG_INTERVAL_MIN;
}

// ---------- Per-item phrasing ----------
// Recurring item names are whatever the user typed into main.html's
// Recurring Items settings, not a fixed enum — so this matches on keywords
// rather than exact names, with a generic pool as the fallback for anything
// that doesn't match (custom items, one-off to-dos).
function categorizeItem(name) {
  const n = String(name).toLowerCase();
  if (/side ?hustle|\bhustle\b|business|affiliate|editing client/.test(n)) return 'sideHustle';
  if (/\bgym\b|workout|\blift/.test(n)) return 'gym';
  if (/water|hydrat/.test(n)) return 'water';
  if (/\bread(ing)?\b|\bbook/.test(n)) return 'reading';
  if (/stretch|mobility|\byoga\b/.test(n)) return 'stretch';
  if (/skin ?care/.test(n)) return 'skincare';
  if (/\bclean|\btidy|\broom\b/.test(n)) return 'cleaning';
  if (/supplement|vitamin/.test(n)) return 'supplements';
  if (/\bsleep\b|bed ?time/.test(n)) return 'sleep';
  if (/\bmed(s|ication)?\b|\bpill/.test(n)) return 'meds';
  if (/\bwork\b/.test(n)) return 'work';
  return 'generic';
}
const PHRASES = {
  gym: [
    n => n + ' — the weights aren\'t lifting themselves',
    n => 'Still no ' + n.toLowerCase() + ' today',
    n => n + ': future you is currently disappointed',
    n => 'Your gym bag is still zipped shut (' + n + ')',
    n => n + ' — bench press beats bench sitting',
    n => 'Zero reps logged for ' + n + ' today',
  ],
  water: [
    n => n + ' — hydrate or diedrate',
    n => 'Still haven\'t hit ' + n.toLowerCase() + ' today',
    n => n + ': your cells are filing a complaint',
    n => 'That water bottle isn\'t drinking itself (' + n + ')',
    n => n + ' — go take a sip right now',
  ],
  reading: [
    n => n + ' — that bookmark hasn\'t moved',
    n => 'Zero pages today for ' + n,
    n => n + ' is still waiting on the nightstand',
    n => 'Still haven\'t cracked ' + n.toLowerCase() + ' open today',
    n => n + ' — even one page counts',
  ],
  stretch: [
    n => n + ' — your hips will remember this',
    n => 'Still haven\'t stretched (' + n + ')',
    n => n + ': five minutes, that\'s it',
    n => 'Everything\'s still tight — ' + n,
    n => n + ' — don\'t skip it two days running',
  ],
  skincare: [
    n => n + ' — skip it and regret it in the mirror later',
    n => 'Still haven\'t done ' + n.toLowerCase(),
    n => n + ': quick one, don\'t skip',
    n => 'Still waiting on ' + n.toLowerCase() + ' today',
  ],
  cleaning: [
    n => n + ' — the mess isn\'t cleaning itself',
    n => 'Still haven\'t done ' + n.toLowerCase(),
    n => n + ': five minutes and it\'s done',
    n => 'Still a mess in there — ' + n,
  ],
  supplements: [
    n => n + ' — still sitting in the bottle',
    n => 'Haven\'t taken ' + n.toLowerCase() + ' yet',
    n => n + ': quick one, don\'t forget',
    n => 'Still untouched today (' + n + ')',
  ],
  sleep: [
    n => n + ' — still owe yourself this one',
    n => 'Haven\'t logged ' + n.toLowerCase() + ' yet',
  ],
  meds: [
    n => n + ' — don\'t forget this one',
    n => 'Still haven\'t taken ' + n.toLowerCase(),
    n => n + ': this one actually matters, don\'t skip',
  ],
  sideHustle: [
    n => n + ' — still nothing logged today',
    n => 'Haven\'t touched ' + n.toLowerCase() + ' yet',
    n => n + ': even 15 minutes moves it forward',
    n => 'Still no progress on ' + n.toLowerCase() + ' today',
    n => n + ' — the money\'s not making itself',
  ],
  work: [
    n => n + ' — still not clocked in',
    n => 'Haven\'t started ' + n.toLowerCase() + ' yet',
    n => n + ': still on the clock to start',
  ],
  generic: [
    n => n + ' — still undone',
    n => 'Haven\'t gotten to ' + n.toLowerCase() + ' yet',
    n => n + ' is still sitting there',
    n => 'Still need to knock out ' + n.toLowerCase(),
    n => n + ' — waiting on you',
    n => 'Still open: ' + n.toLowerCase(),
  ],
};

// A single item's own reminder, not a bundled digest. `nagCount` (how many
// times this item has already been reminded about today) shifts which
// phrase gets picked, so a re-nag doesn't repeat the exact same line as the
// first nudge.
export function composeSingleMessage(name, dateKey, nagCount) {
  const pool = PHRASES[categorizeItem(name)] || PHRASES.generic;
  const seed = hashStr(dateKey + '|' + name + '|' + (nagCount || 0));
  return pool[seed % pool.length](name);
}

// ---------- Weekly Schedule hourly reminders ----------
// Always anchored to schedule-model.js's own SCHEDULE_TIMEZONE (a fixed
// constant, not the REMINDER_TIMEZONE env var other reminders use) so this
// never disagrees with schedule.html's own clock regardless of how
// REMINDER_TIMEZONE happens to be configured for goals/habits reminders.
export function scheduleNowParts(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULE_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(nowMs == null ? Date.now() : nowMs));
  const get = t => Number(parts.find(p => p.type === t).value);
  return {
    dateKey: get('year') + '-' + String(get('month')).padStart(2, '0') + '-' + String(get('day')).padStart(2, '0'),
    minutes: (get('hour') % 24) * 60 + get('minute'),
    hour: get('hour') % 24,
  };
}

// The active window for a resolved day is simply the earliest start and
// latest end across everything on it — naturally spans 7am-11pm on a
// Mon-Wed, 9am-midnight on Saturday, etc., no separate "wake time"/"bedtime"
// config needed since the schedule itself already encodes both per day.
// Returns null for a day with nothing scheduled (Sunday, or outside any
// active profile's date range) — callers should send nothing at all then.
export function scheduleDayWindow(resolved) {
  if (!Array.isArray(resolved) || !resolved.length) return null;
  return {
    start: Math.min(...resolved.map(item => item.startMinutes)),
    end: Math.max(...resolved.map(item => item.endMinutes)),
  };
}

export function shouldSendScheduleReminder(resolved, nowMinutes) {
  const window = scheduleDayWindow(resolved);
  if (!window) return false;
  return nowMinutes >= window.start && nowMinutes < window.end;
}

// Stable per-hour claim key — schedule-reminder:<dateKey>:<HH> — inserted
// via an atomic ignore-duplicates insert (see insertUniqueRow below) so two
// overlapping cron invocations can't both win the right to send the same
// hour's reminder, the same claim-as-atomic-insert pattern
// api/telegram-webhook.js's claimTelegramUpdate already uses.
export function scheduleReminderClaimKey(dateKey, hour) {
  return 'schedule-reminder:' + dateKey + ':' + String(hour).padStart(2, '0');
}

export function buildScheduleReminderMessage(nowMinutes, current, next) {
  const currentLabel = current ? current.title : 'Free time';
  let msg = formatTime12(nowMinutes) + ' — ' + currentLabel + '.';
  if (next) msg += ' Next: ' + next.title + ' at ' + formatTime12(next.startMinutes) + '.';
  return msg;
}

// A temporary "pause for N minutes" auto-clears itself the first tick after
// it expires (returned as changed:true so the caller persists the clear) —
// an indefinite pause (no pausedUntil) stays paused until resume_schedule_
// reminders is called explicitly.
export function resolveScheduleReminderPause(state, nowMs) {
  const s = state && typeof state === 'object' ? state : {};
  if (s.pausedUntil && nowMs >= Number(s.pausedUntil)) {
    return { paused: false, changed: true, next: { paused: false, pausedUntil: null } };
  }
  return { paused: !!s.paused, changed: false, next: s };
}

// Mirrors the dashboard's own day-key conventions (6 AM boundary for
// goals/business, plain calendar date for gym/water/supplements/stretch),
// computed in the recipient's timezone rather than the server's.
function dateKeyInTz(tz, sixAmBoundary) {
  const local = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  if (sixAmBoundary && local.getHours() < 6) local.setDate(local.getDate() - 1);
  const y = local.getFullYear(), m = String(local.getMonth() + 1).padStart(2, '0'), d = String(local.getDate()).padStart(2, '0');
  return { key: y + '-' + m + '-' + d, dow: local.getDay() };
}

async function fetchRow(supabaseUrl, supabaseKey, key) {
  const url = supabaseUrl + '/rest/v1/app_state?key=eq.' + encodeURIComponent(key) + '&select=data';
  const r = await fetch(url, { headers: { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey } });
  if (!r.ok) return null;
  const rows = await r.json();
  return (rows && rows[0] && rows[0].data) || null;
}

async function upsertRow(supabaseUrl, supabaseKey, key, data) {
  const url = supabaseUrl + '/rest/v1/app_state?on_conflict=key';
  const r = await fetch(url, {
    method: 'POST',
    headers: { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error('state write failed: ' + r.status + ' ' + (await r.text()));
}

// Atomic ignore-duplicates insert — the primary key on `key` makes this a
// real claim across concurrent invocations, unlike fetchRow/upsertRow's
// naive read-then-write. Returns true only for the invocation that actually
// won the claim (empty response array means the row already existed).
async function insertUniqueRow(supabaseUrl, supabaseKey, key, data) {
  const url = supabaseUrl + '/rest/v1/app_state?on_conflict=key';
  const r = await fetch(url, {
    method: 'POST',
    headers: { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error('claim insert failed: ' + r.status);
  const rows = await r.json();
  return Array.isArray(rows) ? rows.length > 0 : true;
}

// A "Skip today" button whose callback_data api/telegram-webhook.js's
// callback_query handler routes into a one-day override (disabling just
// this occurrence) — Telegram caps callback_data at 64 bytes; block ids in
// this dashboard never exceed ~40 chars and dateKey is a fixed 10, so no
// truncation risk in practice.
function scheduleReminderKeyboard(blockId, dateKey) {
  return [[{ text: 'Skip today', callback_data: 'sched-skip:' + blockId + ':' + dateKey }, { text: 'Got it', callback_data: 'sched-ok' }]];
}

async function fetchAllRowMeta(supabaseUrl, supabaseKey) {
  const url = supabaseUrl + '/rest/v1/app_state?select=key,updated_at';
  const r = await fetch(url, { headers: { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey } });
  if (!r.ok) return [];
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

// ---------- Inactivity nudge ----------
// The whole system here — habit streaks, the correlation-driven morning
// nudge, the auto-drafted review — quietly degrades the longer you go
// without logging anything, with nothing telling you that's happening.
// Fires once no app_state row has genuinely changed in INACTIVITY_NUDGE_DAYS
// days. Rows excluded from "activity" are this feature's own bookkeeping
// (and the reminder engine's), which update themselves on a schedule
// regardless of whether the user has actually touched the dashboard —
// counting them would make every tick look like fresh activity.
const INACTIVITY_ACTIVITY_EXCLUDE = new Set(['reminder_state', 'subs_reminders', 'last_action', 'inactivity_nudge']);

export function computeDaysSinceActivity(rowMeta, nowMs) {
  let latest = null;
  (rowMeta || []).forEach(r => {
    if (!r || !r.key || INACTIVITY_ACTIVITY_EXCLUDE.has(r.key) || !r.updated_at) return;
    const t = new Date(r.updated_at).getTime();
    if (!isNaN(t) && (latest == null || t > latest)) latest = t;
  });
  return latest == null ? null : (nowMs - latest) / (24 * 60 * 60 * 1000);
}

// A multi-day cooldown (not the once-a-day model everything else here
// uses) — once triggered, this shouldn't repeat every tick or even every
// day, just periodically while the silence continues.
export function shouldSendInactivityNudge(daysSinceActivity, lastNudgeSentAtMs, nowMs, thresholdDays, cooldownDays) {
  if (daysSinceActivity == null || daysSinceActivity < thresholdDays) return false;
  if (lastNudgeSentAtMs && (nowMs - lastNudgeSentAtMs) < cooldownDays * 24 * 60 * 60 * 1000) return false;
  return true;
}

export function composeInactivityNudge(daysSinceActivity) {
  const days = Math.floor(daysSinceActivity);
  return 'Haven\'t heard from you in ' + days + ' day' + (days === 1 ? '' : 's')
    + ' — no pressure, just checking in. Your dashboard\'s here whenever you\'re ready.';
}

function waterDoneToday(healthData, todayPlain) {
  const w = healthData && healthData['po_water_v1'];
  if (!w || !w.profile || !w.profile.weightKg) return false;
  const p = w.profile;
  const wKg = w.weightUnit === 'lb' ? p.weightKg / 2.20462 : p.weightKg;
  const base = wKg * 35, exercise = (p.activityHrsPerWeek || 0) / 7 * 500, caffeine = Math.max(0, (w.caffeineMgPerDay || 0) - 200) * 1.5;
  let adjust = 0; if (p.sex === 'm') adjust += 200; if ((p.age || 0) >= 50) adjust += 100;
  const totalMl = base + exercise + caffeine + adjust;
  let unitMl = 1; if (w.unit === 'bottle') unitMl = w.bottleMl || 500; else if (w.unit === 'glass') unitMl = w.glassMl || 250; else if (w.unit === 'oz') unitMl = 30;
  const targetUnits = Math.ceil(totalMl / unitMl);
  const count = (w.logs && w.logs[todayPlain]) || 0;
  return targetUnits > 0 && count >= targetUnits;
}

function isScheduledToday(def, dow) {
  if (def.freq === 'daily') return true;
  if (def.freq === 'days') return Array.isArray(def.days) && def.days.indexOf(dow) !== -1;
  return false;
}

function sourceDoneToday(autoSource, ctx) {
  const { gymData, readingData, businessData, healthData, todayPlain, todayKey6am, utcToday } = ctx;
  if (autoSource === 'gym') {
    const doneDays = gymData && gymData['po_coach_workout_done'];
    return !!(doneDays && doneDays[todayPlain]);
  }
  if (autoSource === 'reading') {
    const items = readingData && readingData['reading:items'];
    return Array.isArray(items) && items.some(it => Array.isArray(it.sessions) && it.sessions.some(s => s.date === utcToday));
  }
  if (autoSource === 'stretch_am' || autoSource === 'stretch_pm') {
    const items = gymData && gymData[autoSource === 'stretch_am' ? 'stretch:am:items' : 'stretch:pm:items'];
    const log = (gymData && gymData['stretch:log']) || {};
    if (!Array.isArray(items) || !items.length) return false;
    return items.every(it => log[it.id] && log[it.id][todayPlain]);
  }
  if (autoSource === 'business') {
    const commitLog = (businessData && businessData['biz:affiliate:commitLog']) || {};
    const delivery = (businessData && businessData['biz:editing:deliveryLog']) || {};
    const revenue = (businessData && businessData['biz:affiliate:revenue']) || [];
    const payments = (businessData && businessData['biz:editing:payments']) || [];
    const anyCommit = Object.keys(commitLog).some(cid => commitLog[cid] && commitLog[cid][todayKey6am]);
    const anyDelivery = Object.keys(delivery).some(cid => (delivery[cid] || {})[todayKey6am] > 0);
    const anyRevenue = revenue.some(r => r.date === todayKey6am) || payments.some(p => p.date === todayKey6am);
    return anyCommit || anyDelivery || anyRevenue;
  }
  if (autoSource === 'water') return waterDoneToday(healthData, todayPlain);
  if (autoSource === 'supplements') {
    const items = healthData && healthData['stack:items'];
    const taken = (healthData && healthData['stack:taken:' + todayKey6am]) || {};
    if (!Array.isArray(items) || !items.length) return false;
    return items.every(it => taken[it.id]);
  }
  if (autoSource === 'peak_morning') {
    // sleep.html's night log uses a plain calendar date, same as todayPlain
    // here (kept the historical 'peak_morning' autoSource name so an
    // already-saved recurring item keeps auto-checking without a silent break).
    const nights = (ctx.sleepData && ctx.sleepData['sleep:nights']) || {};
    return !!nights[todayPlain];
  }
  if (autoSource === 'food') {
    const entries = (healthData && healthData['cal:entries']) || [];
    return entries.some(e => e && e.dateKey === todayPlain);
  }
  if (autoSource === 'weight') {
    const entries = (gymData && gymData['po_coach_weights']) || [];
    return entries.some(e => e && e.dateKey === todayPlain);
  }
  return false;
}

// ---------- Delivery: Telegram, Twilio SMS, or free email-to-SMS carrier gateway ----------
// Prefers Telegram if configured, then Twilio, then falls back to emailing
// your carrier's SMS gateway address (e.g. 5551234567@vtext.com) via Resend.
// Either way this returns a small result object; the caller doesn't need to
// know which path was used.
async function sendViaTelegram(body, opts) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  const payload = { chat_id: chatId, text: body };
  if (opts && opts.inlineKeyboard) payload.reply_markup = { inline_keyboard: opts.inlineKeyboard };
  const res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error('telegram send failed: ' + JSON.stringify(json));
  return { method: 'telegram', id: json.result && json.result.message_id };
}

// A single "✅ Done" button whose callback_data api/telegram-webhook.js's
// callback_query handler routes straight into execMarkTodoDone — the same
// fuzzy-match-and-materialize path a typed "mark X done" chat message
// already goes through, so tapping it is exactly equivalent to marking the
// item done via chat. Telegram caps callback_data at 64 bytes; the 'done:'
// prefix (5 bytes) leaves 59 for the name, and truncating is safe here since
// execMarkTodoDone's fuzzy match already accepts either side containing the
// other — a truncated prefix still matches the full stored name.
function doneButton(name) {
  return [[{ text: '✅ Done', callback_data: 'done:' + String(name).slice(0, 59) }]];
}

async function sendViaTwilio(body) {
  const twSid = process.env.TWILIO_ACCOUNT_SID, twToken = process.env.TWILIO_AUTH_TOKEN;
  const twFrom = process.env.TWILIO_FROM_NUMBER, twTo = process.env.TWILIO_TO_NUMBER;
  const twRes = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + twSid + '/Messages.json', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(twSid + ':' + twToken).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: twTo, From: twFrom, Body: body }).toString(),
  });
  const twJson = await twRes.json();
  if (!twRes.ok) throw new Error('twilio send failed: ' + JSON.stringify(twJson));
  return { method: 'twilio', id: twJson.sid };
}

async function sendViaEmailGateway(body) {
  const resendKey = process.env.RESEND_API_KEY;
  const gatewayTo = process.env.SMS_GATEWAY_TO; // full address, e.g. 5551234567@vtext.com
  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
    // Blank subject on purpose — some carriers prepend the subject to the
    // delivered text, which would duplicate content. Keep the body short;
    // long messages get truncated or split oddly by carrier gateways.
    body: JSON.stringify({ from, to: [gatewayTo], subject: '', text: body }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('resend send failed: ' + JSON.stringify(json));
  return { method: 'email-gateway', id: json.id };
}

// opts.inlineKeyboard is Telegram-only (ignored by the Twilio/email-gateway
// paths, which have no concept of tappable buttons) — see doneButton() above.
export async function sendReminder(body, opts) {
  const tgConfigured = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID;
  const twConfigured = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER && process.env.TWILIO_TO_NUMBER;
  const emailConfigured = process.env.RESEND_API_KEY && process.env.SMS_GATEWAY_TO;
  if (tgConfigured) return sendViaTelegram(body, opts);
  if (twConfigured) return sendViaTwilio(body);
  if (emailConfigured) return sendViaEmailGateway(body);
  throw new Error('no delivery method configured — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, the TWILIO_* vars, or RESEND_API_KEY + SMS_GATEWAY_TO');
}

// Recurring items scheduled today and still undone — exported separately so
// it can be exercised directly in tests without going through req/res or
// real network calls. Returns bare names (unchanged shape from before);
// the handler looks up each name's def.time itself.
export async function computeUndone(fetchers) {
  const { goalsData, healthData, gymData, businessData, readingData, peakData, sleepData, todayKey6am, todayPlain, dow, utcToday } = fetchers;
  const defs = (goalsData && goalsData['recur:defs']) || [];
  const existingGoals = (goalsData && goalsData['goals:' + todayKey6am]) || [];
  const existingByText = {};
  existingGoals.forEach(g => { existingByText[g.text] = g; });

  const ctx = { gymData, readingData, businessData, healthData, peakData, sleepData, todayPlain, todayKey6am, utcToday };
  const undone = [];
  defs.forEach(def => {
    if (!isScheduledToday(def, dow)) return;
    const existing = existingByText[def.name];
    let done = existing ? !!existing.done : false;
    if (!done && def.autoSource) done = sourceDoneToday(def.autoSource, ctx);
    if (!done) undone.push(def.name);
  });
  return undone;
}

// One-off (non-recurring) to-dos with a time set — added via the Schedule/
// Calendar time field — that aren't already covered by a recurring def of
// the same name. These get individually reminded the same as recurring
// items with an explicit time.
export function computeOneOffTimedUndone(goalsData, todayKey6am, defs) {
  const existingGoals = (goalsData && goalsData['goals:' + todayKey6am]) || [];
  const defNames = new Set((defs || []).map(d => d.name));
  return existingGoals
    .filter(g => g.time && !g.done && !defNames.has(g.text))
    .map(g => ({ name: g.text, time: g.time }));
}

// One-off to-dos with NO time set at all (plain items typed into main.html's
// list) — previously invisible to this whole engine, since only timed
// one-offs (above) and recurring items were ever reminded. These get their
// own individual message too, defaulting to GENERIC_ITEM_DEFAULT_MIN via
// effectiveTimeMinutes downstream, same as an untimed recurring item.
export function computeUntimedGoalsUndone(goalsData, todayKey6am, defs) {
  const existingGoals = (goalsData && goalsData['goals:' + todayKey6am]) || [];
  const defNames = new Set((defs || []).map(d => d.name));
  return existingGoals
    .filter(g => !g.time && !g.done && !defNames.has(g.text))
    .map(g => ({ name: g.text, time: null }));
}

// Daily habits (main.html's separate "Daily Habits" tracker, habits:defs /
// habits:log) — same 6am day boundary as goals, and same as untimed goals
// above, these had never been wired into the reminder engine at all.
export function computeHabitsUndone(goalsData, todayKey6am) {
  const defs = (goalsData && goalsData['habits:defs']) || [];
  const log = (goalsData && goalsData['habits:log']) || {};
  return defs
    .filter(h => h && h.name && !(log[h.id] && log[h.id][todayKey6am]))
    .map(h => ({ name: h.name, time: null }));
}

// Sends at most one hourly Weekly Schedule reminder per real clock hour,
// stating the current block/appointment and what's next — see
// scheduleDayWindow/shouldSendScheduleReminder/buildScheduleReminderMessage
// above for the actual decision logic, kept pure and unit-tested
// separately from this orchestration. Returns null when there's nothing to
// report (paused, no active schedule today, outside the day's own active
// window, or this hour was already sent/claimed) — the caller only pushes
// a result entry when this returns something concrete.
export async function runScheduleReminder(supabaseUrl, supabaseKey) {
  const [scheduleRow, pauseState] = await Promise.all([
    fetchRow(supabaseUrl, supabaseKey, 'schedule'),
    fetchRow(supabaseUrl, supabaseKey, 'schedule_reminder_pause'),
  ]);
  const { paused, changed, next: nextPauseState } = resolveScheduleReminderPause(pauseState, Date.now());
  if (changed) await upsertRow(supabaseUrl, supabaseKey, 'schedule_reminder_pause', nextPauseState);
  if (paused) return null;

  const model = normalizeScheduleModel(scheduleRow && scheduleRow['schedule:model_v1']);
  const { dateKey, minutes, hour } = scheduleNowParts();
  const resolved = resolveScheduleForDate(model, dateKey);
  if (!shouldSendScheduleReminder(resolved, minutes)) return null;

  const claimKey = scheduleReminderClaimKey(dateKey, hour);
  const claimed = await insertUniqueRow(supabaseUrl, supabaseKey, claimKey, { sentAt: Date.now() });
  if (!claimed) return null; // this hour was already sent — by this tick or a concurrent one

  const { current, next } = currentAndNextForDate(resolved, minutes);
  const message = buildScheduleReminderMessage(minutes, current, next);
  const keyboard = current && current.kind === 'block' ? scheduleReminderKeyboard(current.id, dateKey) : undefined;
  await sendReminder(message, keyboard ? { inlineKeyboard: keyboard } : undefined);
  return { name: '__schedule_reminder__', message };
}

export default async function handler(req, res) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const auth = req.headers.authorization || '';
      if (auth !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'unauthorized' });
    }

    const tz = process.env.REMINDER_TIMEZONE || 'America/New_York';
    const bedtimeMin = parseHM(process.env.BEDTIME_LOCAL || '23:00');
    const morningBriefingMin = parseHM(process.env.MORNING_BRIEFING_TIME || MORNING_BRIEFING_DEFAULT_TIME);
    const nowMin = minutesInTz(tz);

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return res.status(500).json({ error: 'Supabase env vars not configured' });

    const [goalsData, healthData, gymData, businessData, readingData, peakData, sleepData, financeData, stateRow, subsRemindedRow, caffeineData] = await Promise.all([
      fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'goals'),
      fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'health'),
      fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'po-coach'),
      fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'business'),
      fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'reading'),
      fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'peak'),
      fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'sleep'),
      fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'finance'),
      fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'reminder_state'),
      fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'subs_reminders'),
      fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'caffeine'),
    ]);

    const { key: todayKey6am, dow } = dateKeyInTz(tz, true);
    const { key: todayPlain } = dateKeyInTz(tz, false);
    const utcToday = new Date().toISOString().slice(0, 10);

    const defs = (goalsData && goalsData['recur:defs']) || [];
    const undoneRecurNames = await computeUndone({ goalsData, healthData, gymData, businessData, readingData, peakData, sleepData, todayKey6am, todayPlain, dow, utcToday });
    const recurItems = undoneRecurNames.map(name => ({ name, time: (defs.find(d => d.name === name) || {}).time || null }));
    const oneOffItems = computeOneOffTimedUndone(goalsData, todayKey6am, defs);
    const untimedGoalItems = computeUntimedGoalsUndone(goalsData, todayKey6am, defs);
    const habitItems = computeHabitsUndone(goalsData, todayKey6am);
    const allItems = recurItems.concat(oneOffItems, untimedGoalItems, habitItems);

    const todayState = (stateRow && stateRow[todayKey6am]) || {};
    const dueIndividual = [];
    // sleep.html's night log uses a plain calendar date, same as todayPlain.
    const lastNightMorning = (sleepData && sleepData['sleep:nights'] && sleepData['sleep:nights'][todayPlain]) || null;
    const lastNightSleepQuality = lastNightMorning ? lastNightMorning.sleepQuality : null;

    // Every item gets its own effective time now (explicit, name-based, or
    // the GENERIC_ITEM_DEFAULT_MIN default) and its own independent per-item
    // state/re-nag cadence — so an undone generic to-do or habit becomes its
    // own separate text, not lumped into one big bundled message with
    // everything else that's also undone.
    allItems.forEach(({ name, time }) => {
      const eff = effectiveTimeMinutes(name, time, bedtimeMin, todayKey6am, lastNightSleepQuality);
      const st = todayState[name];
      if (shouldSendNow(st, nowMin, eff, bedtimeMin)) {
        dueIndividual.push({ name, count: st ? st.count : 0 });
      }
    });

    const feelingCheckinDue = shouldSendFeelingCheckin(peakData, nowMin, bedtimeMin, todayState.__feeling_checkin__);
    const subsRemindedMap = subsRemindedRow || {};
    const dueSubs = subsRenewalsDue((financeData && financeData.subs) || [], todayPlain, subsRemindedMap);
    const morningBriefingDue = shouldSendMorningBriefing(nowMin, morningBriefingMin, bedtimeMin, todayState.__morning_briefing__);

    // Reactive low-energy nudge — reuses today's actual wake time from
    // sleep.html if logged, falling back to a default, since that's already
    // fetched above for computeUndone() (no extra reads).
    const cafLogs = (caffeineData && caffeineData['caf:logs']) || [];
    const nicLogs = (caffeineData && caffeineData['nic:logs']) || [];
    const wakeHour = lastNightMorning && lastNightMorning.wakeTime
      ? parseHM(lastNightMorning.wakeTime) / 60
      : ENERGY_DEFAULT_WAKE_HOUR;
    const nowTs = Date.now();
    const nowHour = nowMin / 60;
    const currentEnergy = computeCurrentEnergy(cafLogs, wakeHour, nowHour, nowTs);
    const lastStimulantTs = cafLogs.concat(nicLogs)
      .reduce((max, l) => (l && typeof l.ts === 'number' && l.ts > max ? l.ts : max), -Infinity);
    const energyNudgeDue = shouldSendEnergyNudge(
      currentEnergy, nowMin, lastStimulantTs === -Infinity ? null : lastStimulantTs, nowTs, todayState.__energy_nudge__
    );

    // Only checked during the same waking window as the morning briefing —
    // no reason to evaluate this (extra Supabase reads) on every 15-minute
    // tick around the clock, and it keeps the "quiet checking in" tone from
    // ever landing at 3am.
    let inactivityNudgeDue = false, daysSinceActivity = null;
    const inactivityWindowOk = nowMin >= morningBriefingMin && nowMin < bedtimeMin;
    if (inactivityWindowOk) {
      const [allRowMeta, nudgeStateRow] = await Promise.all([
        fetchAllRowMeta(SUPABASE_URL, SUPABASE_ANON_KEY),
        fetchRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'inactivity_nudge'),
      ]);
      daysSinceActivity = computeDaysSinceActivity(allRowMeta, Date.now());
      const inactivityNudgeDays = Number(process.env.INACTIVITY_NUDGE_DAYS || 3);
      const lastNudgeSentAtMs = (nudgeStateRow && nudgeStateRow.lastSentAt) || null;
      inactivityNudgeDue = shouldSendInactivityNudge(daysSinceActivity, lastNudgeSentAtMs, Date.now(), inactivityNudgeDays, inactivityNudgeDays);
    }

    if (!dueIndividual.length && !feelingCheckinDue && !dueSubs.length && !morningBriefingDue && !inactivityNudgeDue && !energyNudgeDue) {
      return res.status(200).json({ sent: false, reason: 'nothing due right now', nowMin, bedtimeMin });
    }

    const results = [];
    let stateChanged = false;
    if (inactivityNudgeDue) {
      const body = composeInactivityNudge(daysSinceActivity);
      try {
        const result = await sendReminder(body);
        await upsertRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'inactivity_nudge', { lastSentAt: Date.now() });
        results.push({ name: '__inactivity_nudge__', method: result.method });
      } catch (e) {
        results.push({ name: '__inactivity_nudge__', error: e && e.message ? e.message : String(e) });
      }
    }
    if (morningBriefingDue) {
      const todayNames = undoneRecurNames.concat(oneOffItems.map(i => i.name));
      const workoutDoneToday = !!((gymData && gymData['po_coach_workout_done'] || {})[todayPlain]);
      const actionableInsight = computeActionableInsight(caffeineData, sleepData, peakData, gymData, workoutDoneToday);
      // No extra Supabase reads needed — goalsData/gymData/sleepData are
      // already fetched above for computeUndone().
      const driftDayRows = computeDriftDayRows(dateKeysBackFromPlain(DRIFT_BASELINE_DAYS, todayPlain), goalsData, gymData, sleepData);
      const driftInsight = computeDriftInsight(driftDayRows);
      const body = composeMorningBriefing(todayNames, lastNightSleepQuality, dueSubs.length, actionableInsight, driftInsight);
      try {
        const result = await sendReminder(body);
        todayState.__morning_briefing__ = true;
        stateChanged = true;
        results.push({ name: '__morning_briefing__', method: result.method });
      } catch (e) {
        results.push({ name: '__morning_briefing__', error: e && e.message ? e.message : String(e) });
      }
    }
    // Only ONE individual item goes out per tick, even when several are due
    // at once — otherwise every simultaneously-overdue item fires in the
    // same invocation and lands as a burst of texts within the same minute,
    // which reads exactly like the old bundled digest even though they're
    // technically separate messages. Whatever's left stays due (no state
    // written for it) and gets picked up on a later tick instead, so
    // multiple undone things drip out one at a time, spaced by however often
    // the scheduler actually runs, rather than all landing together.
    for (const { name, count } of dueIndividual.slice(0, MAX_INDIVIDUAL_SENDS_PER_TICK)) {
      const body = composeSingleMessage(name, todayKey6am, count);
      try {
        const result = await sendReminder(body, { inlineKeyboard: doneButton(name) });
        todayState[name] = { count: count + 1, lastMinutes: nowMin };
        stateChanged = true;
        results.push({ name, method: result.method });
      } catch (e) {
        results.push({ name, error: e && e.message ? e.message : String(e) });
      }
    }
    if (feelingCheckinDue) {
      const body = pickFeelingPrompt(todayKey6am, nowMin);
      try {
        const result = await sendReminder(body);
        todayState.__feeling_checkin__ = { lastMinutes: nowMin };
        stateChanged = true;
        results.push({ name: '__feeling_checkin__', method: result.method });
      } catch (e) {
        results.push({ name: '__feeling_checkin__', error: e && e.message ? e.message : String(e) });
      }
    }
    if (energyNudgeDue) {
      const body = composeEnergyNudge(currentEnergy);
      try {
        const result = await sendReminder(body);
        todayState.__energy_nudge__ = { lastMinutes: nowMin };
        stateChanged = true;
        results.push({ name: '__energy_nudge__', method: result.method });
      } catch (e) {
        results.push({ name: '__energy_nudge__', error: e && e.message ? e.message : String(e) });
      }
    }
    let subsRemindedChanged = false;
    if (dueSubs.length) {
      const body = composeSubsMessage(dueSubs);
      try {
        const result = await sendReminder(body);
        dueSubs.forEach(s => { subsRemindedMap[s.remindKey] = true; });
        subsRemindedChanged = true;
        results.push({ name: '__subs_reminder__', items: dueSubs.map(s => s.name), method: result.method });
      } catch (e) {
        results.push({ name: '__subs_reminder__', items: dueSubs.map(s => s.name), error: e && e.message ? e.message : String(e) });
      }
    }
    if (subsRemindedChanged) {
      // Its own row, unlike reminder_state — this one must persist across
      // days (a renewal 3 days out shouldn't re-remind on day 2 of the
      // window), so nothing here gets pruned on write.
      await upsertRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'subs_reminders', subsRemindedMap);
    }

    if (stateChanged) {
      // Only today's bucket is kept — older dateKeys are dropped rather
      // than accumulating forever, since nothing ever reads them again.
      await upsertRow(SUPABASE_URL, SUPABASE_ANON_KEY, 'reminder_state', { [todayKey6am]: todayState });
    }

    // Weekly Schedule hourly reminder — isolated in its own try/catch so a
    // problem here (or Supabase not yet having a 'schedule' row for anyone
    // who hasn't visited schedule.html) can never break the rest of this
    // handler's already-working reminders.
    try {
      const scheduleReminderResult = await runScheduleReminder(SUPABASE_URL, SUPABASE_ANON_KEY);
      if (scheduleReminderResult) results.push(scheduleReminderResult);
    } catch (e) {
      results.push({ name: '__schedule_reminder__', error: e && e.message ? e.message : String(e) });
    }

    return res.status(200).json({ sent: results.some(r => !r.error), results, nowMin, bedtimeMin });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
