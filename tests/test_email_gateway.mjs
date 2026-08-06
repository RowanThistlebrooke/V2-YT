import { sendReminder, default as handler } from '../api/send-reminders.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}

function clearEnv() {
  ['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM_NUMBER','TWILIO_TO_NUMBER','RESEND_API_KEY','SMS_GATEWAY_TO','RESEND_FROM']
    .forEach(k => delete process.env[k]);
}

(async () => {
  const origFetch = global.fetch;

  // --- Neither configured -> throws a clear error ---
  clearEnv();
  let threw = null;
  try { await sendReminder('test'); } catch (e) { threw = e.message; }
  assertEq(!!threw && threw.includes('no delivery method'), true, 'neither Twilio nor email configured -> clear error');

  // --- Email gateway path: only RESEND_API_KEY + SMS_GATEWAY_TO set ---
  clearEnv();
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.SMS_GATEWAY_TO = '5551234567@vtext.com';
  let capturedReq = null;
  global.fetch = async (url, opts) => {
    capturedReq = { url: String(url), opts };
    return { ok: true, json: async () => ({ id: 'email_abc123' }) };
  };
  let result = await sendReminder('Still todo today: Gym, Read');
  assertEq(result, { method: 'email-gateway', id: 'email_abc123' }, 'email-gateway path returns correct result shape');
  assertEq(capturedReq.url, 'https://api.resend.com/emails', 'email-gateway hits Resend API');
  const sentBody = JSON.parse(capturedReq.opts.body);
  assertEq(sentBody.to, ['5551234567@vtext.com'], 'email-gateway sends to the correct carrier gateway address');
  assertEq(sentBody.text, 'Still todo today: Gym, Read', 'email-gateway body text correct');
  assertEq(sentBody.subject, '', 'email-gateway subject left blank (avoid carrier duplication)');
  assertEq(sentBody.from, 'onboarding@resend.dev', 'email-gateway defaults From to Resend sandbox sender');
  assertEq(capturedReq.opts.headers.Authorization, 'Bearer re_test_key', 'email-gateway auth header correct');

  // --- RESEND_FROM override respected ---
  process.env.RESEND_FROM = 'reminders@mydomain.com';
  await sendReminder('x');
  const sentBody2 = JSON.parse(capturedReq.opts.body);
  assertEq(sentBody2.from, 'reminders@mydomain.com', 'RESEND_FROM override respected');
  delete process.env.RESEND_FROM;

  // --- Twilio preferred when BOTH are configured ---
  process.env.TWILIO_ACCOUNT_SID = 'ACxxx';
  process.env.TWILIO_AUTH_TOKEN = 'tok';
  process.env.TWILIO_FROM_NUMBER = '+15550000000';
  process.env.TWILIO_TO_NUMBER = '+15551111111';
  global.fetch = async (url) => {
    capturedReq = { url: String(url) };
    return { ok: true, json: async () => ({ sid: 'SM999' }) };
  };
  result = await sendReminder('test');
  assertEq(result, { method: 'twilio', id: 'SM999' }, 'Twilio preferred over email when both configured');
  assertEq(capturedReq.url.includes('twilio.com'), true, 'hits Twilio API when both configured');

  // --- Email send failure surfaces a clear error ---
  clearEnv();
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.SMS_GATEWAY_TO = '5551234567@vtext.com';
  global.fetch = async () => ({ ok: false, json: async () => ({ message: 'invalid api key' }) });
  threw = null;
  try { await sendReminder('test'); } catch (e) { threw = e.message; }
  assertEq(!!threw && threw.includes('resend send failed'), true, 'Resend failure surfaces a clear error');

  // --- Full handler end-to-end with email gateway configured ---
  // Uses an explicit recur-def time set safely in the past and a bedtime
  // safely in the future, so the individual-reminder path fires
  // deterministically without relying on any fixed-hour gate (removed).
  // The clock is frozen at a comfortably-midday UTC time first — otherwise
  // "safely in the past" (nowMinUtc - 60, clamped to 0 near midnight) can
  // lose its safety margin against the reminder engine's own ±10min jitter
  // whenever this suite happens to run close to real UTC midnight.
  clearEnv();
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.SMS_GATEWAY_TO = '5551234567@vtext.com';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
  process.env.CRON_SECRET = 'secret123';
  process.env.REMINDER_TIMEZONE = 'UTC';
  const OrigDate = global.Date;
  const realNow = new OrigDate();
  const frozenMs = OrigDate.UTC(realNow.getUTCFullYear(), realNow.getUTCMonth(), realNow.getUTCDate(), 14, 0, 0, 0);
  class FrozenDate extends OrigDate {
    constructor(...args) { if (args.length === 0) super(frozenMs); else super(...args); }
    static now() { return frozenMs; }
  }
  global.Date = FrozenDate;
  const nowMinUtc = (() => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
    const h = Number(parts.find(p => p.type === 'hour').value) % 24;
    const m = Number(parts.find(p => p.type === 'minute').value);
    return h * 60 + m;
  })();
  const minToHM = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  const gymTime = minToHM(Math.max(0, nowMinUtc - 60));
  process.env.BEDTIME_LOCAL = minToHM(Math.min(1439, nowMinUtc + 120));
  // Pin the morning briefing's fire time safely out of this test's frozen
  // "now" so it doesn't interject an extra message alongside the Gym
  // reminder this test is actually checking.
  process.env.MORNING_BRIEFING_TIME = '23:59';
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('supabase')) {
      if (u.includes('key=eq.goals')) return { ok: true, json: async () => [{ data: { 'recur:defs': [{ id: 'r1', name: 'Gym', freq: 'daily', autoSource: null, time: gymTime }] } }] };
      // A recent peak:checkins entry suppresses the independent periodic
      // feeling-check-in reminder, which is unrelated to what this test
      // is actually checking (the Gym reminder).
      if (u.includes('key=eq.peak')) return { ok: true, json: async () => [{ data: { 'peak:checkins': [{ ts: Date.now() }] } }] };
      return { ok: true, json: async () => [] };
    }
    if (u.includes('resend')) return { ok: true, json: async () => ({ id: 'email_final' }) };
    throw new Error('unexpected fetch: ' + u);
  };
  function mockRes() {
    const res = { _status: null, _body: null };
    res.status = (s) => { res._status = s; return res; };
    res.json = (b) => { res._body = b; return res; };
    return res;
  }
  const res = mockRes();
  await handler({ headers: { authorization: 'Bearer secret123' } }, res);
  assertEq(res._status, 200, 'full handler end-to-end returns 200');
  assertEq(res._body.sent, true, 'full handler end-to-end sends');
  assertEq(res._body.results.length, 1, 'full handler sends exactly one individual reminder');
  assertEq(res._body.results[0].name, 'Gym', 'full handler reports the correct item name');
  assertEq(res._body.results[0].method, 'email-gateway', 'full handler reports email-gateway as the method used');

  global.Date = OrigDate;
  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
