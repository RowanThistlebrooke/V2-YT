// ============================================================
// POST /api/notes-ai
// Authorization: Bearer <NOTES_EMBED_SECRET>
//
// Powers Notes' two other optional AI features (voice journaling + an
// on-demand reflection), sharing NOTES_EMBED_SECRET with api/notes-embed.js
// rather than minting a third/fourth secret for the same page.
//
// Body: { action: 'transcribe-chunk', audioBase64, mimeType }
//   Transcribes ONE short chunk of browser-recorded audio (OpenAI Whisper).
//   Deliberately chunk-at-a-time rather than one call for a whole recording:
//   Vercel's Serverless Functions reject request bodies over ~4.5MB, which a
//   single long voice-journal recording (sent as base64, ~33% larger than
//   raw) blows past easily — notes.html records in a continuous loop of
//   ~55s chunks instead, each well under that ceiling, so total recording
//   length is effectively unbounded. Requires OPENAI_API_KEY.
//
// Body: { action: 'polish', text }
//   Rewrites a raw transcript (the concatenation of every chunk above) into
//   clean prose in the speaker's own voice, run once at the end of a
//   recording rather than per-chunk (cheaper, and avoids the rewrite
//   losing continuity across chunk boundaries). Requires ANTHROPIC_API_KEY.
//
// Body: { action: 'reflect', text }
//   A short, supportive, on-demand reflection on the current note, given
//   real context from the rest of the dashboard (the same buildContext()
//   the Telegram assistant uses) so it's not reacting to the note in
//   total isolation. Deliberately NOT the Telegram assistant's tool-use
//   loop/system prompt — this is a plain completion with its own tone and
//   safety guardrails (see REFLECT_SYS), since a reflection has no business
//   calling log_purchase or add_todo. Requires ANTHROPIC_API_KEY.
// ============================================================

import { buildContext } from './telegram-webhook.js';

// Default Vercel function timeout is too tight for a slow-connection audio
// upload + Whisper round trip; each call here only ever handles one ~55s
// chunk or a plain-text completion, but this leaves real margin either way.
export const config = { maxDuration: 30 };

function extensionForMime(mimeType) {
  const m = mimeType || '';
  if (m.includes('webm')) return 'webm';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return 'webm';
}

// Browser-recorded audio varies by device (webm/opus on Chrome/Android,
// mp4/aac on Safari/iOS) unlike Telegram's fixed OGG voice notes, so this
// picks a matching filename extension rather than assuming one.
async function transcribeVoiceNote(apiKey, buffer, mimeType) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/webm' }), 'note.' + extensionForMime(mimeType));
  form.append('model', 'whisper-1');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + apiKey },
    body: form,
  });
  if (!res.ok) throw new Error('OpenAI transcription error: ' + res.status + ' ' + (await res.text()));
  const json = await res.json();
  if (typeof json.text !== 'string') throw new Error('OpenAI transcription response missing text');
  return json.text;
}

const POLISH_SYS = 'Rewrite the following raw speech-to-text transcript into clean, natural written prose in the '
  + 'same voice and first person as the speaker. Fix filler words, false starts, run-ons, and transcription errors; '
  + 'keep every actual detail and the original meaning and tone — don\'t add anything they didn\'t say, don\'t '
  + 'summarize or shorten it, don\'t make it more formal than how a person actually journals. Return ONLY the '
  + 'rewritten text, nothing else — no preamble, no quotation marks, no "Here\'s the rewrite:".';

async function polishTranscript(apiKey, rawText) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      // Haiku, not Sonnet — this is a mechanical rewrite (fix filler words,
      // keep the meaning) with no real judgment call in it, and it runs
      // once per recording session, so it's a cheap place to save cost
      // without touching output quality. reflectOnNote below stays on
      // Sonnet — it's rare (on-demand only) and the tone genuinely matters.
      model: 'claude-haiku-4-5-20251001',
      // Generous on purpose — a long journal entry can run well past a
      // thousand words, and a truncated rewrite (this used to be capped at
      // 1024 tokens, well under that) is worse than not polishing at all.
      max_tokens: 8192,
      system: POLISH_SYS,
      messages: [{ role: 'user', content: rawText }],
    }),
  });
  if (!res.ok) throw new Error('Anthropic error: ' + res.status + ' ' + (await res.text()));
  const json = await res.json();
  const block = (json.content || []).find(b => b.type === 'text');
  return block ? block.text.trim() : rawText;
}

const REFLECT_SYS = 'You are a warm, perceptive journaling companion reading one entry the user just wrote, with '
  + 'some real background on their life (their to-dos, gym, finances, health, etc. — passed below as JSON, the same '
  + 'data their own dashboard already tracks) for context. Respond with a short, genuine reflection — 2 to 5 '
  + 'sentences — that actually notices what\'s going on for them rather than generic encouragement; only reference '
  + 'the background context when it\'s truly relevant, don\'t force it in. You can ask at most one gentle '
  + 'follow-up question if it fits naturally. Never diagnose, never claim to be a therapist, never sound clinical '
  + 'or preachy for ordinary tough-day content. If anything in the entry suggests real crisis or danger — '
  + 'self-harm, suicidal thoughts, abuse — gently and briefly encourage them to reach out to a real person or a '
  + 'crisis line (988 in the US, or their local equivalent) alongside whatever else you say, without making the '
  + 'whole response about that unless the entry clearly calls for it.';

async function reflectOnNote(apiKey, noteText) {
  const context = await buildContext().catch(() => ({}));
  const userMsg = 'Background context on my life (JSON, only use what\'s relevant):\n'
    + JSON.stringify(context).slice(0, 12000)
    + '\n\n---\n\nWhat I just wrote:\n' + noteText;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 512,
      system: REFLECT_SYS,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!res.ok) throw new Error('Anthropic error: ' + res.status + ' ' + (await res.text()));
  const json = await res.json();
  const block = (json.content || []).find(b => b.type === 'text');
  return block ? block.text.trim() : '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const secret = process.env.NOTES_EMBED_SECRET;
  if (!secret) return res.status(500).json({ error: 'server not configured (missing NOTES_EMBED_SECRET)' });
  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + secret) return res.status(401).json({ error: 'unauthorized' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  try {
    if (body.action === 'transcribe-chunk') {
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) return res.status(500).json({ ok: false, error: 'OPENAI_API_KEY not configured' });
      const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64 : '';
      if (!audioBase64) return res.status(400).json({ ok: false, error: 'missing audioBase64' });
      const buffer = Buffer.from(audioBase64, 'base64');
      if (!buffer.length) return res.status(400).json({ ok: false, error: 'empty audio' });
      const transcript = await transcribeVoiceNote(openaiKey, buffer, body.mimeType);
      return res.status(200).json({ ok: true, transcript });
    }

    if (body.action === 'polish') {
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (!anthropicKey) return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return res.status(200).json({ ok: true, polished: '' });
      const polished = await polishTranscript(anthropicKey, text);
      return res.status(200).json({ ok: true, polished });
    }

    if (body.action === 'reflect') {
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (!anthropicKey) return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return res.status(400).json({ ok: false, error: 'missing text' });
      const reflection = await reflectOnNote(anthropicKey, text);
      return res.status(200).json({ ok: true, reflection });
    }

    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}
