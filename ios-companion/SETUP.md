# Perform Health — Apple Watch → Dashboard Setup

This wires your Apple Watch health data into the dashboard:

```
Apple Watch → iPhone Health → PerformHealth app
   → POST /api/health-sync (secret-protected)
   → Supabase (health_metrics) → health.html
```

There are 3 setup steps: **Supabase → Vercel → iOS app**. ~20 minutes.

---

## 1. Supabase (database)

1. Open your Supabase project → **SQL Editor** → **New query**.
2. Paste the contents of [`/supabase/health_schema.sql`](../supabase/health_schema.sql) and **Run**.
   - Creates the `health_metrics` table (one row per day).
   - Read access is public (anon key) so the dashboard can show it.
   - Writes are locked to the service-role key (only the webhook can write).
3. Get your **service role key**: Settings → **API** → `service_role` (the *secret* one, not anon).
   ⚠️ Never put this key in any HTML/JS file — server-side only.

---

## 2. Vercel (webhook)

In your Vercel project → **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | your project URL, e.g. `https://xxxx.supabase.co` (you likely already set this) |
| `SUPABASE_SERVICE_ROLE_KEY` | the service_role secret from step 1 |
| `HEALTH_SYNC_SECRET` | a long random string — generate with: `openssl rand -hex 32` |

Then **redeploy** (push to git, or Deployments → Redeploy). The endpoint
`POST https://<your-app>.vercel.app/api/health-sync` is now live.

Quick test from your Mac (replace URL + secret):

```bash
curl -X POST https://<your-app>.vercel.app/api/health-sync \
  -H "Authorization: Bearer <HEALTH_SYNC_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"day":"2026-06-17","resting_hr":52,"hrv":68,"steps":4200}'
```

Expect `{"ok":true,"written":1}`. Then check the row in Supabase → Table Editor → `health_metrics`.

---

## 3. iOS app (PerformHealth)

You need a Mac with **Xcode**. A free Apple ID works for a 7-day test build;
a paid Developer account ($99/yr) lets it run for a year without re-installing.

### Create the Xcode project
1. Xcode → **File → New → Project → iOS → App**.
   - Product Name: `PerformHealth`
   - Interface: **SwiftUI**, Language: **Swift**
   - Bundle ID: anything unique, e.g. `com.tuna.performhealth`
2. Delete the auto-generated `ContentView.swift` and the `…App.swift`.
3. **Drag in** all files from [`PerformHealth/`](PerformHealth/):
   - `PerformHealthApp.swift`, `AppModel.swift`, `AppSettings.swift`,
     `HealthManager.swift`, `SyncService.swift`, `ContentView.swift`
   - When prompted, check **"Copy items if needed"** and your app target.

### Enable HealthKit
4. Select the project → your target → **Signing & Capabilities**.
5. Click **+ Capability → HealthKit**. Then tick **Background Delivery**.
   - This matches `PerformHealth.entitlements` (HealthKit + background-delivery).
   - If Xcode created its own `.entitlements`, just make sure those two keys exist;
     you can also drag in the provided `PerformHealth.entitlements` and point
     *Build Settings → Code Signing Entitlements* at it.

### Info.plist keys (required or the app crashes on launch)
6. Target → **Info** tab → add:

| Key | Value |
|---|---|
| `Privacy - Health Share Usage Description` (`NSHealthShareUsageDescription`) | `Reads your health metrics to show them on your dashboard.` |
| `Privacy - Health Update Usage Description` (`NSHealthUpdateUsageDescription`) | `Not used for writing — required by HealthKit.` |

7. Target → **Signing & Capabilities → Background Modes** (add capability if missing) →
   no checkbox needed beyond HealthKit's background delivery, but enabling
   **Background fetch** is harmless and can help.

### Run it
8. Plug in your iPhone, select it as the run target, press **▶**.
   - First launch: tap through the **Health permission** screen — **allow all** the
     requested categories (otherwise those metrics stay blank).
9. In the app: tap the **gear** → paste your **Webhook URL**
   (`https://<your-app>.vercel.app/api/health-sync`) and the **HEALTH_SYNC_SECRET** →
   **Save**.
10. Tap **Sync now**. It backfills the last 30 days, then keeps today's data fresh
    automatically when new readings arrive.

---

## How automatic sync works

- The app registers `HKObserverQuery` + background delivery on energy, heart rate,
  steps, and sleep. When the Watch writes new data, iOS wakes the app and it pushes
  today's snapshot. Timing is **iOS-controlled** (typically within ~1 hour), not instant.
- Open the app any time and tap **Sync now** to force an immediate update.

## Free Apple ID note (no paid account)
- Apps signed with a free Apple ID **expire after 7 days**. Reconnect the phone to
  Xcode and press ▶ again to re-install. Background delivery also pauses once the
  signing expires. The $99/yr account removes this.

## Metrics collected (Series 8/9/10 = full set)
Sleep (stages), resting HR, walking HR, HRV (SDNN), cardio recovery, overnight HR
low/avg, VO₂max, SpO₂, respiratory rate, wrist temperature deviation, active +
resting energy, exercise minutes, stand hours, steps, distance, flights, a
training-load proxy, weight, body-fat %, BMI, and per-day workouts.
The dashboard hides any card with no data.
