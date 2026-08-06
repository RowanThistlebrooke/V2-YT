import handler, { extractVideoId, parseIsoDurationToMinutes } from '../api/youtube-duration.js';

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
  res.end = () => { return res; };
  res.setHeader = () => {};
  return res;
}

// ==================== extractVideoId (pure logic) ====================
{
  assertEq(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ', 'a standard watch URL');
  assertEq(extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ', 'a youtu.be short link');
  assertEq(extractVideoId('https://youtu.be/dQw4w9WgXcQ?t=30'), 'dQw4w9WgXcQ', 'a youtu.be short link with a query string');
  assertEq(extractVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ', 'the mobile-site host');
  assertEq(extractVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ', 'an embed URL');
  assertEq(extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ', 'a Shorts URL');
  assertEq(extractVideoId('www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ', 'a URL pasted without a protocol still works');
  assertEq(extractVideoId('https://example.com/not-youtube'), null, 'a non-YouTube URL yields no video id');
  assertEq(extractVideoId('not a url at all'), null, 'garbage input does not throw, just yields null');
}

// ==================== parseIsoDurationToMinutes (pure logic) ====================
{
  assertEq(parseIsoDurationToMinutes('PT1H32M4S'), 92, 'hours + minutes + seconds rounds to the nearest minute');
  assertEq(parseIsoDurationToMinutes('PT45M'), 45, 'minutes only');
  assertEq(parseIsoDurationToMinutes('PT30S'), 1, 'a sub-minute duration rounds up rather than truncating to 0');
  assertEq(parseIsoDurationToMinutes('PT10H'), 600, 'hours only, a long audiobook-length video');
  assertEq(parseIsoDurationToMinutes(''), null, 'an empty duration string is rejected rather than misread as 0');
  assertEq(parseIsoDurationToMinutes(undefined), null, 'a missing duration is rejected, not silently treated as 0');
  assertEq(parseIsoDurationToMinutes('garbage'), null, 'a non-ISO-8601 string is rejected');
}

(async () => {
  const origFetch = global.fetch;
  const origEnv = { ...process.env };
  process.env.YOUTUBE_LOOKUP_SECRET = 'shh-yt-secret';
  process.env.YOUTUBE_API_KEY = 'yt-key-1';

  // ---- method/auth guards ----
  {
    const res = mockRes();
    await handler({ method: 'OPTIONS', headers: {} }, res);
    assertEq(res._status, 204, 'OPTIONS returns 204');

    const res2 = mockRes();
    await handler({ method: 'GET', headers: {} }, res2);
    assertEq(res2._status, 405, 'GET is rejected with 405');

    const res3 = mockRes();
    await handler({ method: 'POST', headers: {}, body: { url: 'https://youtu.be/abc' } }, res3);
    assertEq(res3._status, 401, 'missing Authorization header is 401');

    const res4 = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer wrong' }, body: {} }, res4);
    assertEq(res4._status, 401, 'wrong bearer secret is 401');
  }

  // ---- missing server config ----
  {
    delete process.env.YOUTUBE_API_KEY;
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-yt-secret' }, body: { url: 'https://youtu.be/abc' } }, res);
    assertEq(res._status, 500, 'missing YOUTUBE_API_KEY is a 500');
    process.env.YOUTUBE_API_KEY = 'yt-key-1';
  }

  // ---- validation ----
  {
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-yt-secret' }, body: {} }, res);
    assertEq(res._status, 400, 'missing url is a 400');

    const res2 = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-yt-secret' }, body: { url: 'https://example.com/nope' } }, res2);
    assertEq(res2._status, 200, 'an unrecognized link still responds 200 (not a hard failure)');
    assertEq(res2._body.ok, false, 'an unrecognized link is reported as not-ok rather than throwing');
  }

  // ---- happy path ----
  {
    let seenUrl = null;
    global.fetch = async (url) => {
      seenUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          items: [{
            contentDetails: { duration: 'PT2H5M10S' },
            snippet: { title: 'Sapiens (Full Audiobook)' },
          }],
        }),
      };
    };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-yt-secret' }, body: { url: 'https://www.youtube.com/watch?v=abc123' } }, res);
    assertEq(res._status, 200, 'a valid lookup returns 200');
    assertEq(res._body.ok, true, 'ok:true on a successful lookup');
    assertEq(res._body.minutes, 125, 'duration is converted to total minutes (2h5m10s -> 125)');
    assertEq(res._body.title, 'Sapiens (Full Audiobook)', 'the video title is returned for display');
    assertTrue(seenUrl.includes('id=abc123'), 'the extracted video id is sent to the YouTube API: ' + seenUrl);
    assertTrue(seenUrl.includes('key=yt-key-1'), 'the request uses YOUTUBE_API_KEY');
  }

  // ---- video not found ----
  {
    global.fetch = async () => ({ ok: true, json: async () => ({ items: [] }) });
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-yt-secret' }, body: { url: 'https://youtu.be/deadbeef' } }, res);
    assertEq(res._status, 200, 'a not-found video still responds 200');
    assertEq(res._body.ok, false, 'not-found is reported as ok:false');
  }

  // ---- YouTube API itself errors (e.g. bad key, quota) ----
  {
    global.fetch = async () => ({ ok: false, json: async () => ({ error: { message: 'API key not valid' } }) });
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-yt-secret' }, body: { url: 'https://youtu.be/abc' } }, res);
    assertEq(res._status, 200, 'a YouTube API error still responds 200');
    assertEq(res._body.error, 'API key not valid', 'the underlying API error message is surfaced');
  }

  global.fetch = origFetch;
  process.env = origEnv;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
