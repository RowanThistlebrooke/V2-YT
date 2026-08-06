import handler, {
  TOOL_EXECUTORS, resolvePendingAction, handleCallbackQuery, buildContext, scheduleNow, readScheduleModel,
} from '../api/telegram-webhook.js';
import { buildDefaultScheduleModel } from '../schedule-model.js';

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
  res.send = (b) => { res._body = b; return res; };
  return res;
}

function makeHarness(seed) {
  const rows = JSON.parse(JSON.stringify(seed || {}));
  const calls = { sendMessage: [], answerCallbackQuery: [], editMessageReplyMarkup: [], editMessageText: [], googleEvents: [] };
  async function fetchStub(url, opts) {
    const u = String(url);
    if (u.includes('/rest/v1/app_state')) {
      if (!opts || !opts.method || opts.method === 'GET') {
        const key = decodeURIComponent(u.match(/key=eq\.([^&]+)/)[1]);
        return { ok: true, json: async () => (Object.hasOwn(rows, key) ? [{ data: JSON.parse(JSON.stringify(rows[key])) }] : []) };
      }
      if (opts.method === 'DELETE') {
        const key = decodeURIComponent(u.match(/key=eq\.([^&]+)/)[1]);
        const idMatch = u.match(/data->>id=eq\.([^&]+)/);
        const matchesId = !idMatch || String((rows[key] || {}).id) === decodeURIComponent(idMatch[1]);
        if (!Object.hasOwn(rows, key) || !matchesId) return { ok: true, json: async () => [] };
        const prior = rows[key];
        delete rows[key];
        return { ok: true, json: async () => [{ key, data: prior }] };
      }
      const body = JSON.parse(opts.body);
      const unique = String((opts.headers && opts.headers.Prefer) || '').includes('ignore-duplicates');
      if (unique && Object.hasOwn(rows, body.key)) return { ok: true, json: async () => [] };
      rows[body.key] = body.data;
      return { ok: true, json: async () => (unique ? [body] : {}) };
    }
    if (u.includes('/rest/v1/google_tokens')) {
      return { ok: true, json: async () => [{ access: 'g-access', refresh: 'g-refresh', expires: Date.now() + 3600000 }] };
    }
    if (u.includes('googleapis.com/calendar/v3/calendars/primary/events')) {
      calls.googleEvents.push({ method: opts && opts.method, url: u, body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (opts && opts.method === 'DELETE') return { ok: true, status: 204, json: async () => null };
      return { ok: true, json: async () => ({ id: 'gcal-evt-1', summary: (opts && opts.body && JSON.parse(opts.body).summary) || 'ok' }) };
    }
    for (const method of ['sendMessage', 'answerCallbackQuery', 'editMessageReplyMarkup', 'editMessageText']) {
      if (u.includes('/' + method)) { calls[method].push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ ok: true, result: { message_id: 77 } }) }; }
    }
    throw new Error('unexpected fetch: ' + u);
  }
  return { rows, calls, fetchStub };
}

