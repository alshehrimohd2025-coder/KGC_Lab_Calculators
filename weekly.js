/* ============================================================
   Weekly report for management
   ------------------------------------------------------------
   Built from the records, not typed up: the readings log, the
   before/after cards, the addition and treatment logs, the
   follow-ups closed on the tasks page, and the production report.
   The engineer reads it, adds a comment under each part and a list
   of what is needed, then prints it (or saves it as PDF).

   It answers four questions, in this order:
     1. How were the baths?   breaches, and how complete the analysis was
     2. What did we do?       additions, treatments, calibration, follow-ups
     3. What changed?         before/after results, problems closed or still open
     4. What do we need?      decision / purchase / maintenance, with why,
                              who and by when

   Two rules it keeps:
     - A lower zinc figure is never called an improvement: it moves with
       the kind of steel put through, so it is shown beside the product mix
       and described only as higher or lower.
     - No money is computed. There is no documented price basis here, and a
       saving figure without one is a guess with a currency sign on it.

   Gaps are said out loud: days with no production data, readings judged
   against today's limits, totals that are estimates.

   Stored at weekly_reports/<weekStart>:
     { preparedBy, comments: { summary, status, done, changed, needs },
       needs: { <pushId>: { kind, what, why, owner, due } } }

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

  let readings = {}, renewals = {}, acidAdds = {}, fluxT = {}, peroxT = {}, saltAdds = {}, bath = {}, calib = {},
      taskLog = {}, taskState = {}, reports = {};
  let weekStart = null;
  let held = false;

  /* ---------------- helpers ---------------- */

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pad = n => (n < 10 ? '0' : '') + n;
  const dayKey = d => { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const parse = s => new Date(s + 'T00:00:00');
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return dayKey(d); };
  const canEdit = () => (typeof IS_EDITOR !== 'undefined' && IS_EDITOR) &&
                        (typeof IS_AUTHED !== 'undefined' && IS_AUTHED);
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const fmt = (v, d) => (v == null || !isFinite(v)) ? '—'
    : Number(v).toLocaleString(undefined, { maximumFractionDigits: d == null ? 2 : d, minimumFractionDigits: 0 });
  const tankById = id => (typeof tanks !== 'undefined' ? tanks.find(x => x.id === Number(id)) : null);
  const tankName = id => { const tk = tankById(id); return tk ? tankLabel(tk.name) : (id == null ? '—' : String(id)); };
  const T = () => window.KGCTasks;
  const paramLabel = k => (T() ? T().paramLabel(k) : k);
  const tsDay = ts => { const n = typeof ts === 'number' ? ts : Date.parse(ts); return isFinite(n) ? dayKey(new Date(n)) : ''; };
  const inWeek = (d, S, E) => !!d && d >= S && d <= E;
  const values = o => Object.keys(o || {}).map(k => Object.assign({ _k: k }, o[k])).filter(Boolean);

  function measurable(tankId) { return T() ? T().measurable(tankId) : []; }

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

  function weekRows(S, E) {
    return values(readings).filter(r => inWeek(r.date, S, E));
  }

  function breaches(rows) {
    const out = [];
    if (typeof tanks === 'undefined') return out;
    tanks.slice().sort((a, b) => a.id - b.id).forEach(function (tk) {
      measurable(tk.id).forEach(function (p) {
        const pts = rows.filter(r => Number(r.tankId) === tk.id && r[p.key] != null && r[p.key] !== '' && Number(r[p.key]) !== 0)
          .sort((a, b) => a.date < b.date ? -1 : 1);
        if (!pts.length) return;
        const bad = pts.filter(r => ['warn', 'crit'].indexOf(evalTier(tk.id, p.key, r[p.key])) !== -1);
        if (!bad.length) return;
        const worst = bad.slice().sort((a, b) => outside(p, Number(b[p.key])) - outside(p, Number(a[p.key])))[0];
        const last = pts[pts.length - 1];
        out.push({
          tankId: tk.id, key: p.key, p: p, n: pts.length, bad: bad.length,
          crit: bad.filter(r => evalTier(tk.id, p.key, r[p.key]) === 'crit').length,
          worst: Number(worst[p.key]), worstDate: worst.date,
          last: Number(last[p.key]), lastDate: last.date, lastTier: evalTier(tk.id, p.key, last[p.key])
        });
      });
    });
    return out.sort((a, b) => b.crit - a.crit || b.bad - a.bad);
  }

  function completeness(rows) {
    const out = [];
    if (typeof tanks === 'undefined' || !T()) return out;
    tanks.slice().sort((a, b) => a.id - b.id).forEach(function (tk) {
      const sc = T().scheduleFor(tk.id);
      if (sc.off || !sc.params.length) return;
      const expected = Math.max(1, Math.floor(7 / sc.every));
      let full = 0, partial = 0;
      rows.filter(r => Number(r.tankId) === tk.id).forEach(function (r) {
        const have = sc.params.filter(k => r[k] != null && r[k] !== '').length;
        if (have === sc.params.length) full++;
        else if (have > 0) partial++;
      });
      out.push({ tankId: tk.id, sc: sc, expected: expected, full: full, partial: partial,
        pct: Math.min(100, Math.round(full / expected * 100)) });
    });
    return out;
  }

  /* ---------------- 2. what was done ---------------- */

  function events(S, E) {
    const out = [];
    const A = window.KGCActions;
    const add = (date, tankId, type, detail, card) => out.push({ date: date, tankId: tankId, type: type, detail: detail, card: !!card });

    if (A) A.list().forEach(function (c) {
      const a = c.action;
      if (!a || !inWeek(String(a.at || '').slice(0, 10), S, E)) return;
      const sug = a.suggestedQty != null ? t('wk.ev.suggested', { q: fmt(a.suggestedQty) + ' ' + (a.suggestedUnit || '') }) : '';
      add(String(a.at).slice(0, 10), c.tankId, t('wk.type.card'),
        A.materialText(a) + ' — ' + t('wk.ev.actual', { q: fmt(a.actualQty) + ' ' + (a.actualUnit || '') }) +
        (sug ? ' · ' + sug : '') + (c.evaluation ? ' · ' + t('ac.res.' + c.evaluation.result) : ' · ' + t('wk.ev.noEval')), true);
    });
    values(renewals).forEach(function (r) {
      if (!inWeek(r.date, S, E)) return;
      add(r.date, r.tankId, t('lab.type.' + r.type), (r.qty ? fmt(r.qty) + ' ' + (r.unit || '') : '') + (r.note ? ' — ' + r.note : ''));
    });
    values(acidAdds).forEach(function (r) {
      if (!inWeek(r.date, S, E)) return;
      add(r.date, r.tankId, t('wk.type.acid'), fmt(r.tons) + ' t' +
        (r.before != null ? ' · ' + t('wk.ev.before', { v: fmt(r.before) + '%' }) : '') + (r.operator ? ' · ' + r.operator : ''));
    });
    values(fluxT).forEach(function (r) {
      if (!inWeek(r.date, S, E)) return;
      add(r.date, 10, t('wk.type.ammonia'), fmt(r.liters) + ' L · pH ' + fmt(r.phBefore) + ' → ' + fmt(r.phAfter) + (r.operator ? ' · ' + r.operator : ''));
    });
    values(peroxT).forEach(function (r) {
      if (!inWeek(r.date, S, E)) return;
      add(r.date, 10, t('wk.type.peroxide'), fmt(r.liters) + ' L · Fe ' + fmt(r.feBefore) + ' → ' + fmt(r.feAfter) + ' g/L' + (r.operator ? ' · ' + r.operator : ''));
    });
    values(saltAdds).forEach(function (r) {
      if (!inWeek(r.date, S, E)) return;
      add(r.date, 10, t('wk.type.salt'), fmt(r.kg) + ' kg' +
        (r.beBefore != null ? ' · Bé ' + fmt(r.beBefore) + ' → ' + (r.beAfter != null ? fmt(r.beAfter) : '?') : ''));
    });
    values(bath).forEach(function (r) {
      if (!inWeek(r.date, S, E)) return;
      add(r.date, 12, t('wk.type.bath'), t('wk.ev.bath'));
    });
    Object.keys(calib).forEach(function (k) {
      const r = calib[k];
      if (!r || !inWeek(r.last, S, E)) return;
      add(r.last, null, t('wk.type.calib'), t('kettle.inst.' + k) + (r.due ? ' · ' + t('wk.ev.nextDue', { d: r.due }) : '') + (r.by ? ' · ' + r.by : ''));
    });
    return out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  }

  function followUps(S, E) {
    const done = values(taskLog).filter(r => inWeek(tsDay(r.ts), S, E));
    const byKind = {};
    done.forEach(r => { byKind[r.kind] = (byKind[r.kind] || 0) + 1; });
    const postponed = values(taskState).filter(r => r.status === 'postponed' && inWeek(tsDay(r.ts), S, E));
    return { done: done, byKind: byKind, postponed: postponed };
  }

  /* ---------------- 3. what changed ---------------- */

  /** Each parameter's standing at the start of the week against its end. */
  function issueMovement(S, E) {
    const out = { closed: [], opened: [], still: [] };
    if (typeof tanks === 'undefined') return out;
    const all = values(readings);
    tanks.slice().sort((a, b) => a.id - b.id).forEach(function (tk) {
      measurable(tk.id).forEach(function (p) {
        const pts = all.filter(r => Number(r.tankId) === tk.id && r[p.key] != null && r[p.key] !== '' && Number(r[p.key]) !== 0)
          .sort((a, b) => a.date < b.date ? -1 : 1);
        const startPt = pts.filter(r => r.date < S).pop();
        const endPt = pts.filter(r => r.date <= E).pop();
        if (!endPt) return;
        const bad = r => r && ['warn', 'crit'].indexOf(evalTier(tk.id, p.key, r[p.key])) !== -1;
        const item = { tankId: tk.id, key: p.key, from: startPt ? Number(startPt[p.key]) : null,
          to: Number(endPt[p.key]), toDate: endPt.date, range: T() ? T().rangeOf(p) : '' };
        if (bad(startPt) && !bad(endPt)) out.closed.push(item);
        else if (!bad(startPt) && bad(endPt) && endPt.date >= S) out.opened.push(item);
        else if (bad(startPt) && bad(endPt)) out.still.push(item);
      });
    });
    return out;
  }

  function cardResults(S, E) {
    const A = window.KGCActions;
    if (!A) return [];
    return A.list().filter(function (c) {
      const actDay = c.action ? String(c.action.at || '').slice(0, 10) : '';
      const afterIn = A.aftersOf(c).some(x => inWeek(String(x.at || '').slice(0, 10), S, E));
      return inWeek(actDay, S, E) || afterIn;
    });
  }

  /* ---------------- 4. needs ---------------- */

  function suggestions() {
    const out = [];
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

  /* ---------------- production and consumption ---------------- */

  function production(S, E) {
    const Z = window.KGCZinc;
    const days = Object.values((Z && Z._days && Z._days()) || {}).filter(d => d && inWeek(d.date, S, E));
    let kg = 0, zn = 0, dross = 0, release = 0, prodDays = 0;
    days.forEach(function (d) {
      const k = num(d.dayTon) + num(d.nightTon);
      kg += k;
      zn += num(d.dayPct) / 100 * num(d.dayTon) + num(d.nightPct) / 100 * num(d.nightTon);
      dross += num(d.dross); release += num(d.release);
      if (k > 0) prodDays++;
    });
    return { records: days.length, prodDays: prodDays, tonnes: kg / 1000, zincKg: zn,
      zincPerT: kg > 0 && zn > 0 ? zn / kg * 1000 : null, dross: dross, release: release };
  }

  /** Steel put through, by product, from the batch tracker. */
  function productMix(S, E) {
    const P = window.KGCProduction;
    if (!P || !P._batches) return [];
    const by = {};
    Object.values(P._batches() || {}).forEach(function (b) {
      if (!b || !inWeek(tsDay(b.startTs), S, E)) return;
      const k = b.product || '—';
      by[k] = by[k] || { product: k, kg: 0, n: 0 };
      by[k].kg += num(b.weight); by[k].n++;
    });
    return Object.values(by).sort((a, b) => b.kg - a.kg);
  }

  /* Materials put into the baths. The logs on the flux and pickling pages are
     the plant's own record, so they come first; a before/after card adds its
     quantity only when no log entry already covers the same tank and day. */
  function materials(S, E) {
    const tot = {};
    const add = (mat, unit, q, src) => {
      if (!(q > 0)) return;
      const k = mat + '|' + unit;
      tot[k] = tot[k] || { mat: mat, unit: unit, q: 0, srcs: {} };
      tot[k].q += q; tot[k].srcs[src] = 1;
    };
    const logged = {};
    const mark = (mat, tankId, date) => { logged[mat + '|' + tankId + '|' + date] = 1; };
    values(acidAdds).forEach(r => { if (inWeek(r.date, S, E)) { add('hcl', 't', num(r.tons), 'log'); mark('hcl', r.tankId, r.date); } });
    values(renewals).forEach(r => {
      if (inWeek(r.date, S, E) && r.type === 'addition') { add('hcl', r.unit || 'L', num(r.qty), 'log'); mark('hcl', r.tankId, r.date); }
    });
    values(fluxT).forEach(r => { if (inWeek(r.date, S, E)) { add('ammonia', 'L', num(r.liters), 'log'); mark('ammonia', 10, r.date); } });
    values(peroxT).forEach(r => { if (inWeek(r.date, S, E)) { add('peroxide', 'L', num(r.liters), 'log'); mark('peroxide', 10, r.date); } });
    values(saltAdds).forEach(r => { if (inWeek(r.date, S, E)) { add('flux_salt', 'kg', num(r.kg), 'log'); mark('flux_salt', 10, r.date); } });
    const A = window.KGCActions;
    if (A) A.list().forEach(function (c) {
      const a = c.action;
      const d = a ? String(a.at || '').slice(0, 10) : '';
      if (!a || !inWeek(d, S, E) || logged[a.material + '|' + c.tankId + '|' + d]) return;
      add(a.material === 'other' ? (a.materialOther || 'other') : a.material, a.actualUnit || '', num(a.actualQty), 'card');
    });
    return Object.values(tot);
  }

  function matLabel(m) {
    const k = 'lab.item.' + m;
    if (t(k) !== k) return t(k);
    const k2 = 'ac.mat.' + m;
    return t(k2) !== k2 ? t(k2) : m;
  }

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

  function statusHTML(S, E, rep) {
    const rows = weekRows(S, E);
    const br = breaches(rows);
    const cp = completeness(rows);
    const exp = cp.reduce((s, x) => s + x.expected, 0);
    const got = cp.reduce((s, x) => s + Math.min(x.full, x.expected), 0);
    const overall = exp ? Math.round(got / exp * 100) : null;

    const brTable = br.length ? table(
      [t('lab.col.tank'), t('spec.param'), t('wk.col.outOf'), t('wk.col.worst'), t('wk.col.last'), t('ac.col.range')],
      br.map(x => '<tr><td class="name">' + esc(tankName(x.tankId)) + '</td><td>' + esc(paramLabel(x.key)) + '</td>' +
        '<td class="num">' + x.bad + ' / ' + x.n + (x.crit ? ' <small style="color:var(--crit)">(' + esc(t('wk.critN', { n: x.crit })) + ')</small>' : '') + '</td>' +
        '<td class="num">' + tv(x.tankId, x.key, x.worst) + ' <small>' + esc(x.worstDate) + '</small></td>' +
        '<td class="num">' + tv(x.tankId, x.key, x.last) + ' <small>' + esc(x.lastDate) + '</small></td>' +
        '<td class="num" dir="ltr">' + esc(T() ? T().rangeOf(x.p) : '') + '</td></tr>'))
      : '<div class="att-clear"><span class="att-ok">✓</span>' + esc(t(rows.length ? 'wk.noBreach' : 'wk.noReadings')) + '</div>';

    const cpTable = cp.length ? table(
      [t('lab.col.tank'), t('wk.col.schedule'), t('wk.col.expected'), t('wk.col.full'), t('wk.col.partial'), t('wk.col.pct')],
      cp.map(x => '<tr><td class="name">' + esc(tankName(x.tankId)) + '</td>' +
        '<td>' + esc(t('wk.every', { n: x.sc.every, p: x.sc.params.map(paramLabel).join(' · ') })) + '</td>' +
        '<td class="num">' + x.expected + '</td><td class="num">' + x.full + '</td><td class="num">' + x.partial + '</td>' +
        '<td class="num"><b style="color:' + (x.pct >= 100 ? 'var(--accent)' : x.pct >= 50 ? 'var(--warn)' : 'var(--crit)') + '">' + x.pct + '%</b></td></tr>'))
      : '';

    return '<section class="wk-sec">' +
      '<h3 class="wk-h"><span class="wk-n">1</span>' + esc(t('wk.q1')) + '</h3>' +
      '<div class="pt-stats">' +
        stat(t('wk.s.breachParams'), br.length, br.length > 0) +
        stat(t('wk.s.critReadings'), br.reduce((s, x) => s + x.crit, 0), br.some(x => x.crit)) +
        stat(t('wk.s.readings'), rows.length) +
        stat(t('wk.s.complete'), overall == null ? '—' : overall + '%', overall != null && overall < 80) +
      '</div>' +
      '<p class="wk-sub">' + esc(t('wk.h.breaches')) + '</p>' + brTable +
      '<p class="wk-sub">' + esc(t('wk.h.complete')) + '</p>' + cpTable +
      '<p class="wk-note">' + esc(t('wk.n.limits')) + '</p>' +
      commentBox('status', rep) +
    '</section>';
  }

  function doneHTML(S, E, rep) {
    const ev = events(S, E);
    const fu = followUps(S, E);
    const maint = (typeof tanks !== 'undefined' ? tanks : []).filter(tk => tk.status === 'maintenance' || tk.status === 'out_of_service');
    const kinds = Object.keys(fu.byKind).map(k => t('tk.kind.' + k) + ' ' + fu.byKind[k]).join(' · ');
    return '<section class="wk-sec">' +
      '<h3 class="wk-h"><span class="wk-n">2</span>' + esc(t('wk.q2')) + '</h3>' +
      '<div class="pt-stats">' +
        stat(t('wk.s.events'), ev.length) +
        stat(t('wk.s.cards'), ev.filter(x => x.card).length) +
        stat(t('wk.s.followups'), fu.done.length) +
        stat(t('wk.s.postponed'), fu.postponed.length, fu.postponed.length > 0) +
      '</div>' +
      (ev.length ? table([t('lab.col.date'), t('lab.col.tank'), t('lab.col.type'), t('wk.col.detail')],
        ev.map(x => '<tr><td class="num">' + esc(x.date) + '</td><td class="name">' + esc(x.tankId != null ? tankName(x.tankId) : '—') + '</td>' +
          '<td>' + esc(x.type) + '</td><td>' + esc(x.detail) + '</td></tr>'))
        : '<div class="lab-empty">' + esc(t('wk.noEvents')) + '</div>') +
      (fu.done.length ? '<p class="wk-sub">' + esc(t('wk.h.followups', { n: fu.done.length })) + (kinds ? ' — ' + esc(kinds) : '') + '</p>' : '') +
      (fu.postponed.length ? '<p class="wk-sub">' + esc(t('wk.h.postponed')) + '</p><ul class="wk-ul">' +
        fu.postponed.map(r => '<li><b>' + esc(r.title || '') + '</b> — ' + esc(r.reason || '') + ' <small>(' + esc(t('wk.ppUntil', { d: r.until })) + ')</small></li>').join('') + '</ul>' : '') +
      (maint.length ? '<p class="wk-sub">' + esc(t('wk.h.maintNow')) + '</p><ul class="wk-ul">' +
        maint.map(tk => '<li><b>' + esc(tankName(tk.id)) + '</b> — ' + esc(t('st.' + tk.status)) + (tk.note ? ' · ' + esc(tk.note) : '') + '</li>').join('') + '</ul>' : '') +
      '<p class="wk-note">' + esc(t('wk.n.maint')) + '</p>' +
      commentBox('done', rep) +
    '</section>';
  }

  function changedHTML(S, E, rep) {
    const A = window.KGCActions;
    const cards = cardResults(S, E);
    const mv = issueMovement(S, E);
    const cardRows = cards.map(function (c) {
      const before = (c.before && c.before.readings) || {};
      const after = A.mergedAfter(c);
      const keys = Object.keys(before).filter(k => after[k] != null);
      const diff = keys.length
        ? keys.map(k => esc(paramLabel(k)) + ' <span dir="ltr">' + tv(c.tankId, k, before[k]) + ' → ' + tv(c.tankId, k, after[k]) + '</span>').join('<br>')
        : '<span class="ac-none">' + esc(t('ac.none.after')) + '</span>';
      const ev = c.evaluation ? t('ac.res.' + c.evaluation.result) : t('wk.ev.noEval');
      return '<tr><td class="name">' + esc(tankName(c.tankId)) + '</td><td>' + esc(c.action ? A.materialText(c.action) : '—') + '</td>' +
        '<td>' + diff + '</td><td>' + esc(ev) + (c.evaluation && c.evaluation.note ? '<br><small>' + esc(c.evaluation.note) + '</small>' : '') + '</td>' +
        '<td>' + esc(t('ac.stage.' + A.stage(c))) + '</td></tr>';
    });
    const mvList = (arr, cls) => arr.map(x => '<li class="' + cls + '"><b>' + esc(tankName(x.tankId)) + '</b> · ' + esc(paramLabel(x.key)) + ' ' +
      '<span dir="ltr">' + (x.from != null ? tv(x.tankId, x.key, x.from) + ' → ' : '') + tv(x.tankId, x.key, x.to) + '</span>' +
      ' <small dir="ltr">(' + esc(x.range) + ')</small> <small>' + esc(x.toDate) + '</small></li>').join('');
    const openNow = A ? A.list().filter(c => c.status !== 'closed').length : 0;
    return '<section class="wk-sec">' +
      '<h3 class="wk-h"><span class="wk-n">3</span>' + esc(t('wk.q3')) + '</h3>' +
      '<div class="pt-stats">' +
        stat(t('wk.s.closed'), mv.closed.length) +
        stat(t('wk.s.opened'), mv.opened.length, mv.opened.length > 0) +
        stat(t('wk.s.still'), mv.still.length, mv.still.length > 0) +
        stat(t('wk.s.openCards'), openNow) +
      '</div>' +
      '<p class="wk-sub">' + esc(t('wk.h.cards')) + '</p>' +
      (cardRows.length ? table([t('lab.col.tank'), t('ac.f.material'), t('wk.col.beforeAfter'), t('ac.st.eval'), t('ac.col.status')], cardRows)
        : '<div class="lab-empty">' + esc(t('wk.noCards')) + '</div>') +
      '<p class="wk-sub">' + esc(t('wk.h.movement')) + '</p>' +
      ((mv.closed.length + mv.opened.length + mv.still.length)
        ? '<ul class="wk-ul wk-mv">' +
            (mv.closed.length ? '<li class="wk-mv-h">' + esc(t('wk.mv.closed')) + '</li>' + mvList(mv.closed, 'ok') : '') +
            (mv.opened.length ? '<li class="wk-mv-h">' + esc(t('wk.mv.opened')) + '</li>' + mvList(mv.opened, 'bad') : '') +
            (mv.still.length ? '<li class="wk-mv-h">' + esc(t('wk.mv.still')) + '</li>' + mvList(mv.still, 'bad') : '') +
          '</ul>'
        : '<div class="lab-empty">' + esc(t('wk.noMovement')) + '</div>') +
      commentBox('changed', rep) +
    '</section>';
  }

  function needsHTML(S, E, rep) {
    const saved = values(rep.needs).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const edit = canEdit();
    const sg = suggestions().filter(s => !saved.some(n => n.what === s.what));
    return '<section class="wk-sec">' +
      '<h3 class="wk-h"><span class="wk-n">4</span>' + esc(t('wk.q4')) + '</h3>' +
      (saved.length ? table([t('wk.col.kind'), t('wk.col.what'), t('wk.col.why'), t('wk.col.owner'), t('wk.col.due')].concat(edit ? [''] : []),
        saved.map(n => '<tr><td><span class="wk-kind k-' + esc(n.kind) + '">' + esc(t('wk.kind.' + n.kind)) + '</span></td>' +
          '<td class="name">' + esc(n.what) + '</td><td>' + esc(n.why || '') + '</td><td>' + esc(n.owner || '—') + '</td>' +
          '<td class="num">' + esc(n.due || '—') + '</td>' +
          (edit ? '<td><button class="btn mini danger" data-wk-del="' + esc(n._k) + '">' + esc(t('lab.delete')) + '</button></td>' : '') + '</tr>'))
        : '<div class="lab-empty">' + esc(t('wk.noNeeds')) + '</div>') +
      (edit ? '<div class="lab-form wk-needform">' +
        '<div><label>' + esc(t('wk.col.kind')) + '</label><select id="wk-n-kind">' +
          NEED_KINDS.map(k => '<option value="' + k + '">' + esc(t('wk.kind.' + k)) + '</option>').join('') + '</select></div>' +
        '<div><label>' + esc(t('wk.col.what')) + '</label><input type="text" id="wk-n-what" maxlength="160"></div>' +
        '<div><label>' + esc(t('wk.col.why')) + '</label><input type="text" id="wk-n-why" maxlength="240"></div>' +
        '<div><label>' + esc(t('wk.col.owner')) + '</label><input type="text" id="wk-n-owner" maxlength="80"></div>' +
        '<div><label>' + esc(t('wk.col.due')) + '</label><input type="date" id="wk-n-due"></div>' +
        '<div><button class="btn" id="wk-n-add" style="width:100%;justify-content:center">' + esc(t('wk.b.addNeed')) + '</button></div>' +
        '<span class="tk-msg" id="wk-n-msg"></span>' +
      '</div>' : '') +
      (edit && sg.length ? '<div class="wk-sg no-print"><p class="wk-sub">' + esc(t('wk.h.suggest')) + '</p>' +
        sg.map((s, i) => '<div class="tk-row"><span class="wk-kind k-' + esc(s.kind) + '">' + esc(t('wk.kind.' + s.kind)) + '</span> <b>' + esc(s.what) + '</b> — ' + esc(s.why) +
          ' <button class="btn mini ghost" data-wk-sg="' + i + '">' + esc(t('wk.b.useSuggest')) + '</button></div>').join('') + '</div>' : '') +
      '<p class="wk-note">' + esc(t('wk.n.needs')) + '</p>' +
      commentBox('needs', rep) +
    '</section>';
  }

  function consumptionHTML(S, E, rep) {
    const cur = production(S, E);
    const prev = production(addDays(S, -7), addDays(S, -1));
    const mix = productMix(S, E);
    const mats = materials(S, E);
    const partial = cur.records < 7;

    let znLine = '';
    if (cur.zincPerT != null && prev.zincPerT != null) {
      const d = cur.zincPerT - prev.zincPerT;
      znLine = '<p class="wk-note">' + esc(t(Math.abs(d) < 0.05 ? 'wk.zn.same' : d < 0 ? 'wk.zn.lower' : 'wk.zn.higher',
        { a: fmt(cur.zincPerT, 1), b: fmt(prev.zincPerT, 1) })) + '</p>';
    }

    return '<section class="wk-sec">' +
      '<h3 class="wk-h"><span class="wk-n">+</span>' + esc(t('wk.q5')) + '</h3>' +
      (cur.records
        ? '<div class="pt-stats">' +
            stat(t('wk.s.coverage'), cur.records + ' / 7', partial) +
            stat(t('wk.s.tonnes'), fmt(cur.tonnes, 1) + '<small>t</small>') +
            stat(t('wk.s.zincPerT') + (partial ? ' *' : ''), cur.zincPerT != null ? fmt(cur.zincPerT, 1) + '<small>kg/t</small>' : '—') +
            stat(t('wk.s.dross'), fmt(cur.dross, 0) + '<small>kg</small>') +
          '</div>' + znLine
        : '<div class="lab-empty">' + esc(t('wk.noProduction')) + '</div>') +
      (mix.length ? '<p class="wk-sub">' + esc(t('wk.h.mix')) + '</p><ul class="wk-ul">' +
        mix.slice(0, 6).map(m => '<li><b>' + esc(m.product) + '</b> — ' + fmt(m.kg / 1000, 1) + ' t · ' + esc(t('wk.batches', { n: m.n })) + '</li>').join('') + '</ul>'
        : '<p class="wk-note">' + esc(t('wk.noMix')) + '</p>') +
      '<p class="wk-sub">' + esc(t('wk.h.materials')) + '</p>' +
      (mats.length ? table([t('ac.f.material'), t('wk.col.qty'), t('wk.col.perT'), t('wk.col.source')],
        mats.map(m => '<tr><td class="name">' + esc(matLabel(m.mat)) + '</td><td class="num">' + fmt(m.q) + ' ' + esc(m.unit) + '</td>' +
          '<td class="num">' + (cur.tonnes > 0 ? fmt(m.q / cur.tonnes, 3) + ' ' + esc(m.unit) + '/t' + (partial ? ' *' : '') : '—') + '</td>' +
          '<td>' + esc(Object.keys(m.srcs).map(s => t('wk.src.' + s)).join(' + ')) + '</td></tr>'))
        : '<div class="lab-empty">' + esc(t('wk.noMaterials')) + '</div>') +
      (partial && cur.records ? '<p class="wk-note">' + esc(t('wk.n.partial', { n: cur.records })) + '</p>' : '') +
      '<p class="wk-note">' + esc(t('wk.n.zinc')) + '</p>' +
      '<p class="wk-note">' + esc(t('wk.n.money')) + '</p>' +
      commentBox('consumption', rep) +
    '</section>';
  }

  const stat = (k, v, hot) =>
    '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';

  function typing(mount) {
    const a = document.activeElement;
    return !!(a && mount.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
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
    if (!weekStart) weekStart = addDays(dayKey(), -6);
    const S = weekStart, E = addDays(S, 6);
    const rep = reports[S] || {};

    mount.innerHTML =
      '<div class="wk-bar no-print">' +
        '<button class="btn mini ghost" id="wk-prev">' + esc(t('wk.b.prev')) + '</button>' +
        '<label class="wk-from"><span>' + esc(t('wk.from')) + '</span><input type="date" id="wk-start" value="' + S + '"></label>' +
        '<button class="btn mini ghost" id="wk-next"' + (E >= dayKey() ? ' disabled' : '') + '>' + esc(t('wk.b.next')) + '</button>' +
        '<span style="flex:1"></span>' +
        '<button class="btn" id="wk-print">' + esc(t('wk.b.print')) + '</button>' +
      '</div>' +
      '<div class="wk-doc">' +
        '<header class="wk-head">' +
          '<h2>' + esc(t('wk.docTitle')) + '</h2>' +
          '<p class="wk-period">' + esc(t('wk.period', { a: S, b: E })) + '</p>' +
          '<p class="wk-meta">' + esc(t('wk.generated', { d: dayKey() })) + ' · ' + esc(t('wk.preparedBy')) + ' ' +
            (canEdit() ? '<input type="text" id="wk-by" class="no-print-input" maxlength="80" value="' + esc(rep.preparedBy || '') + '">' : '') +
            '<span class="wk-print-text inline" data-wk-mirror="by">' + esc(rep.preparedBy || '') + '</span></p>' +
        '</header>' +
        commentBox('summary', rep) +
        statusHTML(S, E, rep) +
        doneHTML(S, E, rep) +
        changedHTML(S, E, rep) +
        needsHTML(S, E, rep) +
        consumptionHTML(S, E, rep) +
      '</div>';

    wire(mount, S);
  }

  /* ---------------- writes ---------------- */

  function wire(mount, S) {
    const go = d => { weekStart = d; if (document.activeElement) document.activeElement.blur(); render(); };
    const prev = mount.querySelector('#wk-prev'), next = mount.querySelector('#wk-next'), start = mount.querySelector('#wk-start');
    if (prev) prev.addEventListener('click', () => go(addDays(S, -7)));
    if (next) next.addEventListener('click', () => go(addDays(S, 7)));
    if (start) start.addEventListener('change', () => { if (/^\d{4}-\d{2}-\d{2}$/.test(start.value)) go(start.value); });

    const pr = mount.querySelector('#wk-print');
    if (pr) pr.addEventListener('click', function () {
      document.documentElement.classList.add('print-weekly');
      const done = () => { document.documentElement.classList.remove('print-weekly'); window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done);
      window.print();
      setTimeout(done, 1000);
    });

    const base = 'weekly_reports/' + S;
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
      addNeed({ kind: v('#wk-n-kind'), what: v('#wk-n-what'), why: v('#wk-n-why'),
        owner: v('#wk-n-owner') || null, due: v('#wk-n-due') || null })
        .then(() => { if (document.activeElement) document.activeElement.blur(); render(); });
    });
    const sg = suggestions().filter(s => !Object.values((reports[S] || {}).needs || {}).some(n => n && n.what === s.what));
    mount.querySelectorAll('[data-wk-sg]').forEach(function (b) {
      b.addEventListener('click', function () {
        const s = sg[Number(b.getAttribute('data-wk-sg'))];
        if (s) addNeed({ kind: s.kind, what: s.what, why: s.why, owner: null, due: s.due || null });
      });
    });
    mount.querySelectorAll('[data-wk-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!canEdit() || !confirm(t('flux.d.confirmDel'))) return;
        database.ref(base + '/needs/' + b.getAttribute('data-wk-del')).remove();
      });
    });
  }

  /* ---------------- wiring ---------------- */

  const later = () => setTimeout(render, 0);
  database.ref('weekly_reports').on('value', s => { reports = s.val() || {}; render(); });
  database.ref('readings_log').on('value', s => { readings = s.val() || {}; render(); });
  database.ref('renewals').on('value', s => { renewals = s.val() || {}; render(); });
  database.ref('acid_additions').on('value', s => { acidAdds = s.val() || {}; render(); });
  database.ref('flux_treatments').on('value', s => { fluxT = s.val() || {}; render(); });
  database.ref('peroxide_treatments').on('value', s => { peroxT = s.val() || {}; render(); });
  database.ref('flux_salt_additions').on('value', s => { saltAdds = s.val() || {}; render(); });
  database.ref('zinc_bath').on('value', s => { bath = s.val() || {}; render(); });
  database.ref('calibration').on('value', s => { calib = s.val() || {}; render(); });
  database.ref('lab_tasks_log').on('value', s => { taskLog = s.val() || {}; render(); });
  database.ref('lab_tasks').on('value', s => { taskState = s.val() || {}; render(); });
  ['actions', 'lab_schedule', 'tanks_data', 'tank_specs', 'zinc_daily', 'production/batches', 'inventory']
    .forEach(p => database.ref(p).on('value', later));
  if (window.I18N) I18N.onChange(render);
  document.addEventListener('DOMContentLoaded', render);

  window.KGCWeekly = { render: render };
})();
