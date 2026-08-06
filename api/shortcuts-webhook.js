// ============================================================
// POST /api/shortcuts-webhook
// Authorization: Bearer <SHORTCUTS_WEBHOOK_SECRET>
// Body: { "text": "log 20 dollars for lunch" }
//
// A voice/automation front door onto the exact same Claude tool-use
// assistant that powers the Telegram bot — this file adds NO new
// business logic of its own, it just calls telegram-webhook.js's already-
// exported buildContext()/callClaude() with whatever text an iOS Shortcut
// sends in. Two use cases this is built for:
//
//   1. A "Log to dashboard" Shortcut that dictates whatever you say via
//      Siri and POSTs the transcript here, then speaks the JSON `reply`
//      back to you — same free-form logging as texting the bot, just by
//      voice.
//   2. A location-triggered Automation (no user interaction) that POSTs a
//      fixed sentence when you arrive somewhere, e.g. "I just arrived at
//      the gym, starting my workout" on entering a gym's geofence. It's
//      just plain text through the SAME pipe as (1) — there's no separate
//      hardcoded "gym arrival" code path to maintain.
//
// Deliberately stateless (no conversation history): each Shortcut run is
// a one-off utterance, not a back-and-forth chat, and keeping it separate
// from the Telegram bot's own telegram-memory row avoids two channels
// racing to read-modify-write the same history at once.
//
// Required env vars:
//   SHORTCUTS_WEBHOOK_SECRET   shared secret — set this in the Shortcut's
//                              "Get Contents of URL" request headers too
//   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY — same ones the
//                              Telegram assistant already needs
// ============================================================

import { buildContext, callClaude } from './telegram-webhook.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const secret = process.env.SHORTCUTS_WEBHOOK_SECRET;
    if (!secret) return res.status(500).json({ error: 'server not configured (missing SHORTCUTS_WEBHOOK_SECRET)' });
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + secret) return res.status(401).json({ error: 'unauthorized' });

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_ANON_KEY not configured' });
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; } }
    if (!body || typeof body !== 'object') body = {};

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return res.status(400).json({ ok: false, error: 'missing "text" in request body' });

    const context = await buildContext();
    const { text: reply } = await callClaude(anthropicKey, context, text, []);
    return res.status(200).json({ ok: true, reply });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}
