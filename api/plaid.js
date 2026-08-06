// ============================================================
// Consolidated Plaid endpoint — combines what used to be three separate
// files (plaid-link-token.js, plaid-exchange-token.js,
// plaid-sync-transactions.js) into one, so they count as a SINGLE Vercel
// Serverless Function instead of three. Vercel's Hobby plan caps a
// deployment at 12 functions; this repo's api/ directory was over that
// cap and every deploy was failing outright with
// exceeded_serverless_functions_per_deployment (see vercel.json rewrites,
// which keep the original /api/plaid-link-token, /api/plaid-exchange-token,
// and /api/plaid-sync-transactions URLs working unchanged — finance.html's
// plaidCall() never appended a query string of its own, so adding
// ?action=... in each rewrite's destination is safe here).
//
// Required env vars:
//   PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV   from plaid.com/dashboard
//   PLAID_SYNC_SECRET                          any random string, also served
//                                               via /api/config as
//                                               window.DASH_PLAID_SYNC_SECRET
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY    for exchange-token / sync-transactions
// ============================================================

function plaidBaseUrl() {
  const env = process.env.PLAID_ENV || 'sandbox';
  if (env === 'production') return 'https://production.plaid.com';
  if (env === 'development') return 'https://development.plaid.com';
  return 'https://sandbox.plaid.com';
}

// First step of connecting a real bank account: creates a short-lived
// Plaid "link_token" that the browser hands to Plaid's own Link widget (a
// hosted, Plaid-controlled UI — this app never sees or touches actual bank
// credentials, only Plaid does).
async function handleLinkToken(req, res) {
  const clientId = process.env.PLAID_CLIENT_ID;
  const plaidSecret = process.env.PLAID_SECRET;
  if (!clientId || !plaidSecret) return res.status(500).json({ error: 'PLAID_CLIENT_ID / PLAID_SECRET not configured' });

  try {
    const r = await fetch(plaidBaseUrl() + '/link/token/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        secret: plaidSecret,
        client_name: 'Dashboard',
        // A single fixed id is fine — this is a single-user personal
        // dashboard, not a multi-tenant product with real distinct users.
        user: { client_user_id: 'dashboard-user' },
        products: ['transactions'],
        country_codes: ['US'],
        language: 'en',
      }),
    });
    const json = await r.json();
    if (!r.ok || !json.link_token) return res.status(200).json({ ok: false, error: (json && json.error_message) || 'Plaid link/token/create failed' });
    return res.status(200).json({ ok: true, linkToken: json.link_token });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}

