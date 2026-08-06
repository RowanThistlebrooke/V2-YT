import {
  scheduleNowParts, scheduleDayWindow, shouldSendScheduleReminder, scheduleReminderClaimKey,
  buildScheduleReminderMessage, resolveScheduleReminderPause, runScheduleReminder,
} from '../api/send-reminders.js';
import { buildDefaultScheduleModel, resolveScheduleForDate, currentAndNextForDate } from '../schedule-model.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

const model = buildDefaultScheduleModel();
const wed = resolveScheduleForDate(model, '2026-07-29');
const sunday = resolveScheduleForDate(model, '2026-08-02');
const fri = resolveScheduleForDate(model, '2026-07-31');

// ==================== scheduleNowParts (America/New_York, fixed constant) ====================
{
  // 2026-01-15T04:30:00Z is 2026-01-14 23:30 in New York (EST, UTC-5).
  const ts = Date.UTC(2026, 0, 15, 4, 30);
  const parts = scheduleNowParts(ts);
  assertEq(parts.dateKey, '2026-01-14', 'scheduleNowParts converts to America/New_York regardless of REMINDER_TIMEZONE');
  assertEq(parts.hour, 23, 'scheduleNowParts computes the correct hour across a UTC day boundary');
  assertEq(parts.minutes, 23 * 60 + 30, 'scheduleNowParts computes minutes-since-midnight correctly');
}

// ==================== scheduleDayWindow / shouldSendScheduleReminder ====================
{
  assertEq(scheduleDayWindow(sunday), null, 'a day with nothing scheduled (Sunday) has no window at all');
  assertEq(shouldSendScheduleReminder(sunday, 12 * 60), false, 'no reminder ever fires on a day with no active schedule');

  const wedWindow = scheduleDayWindow(wed);
  assertEq(wedWindow, { start: 7 * 60, end: 23 * 60 }, 'a normal weekday\'s window spans wake to sleep target');
  assertTrue(shouldSendScheduleReminder(wed, 8 * 60 + 30), 'a time inside the window sends');
  assertTrue(!shouldSendScheduleReminder(wed, 6 * 60), 'a time before the window (too early) does not send');
  assertTrue(!shouldSendScheduleReminder(wed, 23 * 60 + 30), 'a time after the window (too late) does not send');

  const friWindow = scheduleDayWindow(fri);
  assertEq(friWindow.end, 24 * 60, 'Friday\'s window correctly extends to the midnight (24:00) marker');
  assertTrue(shouldSendScheduleReminder(fri, 23 * 60 + 50), 'a time just before midnight still sends on a day using the extended marker');
}

// ==================== scheduleReminderClaimKey ====================
{
  assertEq(scheduleReminderClaimKey('2026-07-29', 8), 'schedule-reminder:2026-07-29:08', 'the claim key zero-pads a single-digit hour');
  assertEq(scheduleReminderClaimKey('2026-07-29', 23), 'schedule-reminder:2026-07-29:23', 'the claim key formats a two-digit hour unchanged');
}

// ==================== buildScheduleReminderMessage ====================
{
  const { current, next } = currentAndNextForDate(wed, 8 * 60 + 45);
  const msg = buildScheduleReminderMessage(8 * 60 + 45, current, next);
  assertTrue(msg.includes('8:45 AM'), 'the message states the current wall-clock time');
  assertTrue(msg.includes('Gym'), 'the message states the current block');
  assertTrue(msg.includes('Next:') && msg.includes('Train to Central Park'), 'the message states the next block by name');

  const lateNight = currentAndNextForDate(wed, 23 * 60 + 30);
  assertEq(lateNight.next, null, 'sanity check: nothing remains after the Sleep target milestone has passed');
  const lateMsg = buildScheduleReminderMessage(23 * 60 + 30, lateNight.current, lateNight.next);
  assertTrue(!lateMsg.includes('Next:'), 'a message with no next block omits the "Next:" clause entirely rather than a dangling one');

  const gapMsg = buildScheduleReminderMessage(12 * 60, null, { title: 'Lunch', startMinutes: 13 * 60 });
  assertTrue(gapMsg.startsWith('12:00 PM — Free time.'), 'a gap between blocks reports "Free time" rather than a blank/undefined current label');
}

// ==================== resolveScheduleReminderPause ====================
{
  assertEq(resolveScheduleReminderPause(null, Date.now()), { paused: false, changed: false, next: {} }, 'no pause row at all means not paused');
  assertEq(resolveScheduleReminderPause({ paused: true, pausedUntil: null }, Date.now()).paused, true, 'an indefinite pause (no pausedUntil) stays paused');
  assertEq(resolveScheduleReminderPause({ paused: true, pausedUntil: null }, Date.now()).changed, false, 'an indefinite pause never auto-clears on its own');

  const future = Date.now() + 60 * 60 * 1000;
  const notYetExpired = resolveScheduleReminderPause({ paused: true, pausedUntil: future }, Date.now());
  assertEq(notYetExpired, { paused: true, changed: false, next: { paused: true, pausedUntil: future } }, 'a timed pause that has not expired yet stays paused, unchanged');

  const past = Date.now() - 1000;
  const expired = resolveScheduleReminderPause({ paused: true, pausedUntil: past }, Date.now());
  assertEq(expired, { paused: false, changed: true, next: { paused: false, pausedUntil: null } }, 'a timed pause past its pausedUntil auto-clears and reports changed:true so the caller persists it');
}

