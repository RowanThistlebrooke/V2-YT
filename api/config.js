// ============================================================
// GET /api/config  →  returns a tiny JS file that sets the
// public Supabase config on `window` from Vercel env vars:
//   SUPABASE_URL        (your project URL)
//   SUPABASE_ANON_KEY   (the public anon / publishable key)
//   GOOGLE_SYNC_SECRET  (see api/google.js)
//   NOTES_EMBED_SECRET  (see api/notes-embed.js)
//   PLAID_SYNC_SECRET   (see api/plaid.js)
//   YOUTUBE_LOOKUP_SECRET (see api/youtube-duration.js)
//
// Loaded via <script src="/api/config"></script> in the <head>
// BEFORE sync.js / topbar.js. If the env vars aren't set (or the
// site is opened locally), it sets empty strings and the pages
// fall back to whatever default is hardcoded in the JS.
//
// These are PUBLIC values (they ship to the browser anyway), so
// it's fine to expose them — this just lets people configure the
// app with env vars instead of editing files. GOOGLE_SYNC_SECRET and
// NOTES_EMBED_SECRET are no exception: each only gates a single endpoint
// against casual abuse (a stranger running up your OpenAI bill, in
// NOTES_EMBED_SECRET's case) — neither protects confidentiality on its
// own. For Google tokens that's the google_tokens table having no
// anon-key policies at all (see api/google.js); note content
// never leaves localStorage/the normal 'notes' sync row in the first
// place, so there's nothing extra to protect there beyond the vectors
// themselves, which reveal nothing readable on their own.
// ============================================================
export default function handler(req, res) {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_ANON_KEY || '';
  const googleSyncSecret = process.env.GOOGLE_SYNC_SECRET || '';
  const notesEmbedSecret = process.env.NOTES_EMBED_SECRET || '';
  const plaidSyncSecret = process.env.PLAID_SYNC_SECRET || '';
  const youtubeLookupSecret = process.env.YOUTUBE_LOOKUP_SECRET || '';
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(
    'window.DASH_SUPABASE_URL=' + JSON.stringify(url) + ';' +
    'window.DASH_SUPABASE_KEY=' + JSON.stringify(key) + ';' +
    'window.DASH_GOOGLE_SYNC_SECRET=' + JSON.stringify(googleSyncSecret) + ';' +
    'window.DASH_NOTES_EMBED_SECRET=' + JSON.stringify(notesEmbedSecret) + ';' +
    'window.DASH_PLAID_SYNC_SECRET=' + JSON.stringify(plaidSyncSecret) + ';' +
    'window.DASH_YOUTUBE_LOOKUP_SECRET=' + JSON.stringify(youtubeLookupSecret) + ';'
  );
}
