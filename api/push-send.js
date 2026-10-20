// ============================================================
// POST /api/push-send?type=morning|training|nutrition|skincare|reminders&cron=1
// Sends context-aware push notifications to all registered devices.
// Called by Vercel Cron (see vercel.json) on different schedules per type,
// or manually with ?type=test to test any notification.
//
// Reads the user's synced data from Supabase (app_state table) to
// generate personalized content — e.g. today's actual marathon workout
// instead of a generic "go train" message.
//
// Requires Vercel env vars:
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
//   SUPABASE_URL / SUPABASE_ANON_KEY (to read user data + subscriptions)
//
// Gated by APP_SECRET for manual calls; cron invocations use ?cron=1.
// ============================================================
import { requireAppSecret } from './_lib/security.js';
import webpush from 'web-push';

// Fetch any module's synced data from Supabase
async function fetchModuleData(supaUrl, supaKey, appKey) {
  try {
    const r = await fetch(
      supaUrl + '/rest/v1/app_state?key=eq.' + encodeURIComponent(appKey) + '&select=data',
      { headers: { apikey: supaKey, Authorization: 'Bearer ' + supaKey, Accept: 'application/json' } }
    );
    const rows = await r.json().catch(() => []);
    return (rows && rows[0] && rows[0].data) ? rows[0].data : null;
  } catch (e) { return null; }
}

function dateKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function isoWeekKey(d) {
  const dt = new Date(d); dt.setHours(0, 0, 0, 0);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7)); // back up to Monday
  return dateKey(dt);
}

function readMarathonPlan(raw) {
  if (!raw) return null;
  return raw['marathon_plan_v1'] || raw; // sync.js nests data under the localStorage key name
}

