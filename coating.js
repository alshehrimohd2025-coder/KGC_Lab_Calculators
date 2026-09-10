/* ============================================================
   Coating thickness — the quality control the plant actually sells
   ------------------------------------------------------------
   Everything else in this site watches the process going in. This
   measures what comes out: the zinc coating on the steel, against
   ISO 1461 (and the matching ASTM A123 categories).

   ISO 1461 sets two limits per steel-thickness category — a mean
   coating thickness for the batch and a lower local minimum that no
   single reading may fall under. A batch passes only when both hold,
   so both are checked and reported separately.

   Readings are magnetic-gauge measurements in µm. A "sample" is one
   test piece; the standard asks for several readings spread over each
   piece, whose average is that piece's local thickness.

   Coating mass is derived at 7.14 g/cm3 (zinc): 1 µm = 7.14 g/m2.

   Depends on globals from index.html: database, IS_EDITOR, IS_AUTHED, t()
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[coating] Firebase database is not available.');
    return;
  }

  /* ISO 1461 table 3 — steel thickness category -> required thickness.
     `mean` is the batch average minimum, `local` the single-reading floor. */
  const CATEGORIES = [
    { key: 'gt6',    min: 6,    max: Infinity, mean: 85, local: 70 },
    { key: 'r3_6',   min: 3,    max: 6,        mean: 70, local: 55 },
    { key: 'r15_3',  min: 1.5,  max: 3,        mean: 55, local: 45 },
    { key: 'lt15',   min: 0,    max: 1.5,      mean: 45, local: 35 },
    { key: 'cast6',  min: 6,    max: Infinity, mean: 80, local: 70, cast: true },
    { key: 'castlt6',min: 0,    max: 6,        mean: 70, local: 60, cast: true }
  ];

  const ZN_DENSITY = 7.14;          // g/cm3 -> 1 µm of zinc = 7.14 g/m2

  let entries = {};

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pad = n => (n < 10 ? '0' : '') + n;
  const num = v => { const n = Number(v); return isFinite(n) ? n : null; };

  const catOf = key => CATEGORIES.find(c => c.key === key) || null;

  /* ---------------- evaluation ---------------- */

  /** Judge one batch of readings against its category. */
  function judge(readings, catKey) {
    const cat = catOf(catKey);
    const vals = (readings || []).map(num).filter(v => v != null && v > 0);
    if (!cat || !vals.length) return null;

    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const min = Math.min.apply(null, vals);
    const max = Math.max.apply(null, vals);
    const sd = vals.length > 1
      ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (vals.length - 1))
      : 0;

    const meanOk = mean >= cat.mean;
    const localOk = min >= cat.local;

    /* Cpk against the one-sided local minimum — the specification has no
       upper bound, so only the lower capability is meaningful. */
    const cpk = sd > 0 ? (mean - cat.local) / (3 * sd) : null;

    return {
      n: vals.length, mean: mean, min: min, max: max, sd: sd, cpk: cpk,
      mass: mean * ZN_DENSITY,          // g/m2
      meanOk: meanOk, localOk: localOk,
      pass: meanOk && localOk,
      cat: cat
    };
  }

  const list = () => Object.keys(entries)
    .map(k => Object.assign({ _k: k }, entries[k]))
    .filter(e => e && e.date)
    .sort((a, b) => (a.date === b.date ? (b.ts || 0) - (a.ts || 0) : (a.date < b.date ? 1 : -1)));

  /* ---------------- rendering ---------------- */

  function catOptions(sel) {
    return CATEGORIES.map(c =>
      '<option value="' + c.key + '"' + (c.key === sel ? ' selected' : '') + '>' +
      esc(t('coat.cat.' + c.key)) + ' — ' + c.mean + '/' + c.local + ' µm</option>').join('');
  }

  function verdictPill(j) {
    if (!j) return '<span class="zn-pill" style="color:var(--ink-3);border-color:var(--line);background:var(--recess)">—</span>';
    const v = j.pass ? 'var(--accent)' : 'var(--crit)';
    return '<span class="zn-pill" style="color:' + v + ';border-color:' + v + '66;background:' + v + '1a">' +
      esc(j.pass ? t('coat.pass') : t('coat.fail')) + '</span>';
  }

  function render() {
    const mount = document.getElementById('coat-body');
    if (!mount) return;
    const rows = list();

    const judged = rows.map(e => ({ e: e, j: judge(e.readings, e.category) })).filter(x => x.j);
    const passed = judged.filter(x => x.j.pass).length;
    const rate = judged.length ? (passed / judged.length * 100) : 0;

    // capability over the whole record, per category
    const allVals = [];
    judged.forEach(x => { (x.e.readings || []).forEach(v => { const n = num(v); if (n) allVals.push({ v: n, cat: x.j.cat }); }); });
    let cpkAll = null;
    if (allVals.length > 1) {
      const m = allVals.reduce((s, a) => s + a.v, 0) / allVals.length;
      const sd = Math.sqrt(allVals.reduce((s, a) => s + (a.v - m) * (a.v - m), 0) / (allVals.length - 1));
      const localAvg = allVals.reduce((s, a) => s + a.cat.local, 0) / allVals.length;
      if (sd > 0) cpkAll = (m - localAvg) / (3 * sd);
    }

    const stat = (k, v, unit, hot) =>
      '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span>' +
      '<span class="v">' + v + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</span></div>';

    const form =
      '<div class="lab-form" id="coat-form">' +
        '<div><label>' + esc(t('coat.f.batch')) + '</label><input type="text" id="coat-batch" placeholder="' + esc(t('coat.f.batchPh')) + '"></div>' +
        '<div><label>' + esc(t('coat.f.customer')) + '</label><input type="text" id="coat-customer"></div>' +
        '<div><label>' + esc(t('coat.f.cat')) + '</label><select id="coat-cat">' + catOptions('r3_6') + '</select></div>' +
        '<div style="grid-column:1/-1"><label>' + esc(t('coat.f.readings')) + '</label>' +
          '<input type="text" id="coat-readings" inputmode="decimal" placeholder="' + esc(t('coat.f.readingsPh')) + '"></div>' +
        '<div><label>' + esc(t('coat.f.operator')) + '</label><input type="text" id="coat-op"></div>' +
        '<div><label>' + esc(t('coat.f.note')) + '</label><input type="text" id="coat-note"></div>' +
        '<div><button class="btn" id="coat-save" style="width:100%;justify-content:center">' + esc(t('coat.f.save')) + '</button></div>' +
        '<div style="grid-column:1/-1"><span id="coat-msg"></span><div id="coat-preview" class="coat-preview"></div></div>' +
      '</div>';

    const table = rows.length
      ? '<div class="tablewrap"><table><thead><tr>' +
          '<th>' + esc(t('coat.c.date')) + '</th>' +
          '<th>' + esc(t('coat.c.batch')) + '</th>' +
          '<th>' + esc(t('coat.c.cat')) + '</th>' +
          '<th>' + esc(t('coat.c.n')) + '</th>' +
          '<th>' + esc(t('coat.c.mean')) + '</th>' +
          '<th>' + esc(t('coat.c.min')) + '</th>' +
          '<th>' + esc(t('coat.c.mass')) + '</th>' +
          '<th>' + esc(t('coat.c.verdict')) + '</th>' +
          '<th></th>' +
        '</tr></thead><tbody>' +
        rows.map(function (e) {
          const j = judge(e.readings, e.category);
          const req = j ? (j.cat.mean + '/' + j.cat.local) : '—';
          return '<tr class="' + (j && !j.pass ? 'zn-masked' : '') + '">' +
            '<td class="num">' + esc(e.date) + '</td>' +
            '<td class="name">' + esc(e.batch || '—') + (e.customer ? '<br><small style="color:var(--ink-3)">' + esc(e.customer) + '</small>' : '') + '</td>' +
            '<td class="num">' + esc(t('coat.cat.' + e.category)) + '<br><small style="color:var(--ink-3)">' + req + ' µm</small></td>' +
            '<td class="num">' + (j ? j.n : 0) + '</td>' +
            '<td class="num" style="color:' + (j && !j.meanOk ? 'var(--crit)' : 'var(--ink)') + '">' + (j ? j.mean.toFixed(1) : '—') + '</td>' +
            '<td class="num" style="color:' + (j && !j.localOk ? 'var(--crit)' : 'var(--ink)') + '">' + (j ? j.min.toFixed(1) : '—') + '</td>' +
            '<td class="num">' + (j ? Math.round(j.mass) : '—') + '</td>' +
            '<td>' + verdictPill(j) + '</td>' +
            '<td>' + (IS_EDITOR ? '<button class="btn mini danger" data-del-coat="' + esc(e._k) + '">' + esc(t('lab.delete')) + '</button>' : '') + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table></div>'
      : '<div class="lab-empty">' + esc(t('coat.empty')) + '</div>';

    mount.innerHTML =
      '<div class="pt-stats">' +
        stat(t('coat.s.count'), judged.length) +
        stat(t('coat.s.pass'), rate.toFixed(0), '%', rate < 100 && judged.length > 0) +
        stat(t('coat.s.cpk'), cpkAll == null ? '—' : cpkAll.toFixed(2), '', cpkAll != null && cpkAll < 1.33) +
        stat(t('coat.s.fails'), judged.length - passed, '', judged.length - passed > 0) +
      '</div>' +
      (cpkAll != null && cpkAll < 1.33 ? '<div class="zn-note">' + esc(t('coat.cpkWarn')) + '</div>' : '') +
      form + table;

    wireForm(mount);
  }

  /* ---------------- form ---------------- */

  function parseReadings(text) {
    return String(text || '').split(/[\s,;/]+/).map(num).filter(v => v != null && v > 0);
  }

  function wireForm(mount) {
    const el = id => mount.querySelector('#' + id);
    const readings = el('coat-readings'), cat = el('coat-cat'), preview = el('coat-preview');

    function refresh() {
      if (!readings || !preview) return;
      const j = judge(parseReadings(readings.value), cat.value);
      if (!j) { preview.innerHTML = ''; return; }
      preview.innerHTML =
        '<span>' + esc(t('coat.c.n')) + ' <b>' + j.n + '</b></span>' +
        '<span>' + esc(t('coat.c.mean')) + ' <b style="color:' + (j.meanOk ? 'var(--accent)' : 'var(--crit)') + '">' + j.mean.toFixed(1) + '</b> / ' + j.cat.mean + '</span>' +
        '<span>' + esc(t('coat.c.min')) + ' <b style="color:' + (j.localOk ? 'var(--accent)' : 'var(--crit)') + '">' + j.min.toFixed(1) + '</b> / ' + j.cat.local + '</span>' +
        '<span>' + esc(t('coat.c.mass')) + ' <b>' + Math.round(j.mass) + '</b> g/m²</span>' +
        verdictPill(j);
    }
    if (readings) { readings.addEventListener('input', refresh); }
    if (cat) cat.addEventListener('change', refresh);
    refresh();

    const save = el('coat-save');
    if (save) save.addEventListener('click', function () {
      const msg = el('coat-msg');
      const say = (m, bad) => { if (msg) { msg.textContent = m; msg.style.color = bad ? 'var(--crit)' : 'var(--accent)'; } };
      if (!IS_EDITOR || !IS_AUTHED) { say(t('coat.needAuth'), true); return; }

      const vals = parseReadings(readings.value);
      const batch = (el('coat-batch').value || '').trim();
      if (!batch) { say(t('coat.errBatch'), true); return; }
      if (vals.length < 3) { say(t('coat.errReadings'), true); return; }

      const d = new Date();
      database.ref('coating_log').push({
        ts: d.getTime(),
        date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
        batch: batch,
        customer: (el('coat-customer').value || '').trim() || null,
        category: cat.value,
        readings: vals,
        operator: (el('coat-op').value || '').trim() || null,
        note: (el('coat-note').value || '').trim() || null
      }).then(function () {
        say(t('coat.saved', { n: vals.length }));
        ['coat-batch', 'coat-customer', 'coat-readings', 'coat-note'].forEach(id => { const x = el(id); if (x) x.value = ''; });
        refresh();
      }).catch(e => say(t('coat.failed') + ' ' + e.message, true));
    });

    mount.querySelectorAll('[data-del-coat]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!IS_EDITOR || !IS_AUTHED) return;
        if (!confirm(t('coat.confirmDel'))) return;
        database.ref('coating_log/' + b.getAttribute('data-del-coat')).remove();
      });
    });
  }

  /* ---------------- wiring ---------------- */

  database.ref('coating_log').on('value', s => { entries = s.val() || {}; render(); });
  if (window.I18N) I18N.onChange(render);
  document.addEventListener('DOMContentLoaded', render);

  window.KGCCoating = {
    judge: judge, render: render,
    _entries: () => entries, _cats: CATEGORIES, _parse: parseReadings
  };
})();
