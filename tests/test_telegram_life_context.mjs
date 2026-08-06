import { buildContext, summarizeNotesForContext } from '../api/telegram-webhook.js';

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

  // ==================== summarizeNotesForContext (pure) ====================
  {
    const longBody = 'x'.repeat(800);
    const notesData = {
      'notes:items': [
        { id: 'n1', title: 'Old note', body: 'short', updatedAt: 100 },
        { id: 'n2', title: 'Long note', body: longBody, updatedAt: 300 },
        { id: 'n3', title: 'Middle note', body: 'medium length', updatedAt: 200 },
      ],
    };
    const summary = summarizeNotesForContext(notesData);
    assertEq(summary['notes:items'].map(n => n.id), ['n2', 'n3', 'n1'], 'notes are ordered most-recently-edited first');
    assertTrue(summary['notes:items'][0].body.length <= 501, 'a long note body is truncated');
    assertTrue(summary['notes:items'][0].body.endsWith('…'), 'a truncated body is marked with an ellipsis');
    assertEq(summary['notes:items'][1].body, 'medium length', 'a short body is left untouched');

    const many = { 'notes:items': Array.from({ length: 30 }, (_, i) => ({ id: 'n' + i, title: '', body: '', updatedAt: i })) };
    assertEq(summarizeNotesForContext(many)['notes:items'].length, 20, 'the notes list is capped at 20 even when far more exist');

    assertEq(summarizeNotesForContext(null)['notes:items'], [], 'a missing notes row does not throw, just yields an empty list');
    assertEq(summarizeNotesForContext({})['notes:items'], [], 'a notes row with no notes:items array does not throw');
  }

  // ==================== buildContext: lifeContext flattening ====================
  {
    const fake = makeFakeSupabase({
      life_context: { 'life_context:text': 'Training for a marathon in October.' },
    });
    global.fetch = fake.fetchStub;
    const context = await buildContext();
    assertEq(context.lifeContext, 'Training for a marathon in October.', 'the raw life_context row is flattened to a plain lifeContext string');
    assertTrue(!('life_context' in context), 'the raw nested life_context key is removed once flattened');
  }

  // ==================== buildContext: no life context set yet ====================
  {
    const fake = makeFakeSupabase({});
    global.fetch = fake.fetchStub;
    const context = await buildContext();
    assertEq(context.lifeContext, '', 'lifeContext is an empty string, not undefined, when nothing has been written yet');
  }

  // ==================== buildContext: notes are summarized, not raw ====================
  {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: 'n' + i, title: 't' + i, body: 'b' + i, updatedAt: i }));
    const fake = makeFakeSupabase({ notes: { 'notes:items': many } });
    global.fetch = fake.fetchStub;
    const context = await buildContext();
    assertEq(context.notes['notes:items'].length, 20, 'buildContext applies the notes cap, not the raw full list');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
