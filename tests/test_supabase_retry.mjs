// Tests the retry/backoff wrapper added around every Supabase app_state
// read/write in telegram-webhook.js. Exercised indirectly through a real
// tool executor (which goes through patchRow -> readRow/writeRow) rather
// than importing fetchWithRetry directly, since it isn't exported — this
// also proves the retry logic is actually wired into the real code path,
// not just correct in isolation.
import { TOOL_EXECUTORS } from '../api/telegram-webhook.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

(async () => {
  const origFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';

  // ---- a network-level throw on the read, then success, still completes ----
  {
    let calls = 0;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('key=eq.goals') && (!opts || !opts.method)) {
        calls++;
        if (calls === 1) throw new Error('ECONNRESET');
        return { ok: true, json: async () => [{ data: { 'recur:defs': [] } }] };
      }
      if (u.includes('/rest/v1/app_state') && opts && opts.method === 'POST') {
        return { ok: true, json: async () => ({}) };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    const result = await TOOL_EXECUTORS.add_todo({ text: 'Survive a dropped connection' });
    assertEq(result.ok, true, 'a single transient network error on the read is retried and the tool call still succeeds');
    assertEq(calls, 2, 'exactly 2 read attempts made (1 failure + 1 success)');
  }

  // ---- a 429 on the write, then success ----
  // (patchRow also writes a 'last_action' undo-snapshot after every
  // successful mutation — that write is scoped out here, since this test
  // is specifically about retry behavior on the primary 'goals' write.)
  {
    let goalsWriteAttempts = 0;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/rest/v1/app_state') && (!opts || !opts.method)) {
        return { ok: true, json: async () => [{ data: {} }] };
      }
      if (u.includes('/rest/v1/app_state') && opts && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        if (body.key !== 'goals') return { ok: true, json: async () => ({}) };
        goalsWriteAttempts++;
        if (goalsWriteAttempts === 1) return { ok: false, status: 429, text: async () => 'rate limited' };
        return { ok: true, json: async () => ({}) };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    const result = await TOOL_EXECUTORS.add_todo({ text: 'Survive a 429' });
    assertEq(result.ok, true, 'a 429 rate-limit response on the write is retried and the tool call still succeeds');
    assertEq(goalsWriteAttempts, 2, 'exactly 2 write attempts made to the goals row (1 rate-limited + 1 success)');
  }

  // ---- a 500 that never recovers exhausts retries and throws (surfaced as ok:false by the caller's try/catch) ----
  {
    let attempts = 0;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/rest/v1/app_state') && (!opts || !opts.method)) {
        attempts++;
        return { ok: false, status: 503, text: async () => 'db is down' };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    let threw = null;
    try { await TOOL_EXECUTORS.add_todo({ text: 'This will never succeed' }); }
    catch (e) { threw = e.message; }
    assertTrue(!!threw && threw.includes('Supabase read failed'), 'a persistently-failing 5xx eventually surfaces the real error rather than retrying forever');
    assertEq(attempts, 4, 'exactly 4 attempts made (1 initial + 3 retries) before giving up');
  }

  // ---- a non-retryable 4xx (e.g. bad request) fails immediately, no wasted retries ----
  {
    let attempts = 0;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/rest/v1/app_state') && (!opts || !opts.method)) {
        attempts++;
        return { ok: false, status: 400, text: async () => 'bad request' };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    let threw = null;
    try { await TOOL_EXECUTORS.add_todo({ text: 'Bad request, do not retry' }); }
    catch (e) { threw = e.message; }
    assertTrue(!!threw, 'a non-retryable 4xx still surfaces as an error');
    assertEq(attempts, 1, 'only 1 attempt made for a non-retryable 4xx — retrying a bad request would only waste time');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