// Second step of connecting a bank: Plaid Link (running in the browser)
// hands back a short-lived public_token on success — this exchanges it
// for a long-lived access_token, the actual credential capable of reading
// real transaction data. That access_token is stored in a DEDICATED
// Supabase table (plaid_items) with Row Level Security enabled and NO
// policies granted to the anon key — only the service_role key (used here
// only, never shipped to the browser) can read or write it. Same
// deliberate split as google_tokens/handleTokenSync in api/google.js.
//
// One-time setup (run once in the Supabase SQL editor):
//   create table if not exists plaid_items (
//     id int primary key default 1,
//     access_token text, item_id text, institution_name text, cursor text,
//     updated_at timestamptz default now()
//   );
//   alter table plaid_items enable row level security;
//   -- No policies added on purpose — blocks the anon key entirely.
async function handleExchangeToken(req, res) {
  const clientId = process.env.PLAID_CLIENT_ID;
  const plaidSecret = process.env.PLAID_SECRET;
  if (!clientId || !plaidSecret) return res.status(500).json({ error: 'PLAID_CLIENT_ID / PLAID_SECRET not configured' });
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  const publicToken = typeof body.publicToken === 'string' ? body.publicToken : '';
  if (!publicToken) return res.status(400).json({ ok: false, error: 'missing "publicToken"' });
  const institutionName = typeof body.institutionName === 'string' ? body.institutionName.slice(0, 120) : '';

  const exchangeRes = await fetch(plaidBaseUrl() + '/item/public_token/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, secret: plaidSecret, public_token: publicToken }),
  });
  const exchangeJson = await exchangeRes.json();
  if (!exchangeRes.ok || !exchangeJson.access_token) {
    return res.status(200).json({ ok: false, error: (exchangeJson && exchangeJson.error_message) || 'Plaid item/public_token/exchange failed' });
  }

  const writeRes = await fetch(supabaseUrl + '/rest/v1/plaid_items?on_conflict=id', {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    // A fresh connection always starts a fresh sync cursor — any previously
    // stored cursor belonged to a different item/access_token and would be
    // meaningless (or rejected by Plaid) against this new one.
    body: JSON.stringify({
      id: 1,
      access_token: exchangeJson.access_token,
      item_id: exchangeJson.item_id,
      institution_name: institutionName || null,
      cursor: null,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!writeRes.ok) return res.status(500).json({ ok: false, error: 'Supabase write failed: ' + writeRes.status + ' ' + (await writeRes.text()) });

  return res.status(200).json({ ok: true, institutionName: institutionName || null });
}

// Pulls new transactions from the connected bank via Plaid's cursor-based
// /transactions/sync endpoint and returns them as SUGGESTIONS — nothing
// gets written to your actual Purchases list or account balances here.
// finance.html shows each one with an "Add to Purchases" / "Dismiss"
// button, the exact same review-before-logging pattern already used for
// Gmail-scanned receipts, since a bank feed can be miscategorized,
// duplicated, or include something you don't want tracked as a purchase
// (a transfer between your own accounts, for instance).
//
// Only transactions with a POSITIVE amount are surfaced — in Plaid's
// convention that's money leaving the account (an actual purchase), while
// negative amounts are refunds/deposits/incoming transfers, which aren't
// purchases. Transfer/income categories are excluded outright for the
// same reason (see EXCLUDED_PLAID_CATEGORIES below).
//
// The sync cursor (Plaid's own pagination bookmark) is stored alongside
// the access_token in the plaid_items table so each call only fetches
// what's genuinely new since last time, not the whole transaction
// history again.

// Best-guess mapping from Plaid's personal_finance_category.primary enum
// to this app's own 8 purchase categories (see PURCHASE_CATS in
// finance.html) — approximate by nature, same "best guess if unclear"
// tone as the Gmail-receipt AI parser's category mapping.
const PLAID_CATEGORY_MAP = {
  FOOD_AND_DRINK: 'food',
  GENERAL_MERCHANDISE: 'shopping',
  HOME_IMPROVEMENT: 'shopping',
  RENT_AND_UTILITIES: 'bills',
  BANK_FEES: 'bills',
  LOAN_PAYMENTS: 'bills',
  TRANSPORTATION: 'transport',
  MEDICAL: 'health',
  PERSONAL_CARE: 'health',
  ENTERTAINMENT: 'entertainment',
  TRAVEL: 'travel',
  GENERAL_SERVICES: 'other',
  GOVERNMENT_AND_NON_PROFIT: 'other',
};
// Not purchases at all — money moving between your own accounts or coming
// in, not something spent. Excluded rather than mis-bucketed into "other".
const EXCLUDED_PLAID_CATEGORIES = ['INCOME', 'TRANSFER_IN', 'TRANSFER_OUT'];
const PUR_CCY_KEYS = ['USD', 'DOP'];

function mapPlaidTransaction(txn) {
  if (!txn || !(Number(txn.amount) > 0)) return null;
  const primary = txn.personal_finance_category && txn.personal_finance_category.primary;
  if (EXCLUDED_PLAID_CATEGORIES.includes(primary)) return null;
  const currency = PUR_CCY_KEYS.includes(txn.iso_currency_code) ? txn.iso_currency_code : 'USD';
  return {
    plaidId: txn.transaction_id,
    merchant: String(txn.merchant_name || txn.name || '(unknown)').slice(0, 80),
    amount: Number(txn.amount),
    currency,
    category: PLAID_CATEGORY_MAP[primary] || 'other',
    date: txn.date,
  };
}

async function fetchPlaidItem(supabaseUrl, serviceKey) {
  const r = await fetch(supabaseUrl + '/rest/v1/plaid_items?id=eq.1&select=*', {
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
  });
  if (!r.ok) throw new Error('Supabase read failed: ' + r.status + ' ' + (await r.text()));
  const rows = await r.json();
  return rows && rows[0];
}

async function writeCursor(supabaseUrl, serviceKey, cursor) {
  const r = await fetch(supabaseUrl + '/rest/v1/plaid_items?id=eq.1', {
    method: 'PATCH',
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error('Supabase cursor update failed: ' + r.status + ' ' + (await r.text()));
}

async function handleSyncTransactions(req, res) {
  const clientId = process.env.PLAID_CLIENT_ID;
  const plaidSecret = process.env.PLAID_SECRET;
  if (!clientId || !plaidSecret) return res.status(500).json({ error: 'PLAID_CLIENT_ID / PLAID_SECRET not configured' });
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured' });

  const item = await fetchPlaidItem(supabaseUrl, serviceKey);
  if (!item || !item.access_token) return res.status(200).json({ ok: false, error: 'no bank connected yet' });

  const suggestions = [];
  let cursor = item.cursor || undefined;
  let hasMore = true;
  // Plaid recommends looping until has_more is false to fully catch up in
  // one call, rather than only reading a single page and leaving the rest
  // stranded until the next manual sync click.
  while (hasMore) {
    const r = await fetch(plaidBaseUrl() + '/transactions/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, secret: plaidSecret, access_token: item.access_token, cursor }),
    });
    const json = await r.json();
    if (!r.ok) return res.status(200).json({ ok: false, error: (json && json.error_message) || 'Plaid transactions/sync failed' });
    (json.added || []).forEach(txn => {
      const mapped = mapPlaidTransaction(txn);
      if (mapped) suggestions.push(mapped);
    });
    cursor = json.next_cursor;
    hasMore = !!json.has_more;
  }

  await writeCursor(supabaseUrl, serviceKey, cursor);
  return res.status(200).json({ ok: true, suggestions, institutionName: item.institution_name || null });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const secret = process.env.PLAID_SYNC_SECRET;
    if (!secret) return res.status(500).json({ error: 'server not configured (missing PLAID_SYNC_SECRET)' });
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + secret) return res.status(401).json({ error: 'unauthorized' });

    const action = req.query && req.query.action;
    if (action === 'link-token') return await handleLinkToken(req, res);
    if (action === 'exchange-token') return await handleExchangeToken(req, res);
    if (action === 'sync-transactions') return await handleSyncTransactions(req, res);
    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}

export { mapPlaidTransaction, plaidBaseUrl };
