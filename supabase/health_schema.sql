-- ============================================================
-- Apple Watch / HealthKit dashboard schema
-- Run this once in your Supabase project (SQL Editor → New query → Run).
--
-- Design:
--   • One row per day, keyed by `day` (date).
--   • The Vercel webhook (/api/health-sync) writes here using the
--     SERVICE ROLE key, which bypasses RLS — so random clients
--     holding the public anon key CANNOT write fake data.
--   • The dashboard (health.html) reads here with the public anon
--     key, so we add a SELECT-only policy for anon/authenticated.
-- ============================================================

create table if not exists public.health_metrics (
  day                   date primary key,

  -- ---- Sleep (minutes) ----
  sleep_total_min       integer,
  sleep_rem_min         integer,
  sleep_core_min        integer,
  sleep_deep_min        integer,
  sleep_awake_min       integer,
  sleep_start           timestamptz,   -- when you fell asleep (for consistency)
  sleep_end             timestamptz,

  -- ---- Heart ----
  resting_hr            numeric,       -- bpm
  walking_hr            numeric,       -- bpm
  hrv                   numeric,       -- SDNN, ms
  cardio_recovery       numeric,       -- HR drop 1 min post-workout, bpm
  heart_rate_min        numeric,       -- overnight low
  heart_rate_avg        numeric,

  -- ---- Cardio fitness ----
  vo2max                numeric,       -- ml/kg/min

  -- ---- Biomarkers ----
  spo2                  numeric,       -- %
  respiratory_rate      numeric,       -- breaths/min
  wrist_temp_deviation  numeric,       -- °C deviation from baseline

  -- ---- Activity ----
  active_energy         numeric,       -- kcal
  resting_energy        numeric,       -- kcal
  exercise_min          integer,
  stand_hours           integer,
  steps                 integer,
  distance_km           numeric,
  flights               integer,

  -- ---- Training ----
  training_load         numeric,       -- watchOS training load (or our proxy)

  -- ---- Body ----
  weight_kg             numeric,
  body_fat_pct          numeric,
  bmi                   numeric,

  -- ---- Workouts for the day (array of {type, minutes, kcal, avgHr}) ----
  workouts              jsonb,

  -- ---- Anything else the app sends, untyped ----
  raw                   jsonb,

  updated_at            timestamptz not null default now()
);

-- Helpful index for "recent N days" trend queries.
create index if not exists health_metrics_day_desc
  on public.health_metrics (day desc);

-- ---- Row Level Security ----
alter table public.health_metrics enable row level security;

-- Dashboard reads with the public anon key → allow SELECT only.
drop policy if exists health_metrics_read on public.health_metrics;
create policy health_metrics_read
  on public.health_metrics
  for select
  to anon, authenticated
  using (true);

-- NOTE: no INSERT/UPDATE/DELETE policy on purpose.
-- Only the service-role key (used by the Vercel webhook) can write,
-- and the service role bypasses RLS entirely.

-- ---- Realtime (optional, lets the dashboard live-update) ----
-- Run once; ignore the error if the table is already in the publication.
alter publication supabase_realtime add table public.health_metrics;
