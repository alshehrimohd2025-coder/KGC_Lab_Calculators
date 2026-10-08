/* ============================================================
   Before / after — one card per addition or treatment
   ------------------------------------------------------------
   The logs on the flux and pickling pages record what was added.
   They do not keep the problem that called for it next to the result
   it produced, so nobody could say afterwards which treatments worked.
   Each card here holds the whole story, in four stages:

     before      when the sample was taken, the readings, why act
     action      material and strength, the quantity the calculator
                 suggested AND the quantity actually added — two
                 separate figures, never one overwriting the other
     after       each re-measure, kept beside the "before" figures
     evaluation  achieved / needs follow-up / not enough data

   Nothing closes by itself. The page suggests an evaluation, and the
   suggestion looks at every indicator of the tank, not only the one
   that was treated: a pH brought back into range does not make a card
   "achieved" while iron in the same bath is still over its limit.

   Data: actions/<pushId> = {
     tankId, reason, status: 'open' | 'closed', createdTs, closedTs,
     before:     { at, readings: {param: value}, note },
     action:     { material, materialOther, conc, suggestedQty, suggestedUnit,
                   suggestedBy, actualQty, actualUnit, at, by, note },
     afters:     { <pushId>: { at, readings, note, ts } },
     evaluation: { result, note, ts }
   }
   `at` is the local date-time the operator gives ("2026-10-07T09:30").

   Depends on globals from index.html: database, tanks, tankLabel(),
   recordTankReadings(), IS_EDITOR, IS_AUTHED, t(), and KGCSpecs /
   KGCTasks for the reading fields.
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[actions] Firebase database is not available.');
    return;
  }

  const MATERIALS = ['hcl', 'ammonia', 'peroxide', 'flux_salt', 'water', 'degreaser', 'other'];
  const UNITS = ['L', 'kg', 't', 'm³'];
  const SOURCES = ['none', 'ammonia', 'peroxide', 'salt', 'pickling', 'fluxcalc', 'other'];
  const RESULTS = ['achieved', 'followup', 'insufficient'];

  let cards = {};
  let filter = 'open', tankFilter = 0;
  let draft = null;             // the new-card form while it is open
  let openForm = null;          // 'action:<key>' | 'after:<key>' | 'eval:<key>'
  let focusKey = null;
  let held = false;

  /* ---------------- helpers ---------------- */

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pad = n => (n < 10 ? '0' : '') + n;
  const dayKey = d => { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const nowLocal = () => { const d = new Date(); return dayKey(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const canEdit = () => (typeof IS_EDITOR !== 'undefined' && IS_EDITOR) &&
                        (typeof IS_AUTHED !== 'undefined' && IS_AUTHED);
  const fmt = v => (v == null || !isFinite(v) ? '—' : String(Math.round(Number(v) * 1000) / 1000));
  const tankById = id => (typeof tanks !== 'undefined' ? tanks.find(x => x.id === Number(id)) : null);
  const tankName = id => { const tk = tankById(id); return tk ? tankLabel(tk.name) : String(id); };
  const T = () => window.KGCTasks;
  const paramLabel = k => (T() ? T().paramLabel(k) : k);
  const when = at => String(at || '').replace('T', ' ');

  function specOf(tankId, key) {
    const SP = window.KGCSpecs;
    if (!SP) return null;
    return SP.paramsFor(Number(tankId)).find(p => p.key === key) || null;
  }

  function tierOf(tankId, key, v) {
    const SP = window.KGCSpecs, p = specOf(tankId, key);
    return SP && p ? SP.evaluate(v, p).tier : 'none';
  }

  function materialText(a) {
    if (!a) return '';
    if (a.material === 'other') return a.materialOther || t('ac.mat.other');
    const k = 'lab.item.' + a.material;
    const lab = t(k) !== k ? t(k) : t('ac.mat.' + a.material);
    return lab + (a.conc ? ' ' + a.conc : '');
  }

  function list() {
    return Object.keys(cards).map(k => Object.assign({ _k: k }, cards[k]))
      .filter(c => c && c.tankId)
      .sort((a, b) => (b.createdTs || 0) - (a.createdTs || 0));
  }

  function aftersOf(c) {
    return Object.keys(c.afters || {}).map(k => c.afters[k]).filter(Boolean)
      .sort((a, b) => (a.at || '') < (b.at || '') ? -1 : 1);
  }

  /** The latest value of each parameter across all re-measures. */
  function mergedAfter(c) {
    const out = {};
    aftersOf(c).forEach(a => Object.keys(a.readings || {}).forEach(k => { out[k] = Number(a.readings[k]); }));
    return out;
  }

  function stage(c) {
    if (c.status === 'closed') return 'closed';
    if (!c.action) return 'needAction';
    if (!aftersOf(c).length) return 'needAfter';
    if (c.evaluation && c.evaluation.result === 'followup') return 'followup';
    return 'needEval';
  }

  /* What the records say about the result. Every indicator of the tank is
     looked at: the re-measured ones, and any other the live card shows out
     of range — one figure improving is not the bath being right. */
  function suggest(c) {
    const after = mergedAfter(c);
    const before = (c.before && c.before.readings) || {};
    if (!Object.keys(after).length) return { result: 'insufficient', why: t('ac.sg.noAfter') };
    let targets = Object.keys(before).filter(k => ['warn', 'crit'].indexOf(tierOf(c.tankId, k, before[k])) !== -1);
    if (!targets.length) targets = Object.keys(before);
    if (targets.length && !targets.some(k => after[k] != null)) {
      return { result: 'insufficient', why: t('ac.sg.noTarget', { p: targets.map(paramLabel).join(' · ') }) };
    }
    const outAfter = Object.keys(after).filter(k => ['warn', 'crit'].indexOf(tierOf(c.tankId, k, after[k])) !== -1);
    const tk = tankById(c.tankId);
    const others = (T() ? T().measurable(Number(c.tankId)) : []).map(p => p.key)
      .filter(k => after[k] == null && tk && ['warn', 'crit'].indexOf(tierOf(c.tankId, k, tk[k])) !== -1);
    if (outAfter.length || others.length) {
      return { result: 'followup', why: t('ac.sg.stillOut', {
        p: outAfter.concat(others).map(k => paramLabel(k)).join(' · ') }), out: outAfter.concat(others) };
    }
    return { result: 'achieved', why: t('ac.sg.allIn') };
  }

  /* ---------------- rendering ---------------- */

  const TIER_COL = { good: 'var(--accent)', warn: 'var(--warn)', crit: 'var(--crit)' };
  const valHTML = (tankId, k, v) => {
    const tier = tierOf(tankId, k, v);
    return '<b style="color:' + (TIER_COL[tier] || 'var(--ink)') + '">' + fmt(v) + '</b>';
  };

  function readingsList(tankId, r) {
    const keys = Object.keys(r || {});
    if (!keys.length) return '<span class="ac-none">—</span>';
    return keys.map(k => '<span class="ac-rd">' + esc(paramLabel(k)) + ' ' + valHTML(tankId, k, r[k]) + '</span>').join('');
  }

  function select(attr, opts, cur, labelOf) {
    return '<select ' + attr + '>' + opts.map(o =>
      '<option value="' + esc(o) + '"' + (String(cur) === String(o) ? ' selected' : '') + '>' + esc(labelOf(o)) + '</option>').join('') + '</select>';
  }

  function newCardHTML() {
    if (!draft) return '';
    const tankOpts = (typeof tanks !== 'undefined' ? tanks.slice().sort((a, b) => a.id - b.id) : [])
      .filter(tk => T() && T().measurable(tk.id).length).map(tk => tk.id);
    const keys = T() ? T().measurable(Number(draft.tankId)).map(p => p.key) : [];
    const today = draft.at && draft.at.slice(0, 10) === dayKey();
    return '<div class="ac-new" id="ac-new">' +
      '<p class="panel-label">' + esc(t('ac.new.title')) + '</p>' +
      '<div class="tk-fields">' +
        '<label class="tk-field"><span>' + esc(t('lab.col.tank')) + '</span>' +
          select('id="ac-n-tank"', tankOpts, draft.tankId, tankName) + '</label>' +
        '<label class="tk-field"><span>' + esc(t('ac.f.sampleAt')) + '</span><input type="datetime-local" id="ac-n-at" value="' + esc(draft.at) + '"></label>' +
        '<label class="tk-field tk-wide"><span>' + esc(t('ac.f.reason')) + '</span><input type="text" id="ac-n-reason" maxlength="240" value="' + esc(draft.reason) + '" placeholder="' + esc(t('ac.f.reasonPh')) + '"></label>' +
      '</div>' +
      '<p class="tk-hint">' + esc(t('ac.h.before')) + '</p>' +
      (T() ? T().readingFields('bf', Number(draft.tankId), keys, draft.readings) : '') +
      '<label class="tk-note"><span>' + esc(t('tk.f.note')) + '</span><input type="text" id="ac-n-note" maxlength="200" value="' + esc(draft.note) + '"></label>' +
      '<label class="tk-chk"><input type="checkbox" id="ac-n-upd"' + (draft.updateTank && today ? ' checked' : '') + (today ? '' : ' disabled') + '> ' +
        esc(t(today ? 'ac.f.updateTank' : 'ac.f.updateTankPast')) + '</label>' +
      '<div class="tk-actions">' +
        '<button class="btn mini" id="ac-n-save">' + esc(t('ac.b.create')) + '</button>' +
        '<button class="btn mini ghost" id="ac-n-cancel">' + esc(t('ac.b.cancel')) + '</button>' +
        '<span class="tk-msg" id="ac-n-msg"></span>' +
      '</div></div>';
  }

  function actionForm(c) {
    const a = c.action || {};
    return '<div class="tk-form" data-ac-form="action">' +
      '<div class="tk-fields">' +
        '<label class="tk-field"><span>' + esc(t('ac.f.material')) + '</span>' +
          select('data-a="material"', MATERIALS, a.material || '', m => materialText({ material: m })) + '</label>' +
        '<label class="tk-field"><span>' + esc(t('ac.f.materialOther')) + '</span><input type="text" data-a="materialOther" maxlength="80" value="' + esc(a.materialOther || '') + '"></label>' +
        '<label class="tk-field"><span>' + esc(t('ac.f.conc')) + '</span><input type="text" data-a="conc" maxlength="40" value="' + esc(a.conc || '') + '" placeholder="32%"></label>' +
      '</div>' +
      '<div class="ac-qty">' +
        '<div class="ac-qty-box"><p class="ac-qty-h">' + esc(t('ac.f.suggested')) + '</p><div class="tk-fields">' +
          '<label class="tk-field"><span>' + esc(t('ac.f.qty')) + '</span><input type="number" step="any" data-a="suggestedQty" value="' + esc(a.suggestedQty != null ? a.suggestedQty : '') + '"></label>' +
          '<label class="tk-field"><span>' + esc(t('ac.f.unit')) + '</span>' + select('data-a="suggestedUnit"', UNITS, a.suggestedUnit || 'L', u => u) + '</label>' +
          '<label class="tk-field"><span>' + esc(t('ac.f.source')) + '</span>' + select('data-a="suggestedBy"', SOURCES, a.suggestedBy || 'none', s => t('ac.src.' + s)) + '</label>' +
        '</div></div>' +
        '<div class="ac-qty-box actual"><p class="ac-qty-h">' + esc(t('ac.f.actual')) + '</p><div class="tk-fields">' +
          '<label class="tk-field"><span>' + esc(t('ac.f.qty')) + '</span><input type="number" step="any" data-a="actualQty" value="' + esc(a.actualQty != null ? a.actualQty : '') + '"></label>' +
          '<label class="tk-field"><span>' + esc(t('ac.f.unit')) + '</span>' + select('data-a="actualUnit"', UNITS, a.actualUnit || 'L', u => u) + '</label>' +
        '</div></div>' +
      '</div>' +
      '<div class="tk-fields">' +
        '<label class="tk-field"><span>' + esc(t('ac.f.doneAt')) + '</span><input type="datetime-local" data-a="at" value="' + esc(a.at || nowLocal()) + '"></label>' +
        '<label class="tk-field"><span>' + esc(t('ac.f.by')) + '</span><input type="text" data-a="by" maxlength="60" value="' + esc(a.by || '') + '"></label>' +
        '<label class="tk-field tk-wide"><span>' + esc(t('tk.f.note')) + '</span><input type="text" data-a="note" maxlength="200" value="' + esc(a.note || '') + '"></label>' +
      '</div>' +
      '<div class="tk-actions"><button class="btn mini" data-save-action="' + esc(c._k) + '">' + esc(t('tk.b.save')) + '</button><span class="tk-msg"></span></div>' +
    '</div>';
  }

  function afterForm(c) {
    const keys = Object.keys((c.before && c.before.readings) || {});
    const all = T() ? T().measurable(Number(c.tankId)).map(p => p.key) : keys;
    return '<div class="tk-form" data-ac-form="after">' +
      '<div class="tk-fields">' +
        '<label class="tk-field"><span>' + esc(t('ac.f.afterAt')) + '</span><input type="datetime-local" data-afm="at" value="' + nowLocal() + '"></label>' +
      '</div>' +
      '<p class="tk-hint">' + esc(t('ac.h.after')) + '</p>' +
      (T() ? T().readingFields('af', Number(c.tankId), all) : '') +
      '<label class="tk-note"><span>' + esc(t('ac.f.opNote')) + '</span><input type="text" data-afm="note" maxlength="200"></label>' +
      '<label class="tk-chk"><input type="checkbox" data-afm="upd" checked> ' + esc(t('ac.f.updateTank')) + '</label>' +
      '<div class="tk-actions"><button class="btn mini" data-save-after="' + esc(c._k) + '">' + esc(t('tk.b.save')) + '</button><span class="tk-msg"></span></div>' +
    '</div>';
  }

  function evalForm(c, sg) {
    const cur = (c.evaluation && c.evaluation.result) || sg.result;
    return '<div class="tk-form" data-ac-form="eval">' +
      '<div class="ac-results">' + RESULTS.map(r =>
        '<label class="ac-res-opt r-' + r + '"><input type="radio" name="ac-res-' + esc(c._k) + '" value="' + r + '"' + (cur === r ? ' checked' : '') + '> ' + esc(t('ac.res.' + r)) + '</label>').join('') +
      '</div>' +
      '<label class="tk-note"><span>' + esc(t('ac.f.evalNote')) + '</span><input type="text" data-ev="note" maxlength="240" value="' + esc((c.evaluation && c.evaluation.note) || '') + '"></label>' +
      '<div class="tk-actions"><button class="btn mini" data-save-eval="' + esc(c._k) + '">' + esc(t('ac.b.saveEval')) + '</button><span class="tk-msg"></span></div>' +
    '</div>';
  }

  /** Before beside after, one row per parameter that was measured either time. */
  function compareHTML(c) {
    const before = (c.before && c.before.readings) || {};
    const after = mergedAfter(c);
    const keys = Object.keys(before).concat(Object.keys(after).filter(k => before[k] == null));
    if (!keys.length || !Object.keys(after).length) return '';
    const rows = keys.map(function (k) {
      const b = before[k], a = after[k];
      const p = specOf(c.tankId, k);
      let d = '';
      if (b != null && a != null) {
        const diff = a - b;
        d = (diff > 0 ? '+' : '') + fmt(diff);
      }
      const tier = a != null ? tierOf(c.tankId, k, a) : 'none';
      return '<tr><td class="name">' + esc(paramLabel(k)) + (p && p.unit ? ' <small>' + esc(p.unit) + '</small>' : '') + '</td>' +
        '<td class="num">' + (b != null ? valHTML(c.tankId, k, b) : '—') + '</td>' +
        '<td class="num">' + (a != null ? valHTML(c.tankId, k, a) : '—') + '</td>' +
        '<td class="num" dir="ltr">' + esc(d || '—') + '</td>' +
        '<td class="num" dir="ltr">' + esc(p && T() ? T().rangeOf(p) : '') + '</td>' +
        '<td>' + (window.KGCSpecs && a != null ? window.KGCSpecs.badge(tier) : '') + '</td></tr>';
    }).join('');
    return '<div class="tablewrap ac-cmp"><table><thead><tr>' +
      '<th>' + esc(t('spec.param')) + '</th><th>' + esc(t('ac.st.before')) + '</th><th>' + esc(t('ac.st.after')) + '</th>' +
      '<th>' + esc(t('ac.col.diff')) + '</th><th>' + esc(t('ac.col.range')) + '</th><th>' + esc(t('ac.col.status')) + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function cardHTML(c) {
    const st = stage(c);
    const edit = canEdit();
    const sg = suggest(c);
    const a = c.action;
    const afters = aftersOf(c);

    const beforeBox = '<div class="ac-stage done">' +
      '<p class="ac-stage-h">' + esc(t('ac.st.before')) + '</p>' +
      '<p class="ac-when">' + esc(when(c.before && c.before.at)) + '</p>' +
      readingsList(c.tankId, c.before && c.before.readings) +
      (c.before && c.before.note ? '<p class="ac-note">' + esc(c.before.note) + '</p>' : '') +
    '</div>';

    let actionBox;
    if (a) {
      const sq = a.suggestedQty != null && a.suggestedQty !== '' ? Number(a.suggestedQty) : null;
      const aq = a.actualQty != null && a.actualQty !== '' ? Number(a.actualQty) : null;
      const same = sq != null && aq != null && (a.suggestedUnit || '') === (a.actualUnit || '');
      const gap = same && sq ? (aq - sq) / sq * 100 : null;
      actionBox = '<div class="ac-stage done">' +
        '<p class="ac-stage-h">' + esc(t('ac.st.action')) + '</p>' +
        '<p class="ac-when">' + esc(when(a.at)) + (a.by ? ' · ' + esc(a.by) : '') + '</p>' +
        '<p class="ac-mat">' + esc(materialText(a)) + '</p>' +
        '<div class="ac-pair">' +
          '<span><small>' + esc(t('ac.f.suggested')) + '</small>' +
            (sq != null ? '<b>' + fmt(sq) + ' ' + esc(a.suggestedUnit || '') + '</b><small>' + esc(t('ac.src.' + (a.suggestedBy || 'none'))) + '</small>'
                        : '<b>—</b><small>' + esc(t('ac.src.none')) + '</small>') + '</span>' +
          '<span class="actual"><small>' + esc(t('ac.f.actual')) + '</small><b>' + (aq != null ? fmt(aq) + ' ' + esc(a.actualUnit || '') : '—') + '</b>' +
            (gap != null && Math.abs(gap) >= 0.5 ? '<small>' + esc(t('ac.gap', { p: (gap > 0 ? '+' : '') + gap.toFixed(0) })) + '</small>' : '') + '</span>' +
        '</div>' +
        (a.note ? '<p class="ac-note">' + esc(a.note) + '</p>' : '') +
        (edit && st !== 'closed' ? '<button class="btn mini ghost" data-toggle="action:' + esc(c._k) + '">' + esc(t('ac.b.edit')) + '</button>' : '') +
      '</div>';
    } else {
      actionBox = '<div class="ac-stage">' +
        '<p class="ac-stage-h">' + esc(t('ac.st.action')) + '</p>' +
        '<p class="ac-none">' + esc(t('ac.none.action')) + '</p>' +
        (edit ? '<button class="btn mini" data-toggle="action:' + esc(c._k) + '">' + esc(t('ac.b.action')) + '</button>' : '') +
      '</div>';
    }

    const afterBox = '<div class="ac-stage' + (afters.length ? ' done' : '') + '">' +
      '<p class="ac-stage-h">' + esc(t('ac.st.after')) + '</p>' +
      (afters.length ? afters.map(x =>
        '<div class="ac-after"><p class="ac-when">' + esc(when(x.at)) + '</p>' + readingsList(c.tankId, x.readings) +
          (x.note ? '<p class="ac-note">' + esc(x.note) + '</p>' : '') + '</div>').join('')
        : '<p class="ac-none">' + esc(t(a ? 'ac.none.after' : 'ac.none.afterWait')) + '</p>') +
      (edit && a && st !== 'closed' ? '<button class="btn mini' + (afters.length ? ' ghost' : '') + '" data-toggle="after:' + esc(c._k) + '">' +
        esc(t(afters.length ? 'ac.b.afterMore' : 'ac.b.after')) + '</button>' : '') +
    '</div>';

    const ev = c.evaluation;
    const evalBox = '<div class="ac-stage' + (ev ? ' done' : '') + '">' +
      '<p class="ac-stage-h">' + esc(t('ac.st.eval')) + '</p>' +
      (ev ? '<p class="ac-verdict r-' + esc(ev.result) + '">' + esc(t('ac.res.' + ev.result)) + '</p>' +
            (ev.note ? '<p class="ac-note">' + esc(ev.note) + '</p>' : '') : '') +
      (st !== 'closed' && afters.length
        ? '<p class="ac-sg">' + esc(t('ac.sg.label')) + ' <b class="r-' + sg.result + '">' + esc(t('ac.res.' + sg.result)) + '</b> — ' + esc(sg.why) + '</p>'
        : (!ev ? '<p class="ac-none">' + esc(t('ac.none.eval')) + '</p>' : '')) +
      (edit && st !== 'closed' && afters.length ? '<button class="btn mini" data-toggle="eval:' + esc(c._k) + '">' + esc(t(ev ? 'ac.b.reEval' : 'ac.b.eval')) + '</button>' : '') +
      (edit && st !== 'closed' && ev && ev.result !== 'followup' ? '<button class="btn mini ghost" data-close="' + esc(c._k) + '">' + esc(t('ac.b.close')) + '</button>' : '') +
      (edit && st === 'closed' ? '<button class="btn mini ghost" data-reopen="' + esc(c._k) + '">' + esc(t('ac.b.reopen')) + '</button>' : '') +
    '</div>';

    const form = openForm === 'action:' + c._k ? actionForm(c)
               : openForm === 'after:' + c._k ? afterForm(c)
               : openForm === 'eval:' + c._k ? evalForm(c, sg) : '';

    return '<article class="ac-card st-' + st + (focusKey === c._k ? ' focus' : '') + '" id="ac-' + esc(c._k) + '">' +
      '<div class="ac-head">' +
        '<b class="ac-tank">' + esc(tankName(c.tankId)) + '</b>' +
        '<span class="ac-stagechip st-' + st + '">' + esc(t('ac.stage.' + st) + (st === 'closed' && ev ? ' · ' + t('ac.res.' + ev.result) : '')) + '</span>' +
        '<span class="ac-date">' + esc(when(c.before && c.before.at)) + '</span>' +
        (edit ? '<button class="btn mini danger" data-del="' + esc(c._k) + '">' + esc(t('lab.delete')) + '</button>' : '') +
      '</div>' +
      (c.reason ? '<p class="ac-reason"><span class="tk-lbl">' + esc(t('tk.l.reason')) + '</span>' + esc(c.reason) + '</p>' : '') +
      '<div class="ac-stages">' + beforeBox + actionBox + afterBox + evalBox + '</div>' +
      form +
      compareHTML(c) +
    '</article>';
  }

  const stat = (k, v, hot) =>
    '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';

  function typing(mount) {
    const a = document.activeElement;
    return !!(a && mount.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }

  function render() {
    const mount = document.getElementById('actions-body');
    if (!mount) return;
    if (typing(mount)) { held = true; return; }
    held = false;
    if (!mount.dataset.wired) {
      mount.dataset.wired = '1';
      mount.addEventListener('focusout', function () {
        setTimeout(function () { if (held && !typing(mount)) render(); }, 0);
      });
    }

    const all = list();
    const by = s => all.filter(c => stage(c) === s).length;
    const shown = all.filter(function (c) {
      if (tankFilter && Number(c.tankId) !== tankFilter) return false;
      if (focusKey) return c._k === focusKey || filter === 'all';
      return filter === 'all' || (filter === 'open' ? c.status !== 'closed' : c.status === 'closed');
    });

    const tankOpts = [0].concat((typeof tanks !== 'undefined' ? tanks.slice().sort((a, b) => a.id - b.id) : [])
      .filter(tk => T() && T().measurable(tk.id).length).map(tk => tk.id));

    mount.innerHTML =
      '<div class="pt-stats">' +
        stat(t('ac.stage.needAction'), by('needAction')) +
        stat(t('ac.stage.needAfter'), by('needAfter'), by('needAfter') > 0) +
        stat(t('ac.stage.needEval'), by('needEval')) +
        stat(t('ac.stage.followup'), by('followup'), by('followup') > 0) +
        stat(t('ac.stage.closed'), by('closed')) +
      '</div>' +
      '<div class="ac-bar">' +
        (canEdit() && !draft ? '<button class="btn" id="ac-new-btn">' + esc(t('ac.b.new')) + '</button>' : '') +
        '<div class="ac-filters">' + ['open', 'closed', 'all'].map(f =>
          '<button class="btn mini' + (filter === f && !focusKey ? '' : ' ghost') + '" data-filter="' + f + '">' + esc(t('ac.flt.' + f)) + '</button>').join('') +
          select('id="ac-tank-flt"', tankOpts, tankFilter, id => id ? tankName(id) : t('ac.flt.allTanks')) +
        '</div>' +
      '</div>' +
      newCardHTML() +
      (focusKey ? '<p class="tk-hint">' + esc(t('ac.focused')) + ' <button class="btn mini ghost" id="ac-unfocus">' + esc(t('ac.b.showAll')) + '</button></p>' : '') +
      (shown.length ? shown.map(cardHTML).join('') : '<div class="lab-empty">' + esc(t(all.length ? 'ac.emptyFilter' : 'ac.empty')) + '</div>');

    wire(mount);
  }

  /* ---------------- writes ---------------- */

  function flash(root, msg, bad) {
    const el = root && root.querySelector('.tk-msg');
    if (!el) return;
    el.textContent = msg;
    el.style.color = bad ? 'var(--crit)' : 'var(--accent)';
  }

  function keepDraft(mount) {
    if (!draft) return;
    const v = id => (mount.querySelector(id) || {}).value;
    draft.at = v('#ac-n-at') || draft.at;
    draft.reason = v('#ac-n-reason') != null ? v('#ac-n-reason') : draft.reason;
    draft.note = v('#ac-n-note') != null ? v('#ac-n-note') : draft.note;
    const upd = mount.querySelector('#ac-n-upd');
    if (upd && !upd.disabled) draft.updateTank = upd.checked;
    if (T()) draft.readings = Object.assign({}, draft.readings, T().readFields(mount.querySelector('#ac-new') || mount, 'bf'));
  }

  function wire(mount) {
    const blurAndRender = () => { if (document.activeElement) document.activeElement.blur(); render(); };

    const nb = mount.querySelector('#ac-new-btn');
    if (nb) nb.addEventListener('click', function () { startNew({}); });

    mount.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', function () {
      filter = b.getAttribute('data-filter'); focusKey = null; render();
    }));
    const tf = mount.querySelector('#ac-tank-flt');
    if (tf) tf.addEventListener('change', function () { tankFilter = Number(tf.value) || 0; tf.blur(); render(); });
    const uf = mount.querySelector('#ac-unfocus');
    if (uf) uf.addEventListener('click', function () { focusKey = null; render(); });

    // ---- new card ----
    const nt = mount.querySelector('#ac-n-tank');
    if (nt) nt.addEventListener('change', function () {
      keepDraft(mount); draft.tankId = Number(nt.value); draft.readings = {}; nt.blur(); render();
    });
    const nat = mount.querySelector('#ac-n-at');
    if (nat) nat.addEventListener('change', function () { keepDraft(mount); nat.blur(); render(); });
    const nc = mount.querySelector('#ac-n-cancel');
    if (nc) nc.addEventListener('click', function () { draft = null; render(); });
    const ns = mount.querySelector('#ac-n-save');
    if (ns) ns.addEventListener('click', function () {
      if (!canEdit()) return;
      keepDraft(mount);
      const box = mount.querySelector('#ac-new');
      const readings = T() ? T().readFields(box, 'bf') : {};
      if (!draft.reason.trim()) { flash(box, t('ac.e.reason'), true); return; }
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(draft.at || '')) { flash(box, t('ac.e.at'), true); return; }
      if (!Object.keys(readings).length) { flash(box, t('ac.e.readings'), true); return; }
      const rec = {
        tankId: Number(draft.tankId), reason: draft.reason.trim(), status: 'open', createdTs: Date.now(),
        before: { at: draft.at, readings: readings, note: (draft.note || '').trim() || null }
      };
      const ref = database.ref('actions').push();
      ref.set(rec).then(function () {
        if (draft && draft.updateTank && draft.at.slice(0, 10) === dayKey()) recordTankReadings(rec.tankId, readings);
        draft = null; focusKey = null; filter = 'open';
        blurAndRender();
      }).catch(e => flash(box, t('flux.d.failed') + ' ' + (e.message || ''), true));
    });

    // ---- per-card forms ----
    mount.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', function () {
      const v = b.getAttribute('data-toggle');
      openForm = openForm === v ? null : v;
      render();
    }));

    mount.querySelectorAll('[data-save-action]').forEach(b => b.addEventListener('click', function () {
      if (!canEdit()) return;
      const key = b.getAttribute('data-save-action');
      const form = b.closest('.tk-form');
      const v = k => ((form.querySelector('[data-a="' + k + '"]') || {}).value || '').trim();
      const n = k => { const x = v(k); return x === '' ? null : (isFinite(Number(x)) ? Number(x) : null); };
      if (v('material') === 'other' && !v('materialOther')) { flash(form, t('ac.e.material'), true); return; }
      if (n('actualQty') == null || n('actualQty') <= 0) { flash(form, t('ac.e.actual'), true); return; }
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v('at'))) { flash(form, t('ac.e.at'), true); return; }
      const rec = {
        material: v('material'), materialOther: v('materialOther') || null, conc: v('conc') || null,
        suggestedQty: n('suggestedQty'), suggestedUnit: v('suggestedUnit') || null,
        suggestedBy: n('suggestedQty') != null ? (v('suggestedBy') || 'none') : 'none',
        actualQty: n('actualQty'), actualUnit: v('actualUnit') || null,
        at: v('at'), by: v('by') || null, note: v('note') || null
      };
      database.ref('actions/' + key + '/action').set(rec)
        .then(function () { openForm = null; blurAndRender(); })
        .catch(e => flash(form, t('flux.d.failed') + ' ' + (e.message || ''), true));
    }));

    mount.querySelectorAll('[data-save-after]').forEach(b => b.addEventListener('click', function () {
      if (!canEdit()) return;
      const key = b.getAttribute('data-save-after');
      const form = b.closest('.tk-form');
      const at = ((form.querySelector('[data-afm="at"]') || {}).value || '').trim();
      const note = ((form.querySelector('[data-afm="note"]') || {}).value || '').trim();
      const upd = (form.querySelector('[data-afm="upd"]') || {}).checked;
      const vals = T() ? T().readFields(form, 'af') : {};
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) { flash(form, t('ac.e.at'), true); return; }
      if (!Object.keys(vals).length) { flash(form, t('ac.e.readings'), true); return; }
      const c = cards[key];
      if (c && c.action && c.action.at && at < c.action.at) { flash(form, t('ac.e.afterBefore'), true); return; }
      addAfter(key, vals, note, at, upd && at.slice(0, 10) === dayKey())
        .then(function () { openForm = null; blurAndRender(); })
        .catch(e => flash(form, t('flux.d.failed') + ' ' + (e.message || ''), true));
    }));

    mount.querySelectorAll('[data-save-eval]').forEach(b => b.addEventListener('click', function () {
      if (!canEdit()) return;
      const key = b.getAttribute('data-save-eval');
      const form = b.closest('.tk-form');
      const pick = form.querySelector('input[type="radio"]:checked');
      const note = ((form.querySelector('[data-ev="note"]') || {}).value || '').trim();
      if (!pick) return;
      const c = Object.assign({ _k: key }, cards[key]);
      const sg = suggest(c);
      // calling it achieved while the records disagree needs a reason on file
      if (pick.value === 'achieved' && sg.result !== 'achieved') {
        if (!note) { flash(form, t('ac.e.overrideNote', { p: sg.why }), true); return; }
        if (!confirm(t('ac.confirmOverride', { p: sg.why }))) return;
      }
      database.ref('actions/' + key + '/evaluation').set({ result: pick.value, note: note || null, ts: Date.now() })
        .then(function () { openForm = null; blurAndRender(); })
        .catch(e => flash(form, t('flux.d.failed') + ' ' + (e.message || ''), true));
    }));

    mount.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', function () {
      if (!canEdit()) return;
      database.ref('actions/' + b.getAttribute('data-close')).update({ status: 'closed', closedTs: Date.now() });
    }));
    mount.querySelectorAll('[data-reopen]').forEach(b => b.addEventListener('click', function () {
      if (!canEdit()) return;
      database.ref('actions/' + b.getAttribute('data-reopen')).update({ status: 'open', closedTs: null });
    }));
    mount.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', function () {
      if (!canEdit()) return;
      if (!confirm(t('ac.confirmDelete'))) return;
      database.ref('actions/' + b.getAttribute('data-del')).remove();
    }));
  }

  /** Record a re-measure on a card, and (when it is today's sample) on the tank card. */
  function addAfter(key, vals, note, at, updateTank) {
    const c = cards[key];
    if (!c) return Promise.reject(new Error('card not found'));
    const stamp = at || nowLocal();
    return database.ref('actions/' + key + '/afters').push({ at: stamp, readings: vals, note: note || null, ts: Date.now() })
      .then(function () {
        if (updateTank !== false && stamp.slice(0, 10) === dayKey()) recordTankReadings(Number(c.tankId), vals);
      });
  }

  /** Open the new-card form, optionally pre-filled from a task. */
  function startNew(opts) {
    opts = opts || {};
    const firstTank = (typeof tanks !== 'undefined' ? tanks.slice().sort((a, b) => a.id - b.id) : [])
      .find(tk => T() && T().measurable(tk.id).length);
    const fromTask = opts.readings && Object.keys(opts.readings).length;
    draft = {
      tankId: Number(opts.tankId) || (firstTank ? firstTank.id : 3),
      reason: opts.reason || '',
      // a breach's readings are already logged — stamping them again would
      // mark the bath as measured today when nobody took a sample
      at: opts.sampleDate && opts.sampleDate !== dayKey() ? opts.sampleDate + 'T08:00' : nowLocal(),
      readings: opts.readings || {},
      note: '',
      updateTank: !fromTask
    };
    focusKey = null;
    render();
    setTimeout(function () {
      const el = document.getElementById('ac-new');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }

  function focus(key) {
    focusKey = key;
    render();
    setTimeout(function () {
      const el = document.getElementById('ac-' + key);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }

  /* ---------------- wiring ---------------- */

  database.ref('actions').on('value', s => { cards = s.val() || {}; render(); });
  database.ref('tanks_data').on('value', () => setTimeout(render, 0));
  database.ref('tank_specs').on('value', () => setTimeout(render, 0));
  if (window.I18N) I18N.onChange(render);
  document.addEventListener('DOMContentLoaded', render);

  window.KGCActions = {
    render: render, startNew: startNew, focus: focus, addAfter: addAfter,
    suggest: suggest, stage: stage, materialText: materialText, mergedAfter: mergedAfter, aftersOf: aftersOf,
    list: list,
    /** Cards whose action is done and still wait for the first re-measure. */
    pendingAfter: function () {
      return list().filter(c => stage(c) === 'needAfter').map(c => ({
        key: c._k, tankId: Number(c.tankId),
        date: String(c.action.at || '').slice(0, 10) || dayKey(),
        what: materialText(c.action) + (c.action.actualQty != null ? ' ' + fmt(c.action.actualQty) + ' ' + (c.action.actualUnit || '') : ''),
        keys: Object.keys((c.before && c.before.readings) || {})
      }));
    },
    /** Cards evaluated as needing follow-up. */
    followups: function () {
      return list().filter(c => stage(c) === 'followup').map(c => ({
        key: c._k, tankId: Number(c.tankId),
        date: dayKey(new Date(c.evaluation.ts || Date.now())), note: c.evaluation.note || ''
      }));
    },
    /** The newest card still open on this tank, if any. */
    openFor: function (tankId) {
      const c = list().find(x => Number(x.tankId) === Number(tankId) && x.status !== 'closed');
      return c ? { key: c._k, date: String((c.before && c.before.at) || '').slice(0, 10) } : null;
    }
  };
})();
