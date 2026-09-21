/* ============================================================
   Peroxide dosing — learned from the plant's own treatments
   ------------------------------------------------------------
   Same idea as the ammonia panel (flux.js), for the other half of the
   flux clean-out: every time hydrogen peroxide oxidises the dissolved
   iron, the operator logs the iron reading before and after and how
   many litres of 35% peroxide were used. From that history the panel
   computes the average dose efficiency (litres per 1.0 g/L Fe removed)
   and, given a current and target Fe, predicts how much to prepare
   next time — the plant's own note on the flux page already says the
   theoretical figure (fluxcalc.js) ran at 2.5x reality, so an
   empirical model is what actually predicts stock needs.

   "Current Fe" is not typed in twice: it is read straight from
   readings_log, the exact same 'fe' slot the flux tank's trend chart
   and spec limits use (lab.js / specs.js) — so this panel and the
   rest of the tank stay in sync automatically.

   Data lives at  peroxide_treatments/<pushId>  in Firebase, shared and
   synced like everything else, and also feeds the cost page (cost.js)
   and the export report (report.js). Writes require the editor login.

   Depends on globals from index.html:
     database, IS_EDITOR, IS_AUTHED, I18N / t(), KGCSpecs (optional)
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[peroxide] Firebase database is not available.');
    return;
  }

  const FLUX_TANK_ID = 10;

  let treatments = {};   // pushId -> record
  let readingsLog = {};  // key -> {tankId, date, fe, ...} — shared with lab.js

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const num = v => { const n = Number(v); return isFinite(n) ? n : NaN; };
  const pad = n => (n < 10 ? '0' : '') + n;
  const canEdit = () => (typeof IS_EDITOR !== 'undefined' && IS_EDITOR) &&
                        (typeof IS_AUTHED !== 'undefined' && IS_AUTHED);

  /* ---------------- model ---------------- */

  /** Sorted oldest→newest list of valid records. */
  function list() {
    return Object.keys(treatments).map(function (k) {
      const r = treatments[k] || {};
      return Object.assign({ _k: k }, r);
    }).filter(r => r.ts).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  }

  /** Treatments that count toward the prediction model (outliers can be
      flagged out, same as the ammonia log). */
  function modelList() { return list().filter(r => !r.excludeFromModel); }

  /** Litres of peroxide per 1.0 g/L Fe removed, one factor per treatment
      that actually lowered Fe by a meaningful amount. */
  function factors() {
    return modelList().map(function (r) {
      const d = num(r.feBefore) - num(r.feAfter);
      const L = num(r.liters);
      if (!isFinite(d) || d < 0.05 || !isFinite(L) || L <= 0) return null;
      return { r: r, dFe: d, L: L, perFe: L / d };
    }).filter(Boolean);
  }

  function stats() {
    const logged = list().length;
    const excluded = list().filter(r => r.excludeFromModel).length;
    const fs = factors();
    const lastAfter = modelList().map(r => num(r.feAfter)).filter(isFinite).pop();
    if (!fs.length) return { n: 0, logged: logged, excluded: excluded, lastFe: lastAfter };
    const per = fs.map(f => f.perFe);
    const mean = per.reduce((s, v) => s + v, 0) / per.length;
    const min = Math.min.apply(null, per);
    const max = Math.max.apply(null, per);
    return { n: fs.length, logged: logged, excluded: excluded, mean: mean, min: min, max: max, lastFe: lastAfter };
  }

  const round = (v, s) => Math.round(v / s) * s;

  /* ---------------- flux Fe spec (for the target hint) ---------------- */

  function feSpec() {
    try {
      const p = window.KGCSpecs && window.KGCSpecs.paramsFor(FLUX_TANK_ID).find(x => x.key === 'fe');
      return p || null;
    } catch (e) { return null; }
  }

  /** Latest Fe reading logged for the flux tank — the same value the trend
      chart and spec limits already use, read straight from readings_log. */
  function liveFe() {
    let best = null;
    Object.keys(readingsLog).forEach(function (k) {
      const r = readingsLog[k];
      if (!r || Number(r.tankId) !== FLUX_TANK_ID || !(Number(r.fe) > 0)) return;
      if (!best || (r.date || '') > (best.date || '')) best = r;
    });
    return best ? Number(best.fe) : null;
  }

  /* ---------------- rendering ---------------- */

  function fieldHTML(id, label, hint, step, val) {
    return '<div class="field"><label for="' + id + '">' + esc(label) + '</label>' +
      '<input type="number" id="' + id + '" step="' + (step || 'any') + '"' +
      (val != null && val !== '' ? ' value="' + esc(val) + '"' : '') + '>' +
      (hint ? '<p class="hint">' + esc(hint) + '</p>' : '') + '</div>';
  }

  function render() {
    const mount = document.getElementById('perox-dose');
    if (!mount) return;

    const st = stats();
    const sp = feSpec();
    const fromLive = liveFe();
    const targetHint = sp
      ? t('perox.d.rangeHint', { hi: sp.max != null ? sp.max : '—', crit: sp.critMax != null ? sp.critMax : '—' })
      : '';
    const defTarget = sp && sp.max != null ? sp.max : 1.0;
    const defCur = fromLive != null ? fromLive : (isFinite(st.lastFe) ? st.lastFe : '');

    // ---- prediction + summary card ----
    const predInputs =
      '<div class="grid g3">' +
        fieldHTML('px-cur', t('perox.d.curFe'), fromLive != null ? t('perox.d.curHintLive') : t('perox.d.curHint'), '0.05', defCur) +
        fieldHTML('px-tgt', t('perox.d.tgtFe'), targetHint, '0.05', defTarget) +
      '</div>' +
      '<div id="px-predict" class="fx-predict"></div>';

    const summary =
      '<div class="results">' +
        '<div class="res"><span class="rk">' + esc(t('perox.d.count')) + '</span>' +
          '<span class="rv">' + (st.n || 0) + '</span></div>' +
        '<div class="res"><span class="rk">' + esc(t('perox.d.avgFactor')) + '</span>' +
          '<span class="rv">' + (st.n ? st.mean.toFixed(1) : '—') + '<span class="u">L</span></span></div>' +
      '</div>' +
      (st.excluded ? '<p class="fx-basis">' + esc(t('flux.d.excludedNote', { n: st.excluded })) + '</p>' : '');

    // ---- log form (editor only) ----
    const chainFe = fromLive != null ? fromLive : (isFinite(st.lastFe) ? st.lastFe : '');
    const form = canEdit()
      ? '<div class="panel" style="margin-top:16px"><div class="panel-in" style="border-bottom:none">' +
          '<p class="panel-label">' + esc(t('perox.d.newTitle')) + '</p>' +
          '<div class="grid g3">' +
            fieldHTML('px-b', t('perox.d.feBefore'), '', '0.05', chainFe) +
            fieldHTML('px-a', t('perox.d.feAfter'), '', '0.05', '') +
            fieldHTML('px-l', t('perox.d.liters'), t('perox.d.litersHint'), '1', '') +
          '</div>' +
          '<div class="grid g3" style="margin-top:14px">' +
            fieldHTML('px-pct', t('perox.d.pct'), '', '1', 35) +
          '</div>' +
          '<label class="fx-check"><input type="checkbox" id="px-excl"> ' + esc(t('perox.d.exclude')) + '</label>' +
          '<div class="saverow" style="border-top:none;padding-top:14px">' +
            '<div class="field"><label>' + esc(t('flux.d.operator')) + '</label><input type="text" id="px-op" placeholder="' + esc(t('flux.d.name')) + '"></div>' +
            '<div class="field"><label>' + esc(t('flux.d.note')) + '</label><input type="text" id="px-note" placeholder="' + esc(t('flux.d.optional')) + '"></div>' +
            '<div><button class="btn" id="px-save">' + esc(t('flux.d.save')) + '</button></div>' +
          '</div>' +
          '<p id="px-msg" class="fx-msg"></p>' +
        '</div></div>'
      : '';

    // ---- history table ----
    const rows = list().slice().reverse().map(function (r) {
      const d = num(r.feBefore) - num(r.feAfter);
      const perFe = (isFinite(d) && d >= 0.05 && num(r.liters) > 0) ? (num(r.liters) / d).toFixed(1) : '—';
      const perCell = r.excludeFromModel
        ? '<span class="fx-tag">' + esc(t('flux.d.logOnly')) + '</span>'
        : perFe;
      return '<tr' + (r.excludeFromModel ? ' class="fx-excluded"' : '') + '>' +
        '<td class="num">' + esc(r.date || '') + '</td>' +
        '<td class="num">' + (isFinite(num(r.liters)) ? num(r.liters).toLocaleString() : '—') + '</td>' +
        '<td class="num">' + (isFinite(num(r.feBefore)) ? num(r.feBefore).toFixed(2) : '—') +
          ' → ' + (isFinite(num(r.feAfter)) ? num(r.feAfter).toFixed(2) : '—') + '</td>' +
        '<td class="num">' + (isFinite(num(r.pct)) ? num(r.pct) + '%' : '—') + '</td>' +
        '<td class="num">' + perCell + '</td>' +
        '<td>' + esc(r.operator || '—') + '</td>' +
        '<td>' + esc(r.note || '') + '</td>' +
        (canEdit() ? '<td><button class="btn mini danger" data-px-del="' + esc(r._k) + '">' + esc(t('flux.d.delete')) + '</button></td>' : '') +
      '</tr>';
    }).join('');

    const table = list().length
      ? '<div class="tablewrap" style="margin-top:16px"><table><thead><tr>' +
          '<th>' + esc(t('flux.d.col.date')) + '</th>' +
          '<th>' + esc(t('perox.d.col.liters')) + '</th>' +
          '<th>' + esc(t('perox.d.col.fe')) + '</th>' +
          '<th>' + esc(t('perox.d.col.pct')) + '</th>' +
          '<th>' + esc(t('perox.d.col.perFe')) + '</th>' +
          '<th>' + esc(t('flux.d.col.operator')) + '</th>' +
          '<th>' + esc(t('flux.d.col.note')) + '</th>' +
          (canEdit() ? '<th></th>' : '') +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<div class="lab-empty" style="margin-top:16px">' + esc(t('perox.d.empty')) + '</div>';

    mount.innerHTML =
      '<div class="sechead"><span class="secnum">٠</span><h2 class="sectitle">' + esc(t('perox.d.title')) + '</h2></div>' +
      '<p class="secsub">' + esc(t('perox.d.sub')) + '</p>' +
      '<div class="panel">' +
        '<div class="panel-in"><p class="panel-label">' + esc(t('perox.d.predictTitle')) + '</p>' + predInputs + '</div>' +
        '<div class="panel-out"><p class="panel-label">' + esc(t('perox.d.summaryTitle')) + '</p>' + summary + '</div>' +
      '</div>' +
      form + table;

    wire();
    updatePrediction();
  }

  /* ---------------- prediction (live) ---------------- */

  function updatePrediction() {
    const out = document.getElementById('px-predict');
    if (!out) return;
    const st = stats();
    const cur = num((document.getElementById('px-cur') || {}).value);
    const tgt = num((document.getElementById('px-tgt') || {}).value);

    if (!st.n) { out.innerHTML = '<div class="fx-note-empty">' + esc(t('perox.d.needData')) + '</div>'; return; }
    if (!isFinite(cur) || !isFinite(tgt)) { out.innerHTML = '<div class="fx-note-empty">' + esc(t('perox.d.enterFe')) + '</div>'; return; }
    if (tgt >= cur) { out.innerHTML = '<div class="fx-note-empty">' + esc(t('perox.d.tgtLower')) + '</div>'; return; }

    const d = cur - tgt;
    const rec = round(st.mean * d, 0.5);
    const lo = round(st.min * d, 0.5);
    const hi = round(st.max * d, 0.5);
    out.innerHTML =
      '<div class="res hero fx-rec"><span class="rk">' + esc(t('perox.d.recFor', { d: d.toFixed(2) })) + '</span>' +
        '<span class="rv">≈ ' + rec.toFixed(1) + '<span class="u">' + esc(t('flux.d.litersUnit')) + '</span></span></div>' +
      '<p class="fx-basis">' + esc(t('perox.d.basis', { n: st.n, lo: lo.toFixed(1), hi: hi.toFixed(1) })) + '</p>';
  }

  /* ---------------- wiring ---------------- */

  let wired = false;
  function wire() {
    ['px-cur', 'px-tgt'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el && !el.dataset.w) { el.dataset.w = '1'; el.addEventListener('input', updatePrediction); }
    });

    const save = document.getElementById('px-save');
    if (save && !save.dataset.w) { save.dataset.w = '1'; save.addEventListener('click', saveTreatment); }

    const mount = document.getElementById('perox-dose');
    if (mount && !wired) {
      wired = true;
      mount.addEventListener('click', function (ev) {
        const del = ev.target.closest('[data-px-del]');
        if (del) removeTreatment(del.getAttribute('data-px-del'));
      });
    }
  }

  function flash(msg, bad) {
    const el = document.getElementById('px-msg');
    if (!el) return;
    el.textContent = msg;
    el.style.color = bad ? 'var(--crit)' : 'var(--accent)';
    setTimeout(function () { if (el) el.textContent = ''; }, 3500);
  }

  function saveTreatment() {
    if (!canEdit()) { flash(t('flux.d.needAuth'), true); return; }
    const before = num((document.getElementById('px-b') || {}).value);
    const after = num((document.getElementById('px-a') || {}).value);
    const liters = num((document.getElementById('px-l') || {}).value);
    const pct = num((document.getElementById('px-pct') || {}).value);
    const op = ((document.getElementById('px-op') || {}).value || '').trim();
    const note = ((document.getElementById('px-note') || {}).value || '').trim();
    const excl = !!(document.getElementById('px-excl') || {}).checked;

    if (!isFinite(before) || !isFinite(after) || !isFinite(liters) || liters <= 0) {
      flash(t('perox.d.errRequired'), true); return;
    }
    if (after >= before) { flash(t('perox.d.errOrder'), true); return; }

    const dt = new Date();
    const rec = {
      ts: dt.toISOString(),
      date: dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()),
      feBefore: before, feAfter: after, liters: liters,
      pct: isFinite(pct) ? pct : null,
      excludeFromModel: excl,
      operator: op || null, note: note || null
    };
    database.ref('peroxide_treatments').push(rec)
      .then(function () { flash(t('flux.d.saved', { id: rec.date })); })
      .catch(function (e) { flash(t('flux.d.failed') + ' ' + (e.message || ''), true); });
  }

  function removeTreatment(key) {
    if (!canEdit()) return;
    if (!confirm(t('flux.d.confirmDel'))) return;
    database.ref('peroxide_treatments/' + key).remove()
      .catch(function (e) { flash(t('flux.d.failed') + ' ' + (e.message || ''), true); });
  }

  /* ---------------- data + refresh ---------------- */

  database.ref('peroxide_treatments').on('value', function (s) { treatments = s.val() || {}; render(); });
  // the same readings_log lab.js already keeps — reused so "current Fe"
  // always matches the flux tank's own trend chart, not a second copy.
  database.ref('readings_log').on('value', function (s) { readingsLog = s.val() || {}; render(); });
  if (window.I18N) I18N.onChange(render);
  document.addEventListener('DOMContentLoaded', render);

  window.KGCPeroxide = { _treatments: () => treatments, _stats: stats, render: render };
})();
