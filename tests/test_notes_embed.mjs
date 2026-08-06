import handler from '../api/notes-embed.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function mockRes() {
  const res = { _status: null, _body: null, _headers: {} };
  res.status = (s) => { res._status = s; return res; };
  res.json = (b) => { res._body = b; return res; };
  res.send = (b) => { res._body = b; return res; };
  res.end = () => { return res; };
  res.setHeader = (k, v) => { res._headers[k] = v; };
  return res;
}

const FAKE_VECTOR = new Array(1536).fill(0).map((_, i) => (i % 7) / 7);

(async () => {
  const origFetch = global.fetch;
  const origEnv = { ...process.env };
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
  process.env.NOTES_EMBED_SECRET = 'shh-notes-secret';
  process.env.OPENAI_API_KEY = 'sk-fake-openai';

  // ---- OPTIONS / method guards ----
  {
    const res = mockRes();
    await handler({ method: 'OPTIONS', headers: {} }, res);
    assertEq(res._status, 204, 'OPTIONS returns 204');
    const res2 = mockRes();
    await handler({ method: 'GET', headers: {} }, res2);
    assertEq(res2._status, 405, 'GET is rejected with 405');
  }

  // ---- auth ----
  {
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, body: { action: 'search', query: 'hi' } }, res);
    assertEq(res._status, 401, 'no Authorization header is rejected with 401');

    const res2 = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer wrong' }, body: { action: 'search', query: 'hi' } }, res2);
    assertEq(res2._status, 401, 'a wrong bearer secret is rejected with 401');
  }

  // ---- missing server config ----
  {
    delete process.env.OPENAI_API_KEY;
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'search', query: 'hi' } }, res);
    assertEq(res._status, 500, 'missing OPENAI_API_KEY is a 500');
    process.env.OPENAI_API_KEY = 'sk-fake-openai';
  }

  // ---- validation ----
  {
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'upsert', noteId: 'n1' } }, res);
    assertEq(res._status, 400, 'upsert with no text is rejected with 400');

    const res2 = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'upsert', text: 'hello' } }, res2);
    assertEq(res2._status, 400, 'upsert with no noteId is rejected with 400');

    const res3 = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'search', query: '   ' } }, res3);
    assertEq(res3._status, 400, 'search with a blank query is rejected with 400');

    const res4 = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'nonsense' } }, res4);
    assertEq(res4._status, 400, 'an unrecognized action is rejected with 400');
  }

  // ---- upsert: embeds the text, stores the vector against the right note id ----
  {
    let embedInput = null, supabaseUpsertBody = null, supabaseUpsertUrl = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('api.openai.com')) {
        embedInput = JSON.parse(opts.body).input;
        return { ok: true, json: async () => ({ data: [{ embedding: FAKE_VECTOR }] }) };
      }
      if (u.includes('/rest/v1/note_embeddings')) {
        supabaseUpsertUrl = u;
        supabaseUpsertBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'upsert', noteId: 'n_123', text: 'Remember to call the dentist' } }, res);
    assertEq(res._status, 200, 'a valid upsert returns 200');
    assertEq(res._body, { ok: true }, 'upsert response is a plain {ok:true}');
    assertEq(embedInput, 'Remember to call the dentist', 'the note text is sent to OpenAI verbatim');
    assertTrue(supabaseUpsertUrl.includes('on_conflict=note_id'), 'the Supabase write upserts on note_id (on_conflict), not a blind insert');
    assertEq(supabaseUpsertBody.note_id, 'n_123', 'the correct note_id is stored');
    assertEq(supabaseUpsertBody.embedding, FAKE_VECTOR, 'the embedding vector is stored as returned by OpenAI');
  }

  // ---- delete: removes the row for that note id ----
  {
    let deleteUrl = null, deleteMethod = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/rest/v1/note_embeddings')) {
        deleteUrl = u; deleteMethod = opts.method;
        return { ok: true, json: async () => ({}) };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'delete', noteId: 'n_123' } }, res);
    assertEq(res._status, 200, 'a valid delete returns 200');
    assertEq(deleteMethod, 'DELETE', 'delete issues an actual HTTP DELETE against Supabase');
    assertTrue(deleteUrl.includes('note_id=eq.n_123'), 'the delete targets the correct note_id');
  }

  // ---- search: embeds the query, calls match_notes, returns ranked results ----
  {
    let matchBody = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('api.openai.com')) return { ok: true, json: async () => ({ data: [{ embedding: FAKE_VECTOR }] }) };
      if (u.includes('/rest/v1/rpc/match_notes')) {
        matchBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ([{ note_id: 'n_2', similarity: 0.91 }, { note_id: 'n_5', similarity: 0.77 }]) };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'search', query: 'dentist appointment' } }, res);
    assertEq(res._status, 200, 'a valid search returns 200');
    assertEq(res._body, { ok: true, results: [{ noteId: 'n_2', similarity: 0.91 }, { noteId: 'n_5', similarity: 0.77 }] },
      'search returns results ranked in the order match_notes gave them, mapped to camelCase noteId');
    assertEq(matchBody.query_embedding, FAKE_VECTOR, 'the query text was actually embedded before searching');
    assertTrue(typeof matchBody.match_count === 'number' && matchBody.match_count > 0, 'a match_count limit is passed to the RPC');
  }

  // ---- an internal failure reports {ok:false} with 200, not a crash ----
  {
    global.fetch = async () => { throw new Error('openai is down'); };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-notes-secret' }, body: { action: 'search', query: 'anything' } }, res);
    assertEq(res._status, 200, 'an internal failure still responds 200');
    assertEq(res._body.ok, false, 'the failure is reported as {ok:false}');
    assertTrue(res._body.error.includes('openai is down'), 'the underlying error message is surfaced for debugging');
  }

  global.fetch = origFetch;
  process.env = origEnv;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
