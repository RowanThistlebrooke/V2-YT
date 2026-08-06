// =============================================================
// Shared cloud-sync helper for the dashboard.
// Each page calls initCloudSync({...}) once with its config:
//   appKey         — string row key in the public.app_state table
//   syncedKeys     — exact localStorage keys to mirror
//   syncedPrefixes — localStorage key prefixes to mirror (e.g. 'goals:')
//   onApplied      — optional callback after remote state has been applied
//
// Requires:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="sync.js" defer></script>
// =============================================================
(function () {
  'use strict';

  // Prefer Vercel env vars (served via /api/config → window.DASH_*),
  // otherwise fall back to these defaults.
  const SUPABASE_URL = (typeof window !== 'undefined' && window.DASH_SUPABASE_URL) || 'https://srajryooffirbroltjmg.supabase.co';
  const SUPABASE_KEY = (typeof window !== 'undefined' && window.DASH_SUPABASE_KEY) || 'sb_publishable_5142ZwTLF_DkSVRzciNuRA_bHwRAu4c';

  // Tiny self-contained toast so a persistent sync failure is actually
  // visible instead of failing silently forever — every previous "why
  // didn't it sync" report turned out to have no way to tell push/pull
  // even ran, let alone failed. No dependency on any page's own CSS.
  function toast(msg) {
    try {
      const el = document.createElement('div');
      el.textContent = msg;
      el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);' +
        'max-width:90vw;padding:10px 16px;border-radius:10px;font:13px -apple-system,sans-serif;' +
        'background:rgba(20,20,22,0.95);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,0.4);' +
        'z-index:999999;pointer-events:none;';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 5000);
    } catch (e) {}
  }

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    if (!appKey) return;
    if (!window.supabase) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    let supa = null;
    let pushTimer = null;
    let pushInFlight = false;
    let suppressSync = false;
    let lastSyncedJson = null;

    function matches(k) {
      if (!k) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) {
        if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      }
      return false;
    }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      }
      return out;
    }

    const origSet = localStorage.setItem.bind(localStorage);
    const origRemove = localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      origSet(k, v);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };

    function applyRemote(remote, opts) {
      if (!remote || typeof remote !== 'object') return false;
      // A local edit is waiting to be pushed (or is actively being pushed
      // right now) — this incoming snapshot predates that edit, since it
      // was read from the server before the edit landed there. Applying it
      // would silently overwrite the unpushed local change, and since the
      // overwritten state would then match what the pending push is about
      // to send, pushNow()'s no-op check would skip sending it entirely —
      // losing the edit both locally and on the server with no error shown.
      // Skip this pull; the pending push will land first, and a later pull
      // will correctly pick up the merged state.
      if (pushTimer || pushInFlight) return false;
      suppressSync = true;
      let changed = false;
      let localOnly = false;
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          const incoming = JSON.stringify(remote[k]);
          const local = localStorage.getItem(k);
          if (local !== incoming) {
            try { origSet(k, incoming); changed = true; } catch (e) {}
          }
        }
        for (const k of listAllKeys()) {
          if (k in remote) continue;
          // A key can be locally-present-but-absent-from-remote for two very
          // different reasons: (a) it was deleted on another device and that
          // deletion needs to propagate here, or (b) this key was only just
          // added to syncedKeys/syncedPrefixes (a new feature) and the
          // server's row simply predates it, so it was never part of any
          // remote snapshot at all. Treating (b) as a deletion silently
          // destroys real local data the first time this runs — exactly
          // what happened when 'purchases' was added to syncedKeys while
          // pre-existing remote rows still lacked that key entirely. Only
          // the ongoing (non-initial) sync path — where we've already
          // established a synced baseline — should treat "missing from
          // remote" as "deleted elsewhere". On the very first pull of a
          // page load, treat it instead as local-only data to reconcile up.
          if (opts && opts.skipDelete) { localOnly = true; continue; }
          try { origRemove(k); changed = true; } catch (e) {}
        }
      } finally { suppressSync = false; }
      if (changed && typeof onApplied === 'function') {
        try { onApplied(); } catch (e) {}
      }
      if (localOnly) schedulePush();
      return changed;
    }

    // Retries on failure (transient network blip, brief connectivity loss)
    // instead of silently giving up — previously a failed push just sat
    // there until some unrelated key happened to be written again, which
    // could leave a real edit stuck unsynced indefinitely on a flaky
    // connection (e.g. spotty mobile signal right after making a change).
    // Merges this browser's locally-changed keys onto the CURRENT server
    // row instead of blindly replacing the whole row with a stale local
    // snapshot. Without this, an old copy sitting in localStorage (e.g. a
    // backgrounded tab that hasn't pulled recently) can silently wipe out
    // a change written by someone else in the meantime — most concretely,
    // the Telegram assistant logging something (like water) between this
    // browser's last pull and its next push. "Changed by us" is judged
    // against lastSyncedJson (the last row content we know we're in sync
    // with) key-by-key, so a key we haven't touched keeps whatever the
    // server currently has for it, even if that's newer than our copy.
    function mergeForPush(local, remote) {
      const lastKnown = lastSyncedJson ? JSON.parse(lastSyncedJson) : {};
      const merged = Object.assign({}, remote);
      for (const k of Object.keys(local)) {
        if (JSON.stringify(local[k]) !== JSON.stringify(lastKnown[k])) merged[k] = local[k];
      }
      for (const k of Object.keys(lastKnown)) {
        if (!matches(k) || k in local) continue;
        // Explicitly deleted locally (present in what we last synced,
        // matches our scope, but no longer in localStorage) — only
        // propagate that deletion if the server hadn't already moved
        // that key on without us (i.e. it still matches our last-known
        // value), same "changed by us" test as above.
        if (JSON.stringify(remote[k]) === JSON.stringify(lastKnown[k])) delete merged[k];
      }
      return merged;
    }
    async function pushNow(attempt) {
      attempt = attempt || 0;
      pushInFlight = true;
      if (!supa) { pushInFlight = false; return; }
      const local = collect();
      const localJson = JSON.stringify(local);
      if (localJson === lastSyncedJson) { pushInFlight = false; return; }
      try {
        const { data: remoteRow, error: readErr } = await supa
          .from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (readErr) throw readErr;
        const remote = (remoteRow && remoteRow.data) || {};
        const merged = mergeForPush(local, remote);
        const json = JSON.stringify(merged);
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: merged, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) {
          lastSyncedJson = json; pushInFlight = false;
          // Additive, backward-compatible signal alongside the existing
          // behavior — any page can opt in to a dedicated inline sync
          // state (e.g. clearing a retry banner) without sync.js needing
          // to know that page exists.
          try { document.dispatchEvent(new CustomEvent('dashboard:sync-ok', { detail: { appKey } })); } catch (e3) {}
          return;
        }
        throw error;
      } catch (e) {
        if (attempt < 3) { setTimeout(() => pushNow(attempt + 1), 2000 * (attempt + 1)); return; }
        pushInFlight = false;
        console.warn('[sync:' + appKey + '] push failed after 3 attempts:', e && e.message ? e.message : e);
        toast('⚠️ Couldn\'t sync your last change (' + appKey + ') — check your connection.');
        try { document.dispatchEvent(new CustomEvent('dashboard:sync-error', { detail: { appKey, message: e && e.message ? e.message : String(e) } })); } catch (e2) {}
      }
    }
    function schedulePush() {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => { pushTimer = null; pushNow(0); }, 250);
    }

    // Re-pull the latest row from the server. Used on initial load AND
    // whenever the tab becomes visible again — mobile browsers routinely
    // suspend the realtime WebSocket when a tab is backgrounded (locking
    // the phone, switching apps) and don't reliably reconnect it, so a
    // tab left open in the background can silently miss a change pushed
    // from another device and then just sit stale even after you switch
    // back to it. Re-pulling on foreground catches it up regardless of
    // whether the realtime socket survived.
    async function pullLatest() {
      if (!supa) return;
      try {
        const { data, error } = await supa
          .from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (error) { console.warn('[sync:' + appKey + '] pull failed:', error.message || error); return; }
        if (data && data.data) {
          const incoming = JSON.stringify(data.data);
          if (incoming !== lastSyncedJson) {
            lastSyncedJson = incoming;
            applyRemote(data.data);
          }
        }
      } catch (e) { console.warn('[sync:' + appKey + '] pull threw:', e && e.message ? e.message : e); }
    }
    function flushOnUnload() {
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: state, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        lastSyncedJson = json;
      } catch (e) {}
    }

    (async function init() {
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      try {
        const { data, error } = await supa
          .from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (!error && data && data.data && Object.keys(data.data).length > 0) {
          lastSyncedJson = JSON.stringify(data.data);
          applyRemote(data.data, { skipDelete: true });
        } else if (Object.keys(collect()).length > 0) {
          schedulePush();
        }
      } catch (e) {}
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'app_state',
          filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === lastSyncedJson) return;
          lastSyncedJson = incoming;
          applyRemote(payload.new.data);
        })
        .subscribe();
    })();

    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    // Mobile Safari (and most mobile browsers) frequently do NOT fire
    // beforeunload/pagehide when a tab is merely backgrounded — e.g.
    // switching apps or locking the phone right after making an edit.
    // visibilitychange reliably fires in that case, so use it as a backup
    // flush trigger — otherwise a pending debounced push can get frozen
    // mid-timer and never reach the server, making the edit look "stuck"
    // on that device until the page happens to be reopened and edited again.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushOnUnload();
      else pullLatest();
    });
    // pageshow (not just visibilitychange) is the reliable signal for a
    // page restored from the back/forward cache — extremely common on
    // mobile Safari when you switch apps and come back via the app
    // switcher rather than a real reload. A bfcache restore resumes the
    // exact in-memory page from before, so without this it would keep
    // showing whatever was on screen when you left, indefinitely.
    window.addEventListener('pageshow', () => { pullLatest(); });
    window.addEventListener('storage', (e) => {
      if (e.key && matches(e.key)) schedulePush();
    });
  };
})();
