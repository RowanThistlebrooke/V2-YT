import handler from '../api/telegram-webhook.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function mockRes() {
  const res = { _status: null, _body: null };
  res.status = (s) => { res._status = s; return res; };
  res.json = (b) => { res._body = b; return res; };
  res.send = (b) => { res._body = b; return res; };
  return res;
}

const FAKE_AUDIO_BYTES = new TextEncoder().encode('totally-an-ogg-file').buffer;

(async () => {
  const origFetch = global.fetch;
  process.env.TELEGRAM_BOT_TOKEN = 'bot123:ABC';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'shh-secret';
  process.env.TELEGRAM_CHAT_ID = '555';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
  process.env.OPENAI_API_KEY = 'sk-fake-openai';
  process.env.REMINDER_TIMEZONE = 'UTC';

  const headers = { 'x-telegram-bot-api-secret-token': 'shh-secret' };

  // ==================== a voice message: download -> transcribe -> logged via Claude ====================
  {
    const rows = { goals: {}, finance: { purchases: [] } };
    let anthropicReq = null;
    let sentText = null;
    let getFileCalledWith = null;
    let transcriptionCalled = false;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/rest/v1/app_state')) {
        if (!opts || !opts.method) {
          const key = decodeURIComponent(u.match(/key=eq\.([^&]+)/)[1]);
          return { ok: true, json: async () => [{ data: rows[key] || {} }] };
        }
        const body = JSON.parse(opts.body);
        rows[body.key] = body.data;
        return { ok: true, json: async () => ({}) };
      }
      if (u.includes('/getFile')) {
        getFileCalledWith = u;
        return { ok: true, json: async () => ({ ok: true, result: { file_path: 'voice/file_1.oga' } }) };
      }
      if (u.includes('/file/bot')) return { ok: true, arrayBuffer: async () => FAKE_AUDIO_BYTES };
      if (u.includes('api.openai.com/v1/audio/transcriptions')) {
        transcriptionCalled = true;
        return { ok: true, json: async () => ({ text: 'log a 20 dollar grocery run' }) };
      }
      if (u.includes('api.anthropic.com')) {
        anthropicReq = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Logged $20 for groceries.' }] }) };
      }
      if (u.includes('sendMessage')) { sentText = JSON.parse(opts.body).text; return { ok: true, json: async () => ({ ok: true }) }; }
      throw new Error('unexpected fetch: ' + u);
    };

    const res = mockRes();
    await handler({
      method: 'POST', headers,
      body: { message: { chat: { id: 555 }, voice: { file_id: 'voice_1', mime_type: 'audio/ogg', duration: 4 } } },
    }, res);

    assertEq(res._status, 200, 'a voice-only message returns 200');
    assertTrue(!!getFileCalledWith && getFileCalledWith.includes('voice_1'), 'the voice message file_id is resolved via getFile');
    assertTrue(transcriptionCalled, 'the audio bytes were sent to the OpenAI transcription endpoint');
    assertTrue(!!anthropicReq, 'a Claude request was made after transcription');
    const userMsg = anthropicReq.messages[anthropicReq.messages.length - 1];
    assertEq(userMsg.content, 'log a 20 dollar grocery run', 'the TRANSCRIPT (not raw audio) is sent to Claude as plain text, same as a typed message');
    assertEq(sentText, '🎤 "log a 20 dollar grocery run"\n\nLogged $20 for groceries.', 'the reply is prefixed with the transcript so a mishearing is visible, followed by Claude\'s actual reply');

    const mem = rows['telegram-memory'].history;
    assertEq(mem[0].content, 'log a 20 dollar grocery run', 'conversation history stores the transcript itself (plain text, no size concern like photos)');
    assertEq(mem[1].content, 'Logged $20 for groceries.', 'the assistant turn stored in history is the reply WITHOUT the transcript prefix');
  }

  // ==================== missing OPENAI_API_KEY ====================
  {
    delete process.env.OPENAI_API_KEY;
    let sentText = null;
    let anthropicCalled = false;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('api.anthropic.com')) { anthropicCalled = true; return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'should not get here' }] }) }; }
      if (u.includes('sendMessage')) { sentText = JSON.parse(opts.body).text; return { ok: true, json: async () => ({ ok: true }) }; }
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({
      method: 'POST', headers,
      body: { message: { chat: { id: 555 }, voice: { file_id: 'voice_2', mime_type: 'audio/ogg' } } },
    }, res);
    assertEq(res._status, 200, 'missing OPENAI_API_KEY still returns 200 (not an error to Telegram)');
    assertTrue(!!sentText && sentText.includes('OPENAI_API_KEY'), 'the user is told OPENAI_API_KEY is missing');
    assertTrue(!anthropicCalled, 'Claude is never called when transcription cannot even be attempted');
    process.env.OPENAI_API_KEY = 'sk-fake-openai';
  }

  // ==================== Telegram voice download failure ====================
  {
    let sentText = null;
    let transcriptionCalled = false;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/getFile')) return { ok: true, json: async () => ({ ok: false, description: 'file not found' }) };
      if (u.includes('api.openai.com')) { transcriptionCalled = true; return { ok: true, json: async () => ({ text: 'should not get here' }) }; }
      if (u.includes('sendMessage')) { sentText = JSON.parse(opts.body).text; return { ok: true, json: async () => ({ ok: true }) }; }
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({
      method: 'POST', headers,
      body: { message: { chat: { id: 555 }, voice: { file_id: 'voice_bad', mime_type: 'audio/ogg' } } },
    }, res);
    assertEq(res._status, 200, 'a voice download failure still returns 200');
    assertTrue(!!sentText && sentText.toLowerCase().includes("couldn't transcribe"), 'the user is told transcription/download failed');
    assertTrue(!transcriptionCalled, 'OpenAI is never called when the Telegram download itself failed');
  }

  // ==================== OpenAI transcription itself fails ====================
  {
    let sentText = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/getFile')) return { ok: true, json: async () => ({ ok: true, result: { file_path: 'voice/file_2.oga' } }) };
      if (u.includes('/file/bot')) return { ok: true, arrayBuffer: async () => FAKE_AUDIO_BYTES };
      if (u.includes('api.openai.com')) return { ok: false, status: 500, text: async () => 'server error' };
      if (u.includes('sendMessage')) { sentText = JSON.parse(opts.body).text; return { ok: true, json: async () => ({ ok: true }) }; }
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({
      method: 'POST', headers,
      body: { message: { chat: { id: 555 }, voice: { file_id: 'voice_3', mime_type: 'audio/ogg' } } },
    }, res);
    assertEq(res._status, 200, 'a transcription API failure still returns 200');
    assertTrue(!!sentText && sentText.toLowerCase().includes("couldn't transcribe"), 'the user is told transcription failed when OpenAI itself errors');
  }

  // ==================== empty/silent transcript ====================
  {
    let sentText = null;
    let anthropicCalled = false;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/getFile')) return { ok: true, json: async () => ({ ok: true, result: { file_path: 'voice/file_3.oga' } }) };
      if (u.includes('/file/bot')) return { ok: true, arrayBuffer: async () => FAKE_AUDIO_BYTES };
      if (u.includes('api.openai.com')) return { ok: true, json: async () => ({ text: '   ' }) };
      if (u.includes('api.anthropic.com')) { anthropicCalled = true; return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'should not get here' }] }) }; }
      if (u.includes('sendMessage')) { sentText = JSON.parse(opts.body).text; return { ok: true, json: async () => ({ ok: true }) }; }
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({
      method: 'POST', headers,
      body: { message: { chat: { id: 555 }, voice: { file_id: 'voice_silent', mime_type: 'audio/ogg' } } },
    }, res);
    assertEq(res._status, 200, 'a blank/whitespace-only transcript still returns 200');
    assertTrue(!!sentText && sentText.toLowerCase().includes("didn't catch anything"), 'the user is told nothing was heard, rather than silently doing nothing');
    assertTrue(!anthropicCalled, 'Claude is never called with an empty transcript');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