// ==================== runScheduleReminder (full integration, fake Supabase + Telegram) ====================
function makeFakeBackend(seed) {
  const rows = JSON.parse(JSON.stringify(seed || {}));
  const sent = [];
  async function fetchStub(url, opts) {
    const u = String(url);
    if (u.includes('sendMessage')) { sent.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }; }
    if (u.includes('/rest/v1/app_state')) {
      if (!opts || !opts.method || opts.method === 'GET') {
        const key = decodeURIComponent(u.match(/key=eq\.([^&]+)/)[1]);
        return { ok: true, json: async () => (key in rows ? [{ data: rows[key] }] : []) };
      }
      if (opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        const isIgnoreDuplicates = (opts.headers.Prefer || '').includes('ignore-duplicates');
        if (isIgnoreDuplicates) {
          if (body.key in rows) return { ok: true, json: async () => [] }; // conflict — already claimed
          rows[body.key] = body.data;
          return { ok: true, json: async () => [{ key: body.key, data: body.data }] };
        }
        rows[body.key] = body.data; // merge-duplicates upsert
        return { ok: true, json: async () => ({}) };
      }
    }
    throw new Error('unexpected fetch: ' + u);
  }
  return { rows, sent, fetchStub };
}

function freezeAt(utcMs) {
  const OrigDate = global.Date;
  class FrozenDate extends OrigDate {
    constructor(...args) { if (args.length === 0) super(utcMs); else super(...args); }
    static now() { return utcMs; }
  }
  global.Date = FrozenDate;
  return () => { global.Date = OrigDate; };
}

(async () => {
  const origFetch = global.fetch;
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  process.env.TELEGRAM_CHAT_ID = '123';

  // Wednesday 2026-07-29, 08:45 America/New_York = 12:45 UTC.
  const wedMorningUtc = Date.UTC(2026, 6, 29, 12, 45);

  {
    const unfreeze = freezeAt(wedMorningUtc);
    const backend = makeFakeBackend({ schedule: { 'schedule:model_v1': model } });
    global.fetch = backend.fetchStub;
    const result = await runScheduleReminder('https://fake.supabase.co', 'anon');
    assertTrue(!!result, 'a reminder is sent during the active window on a normal weekday');
    assertEq(backend.sent.length, 1, 'exactly one Telegram message is sent');
    assertTrue(backend.sent[0].text.includes('Gym'), 'the sent message names the current block');
    assertTrue(!!backend.sent[0].reply_markup, 'a routine block reminder includes an inline keyboard');
    assertTrue(JSON.stringify(backend.sent[0].reply_markup).includes('sched-skip:'), 'the keyboard\'s callback_data uses the sched-skip: prefix');
    unfreeze();
  }

  {
    // Same tick fired twice — the second call must be a no-op (claim already taken).
    const unfreeze = freezeAt(wedMorningUtc);
    const backend = makeFakeBackend({ schedule: { 'schedule:model_v1': model } });
    global.fetch = backend.fetchStub;
    await runScheduleReminder('https://fake.supabase.co', 'anon');
    const second = await runScheduleReminder('https://fake.supabase.co', 'anon');
    assertEq(second, null, 'a second invocation within the same hour sends nothing — the per-hour claim prevents a duplicate');
    assertEq(backend.sent.length, 1, 'only one message was ever actually sent across both invocations');
    unfreeze();
  }

  {
    // Sunday — no active schedule at all.
    const sundayUtc = Date.UTC(2026, 7, 2, 16, 0); // noon America/New_York
    const unfreeze = freezeAt(sundayUtc);
    const backend = makeFakeBackend({ schedule: { 'schedule:model_v1': model } });
    global.fetch = backend.fetchStub;
    const result = await runScheduleReminder('https://fake.supabase.co', 'anon');
    assertEq(result, null, 'no reminder is sent on Sunday, which has no active schedule at all');
    assertEq(backend.sent.length, 0, 'nothing is sent to Telegram on a day with no schedule');
    unfreeze();
  }

  {
    // Paused indefinitely.
    const unfreeze = freezeAt(wedMorningUtc);
    const backend = makeFakeBackend({ schedule: { 'schedule:model_v1': model }, schedule_reminder_pause: { paused: true, pausedUntil: null } });
    global.fetch = backend.fetchStub;
    const result = await runScheduleReminder('https://fake.supabase.co', 'anon');
    assertEq(result, null, 'a paused schedule sends nothing even during an otherwise-active window');
    assertEq(backend.sent.length, 0, 'nothing is sent to Telegram while paused');
    unfreeze();
  }

  {
    // A pause that just expired auto-clears and still sends this tick.
    const unfreeze = freezeAt(wedMorningUtc);
    const backend = makeFakeBackend({ schedule: { 'schedule:model_v1': model }, schedule_reminder_pause: { paused: true, pausedUntil: wedMorningUtc - 1000 } });
    global.fetch = backend.fetchStub;
    const result = await runScheduleReminder('https://fake.supabase.co', 'anon');
    assertTrue(!!result, 'once a timed pause has expired, this tick sends normally again');
    assertEq(backend.rows.schedule_reminder_pause, { paused: false, pausedUntil: null }, 'the expired pause is persisted as cleared');
    unfreeze();
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