async function buildPayload(type, supaUrl, supaKey) {
  const today = dateKey(new Date());
  const tomorrow = dateKey(new Date(Date.now() + 86400000));
  const MODULE_URL = '/index.html';

  switch (type) {
    case 'training': {
      const plan = readMarathonPlan(await fetchModuleData(supaUrl, supaKey, 'marathon'));
      const entries = (plan && plan.entries) || [];
      const todayEntry = entries.find(e => e.date === today);
      const tomorrowEntry = entries.find(e => e.date === tomorrow);
      if (todayEntry && todayEntry.type !== 'rest') {
        const dist = todayEntry.plannedDistanceMi ? ` (${todayEntry.plannedDistanceMi} mi)` : '';
        return { tag: 'training', title: '🏃 Training · Marathon', body: `Today: ${todayEntry.label || todayEntry.type}${dist}. ${todayEntry.completed ? 'Already marked done ✓' : 'Tap to log your run.'}`, url: '/marathon.html' };
      }
      if (tomorrowEntry && tomorrowEntry.type !== 'rest') {
        const dist = tomorrowEntry.plannedDistanceMi ? ` (${tomorrowEntry.plannedDistanceMi} mi)` : '';
        return { tag: 'training', title: '🏃 Training · Marathon', body: `Tomorrow: ${tomorrowEntry.label || tomorrowEntry.type}${dist}. Plan ahead.`, url: '/marathon.html' };
      }
      return { tag: 'training', title: '💪 Training Reminder', body: 'Stay consistent — check your Fitness and Marathon modules.', url: '/gym.html' };
    }

    case 'nutrition': {
      // Mirrors physique-core dayPlan/dayTotals: day override > weekly split; coach totals > item sum.
      // Cron runs 20:00 UTC (4 PM ET), so the UTC date matches the user's local date.
      const raw = await fetchModuleData(supaUrl, supaKey, 'physique');
      const ph = raw && raw.physique_v1;
      if (ph && ph.targets && ph.split) {
        const dow = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()];
        const rec = (ph.days && ph.days[today]) || {};
        const base = ph.split[dow] || { label: 'Rest', type: 'low' };
        const type = rec.type || base.type, label = rec.label || base.label;
        const tgt = ph.targets[type] || ph.targets.medium;
        let kcal = 0, p = 0;
        if (rec.totals && rec.totals.kcal != null) { kcal = +rec.totals.kcal || 0; p = +rec.totals.p || 0; }
        else (rec.items || []).forEach((i) => { kcal += +i.kcal || 0; p += +i.p || 0; });
        if (tgt) {
          const kLeft = Math.round(tgt.kcal - kcal), pLeft = Math.round(tgt.p - p);
          const tag = { high: 'HIGH', medium: 'MED', low: 'LOW' }[type] || type;
          return {
            tag: 'nutrition', title: '🥗 ' + tag + ' day · ' + label,
            body: (kLeft >= 0 ? kLeft + ' kcal' : -kLeft + ' kcal over') + ' and ' + (pLeft > 0 ? pLeft + ' g protein left' : 'protein hit') + ' (' + Math.round(kcal) + ' / ' + tgt.kcal + ' kcal so far).',
            url: '/physique.html',
          };
        }
      }
      return { tag: 'nutrition', title: '🥗 Nutrition · Log Check-in', body: 'Have you logged meals today? Track calories and macros to stay on target.', url: '/nutrition.html' };
    }

    case 'skincare': {
      const hour = new Date().getUTCHours();
      const isEvening = hour >= 20 || hour < 6;
      return { tag: 'skincare', title: '🧖 Skincare · Routine Reminder', body: isEvening ? 'Time for your PM skincare routine.' : 'Start the day right — complete your AM skincare routine.', url: '/skincare.html' };
    }

    case 'reminders': {
      const thisWeek = isoWeekKey(new Date());
      const yesterday = dateKey(new Date(Date.now() - 86400000));
      const twoDaysAgo = dateKey(new Date(Date.now() - 2 * 86400000));
      const [goalsData, choresData, pcData, gmailAlerts] = await Promise.all([
        fetchModuleData(supaUrl, supaKey, 'goals'),
        fetchModuleData(supaUrl, supaKey, 'chores'),
        fetchModuleData(supaUrl, supaKey, 'personalcare'),
        fetchModuleData(supaUrl, supaKey, 'gmail_alerts'),
      ]);

      // Main goals — search last 3 days newest-first.
      // goals:today only exists after the user opens main.html; before that, yesterday's
      // pending goals (copied by rollover) represent today's work. Snoozed goals excluded.
      let goalsPending = [];
      for (const day of [today, yesterday, twoDaysAgo]) {
        const goals = (goalsData && goalsData['goals:' + day]) || [];
        const pending = goals
          .filter(g => g && !g.done && (!g.snoozedUntil || g.snoozedUntil <= today))
          .map(g => g.text).filter(Boolean);
        if (pending.length > 0) { goalsPending = pending; break; }
      }

      if (goalsPending.length > 0) {
        let body;
        if (goalsPending.length === 1) {
          body = `"${goalsPending[0]}"`;
        } else if (goalsPending.length === 2) {
          body = `"${goalsPending[0]}" and "${goalsPending[1]}"`;
        } else {
          body = `"${goalsPending[0]}", "${goalsPending[1]}" +${goalsPending.length - 2} more`;
        }
        if (gmailAlerts && gmailAlerts.importantCount > 0) {
          body += ` · 📧 ${gmailAlerts.importantCount} important email${gmailAlerts.importantCount === 1 ? '' : 's'}`;
        }
        return { tag: 'reminders', title: `✅ ${goalsPending.length} goal${goalsPending.length === 1 ? '' : 's'} remaining`, body, url: '/main.html' };
      }

      // No pending goals — surface important Gmail alerts before falling through to chores
      if (gmailAlerts && gmailAlerts.importantCount > 0) {
        const top = gmailAlerts.topImportant && gmailAlerts.topImportant[0];
        const body = top
          ? `"${top.subject.slice(0, 70)}" from ${top.from}`
          : `${gmailAlerts.importantCount} important email${gmailAlerts.importantCount === 1 ? '' : 's'} need your attention`;
        return { tag: 'gmail', title: `📧 ${gmailAlerts.importantCount} important email${gmailAlerts.importantCount === 1 ? '' : 's'}`, body, url: '/mail.html' };
      }

      // Fall back to chores / personal care
      const choreItems = (choresData && (Array.isArray(choresData) ? choresData : choresData['chores:items'])) || [];
      const chorePending = choreItems.filter(c => {
        if (c.recurring === 'daily') return c.lastDoneKey !== today;
        if (c.recurring === 'weekly') return c.lastDoneKey !== thisWeek;
        return !c.done;
      }).map(c => c.text);

      const pcItems = (pcData && pcData['personalcare:items']) || [];
      const pcPending = pcItems.filter(i => i.kind === 'daily' && i.lastDoneKey !== today).map(i => i.name);

      const allPending = [...chorePending, ...pcPending];
      if (allPending.length > 0) {
        const body = allPending.length === 1
          ? `"${allPending[0]}" is still pending.`
          : `${allPending.length} tasks pending — "${allPending[0]}" and ${allPending.length - 1} more.`;
        return { tag: 'reminders', title: '✅ Reminders · ' + allPending.length + ' pending', body, url: '/chores.html' };
      }

      return { tag: 'reminders', title: '✅ All done for today!', body: 'All goals and tasks complete. Keep it up!', url: '/main.html' };
    }

    case 'morning':
    default: {
      const yesterday = dateKey(new Date(Date.now() - 86400000));
      const [plan, goalsData, gmailAlerts] = await Promise.all([
        fetchModuleData(supaUrl, supaKey, 'marathon').then(readMarathonPlan),
        fetchModuleData(supaUrl, supaKey, 'goals'),
        fetchModuleData(supaUrl, supaKey, 'gmail_alerts'),
      ]);
      const todayRun = ((plan && plan.entries) || []).find(e => e.date === today && e.type !== 'rest');
      // goals:today may not exist yet if app hasn't been opened — fall back to yesterday's
      let pendingGoals = [];
      for (const day of [today, yesterday]) {
        const goals = (goalsData && goalsData['goals:' + day]) || [];
        const pending = goals.filter(g => g && !g.done && (!g.snoozedUntil || g.snoozedUntil <= today));
        if (pending.length > 0) { pendingGoals = pending; break; }
      }
      const pendingCount = pendingGoals.length;

      const parts = [];
      if (todayRun) {
        const dist = todayRun.plannedDistanceMi ? ` (${todayRun.plannedDistanceMi} mi)` : '';
        parts.push(`Run: ${todayRun.label || todayRun.type}${dist}`);
      }
      if (pendingCount > 0) {
        const topText = pendingGoals[0] && pendingGoals[0].text;
        parts.push(topText
          ? `"${topText}"${pendingCount > 1 ? ' +' + (pendingCount - 1) + ' more' : ''}`
          : `${pendingCount} goal${pendingCount === 1 ? '' : 's'} to do`);
      }
      if (gmailAlerts && gmailAlerts.importantCount > 0) {
        parts.push(`${gmailAlerts.importantCount} important email${gmailAlerts.importantCount === 1 ? '' : 's'}`);
      }

      const body = parts.length > 0
        ? parts.join(' · ')
        : 'Open coach for your full daily briefing.';
      return { tag: 'morning', title: 'Good morning, Shrey ☀️', body, url: '/index.html' };
    }
  }
}

