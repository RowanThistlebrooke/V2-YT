import handler, {
  computeDaysSinceActivity, shouldSendInactivityNudge, composeInactivityNudge,
} from '../api/send-reminders.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function mockRes() {
  const res = { _status: null, _body: null };
  res.status = (s) => { res._status = s; return res; };
  res.json = (b) => { res._body = b; return res; };
  return res;
}

function freezeClockAt(hour, minute) {
  const OrigDate = global.Date;
  const real = new OrigDate();
  const fixedMs = OrigDate.UTC(real.getUTCFullYear(), real.getUTCMonth(), real.getUTCDate(), hour, minute, 0, 0);
  class FrozenDate extends OrigDate {
    constructor(...args) { if (args.length === 0) super(fixedMs); else super(...args); }
    static now() { return fixedMs; }
  }
  global.Date = FrozenDate;
  return () => { global.Date = OrigDate; };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ==================== computeDaysSinceActivity (pure) ====================
{
  const now = Date.UTC(2026, 0, 10);
  const rows = [
    { key: 'goals', updated_at: new Date(now - 5 * DAY_MS).toISOString() },
    { key: 'notes', updated_at: new Date(now - 2 * DAY_MS).toISOString() }, // most recent genuine activity
    { key: 'reminder_state', updated_at: new Date(now).toISOString() }, // bookkeeping — excluded
    { key: 'last_action', updated_at: new Date(now).toISOString() }, // bookkeeping — excluded
  ];
  const days = computeDaysSinceActivity(rows, now);
  assertTrue(Math.abs(days - 2) < 1e-9, 'picks the most recent NON-bookkeeping row (2 days ago, not the 0-day bookkeeping rows)');

  assertEq(computeDaysSinceActivity([], now), null, 'no rows at all -> null (never nag a totally fresh install)');
  assertEq(computeDaysSinceActivity(
    [{ key: 'reminder_state', updated_at: new Date(now).toISOString() }], now
  ), null, 'only bookkeeping rows present -> null, not "0 days"');
  assertEq(computeDaysSinceActivity([{ key: 'goals' }], now), null, 'a row with no updated_at is ignored rather than crashing');
}

// ==================== shouldSendInactivityNudge (pure) ====================
{
  const now = Date.UTC(2026, 0, 10);
  assertEq(shouldSendInactivityNudge(null, null, now, 3, 3), false, 'no activity history at all -> never nudge');
  assertEq(shouldSendInactivityNudge(2, null, now, 3, 3), false, 'below the threshold -> not due yet');
  assertEq(shouldSendInactivityNudge(3, null, now, 3, 3), true, 'exactly at the threshold, never nudged before -> due');
  assertEq(shouldSendInactivityNudge(10, null, now, 3, 3), true, 'well past the threshold, never nudged before -> due');

  const lastSent = now - 1 * DAY_MS;
  assertEq(shouldSendInactivityNudge(10, lastSent, now, 3, 3), false, 'still within the cooldown since the last nudge -> suppressed');
  const lastSentLongAgo = now - 4 * DAY_MS;
  assertEq(shouldSendInactivityNudge(10, lastSentLongAgo, now, 3, 3), true, 'cooldown has elapsed since the last nudge, still inactive -> due again');
}

// ==================== composeInactivityNudge (pure) ====================
{
  const one = composeInactivityNudge(1.9);
  assertTrue(one.includes('1 day') && !one.includes('1 days'), 'singular phrasing for a single day (floored)');
  const many = composeInactivityNudge(5.2);
  assertTrue(many.includes('5 days'), 'plural phrasing for multiple days');
  assertTrue(one.toLowerCase().includes('no pressure'), 'the tone is gentle, not alarming');
}

// ==================== full handler integration ====================
{
  const unfreeze = freezeClockAt(8, 0); // within the waking window (07:00 briefing time .. 23:59 bedtime)
  try {
    process.env.TELEGRAM_BOT_TOKEN = 'tok'; process.env.TELEGRAM_CHAT_ID = '123';
    process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_ANON_KEY = 'anon';
    process.env.REMINDER_TIMEZONE = 'UTC';
    process.env.BEDTIME_LOCAL = '23:59';
    process.env.INACTIVITY_NUDGE_DAYS = '3';
    delete process.env.MORNING_BRIEFING_TIME;
    delete process.env.CRON_SECRET;

    const now = Date.now();
    let sentText = null;
    let writtenNudgeState = null;
    const rows = {
      goals: {}, peak: {},
      // Morning briefing already fired today, so it won't fire again and
      // muddy this test — only the inactivity nudge should be due.
      // __energy_nudge__ is pre-cooled-down too — this test isn't about the
      // reactive low-energy nudge, and 8am with no caffeine logged is
      // exactly the kind of moment that nudge is designed to fire in.
      reminder_state: { [new Date(now).toISOString().slice(0, 10)]: { __morning_briefing__: true, __energy_nudge__: { lastMinutes: 8 * 60 } } },
      // The most recent genuine activity was 10 days ago -> well past the
      // 3-day threshold, and no inactivity_nudge row yet -> due.
      notes: { 'notes:items': [] },
    };
    const rowMeta = [
      { key: 'notes', updated_at: new Date(now - 10 * DAY_MS).toISOString() },
      { key: 'reminder_state', updated_at: new Date(now).toISOString() },
    ];

    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/rest/v1/app_state')) {
        if (!opts || !opts.method) {
          const m = u.match(/key=eq\.([^&]+)/);
          if (!m) return { ok: true, json: async () => rowMeta };
          const key = decodeURIComponent(m[1]);
          return { ok: true, json: async () => [{ data: rows[key] || null }] };
        }
        const body = JSON.parse(opts.body);
        rows[body.key] = body.data;
        if (body.key === 'inactivity_nudge') writtenNudgeState = body.data;
        return { ok: true, json: async () => ({}) };
      }
      if (u.includes('sendMessage')) { sentText = JSON.parse(opts.body).text; return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }; }
      throw new Error('unexpected fetch: ' + u);
    };

    const res = mockRes();
    await handler({ headers: {} }, res);
    assertEq(res._status, 200, 'full handler returns 200');
    assertEq(res._body.sent, true, 'the handler sends something when only the inactivity nudge is due');
    assertTrue(!!sentText && sentText.toLowerCase().includes('10 day'), 'the sent message names the actual gap (10 days)');
    assertTrue(res._body.results.some(r => r.name === '__inactivity_nudge__'), 'result is tagged distinctly as the inactivity nudge');
    assertTrue(!!writtenNudgeState && typeof writtenNudgeState.lastSentAt === 'number', 'the nudge-sent timestamp is persisted so it can cool down');

    // A second tick right away must NOT resend (cooldown).
    const res2 = mockRes();
    sentText = null;
    await handler({ headers: {} }, res2);
    assertEq(res2._body.sent, false, 'a second tick right after does not resend the inactivity nudge (still in cooldown)');
    assertEq(sentText, null, 'no message was actually sent the second time');
  } finally {
    unfreeze();
    delete process.env.INACTIVITY_NUDGE_DAYS;
  }
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
