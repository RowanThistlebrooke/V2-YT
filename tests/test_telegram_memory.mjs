import { TOOL_EXECUTORS, buildContext } from '../api/telegram-webhook.js';

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
    if (u.includes('open.er-api.com')) return { ok: true, json: async () => ({ rates: { USD: 1.1 } }) };
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

  // ==================== remember() ====================
  {
    const fake = makeFakeSupabase({});
    global.fetch = fake.fetchStub;

    const result = await TOOL_EXECUTORS.remember({ text: 'Training for a marathon in October.' });
    assertTrue(result.ok, 'remember() succeeds with real text');
    const stored = fake.rows.assistant_memory['memory:entries'];
    assertEq(stored.length, 1, 'one entry is stored after one remember() call');
    assertEq(stored[0].text, 'Training for a marathon in October.', 'the stored entry has the exact text');
    assertTrue(typeof stored[0].ts === 'number', 'each entry gets a timestamp');

    const empty = await TOOL_EXECUTORS.remember({ text: '   ' });
    assertEq(empty.ok, false, 'remember() rejects whitespace-only text');
    assertEq(fake.rows.assistant_memory['memory:entries'].length, 1, 'a rejected remember() call does not add an entry');

    // Last-action undo snapshot should exist (patchRow's generic mechanism).
    assertTrue(!!fake.rows.last_action, 'a successful remember() call is undo-able like any other tool write');
  }

  // ==================== remember() truncation + cap ====================
  {
    const fake = makeFakeSupabase({});
    global.fetch = fake.fetchStub;

    const longText = 'x'.repeat(1000);
    await TOOL_EXECUTORS.remember({ text: longText });
    assertTrue(fake.rows.assistant_memory['memory:entries'][0].text.length <= 300, 'an overly long observation is truncated');

    // Fill past the cap.
    const seeded = { assistant_memory: { 'memory:entries': Array.from({ length: 40 }, (_, i) => ({ text: 'entry ' + i, ts: i })) } };
    const fake2 = makeFakeSupabase(seeded);
    global.fetch = fake2.fetchStub;
    await TOOL_EXECUTORS.remember({ text: 'the newest one' });
    const entries = fake2.rows.assistant_memory['memory:entries'];
    assertEq(entries.length, 40, 'the memory log stays capped at 40 entries even after adding a new one');
    assertEq(entries[entries.length - 1].text, 'the newest one', 'the newest entry is kept');
    assertTrue(!entries.some(e => e.text === 'entry 0'), 'the oldest entry is dropped once the cap is exceeded');
  }

  // ==================== forget_memory() ====================
  {
    const seeded = {
      assistant_memory: {
        'memory:entries': [
          { text: 'Training for a marathon in October.', ts: 1 },
          { text: 'Cut back on takeout this quarter.', ts: 2 },
        ],
      },
    };
    const fake = makeFakeSupabase(seeded);
    global.fetch = fake.fetchStub;

    const result = await TOOL_EXECUTORS.forget_memory({ query: 'marathon' });
    assertTrue(result.ok, 'forget_memory() succeeds when a matching entry exists');
    assertEq(result.removed, 1, 'exactly one matching entry is reported removed');
    const remaining = fake.rows.assistant_memory['memory:entries'];
    assertEq(remaining.length, 1, 'the matching entry is actually removed');
    assertEq(remaining[0].text, 'Cut back on takeout this quarter.', 'the non-matching entry is left untouched');

    const noMatch = await TOOL_EXECUTORS.forget_memory({ query: 'nonexistent thing' });
    assertEq(noMatch.ok, false, 'forget_memory() reports failure when nothing matches');

    const empty = await TOOL_EXECUTORS.forget_memory({ query: '' });
    assertEq(empty.ok, false, 'forget_memory() rejects an empty query');
  }

  // ==================== buildContext: assistantMemory flattening ====================
  {
    const fake = makeFakeSupabase({
      assistant_memory: { 'memory:entries': [{ text: 'Likes terse replies.', ts: 5 }] },
    });
    global.fetch = fake.fetchStub;
    const context = await buildContext();
    assertEq(context.assistantMemory, [{ text: 'Likes terse replies.', ts: 5 }], 'buildContext flattens the raw row into a plain assistantMemory array');
    assertTrue(!('assistant_memory' in context), 'the raw nested assistant_memory key is removed once flattened');
  }

  // ==================== buildContext: no memory yet ====================
  {
    const fake = makeFakeSupabase({});
    global.fetch = fake.fetchStub;
    const context = await buildContext();
    assertEq(context.assistantMemory, [], 'assistantMemory is an empty array, not undefined, before anything has been remembered');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