(async () => {
  const origFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon';
  process.env.TELEGRAM_BOT_TOKEN = 'bot123:ABC';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'shh';
  process.env.TELEGRAM_CHAT_ID = '555';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  const model = buildDefaultScheduleModel();
  const gymId = model.profiles.find(p => p.id === 'summer-2026').blocks.find(b => b.id.endsWith('0830-gym')).id;

  // ==================== read tools ====================
  {
    const { fetchStub } = makeHarness({ schedule: { 'schedule:model_v1': model } });
    global.fetch = fetchStub;
    const { dateKey } = scheduleNow();
    const result = await TOOL_EXECUTORS.read_todays_schedule({});
    assertEq(result.ok, true, 'read_todays_schedule succeeds');
    assertTrue(Array.isArray(result.items), 'read_todays_schedule returns an items array');
    assertEq(result.date, dateKey, 'read_todays_schedule reports today\'s real date');

    const atTime = await TOOL_EXECUTORS.read_todays_schedule({ at_time: '08:45' });
    assertTrue(atTime.ok, 'read_todays_schedule with at_time succeeds');

    const badTime = await TOOL_EXECUTORS.read_todays_schedule({ at_time: 'garbage' });
    assertEq(badTime.ok, false, 'read_todays_schedule rejects a malformed at_time rather than throwing');

    const weekly = await TOOL_EXECUTORS.read_weekly_schedule({});
    assertEq(weekly.ok, true, 'read_weekly_schedule succeeds');
    assertEq(Object.keys(weekly.days).length, 6, 'read_weekly_schedule returns exactly six days (Mon-Sat)');

    const next = await TOOL_EXECUTORS.get_next_schedule_block({});
    assertEq(next.ok, true, 'get_next_schedule_block succeeds');
  }

  // ==================== empty schedule (no row at all yet) ====================
  {
    const { fetchStub } = makeHarness({});
    global.fetch = fetchStub;
    const result = await TOOL_EXECUTORS.read_todays_schedule({});
    assertEq(result.ok, true, 'a dashboard that never opened schedule.html still reports ok:true, not an error');
    assertEq(result.items, [], 'and reports an empty schedule rather than throwing');
    assertTrue(typeof result.note === 'string' && result.note.length > 0, 'a friendly note explains why it is empty');
  }

  // ==================== resolvePendingAction — labels + fuzzy resolution ====================
  {
    const { fetchStub } = makeHarness({ schedule: { 'schedule:model_v1': model } });
    global.fetch = fetchStub;

    const addBlock = await resolvePendingAction('add_recurring_schedule_block', { title: 'Meditation', category: 'recovery', start: '06:30', end: '07:00', days: [1, 3, 5] });
    assertTrue(addBlock.label.includes('Meditation') && addBlock.label.includes('Mon/Wed/Fri'), 'add_recurring_schedule_block builds a readable label with weekday names');

    await assertRejects(() => resolvePendingAction('add_recurring_schedule_block', { title: 'X', category: 'free', start: '06:00', end: '07:00', days: [0, 1] }), 'day 0 (Sunday) is rejected for a new recurring block');

    const editBlock = await resolvePendingAction('edit_recurring_schedule_block', { title: 'gym', start: '06:00' });
    assertTrue(editBlock.args.block_id === gymId, 'edit_recurring_schedule_block fuzzy-resolves "gym" to the real Gym block and pins its id');
    assertTrue(editBlock.label.includes('start → 06:00'), 'the edit label states what is changing');

    await assertRejects(() => resolvePendingAction('edit_recurring_schedule_block', { title: 'nonexistent block xyz' }), 'editing a block that doesn\'t exist is rejected with a clear error');

    const disable = await resolvePendingAction('disable_recurring_schedule_block', { title: 'gym' });
    assertTrue(disable.label.includes('Disable') && disable.label.includes('Gym'), 'disable_recurring_schedule_block builds a clear label');

    const skip = await resolvePendingAction('add_schedule_override', { title: 'gym', date: '2026-08-05', action: 'skip' });
    assertTrue(skip.label.includes('Skip') && skip.label.includes('2026-08-05'), 'a skip override label names the block and the single date');

    const move = await resolvePendingAction('add_schedule_override', { title: 'gym', date: '2026-08-05', action: 'move', start: '10:00', end: '11:00' });
    assertTrue(move.label.includes('Move') && move.label.includes('10:00'), 'a move override label states the new time');

    await assertRejects(() => resolvePendingAction('add_schedule_override', { title: 'gym', date: '2026-08-05', action: 'move' }), 'a move override without start/end is rejected');

    const addAppt = await resolvePendingAction('add_schedule_appointment', { title: 'Dentist', date: '2026-08-06', start: '12:00' });
    assertTrue(addAppt.label.includes('Dentist') && addAppt.label.includes('2026-08-06'), 'add_schedule_appointment builds a clear label');
  }

  async function assertRejects(fn, label) {
    try { await fn(); fail++; console.log('FAIL:', label, '(did not throw)'); }
    catch (e) { pass++; console.log('PASS:', label); }
  }

  // ==================== mutation executors ====================
  {
    const { rows, fetchStub } = makeHarness({ schedule: { 'schedule:model_v1': model } });
    global.fetch = fetchStub;
    const result = await TOOL_EXECUTORS.add_recurring_schedule_block({ title: 'Meditation', category: 'recovery', start: '06:30', end: '07:00', days: [1, 3, 5] });
    assertEq(result.ok, true, 'add_recurring_schedule_block succeeds');
    const stored = rows.schedule['schedule:model_v1'];
    assertTrue(stored.profiles.find(p => p.id === 'summer-2026').blocks.some(b => b.title === 'Meditation'), 'the new block is actually persisted into the model');
  }
  {
    const { rows, fetchStub } = makeHarness({ schedule: { 'schedule:model_v1': model } });
    global.fetch = fetchStub;
    await TOOL_EXECUTORS.edit_recurring_schedule_block({ block_id: gymId, start: '06:00', new_title: 'Morning lift' });
    const block = rows.schedule['schedule:model_v1'].profiles.find(p => p.id === 'summer-2026').blocks.find(b => b.id === gymId);
    assertEq(block.start, '06:00', 'edit_recurring_schedule_block persists the new start time');
    assertEq(block.title, 'Morning lift', 'edit_recurring_schedule_block persists the new title');
  }
  {
    const { rows, fetchStub } = makeHarness({ schedule: { 'schedule:model_v1': model } });
    global.fetch = fetchStub;
    await TOOL_EXECUTORS.disable_recurring_schedule_block({ block_id: gymId });
    const block = rows.schedule['schedule:model_v1'].profiles.find(p => p.id === 'summer-2026').blocks.find(b => b.id === gymId);
    assertEq(block.enabled, false, 'disable_recurring_schedule_block persists enabled:false');
  }
  {
    const { rows, fetchStub } = makeHarness({ schedule: { 'schedule:model_v1': model } });
    global.fetch = fetchStub;
    await TOOL_EXECUTORS.add_schedule_override({ block_id: gymId, date: '2026-08-05', action: 'skip' });
    const stored = rows.schedule['schedule:model_v1'];
    assertTrue(stored.overrides['2026-08-05'].disabledBlockIds.includes(gymId), 'add_schedule_override (skip) persists the one-day disable');

    const { rows: rows2, fetchStub: fetchStub2 } = makeHarness({ schedule: { 'schedule:model_v1': model } });
    global.fetch = fetchStub2;
    await TOOL_EXECUTORS.add_schedule_override({ block_id: gymId, date: '2026-08-05', action: 'move', start: '10:00', end: '11:00' });
    assertEq(rows2.schedule['schedule:model_v1'].overrides['2026-08-05'].modifiedBlocks[gymId], { start: '10:00', end: '11:00' }, 'add_schedule_override (move) persists the one-day time change');
  }

  // ==================== appointments + Google push ====================
  {
    const { rows, calls, fetchStub } = makeHarness({ schedule: { 'schedule:model_v1': model } });
    global.fetch = fetchStub;
    const result = await TOOL_EXECUTORS.add_schedule_appointment({ title: 'Dentist', date: '2026-08-06', start: '12:00', end: '12:30' });
    assertEq(result.ok, true, 'add_schedule_appointment succeeds');
    assertEq(result.google_synced, true, 'add_schedule_appointment reports Google sync succeeded when connected');
    assertEq(calls.googleEvents.length, 1, 'exactly one Google Calendar create call was made');
    assertEq(calls.googleEvents[0].method, 'POST', 'the appointment is created via a real POST to the Calendar API');
    const appt = rows.schedule['schedule:model_v1'].appointments[0];
    assertEq(appt.googleEventId, 'gcal-evt-1', 'the returned Google event id is stored on the appointment');
    assertEq(appt.syncStatus, 'synced', 'the appointment is marked synced');

    const moveResult = await TOOL_EXECUTORS.move_schedule_appointment({ appointment_id: appt.id, start: '14:00' });
    assertEq(moveResult.ok, true, 'move_schedule_appointment succeeds');
    assertEq(calls.googleEvents[1].method, 'PATCH', 'moving a synced appointment PATCHes its existing Google event rather than creating a new one');

    const cancelResult = await TOOL_EXECUTORS.cancel_schedule_appointment({ appointment_id: appt.id });
    assertEq(cancelResult.ok, true, 'cancel_schedule_appointment succeeds');
    assertEq(calls.googleEvents[2].method, 'DELETE', 'canceling a synced appointment DELETEs its Google event');
    assertEq(rows.schedule['schedule:model_v1'].appointments.length, 0, 'the canceled appointment is removed from the model');
  }

  // ==================== appointment creation without Google connected (best-effort) ====================
  {
    const { rows, fetchStub } = makeHarness({ schedule: { 'schedule:model_v1': model } });
    const noGoogleFetch = async (url, opts) => {
      if (String(url).includes('/rest/v1/google_tokens')) return { ok: true, json: async () => [] };
      return fetchStub(url, opts);
    };
    global.fetch = noGoogleFetch;
    const result = await TOOL_EXECUTORS.add_schedule_appointment({ title: 'Dentist', date: '2026-08-06', start: '12:00' });
    assertEq(result.ok, true, 'add_schedule_appointment still succeeds locally when Google is not connected');
    assertEq(result.google_synced, false, 'the result honestly reports Google was not synced');
    assertEq(rows.schedule['schedule:model_v1'].appointments[0].syncStatus, 'local', 'the appointment is stored with syncStatus local, ready for the browser\'s own later sync to pick up');
  }

  // ==================== pause / resume ====================
  {
    const { rows, fetchStub } = makeHarness({});
    global.fetch = fetchStub;
    await TOOL_EXECUTORS.pause_schedule_reminders({ duration_minutes: 120 });
    assertTrue(rows.schedule_reminder_pause.paused === true && rows.schedule_reminder_pause.pausedUntil > Date.now(), 'pause_schedule_reminders persists a future pausedUntil for a timed pause');
    await TOOL_EXECUTORS.pause_schedule_reminders({});
    assertEq(rows.schedule_reminder_pause, { paused: true, pausedUntil: null }, 'pause_schedule_reminders with no duration persists an indefinite pause');
    await TOOL_EXECUTORS.resume_schedule_reminders({});
    assertEq(rows.schedule_reminder_pause, { paused: false, pausedUntil: null }, 'resume_schedule_reminders clears the pause');
  }

  // ==================== buildContext includes today's schedule ====================
  {
    const { fetchStub } = makeHarness({ schedule: { 'schedule:model_v1': model } });
    global.fetch = fetchStub;
    const context = await buildContext();
    assertTrue(!!context.schedule, 'buildContext includes a schedule key when the row exists');
    assertEq(context.schedule.date, scheduleNow().dateKey, 'the schedule context is dated to today');
  }
  {
    const { fetchStub } = makeHarness({}); // no schedule row at all
    global.fetch = fetchStub;
    const context = await buildContext();
    assertTrue(!!context.schedule, 'buildContext still includes a schedule key (empty/current:null) even with no row yet, rather than throwing');
  }

  // ==================== end-to-end: confirm-gated mutation via the real callback flow ====================
  {
    const { rows, calls, fetchStub } = makeHarness({ schedule: { 'schedule:model_v1': model } });
    global.fetch = fetchStub;

    // Simulate Claude having already decided to call disable_recurring_schedule_block:
    // resolvePendingAction is the same resolution createPendingAction (internal) uses,
    // then the pending row is written directly so handleCallbackQuery's real confirm
    // path — the same one a genuine Telegram button tap hits — can be driven exactly.
    const resolved = await resolvePendingAction('disable_recurring_schedule_block', { title: 'gym' });
    const pending = { id: 'test-action-1', tool: 'disable_recurring_schedule_block', args: resolved.args, label: resolved.label, createdAt: Date.now() };
    rows['telegram-pending-action'] = pending;

    const res = mockRes();
    await handleCallbackQuery('bot123:ABC', { id: 'cb1', data: 'confirm:' + pending.id, message: { chat: { id: 555 }, message_id: 9, text: pending.label } }, res);
    assertEq(res._body.result.ok, true, 'confirming the pending disable action actually executes it');
    const block = rows.schedule['schedule:model_v1'].profiles.find(p => p.id === 'summer-2026').blocks.find(b => b.id === gymId);
    assertEq(block.enabled, false, 'the confirmed disable is really persisted to the schedule model');
    assertEq(calls.editMessageText[0].text.includes('Confirmed and completed'), true, 'the user sees a confirmation of completion');
  }

  // ==================== sched-skip: / sched-ok callback (direct action on an hourly reminder) ====================
  {
    const { rows, calls, fetchStub } = makeHarness({ schedule: { 'schedule:model_v1': model } });
    global.fetch = fetchStub;
    const res = mockRes();
    await handleCallbackQuery('bot123:ABC', { id: 'cb2', data: 'sched-skip:' + gymId + ':2026-08-05', message: { chat: { id: 555 }, message_id: 10, text: '8:30 AM — Gym.' } }, res);
    assertEq(res._body.result.ok, true, 'a sched-skip tap succeeds');
    assertTrue(rows.schedule['schedule:model_v1'].overrides['2026-08-05'].disabledBlockIds.includes(gymId), 'sched-skip correctly parses the block id (which itself contains colons) and the trailing date');
    assertTrue(calls.editMessageText[0].text.includes('Skipped'), 'the reminder message is edited to reflect the skip');
  }
  {
    const { calls, fetchStub } = makeHarness({});
    global.fetch = fetchStub;
    const res = mockRes();
    await handleCallbackQuery('bot123:ABC', { id: 'cb3', data: 'sched-ok', message: { chat: { id: 555 }, message_id: 11, text: 'anything' } }, res);
    assertEq(res._body.ok, true, 'a sched-ok tap is acknowledged');
    assertEq(calls.editMessageText.length, 0, 'dismissing a reminder does not edit its text, just clears the keyboard');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
