import handler, { subsRenewalsDue, composeSubsMessage } from '../api/send-reminders.js';

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

(async () => {
  const origFetch = global.fetch;

  // ==================== subsRenewalsDue (pure) ====================
  {
    const subs = [
      { name: 'Netflix', entered_amount: 15.99, entered_currency: 'USD', renewal: '2026-07-24' }, // 2 days out
      { name: 'Spotify', entered_amount: 9.99, entered_currency: 'USD', renewal: '2026-08-05' },   // way out — not due
      { name: 'Gym Membership', amount: 40, renewal: '2026-07-20' }, // 2 days in the PAST — still within grace (daysUntil<0 excluded)
      { name: 'iCloud', entered_amount: 2.99, entered_currency: 'USD', renewal: '2026-07-22' }, // today
    ];
    const due = subsRenewalsDue(subs, '2026-07-22', {});
    assertEq(due.map(d => d.name), ['Netflix', 'iCloud'], 'only subs within the 0-3 day window are due (Spotify too far out, Gym Membership already past)');
    const netflix = due.find(d => d.name === 'Netflix');
    assertEq(netflix.daysUntil, 2, 'daysUntil computed correctly');
    assertEq(netflix.currency, 'USD', 'uses entered_currency for display');
    assertEq(netflix.amount, 15.99, 'uses entered_amount for display, not the CHF base amount');
    const icloud = due.find(d => d.name === 'iCloud');
    assertEq(icloud.daysUntil, 0, 'a renewal today has daysUntil 0');

    const noEnteredFields = subsRenewalsDue([{ name: 'Gym Membership', amount: 40, renewal: '2026-07-23' }], '2026-07-22', {});
    assertEq(noEnteredFields[0].currency, 'CHF', 'falls back to CHF when entered_currency is missing');
    assertEq(noEnteredFields[0].amount, 40, 'falls back to the CHF base amount when entered_amount is missing');
  }

  // ---- already-reminded suppression ----
  {
    const subs = [{ name: 'Netflix', entered_amount: 15.99, entered_currency: 'USD', renewal: '2026-07-24' }];
    const due = subsRenewalsDue(subs, '2026-07-22', { 'Netflix|2026-07-24': true });
    assertEq(due.length, 0, 'a renewal already marked reminded for this exact date is suppressed');

    // A DIFFERENT renewal date for the same sub name (next cycle) is NOT suppressed by the old key.
    const dueNextCycle = subsRenewalsDue(subs, '2026-07-22', { 'Netflix|2026-06-24': true });
    assertEq(dueNextCycle.length, 1, 'a stale reminded-key from a previous renewal cycle does not suppress the current one');
  }

  // ---- malformed/missing renewal dates are skipped, not crashed on ----
  {
    const due = subsRenewalsDue([{ name: 'Bad', renewal: 'not-a-date' }, { name: 'NoDate' }, null], '2026-07-22', {});
    assertEq(due.length, 0, 'malformed or missing renewal dates are safely skipped');
  }

  // ==================== composeSubsMessage ====================
  {
    const single = composeSubsMessage([{ name: 'Netflix', amount: 15.99, currency: 'USD', renewal: '2026-07-24', daysUntil: 2 }]);
    assertTrue(single.startsWith('Upcoming renewal:'), 'singular phrasing for exactly one due subscription');
    assertTrue(single.includes('Netflix') && single.includes('USD 15.99') && single.includes('in 2 days'), 'message includes name, amount/currency, and relative timing');

    const today = composeSubsMessage([{ name: 'iCloud', amount: 2.99, currency: 'USD', renewal: '2026-07-22', daysUntil: 0 }]);
    assertTrue(today.includes('renews today'), 'daysUntil 0 phrases as "today"');
    const tomorrow = composeSubsMessage([{ name: 'X', amount: 5, currency: 'USD', renewal: '2026-07-23', daysUntil: 1 }]);
    assertTrue(tomorrow.includes('renews tomorrow'), 'daysUntil 1 phrases as "tomorrow"');

    const multi = composeSubsMessage([
      { name: 'Netflix', amount: 15.99, currency: 'USD', renewal: '2026-07-24', daysUntil: 2 },
      { name: 'iCloud', amount: 2.99, currency: 'USD', renewal: '2026-07-22', daysUntil: 0 },
    ]);
    assertTrue(multi.startsWith('Upcoming renewals:'), 'plural phrasing when more than one subscription is due at once');
    assertTrue(multi.includes('Netflix') && multi.includes('iCloud'), 'multi-message lists every due subscription');
  }

  // ==================== full handler integration ====================
  {
    process.env.TELEGRAM_BOT_TOKEN = 'tok'; process.env.TELEGRAM_CHAT_ID = '123';
    process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_ANON_KEY = 'anon';
    process.env.REMINDER_TIMEZONE = 'UTC';
    process.env.BEDTIME_LOCAL = '23:59';
    // Pin this out of range of the real current time so the (unrelated)
    // morning briefing doesn't interject an extra message alongside the
    // subscription reminder this test is actually checking.
    process.env.MORNING_BRIEFING_TIME = '23:58';
    delete process.env.CRON_SECRET;

    const realNow = new Date();
    const todayPlain = realNow.getUTCFullYear() + '-' + String(realNow.getUTCMonth() + 1).padStart(2, '0') + '-' + String(realNow.getUTCDate()).padStart(2, '0');
    const renewalIn2Days = new Date(realNow); renewalIn2Days.setUTCDate(renewalIn2Days.getUTCDate() + 2);
    const renewalKey = renewalIn2Days.getUTCFullYear() + '-' + String(renewalIn2Days.getUTCMonth() + 1).padStart(2, '0') + '-' + String(renewalIn2Days.getUTCDate()).padStart(2, '0');

    let writtenSubsReminders = null;
    let sentText = null;
    const rows = {
      finance: { subs: [{ name: 'Netflix', entered_amount: 15.99, entered_currency: 'USD', renewal: renewalKey }] },
    };
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/rest/v1/app_state')) {
        if (!opts || !opts.method) {
          const key = decodeURIComponent(u.match(/key=eq\.([^&]+)/)[1]);
          return { ok: true, json: async () => [{ data: rows[key] || null }] };
        }
        const body = JSON.parse(opts.body);
        rows[body.key] = body.data;
        if (body.key === 'subs_reminders') writtenSubsReminders = body.data;
        return { ok: true, json: async () => ({}) };
      }
      if (u.includes('sendMessage')) { sentText = JSON.parse(opts.body).text; return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }; }
      throw new Error('unexpected fetch: ' + u);
    };

    const res = mockRes();
    await handler({ headers: {} }, res);
    assertEq(res._status, 200, 'full handler returns 200');
    assertEq(res._body.sent, true, 'full handler sends when a subscription renewal is due');
    assertTrue(!!sentText && sentText.includes('Netflix'), 'the actual Telegram message mentions the subscription name');
    assertTrue(!!writtenSubsReminders && writtenSubsReminders['Netflix|' + renewalKey] === true, 'subs_reminders row is written marking this renewal as reminded');
    assertTrue(res._body.results.some(r => r.name === '__subs_reminder__'), 'result is tagged distinctly as a subscription reminder');

    // A second tick with the same state must NOT re-send (already reminded).
    const res2 = mockRes();
    sentText = null;
    await handler({ headers: {} }, res2);
    assertEq(res2._body.sent, false, 'a second tick does not re-send once already reminded for this renewal date');
    assertEq(sentText, null, 'no message was actually sent the second time');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
