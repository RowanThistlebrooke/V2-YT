// ============================================================
// physique-core.js — shared logic for the Physique module.
//
// Loaded by physique.html (UI) and lazily by topbar.js (Coach:
// dashboardData() summary + COACH_ACTION physique writes) so both
// compute targets, totals, trends and grades the same way.
//
// Storage: one localStorage key, `physique_v1`, synced under its own
// appKey `physique` (Invariant §8). Every write stamps `updatedAt`
// (Invariant §13) because the Coach writes the same key.
//
// Pure functions only — no DOM, no fetch except pushState().
// ============================================================
(function () {
  'use strict';

  const KEY = 'physique_v1';
  const APP_KEY = 'physique';
  const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  // ===== DATES =====
  function pad(n) { return String(n).padStart(2, '0'); }
  function dateKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
  function addDays(k, n) { const d = parseKey(k); d.setDate(d.getDate() + n); return dateKey(d); }
  // Same 4 AM rollover idea as the rest of the dashboard: a 1 AM snack belongs to "yesterday".
  function todayKey() { const d = new Date(); if (d.getHours() < 4) d.setDate(d.getDate() - 1); return dateKey(d); }
  function mondayOf(k) { const d = parseKey(k); const off = (d.getDay() + 6) % 7; d.setDate(d.getDate() - off); return dateKey(d); }
  function daysBetween(a, b) { return Math.round((parseKey(b) - parseKey(a)) / 86400000); }
  // Relative wording precomputed in JS (Invariant §5) — never hand raw dates to the AI for timing.
  function whenStr(k, ref) {
    const n = daysBetween(k, ref || todayKey());
    if (n === 0) return 'today';
    if (n === 1) return 'yesterday';
    if (n === -1) return 'tomorrow';
    return n > 0 ? n + ' days ago' : Math.abs(n) + ' days from now';
  }

  // ===== DEFAULT STATE =====
  function defaultState() {
    return {
      version: 1,
      updatedAt: 0,
      profile: { heightIn: 69, startDate: dateKey(new Date()), phase: 'lean_bulk', rateLbWk: [0.25, 0.5], waistGuardIn: 1 },
      targets: {
        high:   { kcal: 2800, p: 165, c: 375, f: 70 },
        medium: { kcal: 2700, p: 165, c: 350, f: 70 },
        low:    { kcal: 2500, p: 165, c: 290, f: 75 },
      },
      split: {
        mon: { label: 'Push', type: 'medium' }, tue: { label: 'Pull', type: 'medium' },
        wed: { label: 'Rest', type: 'low' },    thu: { label: 'Legs', type: 'high' },
        fri: { label: 'Upper', type: 'medium' }, sat: { label: 'Lower', type: 'high' },
        sun: { label: 'Rest', type: 'low' },
      },
      program: {},           // { Push: [{name, sets, note, priority}] }
      limits: { drinksPer14d: 4, cardioPerWeek: 2, sleepTargetH: 7.5, fiberG: 30, sodiumMg: 3000 },
      supps: { am: [], pm: [] },
      photos: { last: null, next: null, cadenceDays: 14, setup: '' },
      days: {},              // 'YYYY-MM-DD' -> day record
      sessions: [],          // [{id,date,split,gym,notes,exercises:[{name,planned,sets:[{w,r,unit}],note}]}]
      reviews: [],           // [{weekOf, grades, notes, changes}]
      rules: [],
      priorities: [],
      foods: [],             // personal food database [{name, serving, kcal,p,c,f}]
      imports: {},
    };
  }
  function blankDay() { return { items: [] }; }

  function normalize(s) {
    const d = defaultState();
    if (!s || typeof s !== 'object') return d;
    const out = Object.assign({}, d, s);
    out.profile = Object.assign({}, d.profile, s.profile || {});
    out.targets = Object.assign({}, d.targets, s.targets || {});
    out.split = Object.assign({}, d.split, s.split || {});
    out.limits = Object.assign({}, d.limits, s.limits || {});
    out.supps = Object.assign({}, d.supps, s.supps || {});
    out.photos = Object.assign({}, d.photos, s.photos || {});
    out.days = (s.days && typeof s.days === 'object') ? s.days : {};
    ['sessions', 'reviews', 'rules', 'priorities', 'foods'].forEach(function (k) { if (!Array.isArray(out[k])) out[k] = []; });
    if (!out.imports || typeof out.imports !== 'object') out.imports = {};
    if (!out.program || typeof out.program !== 'object') out.program = {};
    return out;
  }

  function load() {
    try { return normalize(JSON.parse(localStorage.getItem(KEY) || 'null')); }
    catch (e) { console.warn('[physique] load parse failed', e); return normalize(null); }
  }
  // Invariant §9: write + immediate push. Returns the fetch promise so the Coach can await it.
  function save(state) {
    state.updatedAt = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { console.error('[physique] localStorage write failed:', e); }
    return pushState(state);
  }
  function pushState(state) {
    return fetch('/api/db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Secret': window.DASH_APP_SECRET || '' },
      body: JSON.stringify({ key: APP_KEY, data: { [KEY]: state } }),
    }).then(function (r) { if (!r.ok) console.warn('[physique] push HTTP', r.status); return r; })
      .catch(function (e) { console.warn('[physique] push failed:', e); return null; });
  }

  // ===== DAY TYPE + TARGETS =====
  function dayRec(state, k) { return state.days[k] || null; }
  function ensureDay(state, k) { if (!state.days[k]) state.days[k] = blankDay(); if (!Array.isArray(state.days[k].items)) state.days[k].items = []; return state.days[k]; }
  function dayPlan(state, k) {
    const rec = dayRec(state, k);
    const base = state.split[DOW[parseKey(k).getDay()]] || { label: 'Rest', type: 'low' };
    return {
      label: (rec && rec.label) || base.label,
      type: (rec && rec.type) || base.type,
      overridden: !!(rec && (rec.type || rec.label)),
    };
  }
  function targetsFor(state, k) { const t = dayPlan(state, k).type; return Object.assign({ type: t }, state.targets[t] || state.targets.medium); }

  // ===== TOTALS =====
  function sumItems(items) {
    return (items || []).reduce(function (s, it) {
      s.kcal += +it.kcal || 0; s.p += +it.p || 0; s.c += +it.c || 0; s.f += +it.f || 0;
      if (it.alc) s.alcKcal += +it.kcal || 0;
      if (it.fiber != null) s.fiber += +it.fiber || 0;
      if (it.na != null) s.na += +it.na || 0;
      return s;
    }, { kcal: 0, p: 0, c: 0, f: 0, alcKcal: 0, fiber: 0, na: 0 });
  }
  // If the coach recorded an authoritative day estimate (totals), it wins over item sums —
  // imported days often have items with only kcal/P while the day total has full macros.
  function dayTotals(state, k) {
    const rec = dayRec(state, k);
    if (!rec) return null;
    const sum = sumItems(rec.items);
    if (rec.totals && rec.totals.kcal != null) {
      const t = rec.totals;
      return { kcal: +t.kcal || 0, p: +t.p || 0, c: +t.c || 0, f: +t.f || 0,
        alcKcal: t.alcKcal != null ? +t.alcKcal : sum.alcKcal, fiber: t.fiber != null ? +t.fiber : sum.fiber,
        na: t.na != null ? +t.na : sum.na, source: 'estimate', partial: !!rec.partial };
    }
    if (!rec.items.length) return null;
    return Object.assign(sum, { source: 'items', partial: !!rec.partial });
  }

  // ===== WEIGHT =====
  // external = optional array from gym.html's po_coach_weights [{dateKey, weight}] (read-only merge).
  function weightSeries(state, external) {
    const map = {};
    (external || []).forEach(function (w) {
      if (w && w.dateKey && +w.weight > 0) map[w.dateKey] = { dk: w.dateKey, lb: +w.weight, bf: null, clean: true, src: 'gym' };
    });
    Object.keys(state.days).forEach(function (k) {
      const w = state.days[k].weight;
      if (w && +w.lb > 0) map[k] = { dk: k, lb: +w.lb, bf: w.bf != null ? +w.bf : null, clean: w.clean !== false, note: w.note || '', extra: w.extra || null, src: 'physique' };
    });
    return Object.keys(map).sort().map(function (k) { return map[k]; });
  }
  // 7-day average of CLEAN readings in the window ending at k (inclusive).
  function avgAt(series, k, n) {
    n = n || 7;
    const from = addDays(k, -(n - 1));
    const pts = series.filter(function (p) { return p.clean && p.dk >= from && p.dk <= k; });
    if (!pts.length) return null;
    return { avg: pts.reduce(function (s, p) { return s + p.lb; }, 0) / pts.length, n: pts.length };
  }
  function trend(state, external, ref) {
    ref = ref || todayKey();
    const s = weightSeries(state, external);
    const now = avgAt(s, ref), prev = avgAt(s, addDays(ref, -7));
    const cleanThisWeek = s.filter(function (p) { return p.clean && p.dk >= addDays(ref, -6) && p.dk <= ref; }).length;
    const last = s.length ? s[s.length - 1] : null;
    const lastBf = s.slice().reverse().find(function (p) { return p.bf != null; }) || null;
    let rate = null;
    if (now && prev && now.n >= 2 && prev.n >= 2) rate = now.avg - prev.avg;
    // lean mass + FFMI from latest reading that has BF
    let ffmi = null, leanLb = null;
    if (lastBf) {
      leanLb = lastBf.lb * (1 - lastBf.bf / 100);
      const m = (state.profile.heightIn || 69) * 0.0254;
      ffmi = (leanLb / 2.20462) / (m * m);
      ffmi = ffmi + 6.1 * (1.8 - m); // height-normalized
    }
    return { series: s, avg7: now, avgPrev: prev, rateLbWk: rate, cleanThisWeek: cleanThisWeek, last: last, lastBf: lastBf, leanLb: leanLb, ffmi: ffmi };
  }

  // Adaptive TDEE: mean intake over 14 days minus energy stored (weight change of 7-day avgs).
  // Needs ≥10 logged days and two valid averages; otherwise reports calibration progress.
  function adaptiveTdee(state, external, ref) {
    ref = ref || todayKey();
    const s = weightSeries(state, external);
    let kcal = 0, n = 0;
    for (let i = 0; i < 14; i++) {
      const t = dayTotals(state, addDays(ref, -i - 1));
      if (t && !t.partial) { kcal += t.kcal; n++; }
    }
    const a = avgAt(s, ref), b = avgAt(s, addDays(ref, -13));
    const ready = n >= 10 && a && b && a.n >= 3 && b.n >= 2;
    if (!ready) return { ready: false, loggedDays: n, needDays: 10, cleanNow: a ? a.n : 0 };
    const intake = kcal / n;
    const dLbPerDay = (a.avg - b.avg) / 13;
    return { ready: true, tdee: Math.round(intake - dLbPerDay * 3500), intake: Math.round(intake), loggedDays: n };
  }

  // ===== TRAINING =====
  const MUSCLE_RULES = [
    ['lats', /pulldown|pull-?up|chin-?up|lat\b|straight-arm/i],
    ['upper chest', /incline/i],
    ['side delts', /lateral raise|lat raise|side raise|upright row/i],
    ['triceps', /tricep|pushdown|skull|\bdip\b|close-grip/i],
    ['biceps', /(?<!leg |wrist )curl/i],
    ['abs', /crunch|leg raise|sit-?up|rotation|ab wheel|plank|\bab\b/i],
    ['chest', /bench|pec|chest|(?<!rear delt )fly|\bdip\b/i],
    ['back', /\brow\b|t-bar|shrug|back extension/i],
    ['rear delts', /rear delt|face pull|reverse fly/i],
    ['quads', /squat|leg press(?! calf)|leg extension|lunge|hack/i],
    ['hamstrings', /leg curl|romanian|rdl|good morning/i],
    ['calves', /calf/i],
  ];
  function musclesFor(name) {
    const out = [];
    MUSCLE_RULES.forEach(function (r) { if (r[1].test(name || '')) out.push(r[0]); });
    // incline press is upper chest, not generic chest double-count
    if (out.indexOf('upper chest') !== -1) { const i = out.indexOf('chest'); if (i !== -1) out.splice(i, 1); }
    return out;
  }
  function sessionsInRange(state, from, to) {
    return state.sessions.filter(function (x) { return x.date >= from && x.date <= to; }).sort(function (a, b) { return a.date.localeCompare(b.date); });
  }
  function weeklyVolume(state, monday) {
    const vol = {};
    sessionsInRange(state, monday, addDays(monday, 6)).forEach(function (s) {
      (s.exercises || []).forEach(function (ex) {
        const n = (ex.sets || []).length || ex.setCount || 0;
        musclesFor(ex.name).forEach(function (m) { vol[m] = (vol[m] || 0) + n; });
      });
    });
    return vol;
  }
  function bestSet(sets) {
    let best = null;
    (sets || []).forEach(function (st) {
      const w = +st.w || 0, r = +st.r || 0;
      const e1rm = w * (1 + r / 30); // Epley
      if (!best || e1rm > best.e1rm) best = { w: w, r: r, e1rm: e1rm, unit: st.unit || 'lb' };
    });
    return best;
  }
  function exerciseHistory(state, name) {
    const key = String(name || '').toLowerCase();
    return state.sessions.slice().sort(function (a, b) { return a.date.localeCompare(b.date); }).map(function (s) {
      const ex = (s.exercises || []).find(function (e) { return String(e.name).toLowerCase() === key; });
      if (!ex) return null;
      const b = bestSet(ex.sets);
      return b ? { date: s.date, best: b, gym: s.gym || '' } : null;
    }).filter(Boolean);
  }

  // ===== WEEK SUMMARY + GRADES =====
  function grade(score) { return score >= 0.9 ? 'A' : score >= 0.75 ? 'B' : score >= 0.6 ? 'C' : score >= 0.45 ? 'D' : 'F'; }
  const GPA = { A: 4, B: 3, C: 2, D: 1, F: 0 };
  function weekSummary(state, monday, external) {
    const days = [];
    const ref = todayKey();
    for (let i = 0; i < 7; i++) {
      const k = addDays(monday, i);
      const rec = dayRec(state, k) || {};
      const plan = dayPlan(state, k);
      const tgt = targetsFor(state, k);
      const tot = dayTotals(state, k);
      const sess = state.sessions.find(function (s) { return s.date === k; }) || null;
      days.push({
        dk: k, future: k > ref, isToday: k === ref, plan: plan, tgt: tgt, tot: tot, sess: sess,
        sleep: rec.sleep || null, alcohol: rec.alcohol || null, cardio: rec.cardio || [],
        supps: rec.supps || null, weight: rec.weight || null,
      });
    }
    const past = days.filter(function (d) { return !d.future; });
    const fed = past.filter(function (d) { return d.tot && !d.tot.partial; });
    const avg = function (arr, f) { return arr.length ? arr.reduce(function (s, x) { return s + f(x); }, 0) / arr.length : null; };
    const g = {};
    const metrics = {};
    if (fed.length) {
      const pAvg = avg(fed, function (d) { return d.tot.p; }), pT = avg(fed, function (d) { return d.tgt.p; });
      const kAvg = avg(fed, function (d) { return d.tot.kcal; }), kT = avg(fed, function (d) { return d.tgt.kcal; });
      const fatOver = fed.filter(function (d) { return d.tot.f > d.tgt.f + 10; }).length;
      metrics.protein = { avg: Math.round(pAvg), target: Math.round(pT) };
      metrics.calories = { avg: Math.round(kAvg), target: Math.round(kT), delta: Math.round(kAvg - kT) };
      metrics.fat = { overDays: fatOver, days: fed.length, avg: Math.round(avg(fed, function (d) { return d.tot.f; })) };
      const pr = pAvg / pT;
      g.protein = pr >= 0.97 ? 'A' : pr >= 0.9 ? 'B' : pr >= 0.8 ? 'C' : pr >= 0.7 ? 'D' : 'F';
      const dev = Math.abs(kAvg - kT);
      g.calories = dev <= 100 ? 'A' : dev <= 200 ? 'B' : dev <= 300 ? 'C' : dev <= 450 ? 'D' : 'F';
      const fr = fatOver / fed.length;
      g.fat = fr <= 0.15 ? 'A' : fr <= 0.3 ? 'B' : fr <= 0.5 ? 'C' : fr <= 0.75 ? 'D' : 'F';
    }
    const plannedLifts = past.filter(function (d) { return !/rest/i.test(d.plan.label); }).length;
    const done = past.filter(function (d) { return d.sess; }).length;
    metrics.training = { done: done, planned: plannedLifts };
    if (plannedLifts) g.training = grade(done / plannedLifts);
    const cardio = past.reduce(function (s, d) { return s + (d.cardio || []).filter(function (c) { return (+c.min || 0) >= 20; }).length; }, 0);
    metrics.cardio = { sessions: cardio, target: state.limits.cardioPerWeek };
    if (past.length >= 4) g.cardio = cardio >= state.limits.cardioPerWeek ? 'A' : cardio >= 1 ? 'C' : 'F';
    const slept = past.filter(function (d) { return d.sleep && +d.sleep.h > 0; });
    if (slept.length) {
      const sAvg = avg(slept, function (d) { return +d.sleep.h; });
      metrics.sleep = { avg: +sAvg.toFixed(1), nights: slept.length, short: slept.filter(function (d) { return d.sleep.h < 6.5; }).length };
      g.sleep = sAvg >= 7.5 ? 'A' : sAvg >= 7 ? 'B' : sAvg >= 6.5 ? 'C' : sAvg >= 6 ? 'D' : 'F';
    }
    const drinks = past.reduce(function (s, d) { return s + (d.alcohol ? +d.alcohol.drinks || 0 : 0); }, 0);
    metrics.alcohol = { drinks: drinks };
    g.alcohol = drinks === 0 ? 'A' : drinks <= state.limits.drinksPer14d ? 'B' : drinks <= 6 ? 'C' : drinks <= 9 ? 'D' : 'F';
    const suppDays = past.filter(function (d) { return d.supps; });
    if (suppDays.length) {
      const hits = suppDays.reduce(function (s, d) { return s + (d.supps.am ? 1 : 0) + (d.supps.pm ? 1 : 0); }, 0);
      metrics.supps = { hit: hits, of: past.length * 2 };
      g.supps = grade(hits / (past.length * 2));
    }
    const tr = trend(state, external, addDays(monday, 6) < ref ? addDays(monday, 6) : ref);
    metrics.weight = { avg7: tr.avg7 ? +tr.avg7.avg.toFixed(1) : null, rateLbWk: tr.rateLbWk != null ? +tr.rateLbWk.toFixed(2) : null, clean: tr.cleanThisWeek };
    const gs = Object.keys(g).map(function (k) { return GPA[g[k]]; });
    const gpa = gs.length ? gs.reduce(function (a, b) { return a + b; }, 0) / gs.length : null;
    return { monday: monday, days: days, grades: g, metrics: metrics, gpa: gpa, adherence: gpa != null ? Math.round(gpa / 4 * 100) : null, volume: weeklyVolume(state, monday) };
  }

  function drinksLast14(state, ref) {
    ref = ref || todayKey();
    let n = 0;
    for (let i = 0; i < 14; i++) { const r = dayRec(state, addDays(ref, -i)); if (r && r.alcohol) n += +r.alcohol.drinks || 0; }
    return n;
  }

  // ===== QUICK LOG PARSER =====
  // "3 egg omelette 210 18p 1c 15f" | "baguette 85g 230kcal 8p 46c 2f" | "asahi x5 700kcal alc"
  function parseQuickLog(text) {
    let t = ' ' + String(text || '').trim() + ' ';
    const out = { name: '', kcal: null, p: null, c: null, f: null, g: null, alc: false };
    const grab = function (re, key) { const m = t.match(re); if (m) { out[key] = parseFloat(m[1]); t = t.replace(m[0], ' '); } };
    grab(/\s(\d+(?:\.\d+)?)\s*(?:kcal|cal|calories)\b/i, 'kcal');
    grab(/\s(\d+(?:\.\d+)?)\s*p(?:ro(?:tein)?)?\b/i, 'p');
    grab(/\s(\d+(?:\.\d+)?)\s*c(?:arbs?)?\b/i, 'c');
    grab(/\s(\d+(?:\.\d+)?)\s*f(?:at)?\b/i, 'f');
    grab(/\s(\d+(?:\.\d+)?)\s*g(?:rams?)?\b/i, 'g');
    if (/\salc(?:ohol)?\b/i.test(t)) { out.alc = true; t = t.replace(/\salc(?:ohol)?\b/i, ' '); }
    // A trailing bare number is calories when no kcal given ("omelette 210").
    if (out.kcal == null) { const m = t.match(/\s(\d+(?:\.\d+)?)\s*$/); if (m) { out.kcal = parseFloat(m[1]); t = t.slice(0, m.index) + ' '; } }
    if (out.kcal == null && out.p != null && out.c != null && out.f != null) out.kcal = Math.round(out.p * 4 + out.c * 4 + out.f * 9);
    out.name = t.replace(/\s+/g, ' ').trim();
    return out;
  }

  // ===== WRITE OPS (shared by UI + Coach) =====
  function uid(p) { return (p || 'x') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function findSession(state, date, split) {
    let s = state.sessions.find(function (x) { return x.date === date; });
    if (!s) {
      s = { id: uid('s'), date: date, split: split || dayPlan(state, date).label, gym: '', notes: '', exercises: [] };
      state.sessions.push(s);
    }
    return s;
  }
  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }

  function applyOp(state, act) {
    const date = act.date || todayKey();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid date: ' + date };
    switch (act.op) {
      case 'log_food': {
        if (!act.name) return { ok: false, error: 'log_food needs name' };
        const d = ensureDay(state, date);
        d.items.push({ id: uid('f'), t: act.time || new Date().toTimeString().slice(0, 5), name: String(act.name),
          g: num(act.grams), kcal: num(act.kcal) || 0, p: num(act.p) || 0, c: num(act.c) || 0, f: num(act.f) || 0,
          fiber: num(act.fiber), na: num(act.sodium), alc: !!act.alcohol });
        // A live item log supersedes a stale coach day-estimate for the same day.
        if (d.totals && act.keepTotals !== true) delete d.totals;
        if (act.alcohol && act.drinks) { d.alcohol = { drinks: (d.alcohol ? +d.alcohol.drinks || 0 : 0) + (+act.drinks || 0), kcal: (d.alcohol ? +d.alcohol.kcal || 0 : 0) + (num(act.kcal) || 0) }; }
        return { ok: true };
      }
      case 'remove_food': {
        const d = dayRec(state, date);
        if (!d) return { ok: false, error: 'No log for ' + date };
        const q = String(act.name || '').toLowerCase();
        let i = -1;
        d.items.forEach(function (x, idx) { if (String(x.name).toLowerCase().indexOf(q) !== -1) i = idx; });
        if (i < 0) return { ok: false, error: 'No food matching "' + act.name + '" on ' + date };
        d.items.splice(i, 1);
        return { ok: true };
      }
      case 'set_totals': {
        const d = ensureDay(state, date);
        d.totals = { kcal: num(act.kcal), p: num(act.p), c: num(act.c), f: num(act.f) };
        return { ok: true };
      }
      case 'log_weight': {
        const lb = num(act.lb);
        if (!(lb > 50)) return { ok: false, error: 'log_weight needs lb' };
        ensureDay(state, date).weight = { lb: lb, bf: num(act.bf), clean: act.clean !== false, note: act.note || '' };
        return { ok: true };
      }
      case 'log_sleep': {
        const h = num(act.hours);
        if (!(h > 0)) return { ok: false, error: 'log_sleep needs hours' };
        ensureDay(state, date).sleep = { h: h, score: num(act.score), nap: num(act.napMin) };
        return { ok: true };
      }
      case 'log_cardio': {
        const d = ensureDay(state, date);
        if (!Array.isArray(d.cardio)) d.cardio = [];
        d.cardio.push({ kind: act.kind || 'bike', min: num(act.minutes) || 0, note: act.note || '' });
        return { ok: true };
      }
      case 'log_alcohol': {
        const d = ensureDay(state, date);
        d.alcohol = { drinks: num(act.drinks) || 0, kcal: num(act.kcal) || 0, note: act.note || '' };
        return { ok: true };
      }
      case 'supps': {
        const d = ensureDay(state, date);
        d.supps = Object.assign({ am: false, pm: false }, d.supps || {});
        if (act.am != null) d.supps.am = !!act.am;
        if (act.pm != null) d.supps.pm = !!act.pm;
        return { ok: true };
      }
      case 'set_day': {
        const d = ensureDay(state, date);
        if (act.type) { if (!state.targets[act.type]) return { ok: false, error: 'type must be high|medium|low' }; d.type = act.type; }
        if (act.label) d.label = act.label;
        return { ok: true };
      }
      case 'log_set': {
        if (!act.exercise) return { ok: false, error: 'log_set needs exercise' };
        const s = findSession(state, date, act.split);
        if (act.gym) s.gym = act.gym;
        let ex = s.exercises.find(function (e) { return String(e.name).toLowerCase() === String(act.exercise).toLowerCase(); });
        if (!ex) { ex = { name: act.exercise, planned: act.planned || '', sets: [], note: '' }; s.exercises.push(ex); }
        const reps = Array.isArray(act.reps) ? act.reps : [act.reps];
        const ws = Array.isArray(act.weight) ? act.weight : reps.map(function () { return act.weight; });
        reps.forEach(function (r, i) { ex.sets.push({ w: num(ws[i] != null ? ws[i] : ws[0]), r: num(r), unit: act.unit || 'lb' }); });
        if (act.note) ex.note = (ex.note ? ex.note + '; ' : '') + act.note;
        return { ok: true };
      }
      case 'session_note': {
        const s = findSession(state, date, act.split);
        s.notes = (s.notes ? s.notes + ' ' : '') + (act.text || '');
        return { ok: true };
      }
      case 'note': {
        const d = ensureDay(state, date);
        d.notes = (d.notes ? d.notes + ' ' : '') + (act.text || '');
        return { ok: true };
      }
      case 'add_review': {
        state.reviews = state.reviews.filter(function (r) { return r.weekOf !== act.weekOf; });
        state.reviews.push({ weekOf: act.weekOf || mondayOf(date), grades: act.grades || {}, notes: act.notes || [], changes: act.changes || [] });
        return { ok: true };
      }
      default:
        return { ok: false, error: 'Unknown physique op: ' + act.op };
    }
  }

  // ===== COACH SUMMARY (compact, precomputed timing) =====
  function coachSummary(state, external) {
    const ref = todayKey();
    const r1 = function (x) { return x == null ? null : Math.round(x); };
    const plan = dayPlan(state, ref), tgt = targetsFor(state, ref), tot = dayTotals(state, ref) || { kcal: 0, p: 0, c: 0, f: 0, alcKcal: 0 };
    const rec = dayRec(state, ref) || {};
    const last7 = [];
    for (let i = 1; i <= 7; i++) {
      const k = addDays(ref, -i), t = dayTotals(state, k), p2 = dayPlan(state, k), tg = targetsFor(state, k), r = dayRec(state, k) || {};
      if (!t && !r.sleep && !r.weight) continue;
      last7.push({ when: whenStr(k, ref), date: k, day: p2.label + ' (' + p2.type + ')',
        kcal: t ? r1(t.kcal) : null, p: t ? r1(t.p) : null, c: t ? r1(t.c) : null, f: t ? r1(t.f) : null,
        target: tg.kcal + '/' + tg.p + 'P/' + tg.c + 'C/' + tg.f + 'F',
        sleepH: r.sleep ? r.sleep.h : null, drinks: r.alcohol ? r.alcohol.drinks : null,
        trained: !!state.sessions.find(function (s) { return s.date === k; }) });
    }
    const tr = trend(state, external, ref);
    const wk = weekSummary(state, mondayOf(ref), external);
    const prevWk = weekSummary(state, addDays(mondayOf(ref), -7), external);
    const recentSessions = state.sessions.slice().sort(function (a, b) { return b.date.localeCompare(a.date); }).slice(0, 4).map(function (s) {
      return { when: whenStr(s.date, ref), date: s.date, split: s.split, gym: s.gym || undefined,
        exercises: (s.exercises || []).map(function (e) { return e.name + ': ' + ((e.sets || []).map(function (x) { return (x.w != null ? x.w : 'BW') + 'x' + (x.r != null ? x.r : '?'); }).join(', ') || 'not reported'); }) };
    });
    let photo = null;
    if (state.photos.next) {
      const nk = state.photos.next.slice(0, 10);
      photo = { next_when: whenStr(nk, ref), last_when: state.photos.last ? whenStr(state.photos.last, ref) : null };
    }
    return {
      today: { date: ref, split: plan.label, carb_day: plan.type, target: tgt,
        eaten: { kcal: r1(tot.kcal), p: r1(tot.p), c: r1(tot.c), f: r1(tot.f), alcohol_kcal: r1(tot.alcKcal) },
        remaining: { kcal: r1(tgt.kcal - tot.kcal), p: r1(tgt.p - tot.p), c: r1(tgt.c - tot.c), f: r1(tgt.f - tot.f) },
        items: (rec.items || []).map(function (i) { return (i.t ? i.t + ' ' : '') + i.name + (i.g ? ' ' + i.g + 'g' : '') + ' — ' + r1(i.kcal) + 'kcal ' + r1(i.p) + 'P ' + r1(i.c) + 'C ' + r1(i.f) + 'F'; }),
        supps: rec.supps || null, sleepH: rec.sleep ? rec.sleep.h : null, weighIn: rec.weight || null,
        program: state.program[plan.label] || null },
      last_7_days: last7,
      weight: { avg7: tr.avg7 ? +tr.avg7.avg.toFixed(1) : null, avg7_readings: tr.avg7 ? tr.avg7.n : 0,
        rate_lb_per_wk: tr.rateLbWk != null ? +tr.rateLbWk.toFixed(2) : null, target_rate: state.profile.rateLbWk,
        clean_weighins_last_7d: tr.cleanThisWeek, last: tr.last ? { lb: tr.last.lb, when: whenStr(tr.last.dk, ref), clean: tr.last.clean } : null,
        bf_scale: tr.lastBf ? tr.lastBf.bf : null, lean_lb: tr.leanLb ? +tr.leanLb.toFixed(1) : null, ffmi_adj: tr.ffmi ? +tr.ffmi.toFixed(1) : null },
      tdee: adaptiveTdee(state, external, ref),
      this_week: { grades: wk.grades, metrics: wk.metrics, adherence_pct: wk.adherence, volume_sets: wk.volume },
      last_week: { grades: prevWk.grades, metrics: prevWk.metrics, adherence_pct: prevWk.adherence },
      drinks_last_14d: drinksLast14(state, ref), drinks_limit_14d: state.limits.drinksPer14d,
      recent_sessions: recentSessions,
      photos: photo,
      split: state.split, targets: state.targets, priorities: state.priorities,
      latest_review: state.reviews.length ? state.reviews.slice().sort(function (a, b) { return b.weekOf.localeCompare(a.weekOf); })[0] : null,
      rules: state.rules,
    };
  }

  window.PhysiqueCore = {
    KEY: KEY, APP_KEY: APP_KEY, DOW: DOW,
    dateKey: dateKey, parseKey: parseKey, addDays: addDays, todayKey: todayKey, mondayOf: mondayOf, whenStr: whenStr, daysBetween: daysBetween,
    defaultState: defaultState, normalize: normalize, load: load, save: save, pushState: pushState,
    dayPlan: dayPlan, targetsFor: targetsFor, dayTotals: dayTotals, ensureDay: ensureDay, sumItems: sumItems,
    weightSeries: weightSeries, avgAt: avgAt, trend: trend, adaptiveTdee: adaptiveTdee,
    musclesFor: musclesFor, weeklyVolume: weeklyVolume, exerciseHistory: exerciseHistory, bestSet: bestSet,
    weekSummary: weekSummary, drinksLast14: drinksLast14, parseQuickLog: parseQuickLog,
    applyOp: applyOp, coachSummary: coachSummary, uid: uid,
  };
})();
