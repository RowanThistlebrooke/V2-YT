import { TOOL_EXECUTORS, activeDateKey, plainDateKey } from '../api/telegram-webhook.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function makeFakeSupabase(seed) {
  const rows = JSON.parse(JSON.stringify(seed || {}));
  async function fetchStub(url, opts) {
    const u = String(url);
    if (u.includes('open.er-api.com')) return { ok: true, json: async () => ({ rates: { USD: 1.1, EUR: 1.0, GBP: 0.9, DOP: 65 } }) };
    if (u.includes('/rest/v1/app_state')) {
      if (!opts || !opts.method || opts.method === 'GET') {
        const m = u.match(/key=eq\.([^&]+)/);
        const key = decodeURIComponent(m[1]);
        return { ok: true, json: async () => [{ data: rows[key] || {} }] };
      }
      if (opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        rows[body.key] = body.data;
        return { ok: true, json: async () => ({}) };
      }
    }
    throw new Error('unexpected fetch: ' + u);
  }
  return { rows, fetchStub };
}

(async () => {
  const origFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
  process.env.REMINDER_TIMEZONE = 'UTC';

  // ==================== GYM ====================
  {
    const fake = makeFakeSupabase({
      'po-coach': {
        po_coach_v1: { exercises: [{ id: 'ex1', name: 'Bench Press' }, { id: 'ex2', name: 'Squat' }], logs: {} },
        po_coach_ex_done: {}, po_coach_weights: [], 'cardio:sessions': [],
        'stretch:am:items': [{ id: 'am1', name: 'Cat-Cow' }, { id: 'am2', name: 'Chin tucks' }],
        'stretch:pm:items': [{ id: 'pm1', name: 'Couch stretch' }],
        'stretch:log': {},
      },
    });
    global.fetch = fake.fetchStub;

    const setResult = await TOOL_EXECUTORS.log_workout_set({ exercise: 'bench', weight: 135, reps: 8 });
    assertEq(setResult.matched, 'Bench Press', 'log_workout_set fuzzy-matches "bench" to "Bench Press"');
    // Logs are keyed by normalized exercise name (exerciseLogKey), not the
    // day-template entry's own id, so a set logged for the same exercise
    // on another day shares this same bucket instead of fragmenting.
    const loggedSet = fake.rows['po-coach'].po_coach_v1.logs['name:bench press'][0];
    assertEq(loggedSet.weight, 135, 'logged set has correct weight');
    assertEq(loggedSet.reps, 8, 'logged set has correct reps');
    assertTrue(typeof loggedSet.date === 'string' && loggedSet.date.includes('T'), 'logged set date is an ISO instant, matching gym.html\'s own format');

    const doneResult = await TOOL_EXECUTORS.mark_exercise_done({ exercise: 'squat' });
    assertEq(doneResult.matched, 'Squat', 'mark_exercise_done fuzzy-matches');
    const exDoneKey = plainDateKey();
    assertTrue(fake.rows['po-coach'].po_coach_ex_done[exDoneKey].ex2 === true, 'exercise marked done under today\'s plain date key');

    const missResult = await TOOL_EXECUTORS.log_workout_set({ exercise: 'deadlift', weight: 100, reps: 5 });
    assertEq(missResult.ok, false, 'log_workout_set reports failure (not a crash) for an unmatched exercise');

    // Backdating: restoring a set for a past day must land in the correct
    // chronological position, not just get appended after today's sets.
    const back1 = await TOOL_EXECUTORS.log_workout_set({ exercise: 'bench', weight: 130, reps: 10, date: '2026-07-10' });
    assertEq(back1.ok, true, 'log_workout_set accepts a backdated date');
    assertEq(back1.date, '2026-07-10', 'reports back the date it was logged under');
    let benchLogs = fake.rows['po-coach'].po_coach_v1.logs['name:bench press'];
    assertEq(benchLogs.length, 2, 'backdated set is added, not merged/skipped');
    assertEq(benchLogs[0].weight, 130, 'backdated set (July 10) is inserted BEFORE the existing today-dated set');
    assertTrue(benchLogs[0].date.startsWith('2026-07-10'), 'backdated set carries the requested date, not today');
    assertEq(benchLogs[1].weight, 135, 'the originally-logged (today) set stays after the backdated one');

    // A second backdated set for the same past day, logged after the first
    // one chronologically, must land between the two (still in order).
    const back2 = await TOOL_EXECUTORS.log_workout_set({ exercise: 'bench', weight: 145, reps: 8, date: '2026-07-10' });
    assertEq(back2.ok, true, 'a second same-day backdated set is also accepted');
    benchLogs = fake.rows['po-coach'].po_coach_v1.logs['name:bench press'];
    assertEq(benchLogs.length, 3, 'both backdated sets now present alongside the original');
    assertEq(benchLogs[0].weight, 130, 'first July 10 set (130x10) stays first');
    assertEq(benchLogs[1].weight, 145, 'second July 10 set (145x8) inserted right after it');
    assertEq(benchLogs[2].weight, 135, 'today\'s original set remains last');

    const badDate = await TOOL_EXECUTORS.log_workout_set({ exercise: 'bench', weight: 100, reps: 5, date: 'not-a-date' });
    assertEq(badDate.ok, false, 'an unparseable date is rejected rather than silently logging garbage');

    await TOOL_EXECUTORS.log_cardio_session({ duration_min: 30, avg_hr: 140, notes: 'easy run' });
    const cardio = fake.rows['po-coach']['cardio:sessions'][0];
    assertEq(cardio.durationMin, 30, 'cardio session duration recorded');
    assertEq(cardio.avgHr, 140, 'cardio session avg heart rate recorded');
    assertEq(cardio.notes, 'easy run', 'cardio session notes recorded');
    assertEq(cardio.calories, null, 'cardio calories left null rather than guessed (no formula replicated server-side)');

    const stretchOne = await TOOL_EXECUTORS.mark_stretch_done({ routine: 'am', item: 'cat' });
    assertEq(stretchOne.matched, ['Cat-Cow'], 'mark_stretch_done with a specific item only marks that one');
    const stretchLogKey = plainDateKey();
    assertTrue(fake.rows['po-coach']['stretch:log'].am1[stretchLogKey] === true, 'specific AM stretch item marked done');
    assertTrue(!fake.rows['po-coach']['stretch:log'].am2, 'the other AM item was NOT marked done');

    const stretchAll = await TOOL_EXECUTORS.mark_stretch_done({ routine: 'pm' });
    assertEq(stretchAll.matched, ['Couch stretch'], 'mark_stretch_done with no item marks the whole routine');
    assertTrue(fake.rows['po-coach']['stretch:log'].pm1[stretchLogKey] === true, 'whole PM routine marked done');

    await TOOL_EXECUTORS.log_body_weight({ weight: 180 });
    assertEq(fake.rows['po-coach'].po_coach_weights[0], { dateKey: plainDateKey(), weight: 180 }, 'body weight logged for today');
    await TOOL_EXECUTORS.log_body_weight({ weight: 179 });
    assertEq(fake.rows['po-coach'].po_coach_weights.length, 1, 'logging body weight again same day updates in place rather than duplicating');
    assertEq(fake.rows['po-coach'].po_coach_weights[0].weight, 179, 'updated weight value is the latest one');
  }

  // ==================== BUSINESS ====================
  {
    const fake = makeFakeSupabase({
      business: {
        'biz:affiliate:commitments': [{ id: 'c1', label: 'Post 3 TikToks' }],
        'biz:affiliate:commitLog': {}, 'biz:affiliate:revenue': [],
        'biz:editing:clients': [{ id: 'cl1', name: 'Acme Corp', dailyDeliverables: 2, paymentStatus: 'unpaid' }],
        'biz:editing:deliveryLog': {}, 'biz:editing:payments': [],
      },
    });
    global.fetch = fake.fetchStub;

    const commitResult = await TOOL_EXECUTORS.log_affiliate_commit({ commitment: 'tiktok' });
    assertEq(commitResult.matched, 'Post 3 TikToks', 'log_affiliate_commit fuzzy-matches');
    assertTrue(fake.rows.business['biz:affiliate:commitLog'].c1[activeDateKey()] === true, 'commitment marked done today (6am-boundary key)');

    await TOOL_EXECUTORS.log_affiliate_revenue({ amount: 42.5, note: 'Amazon payout' });
    const rev = fake.rows.business['biz:affiliate:revenue'][0];
    assertEq(rev.amount, 42.5, 'affiliate revenue amount recorded');
    assertEq(rev.note, 'Amazon payout', 'affiliate revenue note recorded');
    assertEq(rev.date, activeDateKey(), 'affiliate revenue dated with the 6am-boundary key, matching business.html');

    const d1 = await TOOL_EXECUTORS.log_editing_delivery({ client: 'acme' });
    assertEq(d1.countToday, 1, 'first delivery today counts as 1');
    const d2 = await TOOL_EXECUTORS.log_editing_delivery({ client: 'acme' });
    assertEq(d2.countToday, 2, 'second delivery today counts as 2');
    const d3 = await TOOL_EXECUTORS.log_editing_delivery({ client: 'acme' });
    assertEq(d3.countToday, 2, 'delivery count caps at the client\'s dailyDeliverables target (2), matching business.html');

    const payResult = await TOOL_EXECUTORS.log_editing_payment({ client: 'acme', amount: 500 });
    assertEq(payResult.matched, 'Acme Corp', 'log_editing_payment fuzzy-matches client');
    assertEq(fake.rows.business['biz:editing:payments'][0].amount, 500, 'payment amount recorded');
    assertEq(fake.rows.business['biz:editing:clients'][0].paymentStatus, 'paid', 'logging a payment flips the client\'s paymentStatus to paid, matching business.html\'s cross-reference behavior');
  }

  // ==================== READING ====================
  {
    const fake = makeFakeSupabase({
      reading: { 'reading:items': [{ id: 'r1', title: 'Atomic Habits', status: 'want', currentPage: 0, totalPages: 200, sessions: [] }] },
    });
    global.fetch = fake.fetchStub;

    const result = await TOOL_EXECUTORS.log_reading_session({ title: 'atomic', current_page: 50 });
    assertEq(result.matched, 'Atomic Habits', 'log_reading_session fuzzy-matches by title');
    const item = fake.rows.reading['reading:items'][0];
    assertEq(item.currentPage, 50, 'current page updated');
    assertEq(item.progress, 25, 'progress percentage recalculated from currentPage/totalPages');
    assertEq(item.status, 'progress', 'status auto-advances from "want" to "progress" on first session logged');
    const utcToday = new Date().toISOString().slice(0, 10);
    assertEq(item.sessions, [{ date: utcToday, page: 50, ts: item.sessions[0].ts }], 'session logged under the UTC date slice, matching reading.html exactly');

    await TOOL_EXECUTORS.add_book({ title: 'Deep Work', author: 'Cal Newport', total_pages: 300 });
    const newBook = fake.rows.reading['reading:items'][1];
    assertEq(newBook.title, 'Deep Work', 'new book title recorded');
    assertEq(newBook.status, 'want', 'new book starts in "want" status');
    assertEq(newBook.totalPages, 300, 'new book total pages recorded');
    assertEq(newBook.audiobook, false, 'a book added without audiobook: true defaults to page-tracked, not audiobook');
  }

  // ==================== READING: audiobooks (tracked by time, not pages) ====================
  {
    const fake = makeFakeSupabase({
      reading: { 'reading:items': [{ id: 'r1', title: 'Sapiens', status: 'want', audiobook: true, currentMinutes: 0, totalMinutes: 900, sessions: [] }] },
    });
    global.fetch = fake.fetchStub;

    const result = await TOOL_EXECUTORS.log_reading_session({ title: 'sapiens', current_minutes: 180 });
    assertEq(result.matched, 'Sapiens', 'log_reading_session fuzzy-matches an audiobook by title too');
    const item = fake.rows.reading['reading:items'][0];
    assertEq(item.currentMinutes, 180, 'current minutes updated for an audiobook');
    assertEq(item.progress, 20, 'progress percentage recalculated from currentMinutes/totalMinutes, not pages');
    assertEq(item.status, 'progress', 'status auto-advances from "want" to "progress" for an audiobook session too');
    const utcToday = new Date().toISOString().slice(0, 10);
    assertEq(item.sessions, [{ date: utcToday, minutes: 180, ts: item.sessions[0].ts }], 'an audiobook session is logged with a minutes field, not a page field');

    await TOOL_EXECUTORS.add_book({ title: 'Educated', author: 'Tara Westover', audiobook: true, total_minutes: 720 });
    const newAudiobook = fake.rows.reading['reading:items'][1];
    assertEq(newAudiobook.audiobook, true, 'a new audiobook is flagged as such');
    assertEq(newAudiobook.totalMinutes, 720, 'new audiobook total runtime (minutes) recorded');
    assertEq(newAudiobook.totalPages, 0, 'an audiobook still has a totalPages field (0), so it never gets misread as a page-tracked book');
  }

  // ==================== HABITS ====================
  {
    const fake = makeFakeSupabase({
      goals: { 'habits:defs': [{ id: 'h1', name: 'Meditate' }] },
    });
    global.fetch = fake.fetchStub;
    const result = await TOOL_EXECUTORS.mark_habit_done({ habit: 'medit' });
    assertEq(result.matched, 'Meditate', 'mark_habit_done fuzzy-matches');
    assertTrue(fake.rows.goals['habits:log'].h1[activeDateKey()] === true, 'habit marked done today under the 6am-boundary key');
  }

  // ==================== FINANCE: net worth, subs, wishlist, orders ====================
  {
    const fake = makeFakeSupabase({ finance: { 'nw:bank': [{ name: 'Checking', amount: 1000 }] } });
    global.fetch = fake.fetchStub;

    const addResult = await TOOL_EXECUTORS.adjust_net_worth_account({ category: 'bank', account: 'checking', amount: 200, mode: 'add' });
    assertEq(addResult.newAmount, 1200, 'adjust_net_worth_account "add" mode adds to the existing balance');
    assertEq(fake.rows.finance['nw:activity'][0].delta, 200, 'activity log records the correct positive delta');

    const setResult = await TOOL_EXECUTORS.adjust_net_worth_account({ category: 'bank', account: 'checking', amount: 5000, mode: 'set' });
    assertEq(setResult.newAmount, 5000, 'adjust_net_worth_account "set" mode replaces the balance outright');

    const newAcctResult = await TOOL_EXECUTORS.adjust_net_worth_account({ category: 'crypto', account: 'Coinbase', amount: 300, mode: 'add' });
    assertEq(newAcctResult.newAmount, 300, 'adjusting a non-existent account creates it');
    assertTrue(fake.rows.finance['nw:crypto'].some(a => a.name === 'Coinbase'), 'new crypto account actually persisted');

    const badCat = await TOOL_EXECUTORS.adjust_net_worth_account({ category: 'not-a-real-category', account: 'x', amount: 1 });
    assertEq(badCat.ok, false, 'an invalid category is rejected rather than silently creating a bogus nw:<cat> key');
  }

  {
    const fake = makeFakeSupabase({ finance: { subs: [], 'nw:bank': [{ name: 'Checking', amount: 1000 }] } });
    global.fetch = fake.fetchStub;

    await TOOL_EXECUTORS.add_subscription({ name: 'Netflix', amount: 15.99, currency: 'USD', period: 'monthly', from_account: 'checking' });
    const sub = fake.rows.finance.subs[0];
    assertEq(sub.name, 'Netflix', 'subscription name recorded');
    assertEq(sub.entered_currency, 'USD', 'subscription entered currency recorded');
    assertTrue(Math.abs(sub.amount - 15.99 / 1.1) < 0.001, 'subscription amount converted to CHF base');
    assertEq(sub.fromAccount, 'Checking', 'subscription linked to the matched account');
    assertEq(sub.autoDeduct, false, 'autoDeduct stays false when no renewal_date is given, even with a linked account');
    assertTrue(Array.isArray(sub.priceHistory) && sub.priceHistory.length === 1, 'a single-entry priceHistory baseline is seeded on creation (finance.html\'s price-creep tracking)');
    assertEq(sub.priceHistory[0].enteredAmount, 15.99, 'the seeded price-history entry records the entered amount as-is');
    assertEq(sub.priceHistory[0].enteredCurrency, 'USD', 'the seeded price-history entry records the entered currency');

    const cancelResult = await TOOL_EXECUTORS.cancel_subscription({ name: 'netflix' });
    assertEq(cancelResult.removed, 'Netflix', 'cancel_subscription fuzzy-matches and reports the removed name');
    assertEq(fake.rows.finance.subs.length, 0, 'subscription actually removed from storage');
  }

  {
    const fake = makeFakeSupabase({ finance: { debts: [] } });
    global.fetch = fake.fetchStub;

    const r1 = await TOOL_EXECUTORS.add_debt({ name: 'Car loan', balance: 10000, currency: 'USD', apr: 6, min_payment: 220 });
    assertEq(r1.ok, true, 'add_debt returns ok');
    const debt = fake.rows.finance.debts[0];
    assertEq(debt.name, 'Car loan', 'debt name recorded');
    assertEq(debt.entered_currency, 'USD', 'debt entered currency recorded');
    assertTrue(Math.abs(debt.balance - 10000 / 1.1) < 0.001, 'debt balance converted to CHF base, same exchange-rate convention as subscriptions/purchases');
    assertEq(debt.apr, 6, 'APR stored as given');
    assertTrue(Math.abs(debt.minPayment - 220 / 1.1) < 0.001, 'minimum payment also converted to CHF base, matching the balance');

    // apr/min_payment are optional — a bare debt still logs cleanly.
    const r2 = await TOOL_EXECUTORS.add_debt({ name: 'Family loan', balance: 500, currency: 'DOP' });
    assertEq(r2.ok, true, 'add_debt succeeds with no APR or minimum payment given');
    const bareDebt = fake.rows.finance.debts[1];
    assertEq(bareDebt.apr, 0, 'APR defaults to 0 when not mentioned');
    assertEq(bareDebt.minPayment, 0, 'minimum payment defaults to 0 when not mentioned');
  }

  {
    const fake = makeFakeSupabase({ finance: { wishlist: [] } });
    global.fetch = fake.fetchStub;
    await TOOL_EXECUTORS.add_wishlist_item({ name: 'Nintendo Switch 2', amount: 450, currency: 'USD' });
    assertEq(fake.rows.finance.wishlist[0].name, 'Nintendo Switch 2', 'wishlist item added');
    assertEq(fake.rows.finance.wishlist[0].entered_currency, 'USD', 'wishlist item currency recorded');
  }

  {
    const fake = makeFakeSupabase({ finance: { incoming_orders: [], 'nw:bank': [{ name: 'Checking', amount: 1000 }] } });
    global.fetch = fake.fetchStub;

    const noAccountResult = await TOOL_EXECUTORS.add_order({ name: 'New Headphones', amount: 100, currency: 'USD' });
    assertEq(noAccountResult.deducted, false, 'add_order without a matching account does not deduct');
    assertEq(fake.rows.finance['nw:bank'][0].amount, 1000, 'balance untouched when no account matched');

    const withAccountResult = await TOOL_EXECUTORS.add_order({ name: 'Monitor', amount: 200, currency: 'USD', from_account: 'checking' });
    assertEq(withAccountResult.deducted, true, 'add_order with a matching account deducts immediately, matching finance.html\'s own add-with-account behavior');
    assertTrue(fake.rows.finance['nw:bank'][0].amount < 1000, 'balance actually reduced');
    const order = fake.rows.finance.incoming_orders[1];
    assertTrue(!!order.deductedAt, 'the deducted order is stamped with deductedAt');
    assertEq(order.deductedFrom, { cat: 'bank', name: 'Checking' }, 'deductedFrom recorded matching finance.html\'s own shape');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
