import handler, { mapPlaidTransaction } from '../api/plaid.js';

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

// ==================== mapPlaidTransaction (pure logic) ====================
{
  assertEq(mapPlaidTransaction(null), null, 'a null transaction maps to null rather than crashing');

  const spend = mapPlaidTransaction({
    transaction_id: 't1', amount: 42.5, iso_currency_code: 'USD', date: '2026-01-05',
    merchant_name: 'Trader Joe\'s', name: 'TRADER JOES #123',
    personal_finance_category: { primary: 'FOOD_AND_DRINK' },
  });
  assertEq(spend, { plaidId: 't1', merchant: 'Trader Joe\'s', amount: 42.5, currency: 'USD', category: 'food', date: '2026-01-05' },
    'a positive-amount FOOD_AND_DRINK transaction maps to a food purchase suggestion, preferring merchant_name over name');

  const refund = mapPlaidTransaction({ transaction_id: 't2', amount: -20, personal_finance_category: { primary: 'FOOD_AND_DRINK' } });
  assertEq(refund, null, 'a NEGATIVE amount (refund/deposit) is excluded — not a purchase');

  const income = mapPlaidTransaction({ transaction_id: 't3', amount: 1000, personal_finance_category: { primary: 'INCOME' } });
  assertEq(income, null, 'INCOME category is excluded even with a positive amount');

  const transferOut = mapPlaidTransaction({ transaction_id: 't4', amount: 500, personal_finance_category: { primary: 'TRANSFER_OUT' } });
  assertEq(transferOut, null, 'TRANSFER_OUT is excluded (moving money between your own accounts, not a purchase)');

  const unknownCat = mapPlaidTransaction({ transaction_id: 't5', amount: 10, name: 'Mystery Co', personal_finance_category: { primary: 'SOMETHING_NEW' } });
  assertEq(unknownCat.category, 'other', 'an unrecognized Plaid category falls back to "other" rather than crashing or being dropped');

  const foreignCcy = mapPlaidTransaction({ transaction_id: 't6', amount: 10, name: 'Foo', iso_currency_code: 'EUR', personal_finance_category: { primary: 'TRAVEL' } });
  assertEq(foreignCcy.currency, 'USD', 'a currency outside {USD,DOP} defaults to USD, matching the rest of the app\'s currency policy');

  const noMerchantName = mapPlaidTransaction({ transaction_id: 't7', amount: 10, name: 'RAW POS NAME', personal_finance_category: { primary: 'TRAVEL' } });
  assertEq(noMerchantName.merchant, 'RAW POS NAME', 'falls back to the raw transaction name when merchant_name is absent');
}

(async () => {
  const origFetch = global.fetch;
  const origEnv = { ...process.env };
  process.env.PLAID_SYNC_SECRET = 'shh-plaid-secret';
  process.env.PLAID_CLIENT_ID = 'client123';
  process.env.PLAID_SECRET = 'plaid-secret-abc';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';

  // ---- auth ----
  {
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, query: { action: 'sync-transactions' } }, res);
    assertEq(res._status, 401, 'missing auth is 401');
  }

  // ---- not connected yet (no plaid_items row) ----
  {
    global.fetch = async (url) => {
      if (String(url).includes('/rest/v1/plaid_items')) return { ok: true, json: async () => ([]) };
      throw new Error('unexpected fetch: ' + url);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-plaid-secret' }, query: { action: 'sync-transactions' } }, res);
    assertEq(res._status, 200, 'no connection yet still responds 200');
    assertEq(res._body, { ok: false, error: 'no bank connected yet' }, 'a clear "not connected" message is returned rather than a Plaid API error');
  }

  // ---- happy path: single page, stores the new cursor, returns mapped suggestions ----
  {
    let syncBody = null, cursorWriteBody = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/rest/v1/plaid_items') && (!opts || !opts.method || opts.method === undefined)) {
        return { ok: true, json: async () => ([{ access_token: 'access-1', item_id: 'item-1', institution_name: 'Chase', cursor: 'old-cursor' }]) };
      }
      if (u.includes('/transactions/sync')) {
        syncBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            added: [
              { transaction_id: 'tx1', amount: 15, iso_currency_code: 'USD', date: '2026-01-01', name: 'Coffee Shop', personal_finance_category: { primary: 'FOOD_AND_DRINK' } },
              { transaction_id: 'tx2', amount: -50, iso_currency_code: 'USD', date: '2026-01-02', name: 'Refund', personal_finance_category: { primary: 'GENERAL_MERCHANDISE' } },
            ],
            next_cursor: 'new-cursor-1',
            has_more: false,
          }),
        };
      }
      if (u.includes('/rest/v1/plaid_items') && opts.method === 'PATCH') {
        cursorWriteBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-plaid-secret' }, query: { action: 'sync-transactions' } }, res);
    assertEq(res._status, 200, 'a valid sync returns 200');
    assertEq(syncBody.cursor, 'old-cursor', 'the PREVIOUSLY stored cursor is sent to Plaid, so only genuinely new transactions come back');
    assertEq(res._body.suggestions.length, 1, 'only the one real (positive-amount) purchase is returned as a suggestion, the refund is filtered out');
    assertEq(res._body.suggestions[0].merchant, 'Coffee Shop', 'the correct transaction is surfaced');
    assertEq(res._body.institutionName, 'Chase', 'the institution name is returned for display');
    assertEq(cursorWriteBody.cursor, 'new-cursor-1', 'the new cursor is persisted so the next sync only fetches what\'s new after this point');
  }

  // ---- multi-page sync: loops until has_more is false ----
  {
    let syncCallCount = 0;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/rest/v1/plaid_items') && (!opts || !opts.method)) {
        return { ok: true, json: async () => ([{ access_token: 'access-1', item_id: 'item-1', institution_name: null, cursor: null }]) };
      }
      if (u.includes('/transactions/sync')) {
        syncCallCount++;
        if (syncCallCount === 1) {
          return { ok: true, json: async () => ({ added: [{ transaction_id: 'p1', amount: 5, name: 'Page1', personal_finance_category: { primary: 'FOOD_AND_DRINK' } }], next_cursor: 'cursor-page-2', has_more: true }) };
        }
        return { ok: true, json: async () => ({ added: [{ transaction_id: 'p2', amount: 7, name: 'Page2', personal_finance_category: { primary: 'FOOD_AND_DRINK' } }], next_cursor: 'cursor-final', has_more: false }) };
      }
      if (u.includes('/rest/v1/plaid_items') && opts.method === 'PATCH') return { ok: true, json: async () => ({}) };
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-plaid-secret' }, query: { action: 'sync-transactions' } }, res);
    assertEq(syncCallCount, 2, 'the sync loop makes a second call when has_more is true on the first page');
    assertEq(res._body.suggestions.length, 2, 'transactions from BOTH pages are combined into the final suggestions list');
  }

  global.fetch = origFetch;
  process.env = origEnv;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
