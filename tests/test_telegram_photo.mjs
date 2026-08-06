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

// A minimal but real (non-empty) buffer, so Buffer.from(...).toString('base64')
// produces genuine, checkable base64 output rather than an empty string.
const FAKE_IMAGE_BYTES = new TextEncoder().encode('totally-a-jpeg').buffer;

(async () => {
  const origFetch = global.fetch;
  process.env.TELEGRAM_BOT_TOKEN = 'bot123:ABC';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'shh-secret';
  process.env.TELEGRAM_CHAT_ID = '555';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
  process.env.REMINDER_TIMEZONE = 'UTC';

  const headers = { 'x-telegram-bot-api-secret-token': 'shh-secret' };
  const expectedBase64 = Buffer.from(FAKE_IMAGE_BYTES).toString('base64');

  // ==================== a photo with no caption ====================
  {
    const rows = { goals: {} };
    let anthropicReq = null;
    let sentText = null;
    let getFileCalledWith = null;
    let downloadedPath = null;
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
        return { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/file_1.jpg' } }) };
      }
      if (u.includes('/file/bot')) {
        downloadedPath = u;
        return { ok: true, arrayBuffer: async () => FAKE_IMAGE_BYTES };
      }
      if (u.includes('api.anthropic.com')) {
        anthropicReq = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Logged: a slice of pizza, ~285 kcal.' }] }) };
      }
      if (u.includes('sendMessage')) { sentText = JSON.parse(opts.body).text; return { ok: true, json: async () => ({ ok: true }) }; }
      throw new Error('unexpected fetch: ' + u);
    };

    const res = mockRes();
    await handler({
      method: 'POST', headers,
      body: { message: { chat: { id: 555 }, photo: [{ file_id: 'small_1', file_size: 1000 }, { file_id: 'large_1', file_size: 50000 }] } },
    }, res);

    assertEq(res._status, 200, 'a photo-only message (no text, no caption) returns 200 rather than being skipped');
    assertTrue(!!getFileCalledWith && getFileCalledWith.includes('large_1'), 'the LARGEST available photo size is downloaded, not the first/smallest');
    assertTrue(!!downloadedPath && downloadedPath.includes('photos/file_1.jpg'), 'the actual file bytes are fetched from the file_path getFile resolved');
    assertTrue(!!anthropicReq, 'a Claude request was made');
    const userMsg = anthropicReq.messages[anthropicReq.messages.length - 1];
    assertEq(userMsg.role, 'user', 'the photo turn is sent as a user-role message');
    assertTrue(Array.isArray(userMsg.content), 'photo message content is an array of blocks, not a plain string');
    const imageBlock = userMsg.content.find(b => b.type === 'image');
    assertTrue(!!imageBlock, 'the request includes an image content block');
    assertEq(imageBlock.source.type, 'base64', 'the image is sent as inline base64');
    assertEq(imageBlock.source.media_type, 'image/jpeg', 'a .jpg file_path maps to image/jpeg');
    assertEq(imageBlock.source.data, expectedBase64, 'the base64 payload matches the actual downloaded bytes');
    const textBlock = userMsg.content.find(b => b.type === 'text');
    assertTrue(!!textBlock && textBlock.text.length > 0, 'a default prompt text is included when no caption was given');
    assertEq(sentText, 'Logged: a slice of pizza, ~285 kcal.', 'the reply is sent back to Telegram normally');

    // History must NOT contain the raw base64 image data — only a short placeholder.
    const mem = rows['telegram-memory'].history;
    assertEq(mem.length, 2, 'the photo exchange is persisted to history same as a text exchange');
    assertEq(typeof mem[0].content, 'string', 'the persisted user turn is a plain string placeholder, not the image content-block array');
    assertTrue(!mem[0].content.includes(expectedBase64), 'the persisted history does NOT contain the raw base64 image data');
    assertTrue(mem[0].content.toLowerCase().includes('photo'), 'the placeholder mentions it was a photo');
  }

  // ==================== a photo WITH a caption ====================
  {
    const rows = { goals: {} };
    let anthropicReq = null;
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
      if (u.includes('/getFile')) return { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/file_2.png' } }) };
      if (u.includes('/file/bot')) return { ok: true, arrayBuffer: async () => FAKE_IMAGE_BYTES };
      if (u.includes('api.anthropic.com')) {
        anthropicReq = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Got it, logged the smoothie.' }] }) };
      }
      if (u.includes('sendMessage')) return { ok: true, json: async () => ({ ok: true }) };
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({
      method: 'POST', headers,
      body: { message: { chat: { id: 555 }, photo: [{ file_id: 'p1', file_size: 2000 }], caption: 'my post-workout smoothie' } },
    }, res);
    assertEq(res._status, 200, 'a photo WITH a caption also returns 200');
    const userMsg = anthropicReq.messages[anthropicReq.messages.length - 1];
    const imageBlock = userMsg.content.find(b => b.type === 'image');
    assertEq(imageBlock.source.media_type, 'image/png', 'a .png file_path maps to image/png');
    const textBlock = userMsg.content.find(b => b.type === 'text');
    assertEq(textBlock.text, 'my post-workout smoothie', 'the caption is used as the accompanying text instead of the generic default prompt');
    const mem = rows['telegram-memory'].history;
    assertTrue(mem[0].content.includes('my post-workout smoothie'), 'the persisted placeholder includes the caption text');
  }

  // ==================== Telegram file download failure ====================
  {
    let sentText = null;
    let anthropicCalled = false;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/getFile')) return { ok: true, json: async () => ({ ok: false, description: 'file not found' }) };
      if (u.includes('api.anthropic.com')) { anthropicCalled = true; return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'should not get here' }] }) }; }
      if (u.includes('sendMessage')) { sentText = JSON.parse(opts.body).text; return { ok: true, json: async () => ({ ok: true }) }; }
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({
      method: 'POST', headers,
      body: { message: { chat: { id: 555 }, photo: [{ file_id: 'bad_1', file_size: 1000 }] } },
    }, res);
    assertEq(res._status, 200, 'a download failure still returns 200 (not an error response to Telegram)');
    assertTrue(!!sentText && sentText.toLowerCase().includes("couldn't download"), 'the user is told the download failed');
    assertTrue(!anthropicCalled, 'Claude is never called when the photo download itself failed');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
