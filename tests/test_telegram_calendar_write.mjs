import { TOOL_EXECUTORS } from '../api/telegram-webhook.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function clearGoogleEnv() {
  ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SUPABASE_SERVICE_ROLE_KEY'].forEach(k => delete process.env[k]);
}
function setUpValidTokens() {
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'csecret';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
}
function tokensFetchBranch(u, opts) {
  if (u.includes('google_tokens') && (!opts || !opts.method)) {
    return { ok: true, json: async () => [{ access: 'valid-access', refresh: 'r1', expires: Date.now() + 3600e3 }] };
  }
  return null;
}

(async () => {
  const origFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-key';

  // ==================== not connected at all -> clean {ok:false}, no throw ====================
  {
    clearGoogleEnv();
    global.fetch = async (url) => { throw new Error('should not fetch anything: ' + url); };
    const create = await TOOL_EXECUTORS.create_calendar_event({ title: 'Test', start: '2026-08-01T10:00:00Z', end: '2026-08-01T11:00:00Z' });
    assertEq(create.ok, false, 'create_calendar_event reports failure (not a thrown error) when Google isn\'t connected');
    assertTrue(create.reason.includes('connect'), 'the failure reason tells the user to connect Google');
    const update = await TOOL_EXECUTORS.update_calendar_event({ event_id: 'e1', title: 'New title' });
    assertEq(update.ok, false, 'update_calendar_event also fails cleanly when not connected');
    const del = await TOOL_EXECUTORS.delete_calendar_event({ event_id: 'e1' });
    assertEq(del.ok, false, 'delete_calendar_event also fails cleanly when not connected');
    const list = await TOOL_EXECUTORS.list_calendar_events({ start_date: '2026-08-01', end_date: '2026-08-07' });
    assertEq(list.ok, false, 'list_calendar_events also fails cleanly when not connected');
  }

  setUpValidTokens();

  // ==================== create_calendar_event ====================
  {
    let sentReq = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      const tok = tokensFetchBranch(u, opts);
      if (tok) return tok;
      if (u.includes('calendar/v3') && opts && opts.method === 'POST') {
        sentReq = { url: u, body: JSON.parse(opts.body) };
        return { ok: true, json: async () => ({ id: 'new_event_123', summary: 'Dentist', htmlLink: 'https://calendar.google.com/x' }) };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    const result = await TOOL_EXECUTORS.create_calendar_event({
      title: 'Dentist', start: '2026-08-03T14:00:00-04:00', end: '2026-08-03T15:00:00-04:00', description: 'Cleaning', location: 'Dr. Smith',
    });
    assertEq(result.ok, true, 'create_calendar_event succeeds with valid tokens');
    assertEq(result.id, 'new_event_123', 'returns the real Google-assigned event id');
    assertTrue(sentReq.url.includes('/calendars/primary/events') && !sentReq.url.includes('/events/'), 'POSTs to the bare events collection endpoint, not a specific event id');
    assertEq(sentReq.body.summary, 'Dentist', 'title is sent as summary (Google Calendar\'s field name)');
    assertEq(sentReq.body.start, { dateTime: '2026-08-03T14:00:00-04:00' }, 'a datetime-formatted start is sent as start.dateTime');
    assertEq(sentReq.body.end, { dateTime: '2026-08-03T15:00:00-04:00' }, 'end is sent as end.dateTime the same way');
    assertEq(sentReq.body.description, 'Cleaning', 'description passed through');
    assertEq(sentReq.body.location, 'Dr. Smith', 'location passed through');

    // A bare YYYY-MM-DD date (no time) is sent as an all-day event.
    global.fetch = async (url, opts) => {
      const u = String(url);
      const tok = tokensFetchBranch(u, opts);
      if (tok) return tok;
      if (u.includes('calendar/v3') && opts && opts.method === 'POST') {
        sentReq = { body: JSON.parse(opts.body) };
        return { ok: true, json: async () => ({ id: 'e2', summary: 'Trip' }) };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    await TOOL_EXECUTORS.create_calendar_event({ title: 'Trip', start: '2026-09-01', end: '2026-09-05' });
    assertEq(sentReq.body.start, { date: '2026-09-01' }, 'a bare YYYY-MM-DD start is sent as an all-day start.date, not start.dateTime');
    assertEq(sentReq.body.end, { date: '2026-09-05' }, 'same for end.date');

    // Missing required fields fail cleanly without ever hitting Google.
    global.fetch = async () => { throw new Error('should not call Google when required fields are missing'); };
    const missing = await TOOL_EXECUTORS.create_calendar_event({ title: 'No dates' });
    assertEq(missing.ok, false, 'create_calendar_event rejects a missing start/end before ever calling Google');
  }

  // ==================== update_calendar_event ====================
  {
    let sentReq = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      const tok = tokensFetchBranch(u, opts);
      if (tok) return tok;
      if (u.includes('calendar/v3') && opts && opts.method === 'PATCH') {
        sentReq = { url: u, body: JSON.parse(opts.body) };
        return { ok: true, json: async () => ({ id: 'e1', summary: 'Dentist - rescheduled' }) };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    const result = await TOOL_EXECUTORS.update_calendar_event({ event_id: 'e1', start: '2026-08-03T16:00:00-04:00' });
    assertEq(result.ok, true, 'update_calendar_event succeeds');
    assertTrue(sentReq.url.endsWith('/events/e1'), 'PATCHes the specific event by id');
    assertEq(sentReq.body, { start: { dateTime: '2026-08-03T16:00:00-04:00' } }, 'only the field actually provided is sent — no accidental clobbering of title/end/etc');

    // No event_id -> fails before ever calling Google.
    global.fetch = async () => { throw new Error('should not call Google with no event_id'); };
    const noId = await TOOL_EXECUTORS.update_calendar_event({ title: 'New title' });
    assertEq(noId.ok, false, 'update_calendar_event requires event_id');

    // Nothing to update -> also fails before calling Google.
    const noFields = await TOOL_EXECUTORS.update_calendar_event({ event_id: 'e1' });
    assertEq(noFields.ok, false, 'update_calendar_event with no actual fields to change reports failure rather than a no-op PATCH');
  }

  // ==================== delete_calendar_event ====================
  {
    let deletedUrl = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      const tok = tokensFetchBranch(u, opts);
      if (tok) return tok;
      if (u.includes('calendar/v3') && opts && opts.method === 'DELETE') {
        deletedUrl = u;
        return { ok: true, status: 204, json: async () => { throw new Error('should not parse JSON on a 204'); } };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    const result = await TOOL_EXECUTORS.delete_calendar_event({ event_id: 'e1' });
    assertEq(result.ok, true, 'delete_calendar_event succeeds on a 204 No Content response, without trying to parse a JSON body');
    assertEq(result.deleted, 'e1', 'reports back which event id was deleted');
    assertTrue(deletedUrl.endsWith('/events/e1'), 'DELETEs the specific event by id');

    global.fetch = async () => { throw new Error('should not call Google with no event_id'); };
    const noId = await TOOL_EXECUTORS.delete_calendar_event({});
    assertEq(noId.ok, false, 'delete_calendar_event requires event_id');
  }

  // ==================== list_calendar_events ====================
  {
    let requestedUrl = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      const tok = tokensFetchBranch(u, opts);
      if (tok) return tok;
      if (u.includes('calendar/v3')) {
        requestedUrl = u;
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'e1', summary: 'Standup', start: { dateTime: '2026-08-04T09:00:00Z' }, end: { dateTime: '2026-08-04T09:15:00Z' } },
              { id: 'e2', summary: null, start: { date: '2026-08-05' }, end: { date: '2026-08-06' } },
            ],
          }),
        };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    const result = await TOOL_EXECUTORS.list_calendar_events({ start_date: '2026-08-04', end_date: '2026-08-06' });
    assertEq(result.ok, true, 'list_calendar_events succeeds');
    assertEq(result.events.length, 2, 'returns every event in range');
    assertEq(result.events[0], { id: 'e1', title: 'Standup', start: '2026-08-04T09:00:00Z', end: '2026-08-04T09:15:00Z' }, 'a timed event is summarized with id/title/start/end');
    assertEq(result.events[1].title, '(no title)', 'an event with no summary falls back to a placeholder title, not null/undefined');
    assertEq(result.events[1].start, '2026-08-05', 'an all-day event uses its date field (not dateTime) for start/end');
    assertTrue(requestedUrl.includes('timeMin') && requestedUrl.includes('timeMax'), 'the request includes a time range derived from start_date/end_date');

    global.fetch = async () => { throw new Error('should not call Google with missing date range'); };
    const missing = await TOOL_EXECUTORS.list_calendar_events({ start_date: '2026-08-04' });
    assertEq(missing.ok, false, 'list_calendar_events requires both start_date and end_date');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
