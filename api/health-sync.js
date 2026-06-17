// ============================================================
// POST /api/health-sync
// Receives Apple Watch / HealthKit metrics from the SwiftUI
// companion app and upserts them into Supabase (one row per day).
//
// Auth:   Authorization: Bearer <HEALTH_SYNC_SECRET>
// Body:   a single day object, or an array of day objects:
//   { "day": "2026-06-17", "resting_hr": 52, "hrv": 68, ... }
//
// Env vars required on Vercel:
//   SUPABASE_URL                 (your project URL — already used by /api/config)
//   SUPABASE_SERVICE_ROLE_KEY    (Settings → API → service_role secret)
//   HEALTH_SYNC_SECRET           (a long random string you also paste into the app)
//
// The service-role key bypasses RLS, so the public anon key can't
// be used to forge writes. Keep it server-side only — never ship it
// to the browser.
// ============================================================

// Only these columns are accepted; anything else lands in `raw`.
const ALLOWED = new Set([
  'day',
  'sleep_total_min', 'sleep_rem_min', 'sleep_core_min', 'sleep_deep_min',
  'sleep_awake_min', 'sleep_start', 'sleep_end',
  'resting_hr', 'walking_hr', 'hrv', 'cardio_recovery',
  'heart_rate_min', 'heart_rate_avg',
  'vo2max',
  'spo2', 'respiratory_rate', 'wrist_temp_deviation',
  'active_energy', 'resting_energy', 'exercise_min', 'stand_hours',
  'steps', 'distance_km', 'flights',
  'training_load',
  'weight_kg', 'body_fat_pct', 'bmi',
  'workouts',
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clean(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (!rec.day || !DATE_RE.test(String(rec.day))) return null;
  const row = { updated_at: new Date().toISOString() };
  const extra = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v === null || v === undefined) continue;
    if (ALLOWED.has(k)) row[k] = v;
    else extra[k] = v;
  }
  if (Object.keys(extra).length) row.raw = extra;
  return row;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const secret = process.env.HEALTH_SYNC_SECRET;
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || !supaUrl || !serviceKey) {
    return res.status(500).json({ error: 'server not configured (HEALTH_SYNC_SECRET / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' });
  }

  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body) return res.status(400).json({ error: 'invalid JSON body' });

  const records = Array.isArray(body) ? body : [body];
  const rows = records.map(clean).filter(Boolean);
  if (!rows.length) return res.status(400).json({ error: 'no valid records (each needs a "day": "YYYY-MM-DD")' });

  try {
    const r = await fetch(supaUrl + '/rest/v1/health_metrics?on_conflict=day', {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ error: 'supabase write failed: ' + text });
    }
    return res.status(200).json({ ok: true, written: rows.length });
  } catch (e) {
    return res.status(500).json({ error: 'fetch error: ' + (e && e.message ? e.message : String(e)) });
  }
}
