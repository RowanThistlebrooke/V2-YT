// ============================================================
// POST /api/youtube-duration
// Authorization: Bearer <YOUTUBE_LOOKUP_SECRET>
// Body: { url: "https://www.youtube.com/watch?v=..." }
//
// Looks up a YouTube video's total length via the YouTube Data API, so
// reading.html's "audiobook on YouTube" flow only needs the link pasted in
// — no manually figuring out and typing a multi-hour runtime. Only the
// TOTAL runtime is looked up this way; how much you've actually listened
// to stays a manual entry, same as before, since there's no way to know
// that without watching alongside you.
//
// Required env vars:
//   YOUTUBE_API_KEY        from console.cloud.google.com — enable the
//                          "YouTube Data API v3" for a project, then create
//                          an API key. Free tier is 10,000 units/day; this
//                          call costs 1 unit, so personal use never gets
//                          close.
//   YOUTUBE_LOOKUP_SECRET  any random string, abuse-prevention only, same
//                          trade-off as NOTES_EMBED_SECRET/PLAID_SYNC_SECRET
//                          — served to the browser via /api/config, so it
//                          isn't a real secret once shipped; it just stops
//                          a stranger from burning your API quota.
// ============================================================

// Accepts watch/short/live/embed links, youtu.be short links, with or
// without a protocol — people paste all of these.
function extractVideoId(url) {
  let u;
  try { u = new URL(url); }
  catch (e) {
    try { u = new URL('https://' + url); }
    catch (e2) { return null; }
  }
  if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
  if (u.hostname.includes('youtube.com')) {
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/\/(embed|shorts|live)\/([^/?]+)/);
    if (m) return m[2];
  }
  return null;
}

// "PT1H32M4S" -> 92 (rounds to the nearest whole minute)
function parseIsoDurationToMinutes(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const hours = Number(m[1] || 0), minutes = Number(m[2] || 0), seconds = Number(m[3] || 0);
  return Math.round(hours * 60 + minutes + seconds / 60);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const secret = process.env.YOUTUBE_LOOKUP_SECRET;
  if (!secret) return res.status(500).json({ error: 'server not configured (missing YOUTUBE_LOOKUP_SECRET)' });
  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + secret) return res.status(401).json({ error: 'unauthorized' });

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'YOUTUBE_API_KEY not configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) return res.status(400).json({ ok: false, error: 'missing "url"' });

  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(200).json({ ok: false, error: "couldn't find a video ID in that link — paste a normal youtube.com or youtu.be URL" });
  }

  try {
    const apiUrl = 'https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id='
      + encodeURIComponent(videoId) + '&key=' + encodeURIComponent(apiKey);
    const r = await fetch(apiUrl);
    const json = await r.json();
    if (!r.ok) return res.status(200).json({ ok: false, error: (json.error && json.error.message) || 'YouTube API request failed' });
    const item = json.items && json.items[0];
    if (!item) return res.status(200).json({ ok: false, error: 'video not found (private, deleted, or a bad link)' });
    const minutes = parseIsoDurationToMinutes(item.contentDetails && item.contentDetails.duration);
    if (minutes == null) return res.status(200).json({ ok: false, error: "couldn't parse that video's duration" });
    return res.status(200).json({ ok: true, minutes, title: (item.snippet && item.snippet.title) || '' });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}

export { extractVideoId, parseIsoDurationToMinutes };
