// ============================================================
// POST /api/notes-embed
// Authorization: Bearer <NOTES_EMBED_SECRET>
//
// Semantic search for notes.html. Note CONTENT stays exactly where it
// already lives — localStorage, synced through the normal 'notes' app_state
// row — this endpoint only ever sees a note's text transiently to turn it
// into a vector, and stores nothing but that vector (keyed by note id) in
// its own dedicated Supabase table. Three actions, one body shape each:
//
//   { action: 'upsert', noteId, text }   embed + store/replace this note's vector
//   { action: 'delete', noteId }         remove a note's vector (called when the note is deleted)
//   { action: 'search',  query }         embed the query, return ranked note ids by similarity
//
// The actual ranking math (cosine distance) runs INSIDE Postgres via the
// match_notes() function (see SETUP.md) — this endpoint just embeds text
// and passes vectors back and forth, it never sees or reorders note
// content itself.
//
// Like google.js's GOOGLE_SYNC_SECRET, NOTES_EMBED_SECRET is
// abuse-prevention only (it's served to the browser via /api/config, so it
// isn't a real secret once shipped) — it exists so a stranger who finds
// this URL can't rack up your OpenAI bill, not to protect confidentiality.
//
// Required env vars:
//   OPENAI_API_KEY       from platform.openai.com — server-side only
//   NOTES_EMBED_SECRET    any random string, also served via /api/config
//                         as window.DASH_NOTES_EMBED_SECRET
//   SUPABASE_URL, SUPABASE_ANON_KEY   same ones already used everywhere
// ============================================================

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMENSIONS = 1536;
const SEARCH_MATCH_COUNT = 20;

async function embed(apiKey, text) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, 8000) }),
  });
  if (!res.ok) throw new Error('OpenAI embeddings error: ' + res.status + ' ' + (await res.text()));
  const json = await res.json();
  const vector = json && json.data && json.data[0] && json.data[0].embedding;
  if (!Array.isArray(vector)) throw new Error('OpenAI embeddings response missing a vector');
  return vector;
}

async function upsertEmbedding(supabaseUrl, supabaseKey, noteId, vector) {
  const res = await fetch(supabaseUrl + '/rest/v1/note_embeddings?on_conflict=note_id', {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      Authorization: 'Bearer ' + supabaseKey,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ note_id: noteId, embedding: vector, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error('Supabase upsert failed: ' + res.status + ' ' + (await res.text()));
}

async function deleteEmbedding(supabaseUrl, supabaseKey, noteId) {
  const res = await fetch(supabaseUrl + '/rest/v1/note_embeddings?note_id=eq.' + encodeURIComponent(noteId), {
    method: 'DELETE',
    headers: { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey },
  });
  if (!res.ok) throw new Error('Supabase delete failed: ' + res.status + ' ' + (await res.text()));
}

async function searchEmbeddings(supabaseUrl, supabaseKey, vector) {
  const res = await fetch(supabaseUrl + '/rest/v1/rpc/match_notes', {
    method: 'POST',
    headers: { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query_embedding: vector, match_count: SEARCH_MATCH_COUNT }),
  });
  if (!res.ok) throw new Error('Supabase match_notes call failed: ' + res.status + ' ' + (await res.text()));
  const rows = await res.json();
  return Array.isArray(rows) ? rows.map(r => ({ noteId: r.note_id, similarity: r.similarity })) : [];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const secret = process.env.NOTES_EMBED_SECRET;
    if (!secret) return res.status(500).json({ error: 'server not configured (missing NOTES_EMBED_SECRET)' });
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + secret) return res.status(401).json({ error: 'unauthorized' });

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_ANON_KEY not configured' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; } }
    if (!body || typeof body !== 'object') body = {};

    if (body.action === 'upsert') {
      const noteId = typeof body.noteId === 'string' ? body.noteId : '';
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!noteId || !text) return res.status(400).json({ ok: false, error: 'upsert needs both "noteId" and non-empty "text"' });
      const vector = await embed(openaiKey, text);
      await upsertEmbedding(supabaseUrl, supabaseKey, noteId, vector);
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'delete') {
      const noteId = typeof body.noteId === 'string' ? body.noteId : '';
      if (!noteId) return res.status(400).json({ ok: false, error: 'delete needs "noteId"' });
      await deleteEmbedding(supabaseUrl, supabaseKey, noteId);
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'search') {
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (!query) return res.status(400).json({ ok: false, error: 'search needs non-empty "query"' });
      const vector = await embed(openaiKey, query);
      const results = await searchEmbeddings(supabaseUrl, supabaseKey, vector);
      return res.status(200).json({ ok: true, results });
    }

    return res.status(400).json({ ok: false, error: 'unrecognized "action" — expected upsert, delete, or search' });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}

export { EMBED_MODEL, EMBED_DIMENSIONS };
