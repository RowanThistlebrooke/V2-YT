import { sendReminder } from '../api/send-reminders.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}

function clearEnv() {
  ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER',
   'TWILIO_TO_NUMBER', 'RESEND_API_KEY', 'SMS_GATEWAY_TO', 'RESEND_FROM'].forEach(k => delete process.env[k]);
}

(async () => {
  const origFetch = global.fetch;

  // --- Telegram-only configured ---
  clearEnv();
  process.env.TELEGRAM_BOT_TOKEN = 'bot123:ABC';
  process.env.TELEGRAM_CHAT_ID = '999888777';
  let capturedReq = null;
  global.fetch = async (url, opts) => {
    capturedReq = { url: String(url), opts };
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 42 } }) };
  };
  let result = await sendReminder('Still todo today: Gym, Read');
  assertEq(result, { method: 'telegram', id: 42 }, 'Telegram path returns correct result shape');
  assertEq(capturedReq.url, 'https://api.telegram.org/botbot123:ABC/sendMessage', 'hits the correct Telegram sendMessage URL with the bot token');
  const sentBody = JSON.parse(capturedReq.opts.body);
  assertEq(sentBody.chat_id, '999888777', 'sends to the configured chat id');
  assertEq(sentBody.text, 'Still todo today: Gym, Read', 'message text passed through correctly');

  // --- Telegram takes priority over Twilio AND email gateway when all three configured ---
  process.env.TWILIO_ACCOUNT_SID = 'ACxxx';
  process.env.TWILIO_AUTH_TOKEN = 'tok';
  process.env.TWILIO_FROM_NUMBER = '+15550000000';
  process.env.TWILIO_TO_NUMBER = '+15551111111';
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.SMS_GATEWAY_TO = '5551234567@vtext.com';
  result = await sendReminder('test');
  assertEq(result.method, 'telegram', 'Telegram wins over Twilio and email gateway when all three are configured');

  // --- Telegram API failure (ok:false in response body) surfaces a clear error ---
  clearEnv();
  process.env.TELEGRAM_BOT_TOKEN = 'bot123:ABC';
  process.env.TELEGRAM_CHAT_ID = '999888777';
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: false, description: 'chat not found' }) });
  let threw = null;
  try { await sendReminder('test'); } catch (e) { threw = e.message; }
  assertEq(!!threw && threw.includes('telegram send failed'), true, 'Telegram API-level failure (ok:false) surfaces a clear error even on HTTP 200');

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
