/* ============================================================
   "My tasks today" — the lab engineer's home page
   ------------------------------------------------------------
   Each record already lived on its own page (readings, additions,
   calibration, before/after cards), so a follow-up was only found
   by someone remembering to go and look. This page builds the day's
   list from those records, ranks it, and lets each item be closed
   where it is listed: enter the result, or postpone it with a reason.

   Three kinds of item are kept apart on purpose:
     measure  — a sample is due by the analysis schedule. A missing
                reading is a job to do, never a judgement on the bath.
     review   — a reading that cannot be trusted as it stands: out of
                range but old, or a jump no working bath can make.
     breach   — a recent reading outside the standard. Only this kind
                is a confirmed violation.

   Tasks are derived, not stored: one disappears by itself once the
   reading, the calibration or the evaluation it asks for exists. Only
   what a person decides is stored, at lab_tasks/<taskId>:
     { status: 'postponed', until, reason }
     { status: 'done', note }      a questioned reading confirmed as correct
   Every result entered from this page is also appended to lab_tasks_log,
   the history behind the page's list of what was done today.
   The analysis schedule lives at lab_schedule/<tankId> = { every, params }.

   Depends on globals from index.html: database, tanks, tankLabel(),
   recordTankReadings(), showAppPage(), IS_EDITOR, IS_AUTHED, t(),
   and KGCSpecs / KGCKettle / KGCActions when they are loaded.
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[tasks] Firebase database is not available.');
    return;
  }

  // The plant samples every bath once a week; a tank can be set apart on the page.
  const DEFAULT_EVERY = 7;
  /* The acid baths are sampled for free acid and iron; Baumé and SG are
     there when wanted, not on the routine. Other tanks default to every
     parameter their standard defines. */
  const DEFAULT_PARAMS = {
    3: ['acidPercent', 'fe'], 4: ['acidPercent', 'fe'], 5: ['acidPercent', 'fe'],
    6: ['acidPercent', 'fe'], 8: ['acidPercent', 'fe'], 7: ['acidPercent', 'zn', 'fe']
  };
  // How far back an addition still asks for a re-measure.
  const AFTER_WINDOW_DAYS = 7;
  // A jump is only questioned while the reading is recent enough to redo.
  const JUMP_WINDOW_DAYS = 14;

  const LOGGED = ['ph', 'fe', 'baume', 'acidPercent', 'sg', 'conc', 'temp', 'ec', 'zn', 'salt'];

  let schedule = {}, state = {}, log = {}, readings = {}, acidAdds = {}, renewals = {}, saltAdds = {};
  let openForm = null;          // 'result:<taskId>' or 'postpone:<taskId>'
  let held = false;             // a render waiting for the user to leave a field
  let schedOpen = false;        // the schedule editor stays open across re-renders

  /* ---------------- helpers ---------------- */

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pad = n => (n < 10 ? '0' : '') + n;
  const dayKey = d => { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const parse = s => new Date(s + 'T00:00:00');
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return dayKey(d); };
  const canEdit = () => (typeof IS_EDITOR !== 'undefined' && IS_EDITOR) &&
                        (typeof IS_AUTHED !== 'undefined' && IS_AUTHED);
  const fmt = v => (v == null || !isFinite(v) ? '—' : String(Math.round(Number(v) * 100) / 100));
  const tankById = id => (typeof tanks !== 'undefined' ? tanks.find(x => x.id === Number(id)) : null);
  const tankName = id => { const tk = tankById(id); return tk ? tankLabel(tk.name) : String(id); };

  function paramLabel(key) {
    const k = 'f.' + key, out = t(k);
    return out === k ? key : out;
  }

  /** Spec parameters the plant can actually measure for this tank. */
  function measurable(tankId) {
    const SP = window.KGCSpecs;
    if (!SP || !SP.hasSpec(tankId)) return [];
    return SP.paramsFor(tankId).filter(p => !p.unavailable);
  }

  function specOf(tankId, key) {
    return measurable(tankId).find(p => p.key === key) || null;
  }

  function scheduleFor(tankId) {
    const saved = schedule[tankId] || {};
    const avail = measurable(tankId).map(p => p.key);
    let params = Array.isArray(saved.params) ? saved.params : (DEFAULT_PARAMS[tankId] || avail);
    params = params.filter(k => avail.indexOf(k) !== -1);
    const every = Number(saved.every) > 0 ? Number(saved.every) : DEFAULT_EVERY;
    return { every: every, params: params, off: !!saved.off };
  }

  /** readings_log as tank -> parameter -> [{date, v, ts}] oldest first. */
  function indexReadings() {
    const idx = {};
    Object.keys(readings).forEach(function (k) {
      const r = readings[k];
      if (!r || !r.date) return;
      const id = Number(r.tankId);
      LOGGED.forEach(function (f) {
        const v = r[f];
        if (v == null || v === '' || !isFinite(Number(v))) return;
        idx[id] = idx[id] || {};
        (idx[id][f] = idx[id][f] || []).push({ date: r.date, v: Number(v), ts: Number(r.ts) || 0 });
      });
    });
    Object.keys(idx).forEach(id => Object.keys(idx[id]).forEach(f =>
      idx[id][f].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)));
    return idx;
  }

  /** Day this parameter was last measured, from the log or the live card. */
  function lastMeasured(idx, tankId, key) {
    const list = idx[tankId] && idx[tankId][key];
    let last = list && list.length ? list[list.length - 1].date : null;
    const tk = tankById(tankId);
    const m = tk && tk.measured && tk.measured[key];
    if (m && (!last || m > last)) last = m;
    return last;
  }

  /** Was this tank measured (any of `keys`) after the moment `ts`? */
  function measuredSince(idx, tankId, keys, ts) {
    return keys.some(function (k) {
      const list = (idx[tankId] && idx[tankId][k]) || [];
      return list.some(r => r.ts > ts);
    });
  }

  function rangeOf(p) {
    return window.KGCSpecs ? window.KGCSpecs.rangeText(p) : '';
  }

  /* ---------------- task builders ----------------
     Each returns [{id, kind, rank, tankId, title, reason, need, due, late,
     form, keys}] — rank orders the day, `form` says what "enter result" opens. */

  function measureTasks(idx, today, doneOut) {
    const out = [];
    if (typeof tanks === 'undefined') return out;
    tanks.slice().sort((a, b) => a.id - b.id).forEach(function (tk) {
      const sc = scheduleFor(tk.id);
      if (sc.off || !sc.params.length) return;
      const lasts = sc.params.map(k => lastMeasured(idx, tk.id, k));
      const missingToday = sc.params.filter((k, i) => lasts[i] !== today);
      if (!missingToday.length) {
        doneOut.push({ id: 'm_' + tk.id + '_' + today, kind: 'measure', tankId: tk.id,
          title: tankName(tk.id), need: t('tk.n.sample', { p: sc.params.map(paramLabel).join(' · ') }) });
        return;
      }
      const known = lasts.filter(Boolean);
      const oldest = known.length === lasts.length ? known.sort()[0] : null;
      const due = oldest ? addDays(oldest, sc.every) : today;
      if (due > today) return;
      const late = daysBetween(due, today);
      out.push({
        id: 'm_' + tk.id + '_' + due,
        kind: 'measure', tankId: tk.id, title: tankName(tk.id),
        rank: late > 0 ? 60 + Math.min(late, 20) : 30,
        reason: oldest ? t('tk.r.schedule', { n: sc.every, d: oldest }) : t('tk.r.never'),
        need: t('tk.n.sample', { p: missingToday.map(paramLabel).join(' · ') }),
        due: due, late: late, form: 'measure', keys: missingToday
      });
    });
    return out;
  }

  /** Additions and treatments logged recently with no reading taken after them. */
  function afterTasks(idx, today) {
    const out = [];
    const from = addDays(today, -AFTER_WINDOW_DAYS);
    const push = function (id, tankId, date, what, keys, extra) {
      const late = Math.max(0, daysBetween(date, today));
      out.push(Object.assign({
        id: id, kind: 'after', tankId: tankId, title: tankName(tankId),
        rank: late > 0 ? 90 : 50,
        reason: t('tk.r.after', { w: what, d: date }),
        need: t('tk.n.remeasure', { p: keys.map(paramLabel).join(' · ') }),
        due: date, late: late, form: 'measure', keys: keys
      }, extra || {}));
    };

    // before/after cards whose action is done and still wait for the re-measure
    const A = window.KGCActions;
    if (A && A.pendingAfter) {
      A.pendingAfter().forEach(function (c) {
        if (c.date < from) return;
        const keys = c.keys.length ? c.keys : scheduleFor(c.tankId).params;
        push('a_card_' + c.key, c.tankId, c.date, c.what, keys, { form: 'after', cardKey: c.key });
      });
    }

    Object.keys(acidAdds).forEach(function (k) {
      const r = acidAdds[k];
      if (!r || !r.date || r.date < from || !r.tankId) return;
      const keys = scheduleFor(Number(r.tankId)).params.length ? scheduleFor(Number(r.tankId)).params : ['acidPercent'];
      if (measuredSince(idx, Number(r.tankId), keys, Number(r.ts) || 0)) return;
      push('a_acid_' + k, Number(r.tankId), r.date, t('tk.w.acid', { q: fmt(r.tons) }), keys);
    });

    Object.keys(renewals).forEach(function (k) {
      const r = renewals[k];
      if (!r || r.type !== 'addition' || !r.date || r.date < from || !r.tankId) return;
      const keys = scheduleFor(Number(r.tankId)).params;
      if (!keys.length || measuredSince(idx, Number(r.tankId), keys, Number(r.ts) || 0)) return;
      push('a_rn_' + k, Number(r.tankId), r.date, t('tk.w.addition', { q: r.qty ? fmt(r.qty) + ' ' + (r.unit || '') : '' }), keys);
    });

    // flux salt raises Baumé; the log keeps the "after" figure on the addition itself
    Object.keys(saltAdds).forEach(function (k) {
      const r = saltAdds[k];
      if (!r || !r.date || r.date < from || r.beAfter != null) return;
      const ts = Date.parse(r.ts) || 0;
      if (measuredSince(idx, 10, ['baume'], ts)) return;
      push('a_salt_' + k, 10, r.date, t('tk.w.salt', { q: fmt(r.kg) }), ['baume'], { saltKey: k });
    });
    return out;
  }

  /** Out-of-range readings, split into confirmed breaches and readings to re-check. */
  function readingTasks(idx, today) {
    const SP = window.KGCSpecs;
    const out = [];
    if (!SP || typeof tanks === 'undefined') return out;
    const A = window.KGCActions;

    tanks.slice().sort((a, b) => a.id - b.id).forEach(function (tk) {
      const bad = [];
      let freshest = '';
      measurable(tk.id).forEach(function (p) {
        const r = SP.evaluate(tk[p.key], p);
        const last = lastMeasured(idx, tk.id, p.key);
        if (r.tier === 'warn' || r.tier === 'crit') {
          const age = last ? daysBetween(last, today) : null;
          // a reading stands until the next sample is due; past that it is only a lead
          if (age != null && age <= scheduleFor(tk.id).every) {
            bad.push({ p: p, tier: r.tier, v: Number(tk[p.key]) });
            if (last > freshest) freshest = last;
          } else {
            out.push({
              id: 'r_' + tk.id + '_' + p.key + '_' + (last || 'x'),
              kind: 'review', tankId: tk.id, title: tankName(tk.id), rank: 40,
              reason: t('tk.r.oldBad', { p: paramLabel(p.key), v: fmt(tk[p.key]), r: rangeOf(p),
                n: age == null ? '?' : age }),
              need: t('tk.n.recheck', { p: paramLabel(p.key) }),
              due: today, late: 0, form: 'measure', keys: [p.key]
            });
          }
        }

        // a step no working bath can make is a typing slip until shown otherwise
        const list = (idx[tk.id] && idx[tk.id][p.key]) || [];
        const width = (p.min != null && p.max != null) ? p.max - p.min
                    : p.max != null ? p.max * 0.5 : null;
        if (list.length >= 2 && width > 0) {
          const a = list[list.length - 2], b = list[list.length - 1];
          if ( Math.abs(b.v - a.v) > width && daysBetween(b.date, today) <= JUMP_WINDOW_DAYS) {
            out.push({
              id: 'j_' + tk.id + '_' + p.key + '_' + b.date,
              kind: 'review', tankId: tk.id, title: tankName(tk.id), rank: 45,
              reason: t('tk.r.jump', { p: paramLabel(p.key), a: fmt(a.v), d1: a.date, b: fmt(b.v), d2: b.date }),
              need: t('tk.n.confirm'),
              due: b.date, late: 0, form: 'measure', keys: [p.key], confirmable: true
            });
          }
        }
      });

      if (!bad.length) return;
      const crit = bad.some(x => x.tier === 'crit');
      const card = A && A.openFor ? A.openFor(tk.id) : null;
      out.push({
        id: 'b_' + tk.id + '_' + freshest,
        kind: 'breach', tankId: tk.id, title: tankName(tk.id),
        rank: crit ? 100 : 80, crit: crit,
        reason: bad.map(x => paramLabel(x.p.key) + ' ' + fmt(x.v) + ' (' + rangeOf(x.p) + ')').join(' · '),
        need: card ? t('tk.n.inAction', { d: card.date }) : t('tk.n.act'),
        due: freshest, late: 0, form: 'breach', keys: bad.map(x => x.p.key),
        cardKey: card ? card.key : null
      });
    });
    return out;
  }

  function calibTasks(today) {
    const K = window.KGCKettle;
    if (!K || !K.calibrationAlerts) return [];
    return K.calibrationAlerts().map(function (a) {
      return {
        id: 'c_' + a.key + '_' + a.due,
        kind: 'calib', tankId: null, title: a.name, inst: a.key,
        rank: a.days < 0 ? 70 : 20,
        reason: a.days < 0 ? t('att.calOverdue', { n: Math.abs(a.days) }) : t('att.calSoon', { n: a.days }),
        need: t('tk.n.calib'),
        due: a.due, late: a.days < 0 ? Math.abs(a.days) : 0, form: 'calib'
      };
    });
  }

  function followTasks(today) {
    const A = window.KGCActions;
    if (!A || !A.followups) return [];
    return A.followups().map(function (c) {
      return {
        id: 'f_' + c.key, kind: 'follow', tankId: c.tankId, title: tankName(c.tankId), rank: 25,
        reason: t('tk.r.follow', { d: c.date }) + (c.note ? ' — ' + c.note : ''),
        need: t('tk.n.follow'), due: c.date, late: 0, form: 'card', cardKey: c.key
      };
    });
  }

  /* One sample answers several reasons at once: a scheduled analysis, the
     re-measure after an addition and an old out-of-range figure on the same
     tank are all closed by the same reading. Listing them three times makes
     the day look three times longer than it is, so they become one task that
     carries every reason and asks for every parameter. A follow-up on the
     card a breach already points to folds into that breach the same way. */
  function fold(list) {
    const SAMPLE = { after: 1, measure: 1, review: 1 };
    const out = [];
    list.slice().sort((a, b) => b.rank - a.rank).forEach(function (tk) {
      const host = out.find(function (h) {
        if (h.tankId == null || h.tankId !== tk.tankId) return false;
        if (SAMPLE[h.kind] && SAMPLE[tk.kind] && !h.confirmable && !tk.confirmable &&
            (h.form === 'measure' || h.form === 'after') && tk.form === 'measure') return true;
        return h.kind === 'breach' && tk.kind === 'follow' && h.cardKey && h.cardKey === tk.cardKey;
      });
      if (!host) { out.push(tk); return; }
      host.also = (host.also || []).concat(tk.reason);
      if (tk.keys) host.keys = (host.keys || []).concat(tk.keys.filter(k => (host.keys || []).indexOf(k) === -1));
      if (tk.form === 'measure' && host.form !== 'breach') host.need = t('tk.n.remeasure', { p: host.keys.map(paramLabel).join(' · ') });
      host.late = Math.max(host.late || 0, tk.late || 0);
      if (tk.saltKey) host.saltKey = tk.saltKey;
    });
    return out;
  }

  /** Every task the records call for today, split by what the user decided. */
  function build() {
    const today = dayKey();
    const idx = indexReadings();
    const doneAuto = [];
    let all = [];
    [function () { return measureTasks(idx, today, doneAuto); },
     function () { return afterTasks(idx, today); },
     function () { return readingTasks(idx, today); },
     function () { return calibTasks(today); },
     function () { return followTasks(today); }]
      .forEach(function (fn) { try { all = all.concat(fn() || []); } catch (e) { console.warn('[tasks]', e); } });

    all = fold(all);
    const open = [], postponed = [];
    all.forEach(function (tk) {
      const st = state[tk.id];
      if (st && st.status === 'done') return;
      if (st && st.status === 'postponed' && st.until > today) { postponed.push(Object.assign({}, tk, { st: st })); return; }
      if (st && st.status === 'postponed') tk.wasPostponed = st;
      open.push(tk);
    });
    open.sort((a, b) => b.rank - a.rank || (b.late || 0) - (a.late || 0) || (a.tankId || 99) - (b.tankId || 99));

    // what was closed today: results entered here, plus schedules met some other way
    const logged = Object.keys(log).map(k => log[k])
      .filter(r => r && r.ts && dayKey(new Date(r.ts)) === today)
      .map(r => ({ id: r.id, kind: r.kind, tankId: r.tankId, title: r.title || '', need: r.what || '' }));
    const doneToday = logged.concat(doneAuto.filter(d => !logged.some(l => l.tankId === d.tankId && l.kind === 'measure')));

    return { today: today, open: open, postponed: postponed, done: doneToday };
  }

  /* ---------------- rendering ---------------- */

  const KIND_CLS = { measure: 'tk-k-measure', after: 'tk-k-after', review: 'tk-k-review',
    breach: 'tk-k-breach', calib: 'tk-k-calib', follow: 'tk-k-follow' };

  function dueChip(tk, today) {
    if (tk.kind === 'breach') return '<span class="tk-due">' + esc(t('tk.d.measured', { d: tk.due })) + '</span>';
    if (tk.late > 0) return '<span class="tk-due late">' + esc(t('tk.d.late', { n: tk.late })) + '</span>';
    if (tk.due === today) return '<span class="tk-due now">' + esc(t('tk.d.today')) + '</span>';
    if (tk.due > today) return '<span class="tk-due">' + esc(t('tk.d.until', { d: tk.due })) + '</span>';
    return '<span class="tk-due">' + esc(tk.due) + '</span>';
  }

  /** Inputs for a set of parameters, each with its unit and range beside it. */
  function readingFields(prefix, tankId, keys, values) {
    return '<div class="tk-fields">' + keys.map(function (k) {
      const p = specOf(tankId, k);
      const v = values && values[k] != null ? values[k] : '';
      return '<label class="tk-field"><span>' + esc(paramLabel(k)) +
          (p && p.unit ? ' <small>' + esc(p.unit) + '</small>' : '') + '</span>' +
        '<input type="number" step="any" inputmode="decimal" data-' + prefix + '="' + esc(k) + '" value="' + esc(v) + '">' +
        (p ? '<small class="tk-rng" dir="ltr">' + esc(rangeOf(p)) + '</small>' : '') +
      '</label>';
    }).join('') + '</div>';
  }

  /** Values typed into fields made by readingFields(); blanks are left out. */
  function readFields(root, prefix) {
    const out = {};
    root.querySelectorAll('[data-' + prefix + ']').forEach(function (inp) {
      const raw = String(inp.value).trim();
      if (raw === '') return;
      const v = parseFloat(raw);
      if (isFinite(v)) out[inp.getAttribute('data-' + prefix)] = v;
    });
    return out;
  }

  function resultForm(tk) {
    if (tk.form === 'calib') {
      return '<div class="tk-form" data-form="' + esc(tk.id) + '">' +
        '<div class="tk-fields">' +
          '<label class="tk-field"><span>' + esc(t('tk.f.calLast')) + '</span><input type="date" data-cal="last" value="' + dayKey() + '"></label>' +
          '<label class="tk-field"><span>' + esc(t('tk.f.calDue')) + '</span><input type="date" data-cal="due"></label>' +
          '<label class="tk-field"><span>' + esc(t('tk.f.calBy')) + '</span><input type="text" data-cal="by"></label>' +
        '</div>' +
        '<div class="tk-actions"><button class="btn mini" data-save-cal="' + esc(tk.id) + '">' + esc(t('tk.b.save')) + '</button>' +
        '<span class="tk-msg"></span></div></div>';
    }
    const keys = tk.form === 'breach' ? tk.keys : (tk.keys || []);
    return '<div class="tk-form" data-form="' + esc(tk.id) + '">' +
      '<p class="tk-hint">' + esc(tk.form === 'after' ? t('tk.h.after') : t('tk.h.measure')) + '</p>' +
      readingFields('rd', tk.tankId, keys) +
      '<label class="tk-note"><span>' + esc(t('tk.f.note')) + '</span><input type="text" data-note maxlength="160"></label>' +
      '<div class="tk-actions"><button class="btn mini" data-save-reading="' + esc(tk.id) + '">' + esc(t('tk.b.save')) + '</button>' +
      '<span class="tk-msg"></span></div></div>';
  }

  function postponeForm(tk) {
    return '<div class="tk-form" data-form="' + esc(tk.id) + '">' +
      '<div class="tk-fields">' +
        '<label class="tk-field"><span>' + esc(t('tk.f.until')) + '</span><input type="date" data-pp="until" value="' + addDays(dayKey(), 1) + '"></label>' +
        '<label class="tk-field tk-wide"><span>' + esc(t('tk.f.reason')) + '</span><input type="text" data-pp="reason" maxlength="200" placeholder="' + esc(t('tk.f.reasonPh')) + '"></label>' +
      '</div>' +
      '<div class="tk-actions"><button class="btn mini" data-save-pp="' + esc(tk.id) + '">' + esc(t('tk.b.postpone')) + '</button>' +
      '<span class="tk-msg"></span></div></div>';
  }

  function taskHTML(tk, today) {
    const edit = canEdit();
    let buttons = '';
    if (edit) {
      if (tk.form === 'breach') {
        buttons += tk.cardKey
          ? '<button class="btn mini" data-open-card="' + esc(tk.cardKey) + '">' + esc(t('tk.b.openCard')) + '</button>'
          : '<button class="btn mini" data-start-card="' + esc(tk.id) + '">' + esc(t('tk.b.startCard')) + '</button>';
        buttons += '<button class="btn mini ghost" data-toggle="result:' + esc(tk.id) + '">' + esc(t('tk.b.remeasure')) + '</button>';
      } else if (tk.form === 'card') {
        buttons += '<button class="btn mini" data-open-card="' + esc(tk.cardKey) + '">' + esc(t('tk.b.openCard')) + '</button>';
      } else {
        buttons += '<button class="btn mini" data-toggle="result:' + esc(tk.id) + '">' + esc(t('tk.b.result')) + '</button>';
      }
      if (tk.confirmable) buttons += '<button class="btn mini ghost" data-confirm="' + esc(tk.id) + '">' + esc(t('tk.b.correct')) + '</button>';
      buttons += '<button class="btn mini ghost" data-toggle="postpone:' + esc(tk.id) + '">' + esc(t('tk.b.postpone')) + '</button>';
    }
    const form = openForm === 'result:' + tk.id ? resultForm(tk)
               : openForm === 'postpone:' + tk.id ? postponeForm(tk) : '';
    return '<div class="tk-item ' + KIND_CLS[tk.kind] + (tk.crit ? ' crit' : '') + '">' +
      '<div class="tk-top">' +
        '<span class="tk-kind">' + esc(t('tk.kind.' + tk.kind)) + '</span>' +
        '<b class="tk-title">' + esc(tk.title) + '</b>' +
        dueChip(tk, today) +
      '</div>' +
      '<div class="tk-line"><span class="tk-lbl">' + esc(t('tk.l.reason')) + '</span>' + esc(tk.reason) + '</div>' +
      (tk.also || []).map(r => '<div class="tk-line tk-also"><span class="tk-lbl">' + esc(t('tk.l.also')) + '</span>' + esc(r) + '</div>').join('') +
      '<div class="tk-line"><span class="tk-lbl">' + esc(t('tk.l.need')) + '</span><b>' + esc(tk.need) + '</b></div>' +
      (tk.wasPostponed ? '<div class="tk-line tk-was">' + esc(t('tk.wasPostponed', { r: tk.wasPostponed.reason || '' })) + '</div>' : '') +
      (buttons ? '<div class="tk-actions">' + buttons + '</div>' : '') +
      form +
    '</div>';
  }

  function scheduleHTML() {
    if (typeof tanks === 'undefined') return '';
    const rows = tanks.slice().sort((a, b) => a.id - b.id).filter(tk => measurable(tk.id).length).map(function (tk) {
      const sc = scheduleFor(tk.id);
      const boxes = measurable(tk.id).map(function (p) {
        return '<label class="tk-chk"><input type="checkbox" data-sc-param="' + tk.id + '" value="' + esc(p.key) + '"' +
          (sc.params.indexOf(p.key) !== -1 ? ' checked' : '') + '> ' + esc(paramLabel(p.key)) + '</label>';
      }).join('');
      return '<tr>' +
        '<td class="name">' + esc(tankName(tk.id)) + '</td>' +
        '<td><input type="number" min="1" step="1" class="tk-every" data-sc-every="' + tk.id + '" value="' + sc.every + '"></td>' +
        '<td>' + boxes + '</td>' +
        '<td><input type="checkbox" data-sc-on="' + tk.id + '"' + (sc.off ? '' : ' checked') + '></td>' +
      '</tr>';
    }).join('');
    return '<details class="tk-sched"' + (schedOpen ? ' open' : '') + '>' +
      '<summary>' + esc(t('tk.sc.title')) + '</summary>' +
      '<p class="tk-hint">' + esc(t('tk.sc.sub', { n: DEFAULT_EVERY })) + '</p>' +
      '<div class="tablewrap"><table><thead><tr>' +
        '<th>' + esc(t('lab.col.tank')) + '</th><th>' + esc(t('tk.sc.every')) + '</th>' +
        '<th>' + esc(t('tk.sc.params')) + '</th><th>' + esc(t('tk.sc.on')) + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (canEdit() ? '<div class="tk-actions"><button class="btn mini" id="tk-sc-save">' + esc(t('tk.b.save')) + '</button><span class="tk-msg" id="tk-sc-msg"></span></div>' : '') +
    '</details>';
  }

  const stat = (k, v, hot) =>
    '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';

  function render() {
    const mount = document.getElementById('tasks-body');
    if (!mount) return;
    // re-drawing while someone types would throw their entry away
    if (typing(mount)) { held = true; return; }
    held = false;
    if (!mount.dataset.wired) {
      mount.dataset.wired = '1';
      // a render that was held back while typing runs once the field is left
      mount.addEventListener('focusout', function () {
        setTimeout(function () { if (held && !typing(mount)) render(); }, 0);
      });
      mount.addEventListener('toggle', function (e) {
        if (e.target.classList && e.target.classList.contains('tk-sched')) schedOpen = e.target.open;
      }, true);
    }

    const B = build();
    const late = B.open.filter(x => x.late > 0).length;
    const breaches = B.open.filter(x => x.kind === 'breach').length;
    const measures = B.open.filter(x => x.kind === 'measure' || x.kind === 'after').length;

    mount.innerHTML =
      '<div class="pt-stats">' +
        stat(t('tk.s.open'), B.open.length) +
        stat(t('tk.s.late'), late, late > 0) +
        stat(t('tk.s.breach'), breaches, breaches > 0) +
        stat(t('tk.s.measure'), measures) +
        stat(t('tk.s.done'), B.done.length) +
      '</div>' +
      '<p class="tk-legend">' + esc(t('tk.legend')) + '</p>' +
      (B.open.length
        ? '<div class="tk-list">' + B.open.map(x => taskHTML(x, B.today)).join('') + '</div>'
        : '<div class="att-clear"><span class="att-ok">✓</span>' + esc(t('tk.allDone')) + '</div>') +
      (B.postponed.length
        ? '<details class="tk-more"><summary>' + esc(t('tk.postponed', { n: B.postponed.length })) + '</summary>' +
            B.postponed.map(function (x) {
              return '<div class="tk-row"><b>' + esc(x.title) + '</b> · ' + esc(x.need) +
                '<span class="tk-row-sub">' + esc(t('tk.ppUntil', { d: x.st.until, r: x.st.reason || '' })) + '</span>' +
                (canEdit() ? '<button class="btn mini ghost" data-unpp="' + esc(x.id) + '">' + esc(t('tk.b.unpostpone')) + '</button>' : '') +
              '</div>';
            }).join('') + '</details>'
        : '') +
      (B.done.length
        ? '<details class="tk-more"><summary>' + esc(t('tk.doneToday', { n: B.done.length })) + '</summary>' +
            B.done.map(x => '<div class="tk-row tk-done">✓ <b>' + esc(x.title) + '</b> · ' + esc(x.need) + '</div>').join('') +
          '</details>'
        : '') +
      scheduleHTML();

    wire(mount, B);
  }

  function typing(mount) {
    const a = document.activeElement;
    return !!(a && mount.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }

  /* ---------------- actions ---------------- */

  function flash(root, msg, bad) {
    const el = root && root.querySelector('.tk-msg');
    if (!el) return;
    el.textContent = msg;
    el.style.color = bad ? 'var(--crit)' : 'var(--accent)';
  }

  function goPage(id) {
    const btn = document.querySelector('.topnav button[data-page="' + id + '"]');
    if (btn && typeof showAppPage === 'function') showAppPage(id, btn);
  }

  /** Append to the follow-up history (lab_tasks_log). */
  function logDone(task, what, note) {
    return database.ref('lab_tasks_log').push({
      id: task.id, ts: Date.now(), kind: task.kind, tankId: task.tankId || null,
      title: task.title, what: what || task.need, note: note || null
    });
  }

  /** A questioned reading the engineer has checked and stands by. */
  function markConfirmed(task, note) {
    return database.ref('lab_tasks/' + task.id).set({
      status: 'done', ts: Date.now(), note: note || null,
      kind: task.kind, tankId: task.tankId || null, title: task.title
    }).then(() => logDone(task, t('tk.b.correct'), note));
  }

  function valuesText(vals) {
    return Object.keys(vals).map(k => paramLabel(k) + ' ' + fmt(vals[k])).join(' · ');
  }

  function wire(mount, B) {
    const find = id => B.open.find(x => x.id === id);

    mount.querySelectorAll('[data-toggle]').forEach(function (b) {
      b.addEventListener('click', function () {
        const v = b.getAttribute('data-toggle');
        openForm = openForm === v ? null : v;
        render();
        const f = mount.querySelector('.tk-form input');
        if (f) f.focus();
      });
    });

    mount.querySelectorAll('[data-save-reading]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!canEdit()) return;
        const task = find(b.getAttribute('data-save-reading'));
        const form = b.closest('.tk-form');
        if (!task || !form) return;
        const vals = readFields(form, 'rd');
        if (!Object.keys(vals).length) { flash(form, t('tk.e.empty'), true); return; }
        const note = (form.querySelector('[data-note]') || {}).value || '';
        if (task.form === 'after' && window.KGCActions) {
          window.KGCActions.addAfter(task.cardKey, vals, note.trim());
        } else {
          recordTankReadings(task.tankId, vals);
        }
        if (task.saltKey && vals.baume != null) {
          database.ref('flux_salt_additions/' + task.saltKey + '/beAfter').set(vals.baume);
        }
        logDone(task, valuesText(vals), note.trim() || null);
        openForm = null;
        if (document.activeElement) document.activeElement.blur();
        render();
      });
    });

    mount.querySelectorAll('[data-save-cal]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!canEdit()) return;
        const task = find(b.getAttribute('data-save-cal'));
        const form = b.closest('.tk-form');
        if (!task || !form) return;
        const v = k => ((form.querySelector('[data-cal="' + k + '"]') || {}).value || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v('last')) || !/^\d{4}-\d{2}-\d{2}$/.test(v('due'))) {
          flash(form, t('kettle.cal.badDate'), true); return;
        }
        database.ref('calibration/' + task.inst).set({ last: v('last'), due: v('due'), by: v('by') || null })
          .then(function () { logDone(task, t('tk.f.calDue') + ' ' + v('due'), v('by') || null); openForm = null; render(); })
          .catch(e => flash(form, t('flux.d.failed') + ' ' + (e.message || ''), true));
      });
    });

    mount.querySelectorAll('[data-save-pp]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!canEdit()) return;
        const task = find(b.getAttribute('data-save-pp'));
        const form = b.closest('.tk-form');
        if (!task || !form) return;
        const until = (form.querySelector('[data-pp="until"]') || {}).value || '';
        const reason = ((form.querySelector('[data-pp="reason"]') || {}).value || '').trim();
        if (!reason) { flash(form, t('tk.e.reason'), true); return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until <= dayKey()) { flash(form, t('tk.e.until'), true); return; }
        database.ref('lab_tasks/' + task.id).set({
          status: 'postponed', until: until, reason: reason, ts: Date.now(),
          kind: task.kind, tankId: task.tankId || null, title: task.title
        }).then(function () { openForm = null; if (document.activeElement) document.activeElement.blur(); render(); });
      });
    });

    mount.querySelectorAll('[data-confirm]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!canEdit()) return;
        const task = find(b.getAttribute('data-confirm'));
        if (!task) return;
        const note = prompt(t('tk.askCorrect'), '');
        if (note === null) return;
        markConfirmed(task, note.trim() || null);
      });
    });

    mount.querySelectorAll('[data-unpp]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!canEdit()) return;
        database.ref('lab_tasks/' + b.getAttribute('data-unpp')).remove();
      });
    });

    mount.querySelectorAll('[data-start-card]').forEach(function (b) {
      b.addEventListener('click', function () {
        const task = find(b.getAttribute('data-start-card'));
        if (!task || !window.KGCActions) return;
        const tk = tankById(task.tankId);
        const vals = {};
        measurable(task.tankId).forEach(function (p) {
          if (tk && tk[p.key] != null && tk[p.key] !== '') vals[p.key] = Number(tk[p.key]);
        });
        window.KGCActions.startNew({ tankId: task.tankId, reason: task.reason, readings: vals, sampleDate: task.due });
        goPage('page-actions');
      });
    });

    mount.querySelectorAll('[data-open-card]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!window.KGCActions) return;
        window.KGCActions.focus(b.getAttribute('data-open-card'));
        goPage('page-actions');
      });
    });

    const save = mount.querySelector('#tk-sc-save');
    if (save) save.addEventListener('click', function () {
      if (!canEdit()) return;
      const updates = {};
      mount.querySelectorAll('[data-sc-every]').forEach(function (inp) {
        const id = inp.getAttribute('data-sc-every');
        const every = Math.max(1, Math.round(Number(inp.value) || DEFAULT_EVERY));
        const params = Array.prototype.slice.call(mount.querySelectorAll('[data-sc-param="' + id + '"]'))
          .filter(c => c.checked).map(c => c.value);
        const on = (mount.querySelector('[data-sc-on="' + id + '"]') || {}).checked;
        updates[id] = { every: every, params: params, off: !on };
      });
      database.ref('lab_schedule').set(updates).then(function () {
        const m = document.getElementById('tk-sc-msg');
        if (m) { m.textContent = t('spec.saved'); m.style.color = 'var(--accent)'; }
      });
    });
  }

  /* ---------------- wiring ---------------- */

  database.ref('lab_schedule').on('value', s => { schedule = s.val() || {}; render(); });
  database.ref('lab_tasks').on('value', s => { state = s.val() || {}; render(); });
  database.ref('lab_tasks_log').on('value', s => { log = s.val() || {}; render(); });
  database.ref('readings_log').on('value', s => { readings = s.val() || {}; render(); });
  database.ref('acid_additions').on('value', s => { acidAdds = s.val() || {}; render(); });
  database.ref('renewals').on('value', s => { renewals = s.val() || {}; render(); });
  database.ref('flux_salt_additions').on('value', s => { saltAdds = s.val() || {}; render(); });
  database.ref('tanks_data').on('value', () => setTimeout(render, 0));
  database.ref('tank_specs').on('value', () => setTimeout(render, 0));
  database.ref('calibration').on('value', () => setTimeout(render, 0));
  database.ref('actions').on('value', () => setTimeout(render, 0));
  if (window.I18N) I18N.onChange(render);
  document.addEventListener('DOMContentLoaded', render);
  // the day rolls over while the page stays open on the lab bench
  setInterval(render, 300000);

  window.KGCTasks = {
    render: render, build: build, scheduleFor: scheduleFor,
    readingFields: readingFields, readFields: readFields,
    measurable: measurable, paramLabel: paramLabel, rangeOf: rangeOf,
    _state: () => state, _log: () => log
  };
})();