export default async function handler(req, res) {
  // Vercel Cron sends GET with "Authorization: Bearer <CRON_SECRET>".
  // Manual test button (Settings) sends GET/POST with X-App-Secret.
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = (req.headers && req.headers.authorization) || '';
  // isCron: Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" (serverless
  // runtime always has CRON_SECRET even if Edge Middleware doesn't).
  // The ?cron=1 query param is kept as a fallback so the manual test button in
  // the dashboard still works without needing APP_SECRET in the URL.
  const isCron = (cronSecret && authHeader === 'Bearer ' + cronSecret)
              || (req.query && req.query.cron === '1');

  if (!isCron && !requireAppSecret(req, res)) return;

  const type = (req.query && req.query.type) || 'morning';

  // Check user notification preferences for scheduled cron calls.
  // Manual calls (test button in Settings) always fire regardless of prefs.
  if (isCron) {
    const notifPrefsRaw = await fetchModuleData(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      'notification_prefs'
    );
    if (notifPrefsRaw && notifPrefsRaw[type] === false) {
      return res.status(200).json({ ok: true, sent: 0, message: 'notification type disabled by user preference' });
    }
  }

  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@overseer.app';
  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!vapidPublic || !vapidPrivate) return res.status(500).json({ error: 'VAPID keys not configured' });
  if (!supaUrl || !supaKey) return res.status(500).json({ error: 'Supabase not configured (missing SUPABASE_SERVICE_ROLE_KEY)' });

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  // Read subscriptions from Supabase
  const getRes = await fetch(supaUrl + '/rest/v1/app_state?key=eq.push_subscriptions&select=data', {
    headers: { apikey: supaKey, Authorization: 'Bearer ' + supaKey, Accept: 'application/json' },
  }).catch(() => null);
  if (!getRes || !getRes.ok) return res.status(500).json({ error: 'could not read subscriptions' });
  const rows = await getRes.json().catch(() => []);
  const subs = (rows && rows[0] && Array.isArray(rows[0].data)) ? rows[0].data : [];
  if (!subs.length) return res.status(200).json({ ok: true, sent: 0, message: 'no subscriptions' });

  // Build contextual payload for this notification type
  const payload = await buildPayload(type, supaUrl, supaKey);
  const payloadStr = JSON.stringify(payload);

  const results = await Promise.allSettled(
    subs.map(({ endpoint, keys, expirationTime }) => webpush.sendNotification({ endpoint, keys, expirationTime }, payloadStr))
  );

  const sent = results.filter(r => r.status === 'fulfilled').length;
  // Collect error details with status codes for diagnosis
  const failures = results
    .map((r, i) => r.status === 'rejected' ? { endpoint: subs[i].endpoint.slice(-40), error: String(r.reason), status: r.reason && r.reason.statusCode } : null)
    .filter(Boolean);
  // Remove any subscription that fails — if the push service can't deliver
  // it for any reason it's considered dead. User can re-subscribe.
  const deadEndpoints = results
    .map((r, i) => r.status === 'rejected' ? subs[i].endpoint : null)
    .filter(Boolean);

  // Auto-remove dead subscriptions so they stop accumulating
  if (deadEndpoints.length > 0) {
    const cleaned = subs.filter(s => !deadEndpoints.includes(s.endpoint));
    await fetch(supaUrl + '/rest/v1/app_state', {
      method: 'POST',
      headers: { apikey: supaKey, Authorization: 'Bearer ' + supaKey, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ key: 'push_subscriptions', data: cleaned, updated_at: new Date().toISOString() }),
    }).catch(() => {});
  }

  return res.status(200).json({ ok: true, type, sent, failed: failures.length, failures, deadRemoved: deadEndpoints.length, total: subs.length, payload });
}
