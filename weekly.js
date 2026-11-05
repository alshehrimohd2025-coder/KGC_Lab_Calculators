/* ============================================================
   Management report — a day, a week or a month
   ------------------------------------------------------------
   Built from the records, not typed up: the readings log, the
   before/after cards, the addition and treatment logs, the
   follow-ups closed on the tasks page, and the production report.
   The engineer reads it, adds a comment under each part and a list
   of what is needed, then prints it or exports it to Excel
   (weekly_xlsx.js) to send by email.

   The period is a day, a Sunday-to-Saturday week or a calendar month.
   Each opens on the last complete one: yesterday, last week, last month.

   It reads, in this order:
     top           production, jigs, zinc, the dross to expect, and how many
                   tanks were out of standard — each against the period before
     1. Tanks      which baths left their standard, and which stayed in it
     2. Changed    before/after results, problems that closed or opened
     3. Needs      decision / purchase / maintenance, with why, who and by when
     4. Materials  what was put into the baths

   What goes in is chosen on the page and kept at report_settings:
     { tanksOff: { <tankId>: true }, completeness, unchanged, production }
   Every tank with a standard is in unless taken out. The three options are
   off unless turned on: the analysis-completeness table, the items that did
   not change, and the production figures and product mix (kept for when the
   batch data is complete).

   Two rules it keeps:
     - A lower zinc figure is never called an improvement: it moves with
       the kind of steel put through, so it is described only as higher or
       lower.
     - No money is computed. There is no documented price basis here, and a
       saving figure without one is a guess with a currency sign on it.

   Gaps are said out loud: days with no production data, readings judged
   against today's limits, totals that are estimates — the expected dross is
   one, taken from the last drossings.

   Stored at weekly_reports/<key>, where the key is the week's first day
   (as it always was), day_<date> for a day, or month_<YYYY-MM> for a month:
     { preparedBy, preparedTitle, comments: { summary, status, changed, needs, consumption },
       needs: { <pushId>: { kind, priority, what, why, owner, due } } }

   Depends on globals from index.html: database, tanks, tankLabel(),
   IS_EDITOR, IS_AUTHED, t(), and KGCSpecs / KGCTasks / KGCActions /
   KGCKettle / KGCLab / KGCZinc / KGCProduction when loaded.
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[weekly] Firebase database is not available.');
    return;
  }

  const LOGGED = ['ph', 'fe', 'baume', 'acidPercent', 'sg', 'conc', 'temp', 'ec', 'zn', 'salt'];
  const NEED_KINDS = ['decision', 'purchase', 'maintenance'];
  const PRIORITIES = ['high', 'medium', 'low'];
  const PERIOD_KINDS = ['day', 'week', 'month'];
  const ACID_TANKS = [3, 4, 5, 6];
  const OPTIONS = ['completeness', 'unchanged', 'production'];
  // drossings the expected-dross rate is averaged over
  const DROSS_BASIS = 3;
  // the preparer's title until one is typed for the report; clearing it leaves it blank
  const DEFAULT_TITLE = 'Chemical Engineer';

  let readings = {}, renewals = {}, acidAdds = {}, fluxT = {}, peroxT = {}, saltAdds = {}, reports = {}, settings = {};
  let period = null;            // { kind: 'day' | 'week' | 'month', start: 'YYYY-MM-DD' }
  let exported = null;          // { file, text } — the email text shown after a download
  let held = false;
  let events = {}, eventDraft = null;
  const EVENT_KINDS = ['breakdown', 'bypass', 'maintenance', 'change'];
  const pendingSources = new Set(), failedSources = new Set();
  const dataReady = () => !pendingSources.size && !failedSources.size;

  /* ---------------- helpers ---------------- */

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pad = n => (n < 10 ? '0' : '') + n;
  const dayKey = d => { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const parse = s => new Date(s + 'T00:00:00');
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return dayKey(d); };
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
  const canEdit = () => (typeof IS_EDITOR !== 'undefined' && IS_EDITOR) &&
                        (typeof IS_AUTHED !== 'undefined' && IS_AUTHED);
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const finiteMeasurement = v => {
    if (v == null || typeof v === 'boolean' || (typeof v === 'string' && !v.trim())) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const uncertainBaumePair = r => finiteMeasurement(r.beBefore) === 0 && finiteMeasurement(r.beAfter) === 0;
  const baumeCaveat = note => (note ? note + ' · ' : '') + t('wk.baume.zeroPair');
  const fmt = (v, d) => (v == null || !isFinite(v)) ? '—'
    : Number(v).toLocaleString(undefined, { maximumFractionDigits: d == null ? 2 : d, minimumFractionDigits: 0 });
  const tankById = id => (typeof tanks !== 'undefined' ? tanks.find(x => x.id === Number(id)) : null);
  const tankName = id => { const tk = tankById(id); return tk ? tankLabel(tk.name) : (id == null ? '—' : String(id)); };
  const T = () => window.KGCTasks;
  const paramLabel = k => (T() ? T().paramLabel(k) : k);
  const tsDay = ts => { const n = typeof ts === 'number' ? ts : Date.parse(ts); return isFinite(n) ? dayKey(new Date(n)) : ''; };
  const inRange = (d, S, E) => !!d && d >= S && d <= E;
  const prioRank = p => { const i = PRIORITIES.indexOf(p); return i === -1 ? PRIORITIES.length : i; };

  /* ---------------- periods ---------------- */

  /** First day of the last week that has fully ended (weeks run Sunday to Saturday). */
  function lastWeekStart(today) {
    const back = ((parse(today).getDay() + 1) % 7) || 7;     // days back to the last Saturday
    return addDays(addDays(today, -back), -6);
  }

  /** The last complete period of a kind: yesterday, last week, last month. */
  function defaultPeriod(kind) {
    const today = dayKey();
    if (kind === 'day') return { kind: 'day', start: addDays(today, -1) };
    if (kind === 'month') {
      const d = parse(today); d.setDate(1); d.setMonth(d.getMonth() - 1);
      return { kind: 'month', start: dayKey(d) };
    }
    return { kind: 'week', start: lastWeekStart(today) };
  }

  function currentWeek() {
    const today = dayKey();
    return { kind: 'week', start: addDays(today, -parse(today).getDay()) };
  }

  function bounds(p) {
    if (p.kind === 'day') return { S: p.start, E: p.start, days: 1 };
    if (p.kind === 'month') {
      const d = parse(p.start); d.setMonth(d.getMonth() + 1); d.setDate(0);
      const E = dayKey(d);
      return { S: p.start, E: E, days: daysBetween(p.start, E) + 1 };
    }
    return { S: p.start, E: addDays(p.start, 6), days: 7 };
  }

  function shift(p, n) {
    if (p.kind === 'day') return { kind: 'day', start: addDays(p.start, n) };
    if (p.kind === 'month') {
      const d = parse(p.start); d.setMonth(d.getMonth() + n);
      return { kind: 'month', start: dayKey(d) };
    }
    return { kind: 'week', start: addDays(p.start, 7 * n) };
  }

  // a week keeps the bare date as its key, so reports written before days
  // and months existed are still found
  const reportKey = p => p.kind === 'week' ? p.start
    : p.kind === 'day' ? 'day_' + p.start : 'month_' + p.start.slice(0, 7);
  const samePeriod = (a, b) => !!a && !!b && a.kind === b.kind && a.start === b.start;

  // dates in an isolated left-to-right run, so they read the same inside Arabic text
  function rangeText(p) {
    const b = bounds(p);
    return p.kind === 'day' ? b.S : b.S + ' → ' + b.E;
  }

  const titleOf = rep => rep.preparedTitle != null ? rep.preparedTitle : DEFAULT_TITLE;

  function periodText(p) {
    const b = bounds(p);
    return p.kind === 'day' ? t('wk.periodDay', { a: b.S }) : t('wk.period', { a: b.S, b: b.E });
  }
  const values = o => Object.keys(o || {}).map(k => Object.assign({ _k: k }, o[k])).filter(Boolean);

  function measurable(tankId) { return T() ? T().measurable(tankId) : []; }

  /* ---------------- what goes in the report ---------------- */

  const included = id => !(settings.tanksOff && settings.tanksOff[id]);
  const opt = k => !!settings[k];

  /** Tanks with a standard, in line order: the ones a report can speak about. */
  function reportTanks() {
    return typeof tanks === 'undefined' ? [] : tanks.slice().sort((a, b) => a.id - b.id).filter(tk => measurable(tk.id).length);
  }
  const shownTanks = () => reportTanks().filter(tk => included(tk.id));
  const acidIn = () => ACID_TANKS.every(included);

  /* A choice shows at once. The editor's is also kept for the next report;
     anyone else's lasts until the page is reloaded. */
  function setSettings(updates) {
    const next = JSON.parse(JSON.stringify(settings));
    Object.keys(updates).forEach(function (path) {
      const ps = path.split('/');
      let o = next;
      for (let i = 0; i < ps.length - 1; i++) o = o[ps[i]] = (o[ps[i]] && typeof o[ps[i]] === 'object') ? o[ps[i]] : {};
      if (updates[path] == null) delete o[ps[ps.length - 1]]; else o[ps[ps.length - 1]] = updates[path];
    });
    settings = next;
    if (canEdit()) database.ref('report_settings').update(updates);
  }

  function evalTier(tankId, key, v) {
    const SP = window.KGCSpecs;
    const p = measurable(tankId).find(x => x.key === key);
    return SP && p ? SP.evaluate(v, p).tier : 'none';
  }

  /** How far outside its range a reading sits, as a share of the range. */
  function outside(p, v) {
    const width = (p.min != null && p.max != null) ? (p.max - p.min) : (p.max != null ? p.max : (p.min || 1));
    if (p.max != null && v > p.max) return (v - p.max) / (width || 1);
    if (p.min != null && v < p.min) return (p.min - v) / (width || 1);
    return 0;
  }

  /* ---------------- 1. status ---------------- */

  function rowsIn(S, E) {
    return values(readings).filter(r => inRange(r.date, S, E));
  }

  const isBad = tier => tier === 'warn' || tier === 'crit';
  const reading = v => v != null && v !== '' && isFinite(Number(v)) && Number(v) !== 0;

  /* A parameter's last value up to a day, wherever it was entered. Usually
     that is the reading log; the tank card also counts, because a value typed
     there before readings were dated never reached the log and is still what
     the tank dashboard shows. An undated card value stands only for a period
     that reaches today, and only when nothing dated exists. */
  function lastPoint(tk, key, E, all) {
    let best = null;
    all.forEach(function (r) {
      if (Number(r.tankId) !== tk.id || !r.date || r.date > E || !reading(r[key])) return;
      if (!best || r.date > best.date) best = { date: r.date, v: Number(r[key]) };
    });
    if (reading(tk[key])) {
      const m = tk.measured && tk.measured[key];
      if (m && m <= E && (!best || m > best.date)) best = { date: m, v: Number(tk[key]) };
      else if (!m && !best && E >= dayKey()) best = { date: null, v: Number(tk[key]) };
    }
    return best;
  }

  /* One row per parameter that is out of standard on its last reading up to
     the end of the period — however old that reading is, since a bath nobody
     re-measured is still the bath it was — or that went out at any reading
     taken inside the period. */
  function breaches(S, E) {
    const out = [];
    const all = values(readings);
    shownTanks().forEach(function (tk) {
      measurable(tk.id).forEach(function (p) {
        const last = lastPoint(tk, p.key, E, all);
        if (!last) return;
        const lastTier = evalTier(tk.id, p.key, last.v);
        const pts = all.filter(r => Number(r.tankId) === tk.id && inRange(r.date, S, E) && reading(r[p.key]));
        const bad = pts.filter(r => isBad(evalTier(tk.id, p.key, r[p.key])));
        if (!isBad(lastTier) && !bad.length) return;
        const worst = bad.slice().sort((a, b) => outside(p, Number(b[p.key])) - outside(p, Number(a[p.key])))[0];
        out.push({
          tankId: tk.id, key: p.key, p: p, n: pts.length, bad: bad.length,
          crit: bad.filter(r => evalTier(tk.id, p.key, r[p.key]) === 'crit').length,
          worst: worst ? Number(worst[p.key]) : null, worstDate: worst ? worst.date : null,
          last: last.v, lastDate: last.date, lastTier: lastTier, old: !last.date || last.date < S
        });
      });
    });
    // in line order, as the plant reads its tanks; the ones back in standard after them
    return out.filter(x => isBad(x.lastTier)).concat(out.filter(x => !isBad(x.lastTier)));
  }

  /** Tanks in the report that are within standard on their last reading (with its day), and those never measured. */
  function standing(br, E) {
    const out = { ok: [], none: [] };
    const all = values(readings);
    shownTanks().forEach(function (tk) {
      if (br.some(x => x.tankId === tk.id && isBad(x.lastTier))) return;
      const dates = measurable(tk.id).map(p => lastPoint(tk, p.key, E, all)).filter(Boolean).map(x => x.date || '');
      if (!dates.length) out.none.push(tk.id);
      else out.ok.push({ tankId: tk.id, date: dates.sort().pop() || null });
    });
    return out;
  }
  const outTankIds = br => br.filter(x => isBad(x.lastTier)).map(x => x.tankId)
    .filter((id, i, a) => a.indexOf(id) === i);

  function completeness(S, E, days) {
    const out = [];
    if (!T()) return out;
    const all = values(readings);
    shownTanks().forEach(function (tk) {
      const sc = T().scheduleFor(tk.id);
      if (sc.off || !sc.params.length) return;
      const mine = all.filter(r => Number(r.tankId) === tk.id);
      const have = r => sc.params.filter(k => r[k] != null && r[k] !== '').length;
      let full = 0, partial = 0;
      mine.filter(r => inRange(r.date, S, E)).forEach(function (r) {
        const n = have(r);
        if (n === sc.params.length) full++;
        else if (n > 0) partial++;
      });
      /* Samples the schedule asked for in this window. A window shorter than
         the interval (a single day against a weekly schedule) owes one only if
         a sample fell due inside it; otherwise the tank is simply not due. */
      let expected = Math.floor(days / sc.every);
      if (!expected) {
        const last = mine.filter(r => r.date < S && have(r) === sc.params.length).map(r => r.date).sort().pop();
        expected = (!last || addDays(last, sc.every) <= E) ? 1 : 0;
      }
      out.push({ tankId: tk.id, sc: sc, expected: expected, full: full, partial: partial,
        pct: expected ? Math.min(100, Math.round(full / expected * 100)) : null });
    });
    return out;
  }

  /** Share of the samples due that were taken in full, or null when none was due. */
  function completenessShare(list) {
    const exp = list.reduce((s, x) => s + x.expected, 0);
    const got = list.reduce((s, x) => s + Math.min(x.full, x.expected), 0);
    return exp ? got / exp : null;
  }

  /* ---------------- 2. what changed ---------------- */

  /** Each parameter's standing at the start of the week against its end. */
  function issueMovement(S, E) {
    const out = { closed: [], opened: [], still: [] };
    const all = values(readings);
    shownTanks().forEach(function (tk) {
      measurable(tk.id).forEach(function (p) {
        const startPt = lastPoint(tk, p.key, addDays(S, -1), all);
        const endPt = lastPoint(tk, p.key, E, all);
        if (!endPt) return;
        const bad = pt => !!pt && isBad(evalTier(tk.id, p.key, pt.v));
        const item = { tankId: tk.id, key: p.key, from: startPt ? startPt.v : null,
          to: endPt.v, toDate: endPt.date, range: T() ? T().rangeOf(p) : '' };
        if (bad(startPt) && !bad(endPt)) out.closed.push(item);
        else if (!bad(startPt) && bad(endPt) && endPt.date && endPt.date >= S) out.opened.push(item);
        // an undated card value cannot be placed in the period, so it is not news
        else if (bad(endPt)) out.still.push(item);
      });
    });
    return out;
  }

  function cardResults(S, E) {
    const A = window.KGCActions;
    if (!A) return [];
    return A.list().filter(function (c) {
      if (!included(c.tankId)) return false;
      const actDay = c.action ? String(c.action.at || '').slice(0, 10) : '';
      const afterIn = A.aftersOf(c).some(x => inRange(String(x.at || '').slice(0, 10), S, E));
      return inRange(actDay, S, E) || afterIn;
    });
  }

  /* Specialist logs are independent treatment records, not action cards.
     Keep each record and its actual date even when two have the same day. */
  function specialistResults(S, E) {
    if (!included(10)) return [];
    const result = [];
    const append = (records, material, fields) => values(records).forEach(r => {
      if (!inRange(r.date, S, E)) return;
      fields.forEach(f => {
        let before = finiteMeasurement(r[f.before]), after = finiteMeasurement(r[f.after]);
        if (before == null && after == null) return;
        const unknown = f.key === 'baume' && uncertainBaumePair(r);
        if (unknown) { before = null; after = null; }
        result.push({ date: r.date, tank: t('wk.flux.solution'), material: matLabel(material),
          parameter: paramLabel(f.key), before: before, after: after, unit: f.unit,
          source: matLabel(material) + ' — ' + t('wk.src.log'), note: unknown ? baumeCaveat(r.note) : (r.note || '') });
      });
    });
    append(fluxT, 'ammonia', [
      { key: 'ph', before: 'phBefore', after: 'phAfter', unit: '' },
      { key: 'baume', before: 'beBefore', after: 'beAfter', unit: '°Bé' }
    ]);
    append(peroxT, 'peroxide', [{ key: 'fe', before: 'feBefore', after: 'feAfter', unit: 'g/L' }]);
    append(saltAdds, 'flux_salt', [{ key: 'baume', before: 'beBefore', after: 'beAfter', unit: '°Bé' }]);
    return result.sort((a, b) => a.date.localeCompare(b.date));
  }

  /* ---------------- 3. needs ---------------- */

  /* What each bath out of standard needs, from its last reading — the
     tanks in the report only. One need per tank, its reason naming every
     parameter out with the reading's day, so a stale or mistyped reading
     shows for what it is; one older than a week asks for a re-measure first.
     Far out (critical, or beyond the width of the range) is high priority
     and wanted tomorrow; otherwise medium, the day after. */
  const RINSES = [2, 9], ACIDS = [3, 4, 5, 6, 8];
  function tankNeeds() {
    const out = [];
    const all = values(readings), today = dayKey();
    shownTanks().forEach(function (tk) {
      const bad = [];
      measurable(tk.id).forEach(function (p) {
        const last = lastPoint(tk, p.key, today, all);
        if (!last) return;
        const tier = evalTier(tk.id, p.key, last.v);
        if (!isBad(tier)) return;
        bad.push({ key: p.key, v: last.v, date: last.date, high: p.max != null && last.v > p.max,
          far: tier === 'crit' || outside(p, last.v) > 1,
          text: t('wk.sg.reading', { p: paramLabel(p.key), v: fmt(last.v) + (p.unit ? ' ' + p.unit : ''),
            r: T() ? T().rangeOf(p) : '', d: last.date || t('wk.noDate') }) });
      });
      if (!bad.length) return;
      const has = k => bad.find(x => x.key === k);
      const stale = bad.some(x => !x.date || daysBetween(x.date, today) > 7);
      const urgent = bad.some(x => x.far);
      const tank = tankName(tk.id);
      let kind = 'maintenance', what;
      if (tk.id === 1 && has('conc') && !has('conc').high) what = t('wk.sg.degrease');
      else if (RINSES.indexOf(tk.id) !== -1) what = t('wk.sg.rinse', { tk: tank });
      else if (ACIDS.indexOf(tk.id) !== -1 && has('fe') && has('fe').high) { kind = 'decision'; what = t('wk.sg.acidRenew', { tk: tank }); }
      else if (tk.id === 7 && ((has('zn') && has('zn').high) || (has('fe') && has('fe').high))) { kind = 'decision'; what = t('wk.sg.stripRenew'); }
      else if (tk.id === 10 && has('fe') && has('fe').high) what = t('wk.sg.fluxFe');
      else what = t('wk.sg.correct', { tk: tank, p: bad.map(x => paramLabel(x.key)).join(' · ') });
      out.push({ kind: kind, what: what, priority: urgent ? 'high' : 'medium', due: addDays(today, urgent ? 1 : 2),
        owner: kind === 'maintenance' ? t('wk.sg.owner') : null,
        why: bad.map(x => x.text).join(' · ') + (stale ? ' — ' + t('wk.sg.stale') : '') });
    });
    return out;
  }

  function suggestions() {
    const out = tankNeeds();
    const L = window.KGCLab;
    if (L && L._inventory) {
      const inv = L._inventory();
      Object.keys(inv).forEach(function (k) {
        const it = inv[k];
        if (!it || !(Number(it.min) > 0) || Number(it.qty) > Number(it.min)) return;
        const name = t('lab.item.' + k) === 'lab.item.' + k ? k : t('lab.item.' + k);
        out.push({ kind: 'purchase', what: name, why: t('wk.sg.stock', { q: fmt(it.qty), m: fmt(it.min), u: it.unit || '' }) });
      });
    }
    const K = window.KGCKettle;
    if (K && K.calibrationAlerts) K.calibrationAlerts().forEach(function (a) {
      out.push({ kind: 'maintenance', what: t('wk.sg.calibWhat', { n: a.name }),
        why: a.days < 0 ? t('att.calOverdue', { n: Math.abs(a.days) }) : t('att.calSoon', { n: a.days }), due: a.due });
    });
    const SP = window.KGCSpecs;
    if (SP && SP.unavailable) SP.unavailable().forEach(function (u) {
      out.push({ kind: 'purchase', what: t('wk.sg.instWhat', { p: u.params.join(' · ') }),
        why: t('wk.sg.instWhy', { tk: tankName(u.tankId) }) });
    });
    const A = window.KGCActions;
    if (A) A.followups().forEach(function (c) {
      out.push({ kind: 'decision', what: t('wk.sg.followWhat', { tk: tankName(c.tankId) }), why: c.note || t('ac.res.followup') });
    });
    if (typeof tanks !== 'undefined') tanks.forEach(function (tk) {
      if (tk.status === 'out_of_service' || tk.status === 'maintenance') {
        out.push({ kind: 'maintenance', what: tankName(tk.id), why: t('st.' + tk.status) + (tk.note ? ' — ' + tk.note : '') });
      }
    });
    return out;
  }

  /* A suggestion added to the list keeps an English copy of its wording, so
     an English export never shows text the engineer only saw in Arabic. */
  function pendingSuggestions(rep) {
    const saved = values(rep.needs);
    const here = suggestions();
    const en = window.I18N && I18N.withLang ? I18N.withLang('en', suggestions) : here;
    return here.map((s, i) => ({ s: s, en: en[i] || s }))
      .filter(x => !saved.some(n => n.what === x.s.what || (n.whatEn && n.whatEn === x.en.what)));
  }

  function needText(n, f) {
    const en = window.I18N && I18N.lang === 'en';
    return (en && n[f + 'En']) || n[f] || '';
  }

  /* ---------------- production and consumption ---------------- */

  const zincDays = () => { const Z = window.KGCZinc; return Object.values((Z && Z._days && Z._days()) || {}).filter(d => d && d.date); };
  const dayKg = d => num(d.dayTon) + num(d.nightTon);

  /* From the production report. Jigs are the sheet's own count per shift;
     a period whose sheets carry no jig row says so rather than showing 0. */
  function production(S, E) {
    const days = zincDays().filter(d => inRange(d.date, S, E));
    let kg = 0, zn = 0, dross = 0, release = 0, prodDays = 0, jigs = 0, jigKnown = false;
    days.forEach(function (d) {
      const k = dayKg(d);
      kg += k;
      zn += num(d.dayPct) / 100 * num(d.dayTon) + num(d.nightPct) / 100 * num(d.nightTon);
      dross += num(d.dross); release += num(d.release);
      jigs += num(d.dayJigs) + num(d.nightJigs);
      if (num(d.dayJigs) + num(d.nightJigs) > 0) jigKnown = true;
      if (k > 0) prodDays++;
    });
    const out = { records: days.length, prodDays: prodDays, tonnes: kg / 1000, zincKg: zn,
      zincPerT: kg > 0 && zn > 0 ? zn / kg * 1000 : null, dross: dross, release: release,
      jigs: jigKnown ? jigs : null };
    out.drossRate = drossRate(E);
    out.drossExpected = out.drossRate && days.length ? out.drossRate.rate * out.tonnes : null;
    return out;
  }

  /* Dross builds up with the steel put through and is pulled out on stop
     days, so each weighing covers the production since the one before it.
     The rate is the last few weighings over the tonnes they covered; the
     dross to expect for a period is that rate times what it produced. It is
     an estimate, and the report says what it was taken from. */
  function drossRate(E) {
    const days = zincDays().filter(d => d.date <= E).sort((a, b) => a.date < b.date ? -1 : 1);
    const pulls = days.filter(d => num(d.dross) > 0);
    const spans = [];
    for (let i = pulls.length - 1; i > 0 && spans.length < DROSS_BASIS; i--) {
      const a = pulls[i - 1].date, b = pulls[i].date;
      const kg = days.filter(d => d.date > a && d.date <= b).reduce((s, d) => s + dayKg(d), 0);
      if (kg > 0) spans.push({ from: a, to: b, dross: num(pulls[i].dross), tonnes: kg / 1000 });
    }
    if (!spans.length) return null;
    const dross = spans.reduce((s, x) => s + x.dross, 0), tonnes = spans.reduce((s, x) => s + x.tonnes, 0);
    return { rate: dross / tonnes, n: spans.length, dross: dross, tonnes: tonnes,
      since: spans[spans.length - 1].from, dates: spans.map(x => x.to).reverse() };
  }

  /** Steel put through, by product, from the batch tracker. */
  function productMix(S, E) {
    const P = window.KGCProduction;
    if (!P || !P._batches) return [];
    const by = {};
    Object.values(P._batches() || {}).forEach(function (b) {
      if (!b || !inRange(tsDay(b.startTs), S, E)) return;
      const k = b.product || '—';
      by[k] = by[k] || { product: k, kg: 0, n: 0 };
      by[k].kg += num(b.weight); by[k].n++;
    });
    return Object.values(by).sort((a, b) => b.kg - a.kg);
  }

  /* Materials put into the baths. The logs on the flux and pickling pages are
     the plant's own record, so they come first; a before/after card adds its
     quantity only when no log entry already covers the same tank and day. */
  function materialEntries(S, E) {
    const out = [];
    const add = (mat, unit, q, src, r, tankId, date) => {
      if (!(q > 0)) return;
      const unknown = src === 'log' && tankId === 10 && ['ammonia', 'peroxide', 'flux_salt'].includes(mat) && uncertainBaumePair(r);
      out.push({ mat, unit, q, src, tankId, date: date || r.date,
        note: unknown ? baumeCaveat(r.note) : (r.note || ''),
        before: unknown ? null : finiteMeasurement(r.beBefore), after: unknown ? null : finiteMeasurement(r.beAfter) });
    };
    const logged = {};
    const mark = (mat, tankId, date) => { logged[mat + '|' + tankId + '|' + date] = 1; };
    values(acidAdds).forEach(r => { if (inRange(r.date, S, E)) { add('hcl', 't', num(r.tons), 'log', r, r.tankId); mark('hcl', r.tankId, r.date); } });
    values(renewals).forEach(r => {
      if (inRange(r.date, S, E) && r.type === 'addition') { add('hcl', r.unit || 'L', num(r.qty), 'log', r, r.tankId); mark('hcl', r.tankId, r.date); }
    });
    values(fluxT).forEach(r => { if (inRange(r.date, S, E)) { add('ammonia', 'L', num(r.liters), 'log', r, 10); mark('ammonia', 10, r.date); } });
    values(peroxT).forEach(r => { if (inRange(r.date, S, E)) { add('peroxide', 'L', num(r.liters), 'log', r, 10); mark('peroxide', 10, r.date); } });
    values(saltAdds).forEach(r => { if (inRange(r.date, S, E)) { add('flux_salt', 'kg', num(r.kg), 'log', r, 10); mark('flux_salt', 10, r.date); } });
    const A = window.KGCActions;
    if (A) A.list().forEach(function (c) {
      const a = c.action;
      const d = a ? String(a.at || '').slice(0, 10) : '';
      if (!a || !inRange(d, S, E) || logged[a.material + '|' + c.tankId + '|' + d]) return;
      add(a.material === 'other' ? (a.materialOther || 'other') : a.material, a.actualUnit || '', num(a.actualQty), 'card', a, c.tankId, d);
    });
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  function materials(S, E) {
    const tot = {};
    materialEntries(S, E).forEach(r => {
      const k = r.mat + '|' + r.unit;
      tot[k] = tot[k] || { mat: r.mat, unit: r.unit, q: 0, srcs: {} };
      tot[k].q += r.q; tot[k].srcs[r.src] = 1;
    });
    return Object.values(tot);
  }

  // An unresolved event carries forward; closing it does not erase it from
  // earlier reports. Current undated tank status is never backdated.
  function operatingEvents(S, E) {
    return values(events).filter(e => e.start && e.start <= E && (!e.end || e.end >= S))
      .sort((a, b) => a.start.localeCompare(b.start)).map(e => Object.assign({}, e, {
        tank: e.tankId ? tankName(e.tankId) : t('wk.op.line'),
        kindText: t('wk.op.kind.' + e.kind),
        state: t(e.end && e.end <= E ? 'wk.op.closed' : 'wk.op.open'),
        impactType: t(e.impactBasis === 'observed' ? 'wk.op.observed' : 'wk.op.expected')
      }));
  }

  function currentOutages(E) {
    return E >= dayKey() && typeof tanks !== 'undefined'
      ? tanks.filter(tk => ['out_of_service', 'maintenance'].includes(tk.status))
        .map(tk => ({ tank: tankName(tk.id), status: t('st.' + tk.status), note: tk.note || '' })) : [];
  }

  function operationsHTML(b) {
    const list = operatingEvents(b.S, b.E), current = currentOutages(b.E), edit = canEdit();
    const d = eventDraft || {};
    const input = (key, type, max) => '<label><span>' + esc(t('wk.op.' + key)) + '</span><input data-wk-event="' + key + '" type="' + type + '"' +
      (max ? ' maxlength="' + max + '"' : '') + ' value="' + esc(d[key] || '') + '"></label>';
    const area = key => '<label class="wk-wide"><span>' + esc(t('wk.op.' + key)) + '</span><textarea data-wk-event="' + key + '" rows="2" maxlength="1000">' + esc(d[key] || '') + '</textarea></label>';
    const select = (key, items) => '<label><span>' + esc(t('wk.op.' + key)) + '</span><select data-wk-event="' + key + '">' +
      items.map(x => '<option value="' + esc(x[0]) + '"' + (String(d[key] || '') === String(x[0]) ? ' selected' : '') + '>' + esc(x[1]) + '</option>').join('') + '</select></label>';
    return '<section class="wk-sec">' +
      '<h3 class="wk-h">' + esc(t('wk.op.heading')) + '</h3><p class="wk-sub">' + esc(t('wk.op.help')) + '</p>' +
      (list.length ? table([t('wk.op.dates'), t('wk.op.tankId'), t('wk.op.title'), t('wk.op.action'), t('wk.op.impact'), t('wk.op.status')].concat(edit ? [''] : []),
        list.map(e => '<tr><td class="wk-date">' + esc(e.start) + '<br>' + esc(e.end && e.end <= b.E ? e.end : t('wk.op.open')) + '</td><td>' + esc(e.tank) +
          '</td><td class="wk-prose"><b>' + esc(e.title) + '</b><br>' + esc(e.kindText) + '</td><td class="wk-prose">' + esc(e.action) +
          '</td><td class="wk-prose">' + (e.impact ? '<b>' + esc(e.impactType) + '</b><br>' + esc(e.impact) : '—') +
          '</td><td>' + esc(e.state) + '</td>' + (edit ? '<td><button class="btn mini ghost no-print" data-wk-event-edit="' + esc(e._k) + '">' + esc(t('wk.op.edit')) + '</button></td>' : '') + '</tr>'))
        : '<div class="lab-empty">' + esc(t('wk.op.empty')) + '</div>') +
      (current.length ? '<p class="wk-sub">' + esc(t('wk.op.current')) + '</p><ul class="wk-ul">' + current.map(x => '<li>' + esc(x.tank + ' — ' + x.status + (x.note ? ': ' + x.note : '')) + '</li>').join('') +
        '</ul><p class="wk-note">' + esc(t('wk.op.undated')) + '</p>' : '') +
      (edit ? '<details class="wk-event-form no-print"' + (eventDraft ? ' open' : '') + '><summary>' + esc(t(d._k ? 'wk.op.edit' : 'wk.op.add')) + '</summary>' +
        '<div class="wk-event-grid">' + input('start', 'date') + input('end', 'date') +
        select('tankId', [['', t('wk.op.line')]].concat((typeof tanks !== 'undefined' ? tanks : []).map(tk => [tk.id, tankName(tk.id)]))) +
        select('kind', EVENT_KINDS.map(k => [k, t('wk.op.kind.' + k)])) + input('title', 'text', 200) +
        select('impactBasis', [['expected', t('wk.op.expected')], ['observed', t('wk.op.observed')]]) + area('action') + area('impact') + '</div>' +
        '<p class="tk-hint">' + esc(t('wk.op.evidence')) + '</p><div class="tk-actions"><button class="btn mini" id="wk-event-save">' + esc(t('wk.op.save')) +
        '</button><button class="btn mini ghost" id="wk-event-cancel">' + esc(t('wk.op.cancel')) + '</button><span id="wk-event-msg" role="status"></span></div></details>' : '') + '</section>';
  }

  function matLabel(m) {
    const k = 'lab.item.' + m;
    if (t(k) !== k) return t(k);
    const k2 = 'ac.mat.' + m;
    return t(k2) !== k2 ? t(k2) : m;
  }

  // Specialist logs concern flux solution but do not record its physical vessel.
  const materialTank = r => r.src === 'log' && r.tankId === 10 && ['ammonia', 'peroxide', 'flux_salt'].includes(r.mat)
    ? t('wk.flux.solution') : tankName(r.tankId);

  /* ---------------- rendering ---------------- */

  function commentBox(sec, rep) {
    const v = (rep.comments && rep.comments[sec]) || '';
    return '<div class="wk-comment' + (v ? '' : ' empty') + '">' +
      '<label><span>' + esc(t('wk.c.' + sec)) + '</span>' +
        (canEdit() ? '<textarea data-wk-c="' + sec + '" rows="3" maxlength="2000" placeholder="' + esc(t('wk.c.ph')) + '">' + esc(v) + '</textarea>' : '') +
      '</label>' +
      '<div class="wk-print-text" data-wk-mirror="' + sec + '">' + esc(v) + '</div>' +
    '</div>';
  }

  function table(head, rows, cls) {
    return '<div class="tablewrap' + (cls ? ' ' + cls : '') + '"><table><thead><tr>' +
      head.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
      rows.join('') + '</tbody></table></div>';
  }

  const TIER_COL = { good: 'var(--accent)', warn: 'var(--warn)', crit: 'var(--crit)' };
  const tv = (tankId, key, v) => '<b style="color:' + (TIER_COL[evalTier(tankId, key, v)] || 'var(--ink)') + '">' + fmt(v) + '</b>';

  /** Everything the top of the report and its first section share. */
  function figures(p) {
    const b = bounds(p), pb = bounds(shift(p, -1));
    const ids = shownTanks().map(tk => tk.id);
    const rows = rowsIn(b.S, b.E).filter(r => ids.indexOf(Number(r.tankId)) !== -1);
    const br = breaches(b.S, b.E);
    return { b: b, rows: rows, br: br, out: outTankIds(br).length, prevOut: outTankIds(breaches(pb.S, pb.E)).length,
      cur: production(b.S, b.E), prev: production(pb.S, pb.E) };
  }

  function drossNote(cur) {
    const dr = cur.drossRate;
    return t('wk.n.dross', { r: fmt(dr.rate, 1), t: fmt(cur.tonnes, 1), n: dr.n, d: dr.dates.join(' · '),
      kg: fmt(dr.dross, 0), bt: fmt(dr.tonnes, 1), rm: fmt(cur.dross, 0) });
  }

  function topHTML(F) {
    const cur = F.cur, partial = cur.records > 0 && cur.records < F.b.days, star = partial ? ' *' : '';
    return '<section class="wk-sec wk-top">' +
      '<div class="pt-stats">' +
        stat(t('wk.s.tonnes') + star, cur.records ? fmt(cur.tonnes, 1) + '<small>t</small>' : '—') +
        stat(t('wk.s.jigs') + star, cur.jigs != null ? fmt(cur.jigs, 0) : '—') +
        stat(t('wk.s.zincKg') + star, cur.zincKg > 0 ? fmt(cur.zincKg, 0) + '<small>kg</small>' : '—') +
        stat(t('wk.s.zincPerT') + star, cur.zincPerT != null ? fmt(cur.zincPerT, 1) + '<small>kg/t</small>' : '—') +
        stat(t('wk.s.drossExp') + star, cur.drossExpected != null ? fmt(cur.drossExpected, 0) + '<small>kg</small>' : '—') +
        stat(t('wk.s.tanksOut'), F.out + '<small>/ ' + shownTanks().length + '</small>', F.out > 0) +
      '</div>' +
      (!cur.records ? '<p class="wk-note">' + esc(t('wk.noProduction')) + '</p>'
        : cur.drossRate ? '<p class="wk-note">' + esc(drossNote(cur)) + '</p>'
        : '<p class="wk-note">' + esc(t('wk.n.noDrossRate')) + '</p>') +
      (partial ? '<p class="wk-note">' + esc(t('wk.n.partial', { n: cur.records, d: F.b.days })) + '</p>' : '') +
    '</section>';
  }

  function statusHTML(F, rep) {
    const b = F.b, rows = F.rows, br = F.br;
    const st = standing(br, b.E);
    const off = reportTanks().filter(tk => !included(tk.id)).map(tk => tk.id);
    const names = ids => ids.map(tankName).join(' · ');
    const day = (d, old) => d ? '<small' + (old ? ' class="wk-old"' : '') + '>' + esc(d) + '</small>'
      : '<small class="wk-old">' + esc(t('wk.noDate')) + '</small>';

    const brTable = br.length ? table(
      [t('lab.col.tank'), t('spec.param'), t('wk.col.last'), t('ac.col.status'), t('ac.col.range'), t('wk.col.outOf'), t('wk.col.worst')],
      br.map(x => '<tr><td class="name">' + esc(tankName(x.tankId)) + '</td><td>' + esc(paramLabel(x.key)) + '</td>' +
        '<td class="num">' + tv(x.tankId, x.key, x.last) + ' ' + day(x.lastDate, x.old) + '</td>' +
        '<td>' + esc(t(isBad(x.lastTier) ? 'wk.tier.' + x.lastTier : 'wk.tier.back')) + '</td>' +
        '<td class="num" dir="ltr">' + esc(T() ? T().rangeOf(x.p) : '') + '</td>' +
        '<td class="num">' + (x.n ? x.bad + ' / ' + x.n + (x.crit ? ' <small style="color:var(--crit)">(' + esc(t('wk.critN', { n: x.crit })) + ')</small>' : '') : '—') + '</td>' +
        '<td class="num">' + (x.worst != null ? tv(x.tankId, x.key, x.worst) + ' ' + day(x.worstDate) : '—') + '</td></tr>'))
      : '<div class="att-clear"><span class="att-ok">✓</span>' + esc(t(st.ok.length ? 'wk.noBreach' : 'wk.noReadings')) + '</div>';

    let cpPart = '';
    if (opt('completeness')) {
      const cp = completeness(b.S, b.E, b.days);
      const share = completenessShare(cp);
      cpPart = '<p class="wk-sub">' + esc(t('wk.h.complete')) +
          (share == null ? '' : ' — ' + Math.round(share * 100) + '%') + '</p>' +
        (cp.length ? table(
          [t('lab.col.tank'), t('wk.col.schedule'), t('wk.col.expected'), t('wk.col.full'), t('wk.col.partial'), t('wk.col.pct')],
          cp.map(x => '<tr><td class="name">' + esc(tankName(x.tankId)) + '</td>' +
            '<td>' + esc(t('wk.every', { n: x.sc.every, p: x.sc.params.map(paramLabel).join(' · ') })) + '</td>' +
            '<td class="num">' + x.expected + '</td><td class="num">' + x.full + '</td><td class="num">' + x.partial + '</td>' +
            '<td class="num">' + (x.pct == null ? '<span class="ac-none">' + esc(t('wk.notDue')) + '</span>'
              : '<b style="color:' + (x.pct >= 100 ? 'var(--accent)' : x.pct >= 50 ? 'var(--warn)' : 'var(--crit)') + '">' + x.pct + '%</b>') + '</td></tr>'))
          : '') +
        '<p class="wk-note">' + esc(t('wk.n.full')) + '</p>';
    }

    return '<section class="wk-sec">' +
      '<h3 class="wk-h"><span class="wk-n">1</span>' + esc(t('wk.q1')) + '</h3>' +
      '<p class="wk-sub">' + esc(t('wk.h.breaches', { n: rows.length })) + '</p>' + brTable +
      (br.some(x => x.old) ? '<p class="wk-note">' + esc(t('wk.n.old')) + '</p>' : '') +
      (st.ok.length ? '<p class="wk-line ok"><b>' + esc(t('wk.st.ok')) + '</b> ' +
        esc(st.ok.map(x => tankName(x.tankId) + ' (' + (x.date || t('wk.noDate')) + ')').join(' · ')) + '</p>' : '') +
      (st.none.length ? '<p class="wk-line"><b>' + esc(t('wk.st.none')) + '</b> ' + esc(names(st.none)) + '</p>' : '') +
      (off.length ? '<p class="wk-note">' + esc(t('wk.st.off', { list: names(off) })) + '</p>' : '') +
      cpPart +
      '<p class="wk-note">' + esc(t('wk.n.limits')) + '</p>' +
      commentBox('status', rep) +
    '</section>';
  }

  /* Only what moved: a card parameter whose value changed, a problem that
     closed or opened. What stayed the same is named under the table, or
     listed in it when the report is set to show unchanged items. */
  function changes(b) {
    const A = window.KGCActions;
    const all = opt('unchanged');
    const out = { cards: [], quiet: 0, treatments: specialistResults(b.S, b.E), mv: issueMovement(b.S, b.E) };
    if (A) cardResults(b.S, b.E).forEach(function (c) {
      const before = (c.before && c.before.readings) || {};
      // Do not bring future follow-up readings into a historical report.
      const after = {};
      A.aftersOf(c).filter(x => String(x.at || '').slice(0, 10) <= b.E && !!x.at)
        .forEach(x => Object.keys(x.readings || {}).forEach(k => {
          const v = x.readings[k];
          if (v != null && !(typeof v === 'string' && !v.trim()) && isFinite(Number(v))) after[k] = Number(v);
        }));
      const keys = all ? Object.keys(before).concat(Object.keys(after).filter(k => before[k] == null))
        : Object.keys(before).filter(k => after[k] != null && Number(after[k]) !== Number(before[k]));
      if (keys.length || all) out.cards.push({ c: c, keys: keys, before: before, after: after });
      else out.quiet++;
    });
    return out;
  }

  function changedHTML(b, rep) {
    const A = window.KGCActions;
    const all = opt('unchanged');
    const ch = changes(b), mv = ch.mv;
    const cardRows = ch.cards.map(function (x) {
      const c = x.c;
      const diff = x.keys.length
        ? x.keys.map(k => esc(paramLabel(k)) + ' <span dir="ltr">' + (x.before[k] != null ? tv(c.tankId, k, x.before[k]) : '—') +
            ' → ' + (x.after[k] != null ? tv(c.tankId, k, x.after[k]) : '—') + '</span>').join('<br>')
        : '<span class="ac-none">' + esc(t('ac.none.after')) + '</span>';
      const ev = c.evaluation ? t('ac.res.' + c.evaluation.result) : t('wk.ev.noEval');
      return '<tr><td class="name">' + esc(tankName(c.tankId)) + '</td><td>' + esc(c.action ? A.materialText(c.action) : '—') + '</td>' +
        '<td>' + diff + '</td><td>' + esc(ev) + (c.evaluation && c.evaluation.note ? '<br><small>' + esc(c.evaluation.note) + '</small>' : '') + '</td>' +
        '<td>' + esc(t('ac.stage.' + A.stage(c))) + '</td></tr>';
    });
    const logRows = ch.treatments.map(x => '<tr><td>' + esc(x.date) + '</td><td class="name">' + esc(x.tank) + '</td><td>' +
      esc(x.material) + '</td><td>' + esc(x.parameter) + ' <span dir="ltr">' + esc(fmt(x.before)) + ' → ' + esc(fmt(x.after)) +
      (x.unit ? ' ' + esc(x.unit) : '') + '</span></td><td>' + esc(x.source) + (x.note ? '<br><small>' + esc(x.note) + '</small>' : '') + '</td></tr>');
    const mvList = (arr, cls) => arr.map(x => '<li class="' + cls + '"><b>' + esc(tankName(x.tankId)) + '</b> · ' + esc(paramLabel(x.key)) + ' ' +
      '<span dir="ltr">' + (x.from != null ? tv(x.tankId, x.key, x.from) + ' → ' : '') + tv(x.tankId, x.key, x.to) + '</span>' +
      ' <small dir="ltr">(' + esc(x.range) + ')</small> <small>' + esc(x.toDate) + '</small></li>').join('');
    const still = all ? mv.still : [];
    const openNow = A ? A.list().filter(c => c.status !== 'closed' && included(c.tankId)).length : 0;
    return '<section class="wk-sec">' +
      '<h3 class="wk-h"><span class="wk-n">2</span>' + esc(t('wk.q3')) + '</h3>' +
      '<p class="wk-sub">' + esc(t('wk.h.cards')) + '</p>' +
      (cardRows.length ? table([t('lab.col.tank'), t('ac.f.material'), t('wk.col.beforeAfter'), t('ac.st.eval'), t('ac.col.status')], cardRows)
        : (!logRows.length ? '<div class="lab-empty">' + esc(t(ch.quiet ? 'wk.noCardChange' : 'wk.noCards')) + '</div>' : '')) +
      (logRows.length ? '<p class="wk-sub">' + esc(t('wk.h.treatmentResults')) + '</p>' +
        table([t('wk.mat.date'), t('lab.col.tank'), t('ac.f.material'), t('wk.col.beforeAfter'), t('wk.mat.note')], logRows) : '') +
      (ch.quiet && cardRows.length ? '<p class="wk-note">' + esc(t('wk.n.quietCards', { n: ch.quiet })) + '</p>' : '') +
      '<p class="wk-sub">' + esc(t('wk.h.movement')) + '</p>' +
      ((mv.closed.length + mv.opened.length + still.length)
        ? '<ul class="wk-ul wk-mv">' +
            (mv.closed.length ? '<li class="wk-mv-h">' + esc(t('wk.mv.closed')) + '</li>' + mvList(mv.closed, 'ok') : '') +
            (mv.opened.length ? '<li class="wk-mv-h">' + esc(t('wk.mv.opened')) + '</li>' + mvList(mv.opened, 'bad') : '') +
            (still.length ? '<li class="wk-mv-h">' + esc(t('wk.mv.still')) + '</li>' + mvList(still, 'bad') : '') +
          '</ul>'
        : '<div class="lab-empty">' + esc(t(mv.still.length ? 'wk.noMovementStill' : 'wk.noMovement')) + '</div>') +
      (!all && mv.still.length ? '<p class="wk-line"><b>' + esc(t('wk.st.still')) + '</b> ' +
        esc(mv.still.map(x => tankName(x.tankId) + ' · ' + paramLabel(x.key)).join(', ')) + '</p>' : '') +
      '<p class="wk-note">' + esc(t('wk.n.openCards', { n: openNow })) + '</p>' +
      commentBox('changed', rep) +
    '</section>';
  }

  /* Several needs pasted at once: rows copied from a table, Excel or a chat,
     columns in the form's order — priority, type, needed, why, owner, needed
     by. Tabs or "|" separate the columns; a heading row is skipped. Words
     are read in English or Arabic. */
  const PRIO_WORDS = { high: 'high', 'عالية': 'high', 'عالي': 'high', medium: 'medium', 'متوسطة': 'medium', 'متوسط': 'medium',
    low: 'low', 'منخفضة': 'low', 'منخفض': 'low' };
  const KIND_WORDS = { decision: 'decision', 'قرار': 'decision', purchase: 'purchase', 'شراء': 'purchase',
    maintenance: 'maintenance', 'صيانة': 'maintenance' };
  // kept across re-renders, so live updates from other devices do not wipe a paste
  let pasteOpen = false, pasteNote = '', pasteText = '';
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  /** 14-Oct-2026, 2026-10-14 or 14/10/2026 (day first) as YYYY-MM-DD; anything else is dropped. */
  function pastedDate(s) {
    s = String(s || '').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
    m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/);
    if (m && MON[m[2].toLowerCase()]) return m[3] + '-' + pad(MON[m[2].toLowerCase()]) + '-' + pad(+m[1]);
    m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (m) return m[3] + '-' + pad(+m[2]) + '-' + pad(+m[1]);
    return null;
  }

  function parseNeeds(text) {
    return String(text || '').split(/\r?\n/).map(function (line) {
      let c = line.indexOf('\t') !== -1 ? line.split('\t') : line.split('|');
      c = c.map(x => x.trim());
      if (c.length && c[0] === '') c.shift();
      if (c.length && c[c.length - 1] === '') c.pop();
      return c;
    }).filter(c => c.length >= 3 && !c.every(x => /^:?-*:?$/.test(x)) && !/^(priority|الأولوية)$/i.test(c[0]))
      .map(c => ({ priority: PRIO_WORDS[c[0].toLowerCase()] || null, kind: KIND_WORDS[(c[1] || '').toLowerCase()] || 'decision',
        what: c[2] || '', why: c[3] || '', owner: c[4] || null, due: pastedDate(c[5]) }))
      .filter(n => n.what);
  }

  /** The needs list, most urgent first. */
  function savedNeeds(rep) {
    return values(rep.needs).sort((a, b) => prioRank(a.priority) - prioRank(b.priority) || (a.ts || 0) - (b.ts || 0));
  }

  function needsHTML(b, rep) {
    const saved = savedNeeds(rep);
    const edit = canEdit();
    const sg = pendingSuggestions(rep).map(x => x.s);
    const prioCell = n => edit
      ? '<select class="wk-prio-sel p-' + esc(n.priority || 'none') + '" data-wk-prio="' + esc(n._k) + '">' +
          '<option value=""' + (n.priority ? '' : ' selected') + '>—</option>' +
          PRIORITIES.map(p => '<option value="' + p + '"' + (n.priority === p ? ' selected' : '') + '>' + esc(t('wk.prio.' + p)) + '</option>').join('') +
        '</select>'
      : (n.priority ? '<span class="wk-prio p-' + esc(n.priority) + '">' + esc(t('wk.prio.' + n.priority)) + '</span>' : '—');
    return '<section class="wk-sec">' +
      '<h3 class="wk-h"><span class="wk-n">3</span>' + esc(t('wk.q4')) + '</h3>' +
      (saved.length ? table([t('wk.col.priority'), t('wk.col.kind'), t('wk.col.what'), t('wk.col.why'), t('wk.col.owner'), t('wk.col.due')].concat(edit ? [''] : []),
        saved.map(n => '<tr><td>' + prioCell(n) + '</td><td><span class="wk-kind k-' + esc(n.kind) + '">' + esc(t('wk.kind.' + n.kind)) + '</span></td>' +
          '<td class="name">' + esc(needText(n, 'what')) + '</td><td>' + esc(needText(n, 'why')) + '</td><td>' + esc(n.owner || '—') + '</td>' +
          '<td class="num">' + esc(n.due || '—') + '</td>' +
          (edit ? '<td><button class="btn mini danger" data-wk-del="' + esc(n._k) + '">' + esc(t('lab.delete')) + '</button></td>' : '') + '</tr>'))
        : '<div class="lab-empty">' + esc(t('wk.noNeeds')) + '</div>') +
      (edit ? '<div class="lab-form wk-needform">' +
        '<div><label>' + esc(t('wk.col.priority')) + '</label><select id="wk-n-prio">' +
          PRIORITIES.map(p => '<option value="' + p + '"' + (p === 'medium' ? ' selected' : '') + '>' + esc(t('wk.prio.' + p)) + '</option>').join('') + '</select></div>' +
        '<div><label>' + esc(t('wk.col.kind')) + '</label><select id="wk-n-kind">' +
          NEED_KINDS.map(k => '<option value="' + k + '">' + esc(t('wk.kind.' + k)) + '</option>').join('') + '</select></div>' +
        '<div><label>' + esc(t('wk.col.what')) + '</label><input type="text" id="wk-n-what" maxlength="160"></div>' +
        '<div><label>' + esc(t('wk.col.why')) + '</label><input type="text" id="wk-n-why" maxlength="240"></div>' +
        '<div><label>' + esc(t('wk.col.owner')) + '</label><input type="text" id="wk-n-owner" maxlength="80"></div>' +
        '<div><label>' + esc(t('wk.col.due')) + '</label><input type="date" id="wk-n-due"></div>' +
        '<div><button class="btn" id="wk-n-add" style="width:100%;justify-content:center">' + esc(t('wk.b.addNeed')) + '</button></div>' +
        '<span class="tk-msg" id="wk-n-msg"></span>' +
      '</div>' +
      '<details class="wk-paste no-print"' + (pasteOpen ? ' open' : '') + '><summary>' + esc(t('wk.paste.title')) + '</summary>' +
        '<p class="tk-hint">' + esc(t('wk.paste.hint')) + '</p>' +
        '<textarea id="wk-n-paste" rows="5" dir="auto">' + esc(pasteText) + '</textarea>' +
        '<div class="tk-actions"><button class="btn mini" id="wk-n-paste-go">' + esc(t('wk.paste.go')) + '</button>' +
          '<span class="tk-msg" id="wk-n-paste-msg" style="color:var(--accent)">' + esc(pasteNote) + '</span></div>' +
      '</details>' : '') +
      (edit && sg.length ? '<div class="wk-sg no-print"><p class="wk-sub">' + esc(t('wk.h.suggest')) +
          (sg.length > 1 ? ' <button class="btn mini" data-wk-sg-all>' + esc(t('wk.b.useAll', { n: sg.length })) + '</button>' : '') + '</p>' +
        sg.map((s, i) => '<div class="tk-row"><span class="wk-kind k-' + esc(s.kind) + '">' + esc(t('wk.kind.' + s.kind)) + '</span> ' +
          (s.priority ? '<span class="wk-prio p-' + esc(s.priority) + '">' + esc(t('wk.prio.' + s.priority)) + '</span> ' : '') +
          '<b>' + esc(s.what) + '</b> — ' + esc(s.why) +
          ' <button class="btn mini ghost" data-wk-sg="' + i + '">' + esc(t('wk.b.useSuggest')) + '</button></div>').join('') + '</div>' : '') +
      '<p class="wk-note">' + esc(t('wk.n.needs')) + '</p>' +
      commentBox('needs', rep) +
    '</section>';
  }

  /* Materials always; the production figures and the product mix only when
     the report is set to show them — they wait for the batch data to be complete. */
  function materialsHTML(F, rep) {
    const b = F.b, cur = F.cur, prev = F.prev;
    const mats = materials(b.S, b.E);
    const entries = materialEntries(b.S, b.E);
    const partial = cur.records > 0 && cur.records < b.days;
    let prodPart = '';
    if (opt('production')) {
      const mix = productMix(b.S, b.E);
      let znLine = '';
      if (cur.zincPerT != null && prev.zincPerT != null) {
        const d = cur.zincPerT - prev.zincPerT;
        znLine = '<p class="wk-note">' + esc(t(Math.abs(d) < 0.05 ? 'wk.zn.same' : d < 0 ? 'wk.zn.lower' : 'wk.zn.higher',
          { a: fmt(cur.zincPerT, 1), b: fmt(prev.zincPerT, 1) })) + '</p>';
      }
      prodPart = (cur.records
          ? '<div class="pt-stats">' +
              stat(t('wk.s.coverage'), cur.records + ' / ' + b.days, partial) +
              stat(t('wk.s.tonnes'), fmt(cur.tonnes, 1) + '<small>t</small>') +
              stat(t('wk.s.zincPerT') + (partial ? ' *' : ''), cur.zincPerT != null ? fmt(cur.zincPerT, 1) + '<small>kg/t</small>' : '—') +
              stat(t('wk.s.dross'), fmt(cur.dross, 0) + '<small>kg</small>') +
            '</div>' + znLine
          : '<div class="lab-empty">' + esc(t('wk.noProduction')) + '</div>') +
        (mix.length ? '<p class="wk-sub">' + esc(t('wk.h.mix')) + '</p><ul class="wk-ul">' +
          mix.slice(0, 6).map(m => '<li><b>' + esc(m.product) + '</b> — ' + fmt(m.kg / 1000, 1) + ' t · ' + esc(t('wk.batches', { n: m.n })) + '</li>').join('') + '</ul>'
          : '<p class="wk-note">' + esc(t('wk.noMix')) + '</p>') +
        '<p class="wk-note">' + esc(t('wk.n.zinc')) + '</p>';
    }

    return '<section class="wk-sec">' +
      '<h3 class="wk-h"><span class="wk-n">4</span>' + esc(t(opt('production') ? 'wk.q5' : 'wk.h.materials')) + '</h3>' +
      prodPart +
      (opt('production') ? '<p class="wk-sub">' + esc(t('wk.h.materials')) + '</p>' : '') +
      (mats.length ? table([t('ac.f.material'), t('wk.col.qty'), t('wk.col.perT'), t('wk.col.source')],
        mats.map(m => '<tr><td class="name">' + esc(matLabel(m.mat)) + '</td><td class="num">' + fmt(m.q) + ' ' + esc(m.unit) + '</td>' +
          '<td class="num">' + (cur.tonnes > 0 ? fmt(m.q / cur.tonnes, 3) + ' ' + esc(m.unit) + '/t' + (partial ? ' *' : '') : '—') + '</td>' +
          '<td>' + esc(Object.keys(m.srcs).map(s => t('wk.src.' + s)).join(' + ')) + '</td></tr>'))
        : '<div class="lab-empty">' + esc(t('wk.noMaterials')) + '</div>') +
      (entries.length ? '<h4 class="wk-sub">' + esc(t('wk.mat.details')) + '</h4>' +
        table([t('wk.mat.date'), t('lab.col.tank'), t('ac.f.material'), t('wk.col.qty'), t('wk.mat.before'), t('wk.mat.after'), t('wk.mat.note')], entries.map(r =>
          '<tr><td class="wk-date">' + esc(r.date) + '</td><td>' + esc(materialTank(r)) + '</td><td>' + esc(matLabel(r.mat)) + '</td><td class="num">' + fmt(r.q) + ' ' + esc(r.unit) +
          '</td><td class="num">' + fmt(r.before) + '</td><td class="num">' + fmt(r.after) + '</td><td class="wk-prose">' + esc(r.note) + '</td></tr>')) +
        '<p class="wk-note">' + esc(t('wk.mat.help')) + '</p>' : '') +
      '<p class="wk-note">' + esc(t('wk.n.money')) + '</p>' +
      commentBox('consumption', rep) +
    '</section>';
  }

  /* What goes in the report: the tanks, and the three parts that are off
     unless asked for. The same choice drives the page, the print and the file. */
  let setOpen = false;
  function settingsHTML() {
    const list = reportTanks();
    return '<details class="wk-set no-print"' + (setOpen ? ' open' : '') + '>' +
      '<summary><b>' + esc(t('wk.set.title')) + '</b> <small>' + esc(t('wk.set.count', { n: shownTanks().length, m: list.length })) + '</small></summary>' +
      '<div class="wk-set-body">' +
        '<p class="wk-sub">' + esc(t('wk.set.tanks')) + '</p>' +
        '<label class="wk-chk wk-chk-all"><input type="checkbox" data-wk-acid' + (acidIn() ? ' checked' : '') + '> ' + esc(t('wk.set.acid')) + '</label>' +
        '<div class="wk-chips">' + list.map(tk =>
          '<label class="wk-chk"><input type="checkbox" data-wk-tank="' + tk.id + '"' + (included(tk.id) ? ' checked' : '') + '> ' + esc(tankName(tk.id)) + '</label>').join('') +
        '</div>' +
        '<p class="wk-sub">' + esc(t('wk.set.parts')) + '</p>' +
        '<div class="wk-chips col">' + OPTIONS.map(k =>
          '<label class="wk-chk"><input type="checkbox" data-wk-opt="' + k + '"' + (opt(k) ? ' checked' : '') + '> ' + esc(t('wk.set.' + k)) + '</label>').join('') +
        '</div>' +
        '<p class="tk-hint">' + esc(t(canEdit() ? 'wk.set.saved' : 'wk.set.local')) + '</p>' +
      '</div>' +
    '</details>';
  }

  const stat = (k, v, hot) =>
    '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';

  function typing(mount) {
    const a = document.activeElement;
    // a ticked box is not typing: the page follows it at once
    return !!(a && mount.contains(a) && (/^(TEXTAREA|SELECT)$/.test(a.tagName) ||
      (a.tagName === 'INPUT' && !/^(checkbox|radio)$/.test(a.type))));
  }

  function render() {
    const mount = document.getElementById('weekly-body');
    if (!mount) return;
    if (typing(mount)) { held = true; return; }
    held = false;
    if (!mount.dataset.wired) {
      mount.dataset.wired = '1';
      mount.addEventListener('focusout', function () {
        setTimeout(function () { if (held && !typing(mount)) render(); }, 0);
      });
    }
    if (!period) period = currentWeek();
    const F = figures(period);
    const b = F.b;
    const key = reportKey(period);
    const rep = reports[key] || {};
    const pick = period.kind === 'month'
      ? '<input type="month" id="wk-start" value="' + b.S.slice(0, 7) + '">'
      : '<input type="date" id="wk-start" value="' + b.S + '">';

    mount.innerHTML =
      '<div class="wk-bar no-print">' +
        '<div class="wk-kinds" role="group">' + PERIOD_KINDS.map(k =>
          '<button class="btn mini' + (period.kind === k ? '' : ' ghost') + '" data-wk-kind="' + k + '">' + esc(t('wk.pk.' + k)) + '</button>').join('') +
        '</div>' +
        '<button class="btn mini ghost" id="wk-prev">' + esc(t('wk.b.prev.' + period.kind)) + '</button>' +
        '<label class="wk-from"><span>' + esc(t('wk.from')) + '</span>' + pick + '</label>' +
        '<button class="btn mini ghost" id="wk-next"' + (shift(period, 1).start > dayKey() ? ' disabled' : '') + '>' + esc(t('wk.b.next.' + period.kind)) + '</button>' +
        '<button class="btn mini ghost" id="wk-today"' + (samePeriod(period, { kind: 'day', start: dayKey() }) ? ' disabled' : '') + '>' +
          esc(t('wk.b.today')) + '</button>' +
        '<span style="flex:1"></span>' +
        '<button class="btn mini ghost" id="wk-current">' + esc(t('wk.currentWeek')) + '</button>' +
        '<button class="btn ghost" id="wk-print"' + (dataReady() ? '' : ' disabled') + '>' + esc(t('wk.b.print')) + '</button>' +
        '<button class="btn" id="wk-excel"' + (dataReady() ? '' : ' disabled') + '>' + esc(t('wk.b.excel')) + '</button>' +
      '</div>' +
      (!dataReady() ? '<p class="wk-note" role="status">' + esc(t(failedSources.size ? 'wk.data.failed' : 'wk.data.loading')) + '</p>' : '') +
      settingsHTML() +
      (exported ? '<div class="wk-mail no-print">' +
        '<p class="wk-sub">' + esc(t('wk.x.done', { f: exported.file })) + '</p>' +
        '<textarea id="wk-mail-text" readonly rows="10">' + esc(exported.text) + '</textarea>' +
        '<div class="tk-actions"><button class="btn mini" id="wk-mail-copy">' + esc(t('wk.x.copy')) + '</button>' +
          '<button class="btn mini ghost" id="wk-mail-close">' + esc(t('wk.x.close')) + '</button>' +
          '<span class="tk-msg" id="wk-mail-msg"></span></div>' +
      '</div>' : '') +
      '<div class="wk-doc">' +
        '<header class="wk-head">' +
          '<h2>' + esc(t('wk.docTitle.' + period.kind)) + '</h2>' +
          '<p class="wk-period">' + esc(periodText(period)) + (b.E >= dayKey() ? ' — ' + esc(t('wk.soFar')) : '') + '</p>' +
          '<p class="wk-meta">' + esc(t('wk.generated', { d: dayKey() })) + ' · ' + esc(t('wk.preparedBy')) + ' ' +
            (canEdit() ? '<input type="text" id="wk-by" class="no-print-input" maxlength="80" value="' + esc(rep.preparedBy || '') + '">' +
              '<input type="text" id="wk-title" class="no-print-input" maxlength="80" placeholder="' + esc(t('wk.jobTitle')) + '" value="' + esc(titleOf(rep)) + '">' : '') +
            '<span class="wk-print-text inline" data-wk-mirror="by">' + esc(rep.preparedBy || '') + (titleOf(rep) ? ', ' + esc(titleOf(rep)) : '') + '</span></p>' +
        '</header>' +
        commentBox('summary', rep) +
        topHTML(F) +
        statusHTML(F, rep) +
        operationsHTML(b) +
        changedHTML(b, rep) +
        needsHTML(b, rep) +
        materialsHTML(F, rep) +
      '</div>';

    wire(mount, key);
  }

  /* ---------------- writes ---------------- */

  function setAcid(on) {
    const up = {};
    ACID_TANKS.forEach(id => { up['tanksOff/' + id] = on ? null : true; });
    setSettings(up);
  }

  function wire(mount, key) {
    const go = p => { period = p; if (document.activeElement) document.activeElement.blur(); render(); };
    const prev = mount.querySelector('#wk-prev'), next = mount.querySelector('#wk-next'), start = mount.querySelector('#wk-start');
    mount.querySelectorAll('[data-wk-kind]').forEach(function (b) {
      b.addEventListener('click', function () {
        const k = b.getAttribute('data-wk-kind');
        if (k !== period.kind) go(k === 'week' ? currentWeek() : defaultPeriod(k));
      });
    });
    if (prev) prev.addEventListener('click', () => go(shift(period, -1)));
    if (next) next.addEventListener('click', () => go(shift(period, 1)));
    const today = mount.querySelector('#wk-today');
    if (today) today.addEventListener('click', () => go({ kind: 'day', start: dayKey() }));
    const current = mount.querySelector('#wk-current');
    if (current) current.addEventListener('click', () => go(currentWeek()));
    if (start) start.addEventListener('change', function () {
      if (period.kind === 'month' && /^\d{4}-\d{2}$/.test(start.value)) go({ kind: 'month', start: start.value + '-01' });
      else if (/^\d{4}-\d{2}-\d{2}$/.test(start.value)) go({ kind: period.kind, start: start.value });
    });

    const set = mount.querySelector('.wk-set');
    if (set) set.addEventListener('toggle', () => { setOpen = set.open; });
    const acid = mount.querySelector('[data-wk-acid]');
    if (acid) {
      acid.indeterminate = !acidIn() && ACID_TANKS.some(included);
      acid.addEventListener('change', function () { setAcid(acid.checked); render(); });
    }
    mount.querySelectorAll('[data-wk-tank]').forEach(function (el) {
      el.addEventListener('change', function () {
        setSettings({ ['tanksOff/' + el.getAttribute('data-wk-tank')]: el.checked ? null : true });
        render();
      });
    });
    mount.querySelectorAll('[data-wk-opt]').forEach(function (el) {
      el.addEventListener('change', function () { setSettings({ [el.getAttribute('data-wk-opt')]: el.checked || null }); render(); });
    });

    const xl = mount.querySelector('#wk-excel');
    if (xl) xl.addEventListener('click', openExport);
    const copy = mount.querySelector('#wk-mail-copy');
    if (copy) copy.addEventListener('click', function () {
      const ta = mount.querySelector('#wk-mail-text');
      copyText(ta ? ta.value : '').then(ok => {
        const m = mount.querySelector('#wk-mail-msg');
        if (m) { m.textContent = ok ? t('wk.x.copied') : t('wk.x.copyFail'); m.style.color = ok ? 'var(--accent)' : 'var(--crit)'; }
      });
    });
    const shut = mount.querySelector('#wk-mail-close');
    if (shut) shut.addEventListener('click', function () { exported = null; render(); });

    const pr = mount.querySelector('#wk-print');
    if (pr) pr.addEventListener('click', function () {
      document.documentElement.classList.add('print-weekly');
      const done = () => { document.documentElement.classList.remove('print-weekly'); window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done);
      window.print();
      setTimeout(done, 1000);
    });

    const base = 'weekly_reports/' + key;
    mount.querySelectorAll('[data-wk-event]').forEach(el => {
      el.addEventListener('input', () => {
        eventDraft = eventDraft || {};
        eventDraft[el.getAttribute('data-wk-event')] = el.value;
      });
    });
    mount.querySelectorAll('[data-wk-event-edit]').forEach(el => el.addEventListener('click', () => {
      const id = el.getAttribute('data-wk-event-edit');
      eventDraft = Object.assign({ _k: id }, events[id]);
      if (document.activeElement) document.activeElement.blur();
      render();
    }));
    const cancelEvent = mount.querySelector('#wk-event-cancel');
    if (cancelEvent) cancelEvent.addEventListener('click', () => { eventDraft = null; if (document.activeElement) document.activeElement.blur(); render(); });
    const saveEvent = mount.querySelector('#wk-event-save');
    if (saveEvent) saveEvent.addEventListener('click', async function () {
      if (!canEdit()) return;
      const rec = {};
      mount.querySelectorAll('[data-wk-event]').forEach(el => { rec[el.getAttribute('data-wk-event')] = el.value.trim(); });
      const msg = mount.querySelector('#wk-event-msg');
      const validDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && dayKey(parse(s)) === s;
      if (!validDay(rec.start) || rec.start > dayKey() || (rec.end && (!validDay(rec.end) || rec.end < rec.start || rec.end > dayKey())) || !rec.title || !rec.action) {
        msg.textContent = t('wk.op.invalid'); return;
      }
      rec.tankId = rec.tankId ? Number(rec.tankId) : null;
      rec.end = rec.end || null;
      rec.updatedAt = Date.now();
      const id = eventDraft && eventDraft._k;
      this.disabled = true;
      try {
        if (id) await database.ref('operational_events/' + id).update(rec);
        else await database.ref('operational_events').push(Object.assign({ createdAt: Date.now() }, rec));
        eventDraft = null;
        if (document.activeElement) document.activeElement.blur();
        render();
      } catch (e) { msg.textContent = t('wk.op.failed'); this.disabled = false; }
    });
    mount.querySelectorAll('[data-wk-c]').forEach(function (ta) {
      const sec = ta.getAttribute('data-wk-c');
      const mirror = mount.querySelector('[data-wk-mirror="' + sec + '"]');
      ta.addEventListener('input', function () {
        if (mirror) mirror.textContent = ta.value;
        const box = ta.closest('.wk-comment');
        if (box) box.classList.toggle('empty', !ta.value.trim());
      });
      ta.addEventListener('change', function () {
        if (!canEdit()) return;
        database.ref(base + '/comments/' + sec).set(ta.value.trim() || null);
      });
    });
    const by = mount.querySelector('#wk-by');
    if (by) {
      const mirror = mount.querySelector('[data-wk-mirror="by"]');
      by.addEventListener('input', () => { if (mirror) mirror.textContent = by.value; });
      by.addEventListener('change', () => { if (canEdit()) database.ref(base + '/preparedBy').set(by.value.trim() || null); });
    }
    const jt = mount.querySelector('#wk-title');
    if (jt) {
      // saved even when emptied, so a cleared title stays cleared instead of the default returning
      jt.addEventListener('change', () => { if (canEdit()) database.ref(base + '/preparedTitle').set(jt.value.trim()); });
    }

    const addNeed = function (rec) {
      if (!canEdit()) return Promise.resolve();
      return database.ref(base + '/needs').push(Object.assign({ ts: Date.now() }, rec));
    };
    const addBtn = mount.querySelector('#wk-n-add');
    if (addBtn) addBtn.addEventListener('click', function () {
      const v = id => ((mount.querySelector(id) || {}).value || '').trim();
      const msg = mount.querySelector('#wk-n-msg');
      if (!v('#wk-n-what') || !v('#wk-n-why')) {
        if (msg) { msg.textContent = t('wk.e.need'); msg.style.color = 'var(--crit)'; }
        return;
      }
      addNeed({ kind: v('#wk-n-kind'), priority: v('#wk-n-prio') || null, what: v('#wk-n-what'), why: v('#wk-n-why'),
        owner: v('#wk-n-owner') || null, due: v('#wk-n-due') || null })
        .then(() => { if (document.activeElement) document.activeElement.blur(); render(); });
    });
    const paste = mount.querySelector('.wk-paste');
    if (paste) paste.addEventListener('toggle', () => { pasteOpen = paste.open; if (!paste.open) pasteNote = ''; });
    const pasteBox = mount.querySelector('#wk-n-paste');
    if (pasteBox) pasteBox.addEventListener('input', () => { pasteText = pasteBox.value; pasteNote = ''; });
    const pasteGo = mount.querySelector('#wk-n-paste-go');
    if (pasteGo) pasteGo.addEventListener('click', function () {
      const ta = mount.querySelector('#wk-n-paste');
      const msg = mount.querySelector('#wk-n-paste-msg');
      const list = parseNeeds(ta ? ta.value : '');
      if (!list.length) {
        if (msg) { msg.textContent = t('wk.paste.none'); msg.style.color = 'var(--crit)'; }
        return;
      }
      pasteGo.disabled = true;
      // one at a time, so they keep the pasted order
      list.reduce((p, n, i) => p.then(() => addNeed(Object.assign(n, { ts: Date.now() + i }))), Promise.resolve())
        .then(function () {
          pasteText = '';
          pasteNote = t('wk.paste.ok', { n: list.length });
          if (document.activeElement) document.activeElement.blur();
          render();
        });
    });
    const sg = pendingSuggestions(reports[key] || {});
    // the owner is kept in English, as the file is
    const fromSuggestion = (x, i) => ({ ts: Date.now() + (i || 0), kind: x.s.kind, priority: x.s.priority || 'medium',
      what: x.s.what, why: x.s.why, whatEn: x.en.what, whyEn: x.en.why, owner: x.en.owner || null, due: x.s.due || null });
    mount.querySelectorAll('[data-wk-sg]').forEach(function (b) {
      b.addEventListener('click', function () {
        const x = sg[Number(b.getAttribute('data-wk-sg'))];
        if (x) addNeed(fromSuggestion(x));
      });
    });
    const sgAll = mount.querySelector('[data-wk-sg-all]');
    if (sgAll) sgAll.addEventListener('click', function () {
      sgAll.disabled = true;
      sg.reduce((p, x, i) => p.then(() => addNeed(fromSuggestion(x, i))), Promise.resolve());
    });
    mount.querySelectorAll('[data-wk-prio]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        if (!canEdit()) return;
        database.ref(base + '/needs/' + sel.getAttribute('data-wk-prio') + '/priority').set(sel.value || null);
        sel.blur();
      });
    });
    mount.querySelectorAll('[data-wk-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!canEdit() || !confirm(t('flux.d.confirmDel'))) return;
        database.ref(base + '/needs/' + b.getAttribute('data-wk-del')).remove();
      });
    });
  }

  /* ---------------- export ---------------- */

  /* Everything the Excel file shows, computed by the same functions that draw
     the page — so the file and the screen cannot disagree. Text comes out in
     whatever language t() is answering in; the export asks for English. */
  function model(p) {
    const F = figures(p), b = F.b, pb = bounds(shift(p, -1));
    const rep = reports[reportKey(p)] || {};
    const A = window.KGCActions;
    const cur = F.cur, prev = F.prev;
    const all = opt('unchanged'), showProd = opt('production');
    const ch = changes(b), mv = ch.mv;
    const st = standing(F.br, b.E);
    const cp = opt('completeness') ? completeness(b.S, b.E, b.days) : null;

    const cardRows = [];
    ch.cards.forEach(function (x) {
      const c = x.c;
      const base = {
        tank: tankName(c.tankId), material: c.action ? A.materialText(c.action) : '—',
        evaluation: c.evaluation ? t('ac.res.' + c.evaluation.result) : t('wk.ev.noEval'),
        result: c.evaluation ? c.evaluation.result : null,
        evalNote: (c.evaluation && c.evaluation.note) || '', stage: t('ac.stage.' + A.stage(c))
      };
      (x.keys.length ? x.keys : [null]).forEach(function (k) {
        cardRows.push(Object.assign({}, base, k == null ? { param: '—' } : {
          param: paramLabel(k),
          before: x.before[k] != null ? Number(x.before[k]) : null,
          after: x.after[k] != null ? Number(x.after[k]) : null,
          afterTier: x.after[k] != null ? evalTier(c.tankId, k, x.after[k]) : 'none'
        }));
      });
    });

    const move = [];
    [['closed', mv.closed], ['opened', mv.opened]].concat(all ? [['still', mv.still]] : []).forEach(function (g) {
      g[1].forEach(x => move.push({ move: g[0], tank: tankName(x.tankId), param: paramLabel(x.key),
        from: x.from, to: x.to, toDate: x.toDate, range: x.range, tier: evalTier(x.tankId, x.key, x.to) }));
    });

    let znNote = null;
    if (cur.zincPerT != null && prev.zincPerT != null) {
      const d = cur.zincPerT - prev.zincPerT;
      znNote = t(Math.abs(d) < 0.05 ? 'wk.zn.same' : d < 0 ? 'wk.zn.lower' : 'wk.zn.higher',
        { a: fmt(cur.zincPerT, 1), b: fmt(prev.zincPerT, 1) });
    }
    const mix = showProd ? productMix(b.S, b.E) : [];
    const mixKg = mix.reduce((s, m) => s + m.kg, 0);
    const dr = cur.drossRate;
    const orNull = (x, v) => x.records ? v : null;

    return {
      kind: p.kind, S: b.S, E: b.E, days: b.days, prevS: pb.S, prevE: pb.E, prevDays: pb.days, generated: dayKey(),
      generatedAt: pad(new Date().getHours()) + ':' + pad(new Date().getMinutes()), open: b.E >= dayKey(),
      preparedBy: rep.preparedBy || '', preparedTitle: titleOf(rep), comments: rep.comments || {},
      options: { completeness: !!cp, unchanged: all, production: showProd },
      kpi: {
        tonnes: { cur: orNull(cur, cur.tonnes), prev: orNull(prev, prev.tonnes) },
        jigs: { cur: cur.jigs, prev: prev.jigs },
        zincKg: { cur: cur.zincKg > 0 ? cur.zincKg : null, prev: prev.zincKg > 0 ? prev.zincKg : null },
        zincPerT: { cur: cur.zincPerT, prev: prev.zincPerT },
        drossExp: { cur: cur.drossExpected, prev: prev.drossExpected },
        tanksOut: { cur: F.out, prev: F.prevOut, of: shownTanks().length }
      },
      dross: { removed: orNull(cur, cur.dross),
        basis: dr ? { rate: dr.rate, n: dr.n, dates: dr.dates, dross: dr.dross, tonnes: dr.tonnes } : null },
      readings: F.rows.length,
      breaches: F.br.map(x => ({ tank: tankName(x.tankId), param: paramLabel(x.key), unit: x.p.unit || '', n: x.n, bad: x.bad, crit: x.crit,
        worst: x.worst, worstDate: x.worstDate, last: x.last, lastDate: x.lastDate, lastTier: x.lastTier, old: x.old,
        range: T() ? T().rangeOf(x.p) : '' })),
      outTanks: outTankIds(F.br).map(tankName),
      inStandard: st.ok.map(x => ({ tank: tankName(x.tankId), date: x.date })),
      noReading: st.none.map(tankName),
      excluded: reportTanks().filter(tk => !included(tk.id)).map(tk => tankName(tk.id)),
      completeness: cp && cp.map(x => ({ tank: tankName(x.tankId),
        schedule: t('wk.every', { n: x.sc.every, p: x.sc.params.map(paramLabel).join(' · ') }),
        expected: x.expected, full: x.full, partial: x.partial, pct: x.pct == null ? null : x.pct / 100 })),
      completenessShare: cp ? completenessShare(cp) : null,
      cards: cardRows,
      treatments: ch.treatments,
      operations: operatingEvents(b.S, b.E),
      currentOutages: currentOutages(b.E),
      quietCards: ch.quiet,
      openCards: A ? A.list().filter(c => c.status !== 'closed' && included(c.tankId)).length : 0,
      movement: move,
      still: all ? [] : mv.still.map(x => ({ tank: tankName(x.tankId), param: paramLabel(x.key) })),
      needs: savedNeeds(rep).map(n => ({ priority: n.priority || '', priorityText: n.priority ? t('wk.prio.' + n.priority) : '',
        kind: t('wk.kind.' + n.kind), what: needText(n, 'what'), why: needText(n, 'why'), owner: n.owner || '', due: n.due || '' })),
      production: { cur: cur, prev: prev, partial: cur.records < b.days },
      znNote: znNote,
      mix: mix.map(m => ({ product: m.product, tonnes: m.kg / 1000, share: mixKg ? m.kg / mixKg : null, n: m.n })),
      materials: materials(b.S, b.E).map(m => ({ name: matLabel(m.mat), q: m.q, unit: m.unit,
        perT: cur.tonnes > 0 ? m.q / cur.tonnes : null, source: Object.keys(m.srcs).map(s => t('wk.src.' + s)).join(' + ') })),
      materialEntries: materialEntries(b.S, b.E).map(r => Object.assign({}, r, { name: matLabel(r.mat), tank: materialTank(r), source: t('wk.src.' + r.src) })),
      notes: { limits: t('wk.n.limits'), full: t('wk.n.full'), zinc: t('wk.n.zinc'), money: t('wk.n.money'),
        partial: cur.records && cur.records < b.days ? t('wk.n.partial', { n: cur.records, d: b.days }) : '' }
    };
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => fallback());
    }
    return Promise.resolve(fallback());
    function fallback() {
      const ta = document.getElementById('wk-mail-text');
      if (!ta) return false;
      ta.focus(); ta.select();
      try { return document.execCommand('copy'); } catch (e) { return false; }
    }
  }

  /** Ask which period to send, then build and download the file. */
  function openExport() {
    const choices = [{ id: 'screen', p: period }];
    if (!samePeriod(period, currentWeek())) choices.push({ id: 'current', p: currentWeek() });
    // today so far, for a report sent before the day is over
    const today = { kind: 'day', start: dayKey() };
    if (!samePeriod(today, period)) choices.push({ id: 'today', p: today });
    ['day', 'week', 'month'].forEach(function (k) {
      const p = defaultPeriod(k);
      if (!samePeriod(p, period)) choices.push({ id: 'last-' + k, p: p });
    });
    const wrap = document.createElement('div');
    wrap.className = 'pt-overlay';
    wrap.innerHTML =
      '<div class="pt-modal">' +
        '<div class="pt-modal-head"><h3>' + esc(t('wk.x.title')) + '</h3>' +
        '<button class="pt-x" data-close aria-label="close">&times;</button></div>' +
        '<div class="pt-modal-body">' +
          '<p class="tk-hint">' + esc(t('wk.x.sub')) + '</p>' +
          '<div class="wk-x-list">' + choices.map((c, i) =>
            '<label class="wk-x-opt"><input type="radio" name="wk-x" value="' + i + '"' + (i ? '' : ' checked') + '>' +
              '<span><b>' + esc(c.id === 'screen' ? t('wk.x.screen') : c.id === 'current' ? t('wk.currentWeek') : c.id === 'today' ? t('wk.x.today') : t('wk.x.last.' + c.p.kind)) + '</b>' +
              '<small>' + esc(t('wk.pk.' + c.p.kind)) + ' · <bdi dir="ltr">' + esc(rangeText(c.p)) + '</bdi></small></span></label>').join('') +
          '</div>' +
          '<label class="wk-chk wk-x-acid"><input type="checkbox" id="wk-x-acid"' + (acidIn() ? ' checked' : '') + '> ' +
            esc(t('wk.x.acid')) + '</label>' +
          '<p class="tk-hint">' + esc(t('wk.x.commentsNote')) + '</p>' +
        '</div>' +
        '<div class="pt-modal-foot">' +
          '<button class="btn" id="wk-x-go">' + esc(t('wk.x.go')) + '</button>' +
          '<button class="btn ghost" data-close>' + esc(t('pt.cancel')) + '</button>' +
          '<span class="tk-msg" id="wk-x-msg"></span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    if (window.KGCWeeklyExportOptions) window.KGCWeeklyExportOptions.mount(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    wrap.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
    // a mixed choice made on the page stays as it is unless the box is touched here
    const acid = wrap.querySelector('#wk-x-acid');
    let acidTouched = false;
    acid.indeterminate = !acidIn() && ACID_TANKS.some(included);
    acid.addEventListener('change', () => { acidTouched = true; });
    wrap.querySelector('#wk-x-go').addEventListener('click', function () {
      if (acidTouched) setAcid(acid.checked);
      const pick = wrap.querySelector('input[name="wk-x"]:checked');
      const c = choices[Number(pick ? pick.value : 0)];
      const msg = wrap.querySelector('#wk-x-msg');
      this.disabled = true;
      // the page moves to the exported period, so what was sent is what is on screen
      period = c.p;
      exportExcel().then(close, function (e) {
        console.error('[weekly] export failed', e);
        if (msg) { msg.textContent = t('wk.x.failed') + ' ' + (e.message || ''); msg.style.color = 'var(--crit)'; }
        wrap.querySelector('#wk-x-go').disabled = false;
      });
    });
  }

  function loadLogo() {
    return fetch('logo.png').then(r => r.ok ? r.arrayBuffer() : null).then(b => b ? new Uint8Array(b) : null).catch(() => null);
  }

  async function exportExcel() {
    if (!dataReady()) throw new Error(t(failedSources.size ? 'wk.data.failed' : 'wk.data.loading'));
    const X = window.KGCWeeklyXlsx;
    if (!X) throw new Error('weekly_xlsx.js not loaded');
    const m = I18N.withLang('en', () => model(period));
    const logo = await loadLogo();
    const out = X.build(m, logo);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out.blob);
    a.download = out.file;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    exported = { file: out.file, text: X.emailText(m) };
    render();
    copyText(exported.text);
    return out;
  }

  /* ---------------- wiring ---------------- */

  function watch(path, assign) {
    pendingSources.add(path);
    database.ref(path).on('value', s => {
      if (assign) assign(s.val() || {});
      pendingSources.delete(path); failedSources.delete(path);
      setTimeout(render, 0);
    }, () => { failedSources.add(path); render(); });
  }
  watch('weekly_reports', v => { reports = v; });
  watch('operational_events', v => { events = v; });
  watch('readings_log', v => { readings = v; });
  watch('renewals', v => { renewals = v; });
  watch('acid_additions', v => { acidAdds = v; });
  watch('flux_treatments', v => { fluxT = v; });
  watch('peroxide_treatments', v => { peroxT = v; });
  watch('flux_salt_additions', v => { saltAdds = v; });
  watch('report_settings', v => { settings = v; });
  // the needs suggestions read calibration and stock through their own pages
  ['actions', 'lab_schedule', 'tanks_data', 'tank_specs', 'zinc_daily', 'production/batches', 'inventory', 'calibration']
    .forEach(p => watch(p));
  if (window.I18N) I18N.onChange(render);
  document.addEventListener('DOMContentLoaded', render);

  window.KGCWeekly = {
    render: render, model: model, exportExcel: exportExcel,
    period: () => period, setPeriod: p => { period = p; render(); },
    defaultPeriod: defaultPeriod, bounds: bounds
  };
})();

