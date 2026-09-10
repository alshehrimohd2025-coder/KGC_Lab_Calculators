/* ============================================================
   Flux pH dosing — learned from the plant's own treatments
   ------------------------------------------------------------
   The theoretical stoichiometric calculator (further down the flux
   page) never matched reality, so this panel builds an EMPIRICAL
   model instead: every time ammonia is added to raise the flux pH,
   the operator logs how many litres moved the pH from A to B. From
   that history the panel computes the average dose efficiency
   (litres per +1.0 pH) and, given a current and target pH, predicts
   how much ammonia to prepare next time.

   Data lives at  flux_treatments/<pushId>  in Firebase, shared and
   synced like everything else. Writes require the editor login.

   Depends on globals from index.html:
     database, IS_EDITOR, IS_AUTHED, I18N / t(), KGCSpecs (optional)
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[flux] Firebase database is not available.');
    return;
  }

  let treatments = {};   // pushId -> record

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

  /** Treatments that count toward the prediction model (outliers such as
      emergency neutralisation from very low pH can be flagged out). */
  function modelList() { return list().filter(r => !r.excludeFromModel); }

  /** Litres of ammonia per +1.0 pH, one factor per treatment that
      actually raised the pH by a meaningful amount. */
  function factors() {
    return modelList().map(function (r) {
      const d = num(r.phAfter) - num(r.phBefore);
      const L = num(r.liters);
      if (!isFinite(d) || d < 0.05 || !isFinite(L) || L <= 0) return null;
      return { r: r, dPh: d, L: L, perPh: L / d };
    }).filter(Boolean);
  }

  function stats() {
    const logged = list().length;
    const excluded = list().filter(r => r.excludeFromModel).length;
    const fs = factors();
    if (!fs.length) return { n: 0, logged: logged, excluded: excluded,
      salt: list().reduce((s2, r) => s2 + (num(r.saltKg) || 0), 0) };
    const per = fs.map(f => f.perPh);
    const mean = per.reduce((s, v) => s + v, 0) / per.length;
    const min = Math.min.apply(null, per);
    const max = Math.max.apply(null, per);
    // average Baumé rise, informational only — model treatments only
    const beRises = modelList().map(r => num(r.beAfter) - num(r.beBefore)).filter(v => isFinite(v) && v > 0);
    const beMean = beRises.length ? beRises.reduce((s, v) => s + v, 0) / beRises.length : NaN;
    const lastAfter = modelList().map(r => num(r.phAfter)).filter(isFinite).pop();
    const salt = list().reduce((s2, r) => s2 + (num(r.saltKg) || 0), 0);
    return { n: fs.length, salt: salt, logged: logged, excluded: excluded, mean: mean, min: min, max: max, beMean: beMean, lastPh: lastAfter };
  }

  const round = (v, s) => Math.round(v / s) * s;

  /* ---------------- flux pH spec (for the target hint) ---------------- */

  function phSpec() {
    try {
      const p = window.KGCSpecs && window.KGCSpecs.paramsFor(10).find(x => x.key === 'ph');
      return p || null;
    } catch (e) { return null; }
  }

  /* ---------------- rendering ---------------- */

  function fieldHTML(id, label, hint, step, val) {
    return '<div class="field"><label for="' + id + '">' + esc(label) + '</label>' +
      '<input type="number" id="' + id + '" step="' + (step || 'any') + '"' +
      (val != null && val !== '' ? ' value="' + esc(val) + '"' : '') + '>' +
      (hint ? '<p class="hint">' + esc(hint) + '</p>' : '') + '</div>';
  }

  function render() {
    const mount = document.getElementById('flux-dose');
    if (!mount) return;

    const st = stats();
    const sp = phSpec();
    const targetHint = sp
      ? t('flux.d.rangeHint', {
          lo: sp.min != null ? sp.min : '—',
          hi: sp.max != null ? sp.max : '—',
          opt: sp.optimum != null ? sp.optimum : (sp.max != null ? sp.max : '—')
        })
      : '';
    const defTarget = sp && sp.optimum != null ? sp.optimum : 4.8;
    const defCur = isFinite(st.lastPh) ? st.lastPh : '';

    // ---- prediction + summary card ----
    const predInputs =
      '<div class="grid g3">' +
        fieldHTML('fx-cur', t('flux.d.curPh'), t('flux.d.curHint'), '0.05', defCur) +
        fieldHTML('fx-tgt', t('flux.d.tgtPh'), targetHint, '0.05', defTarget) +
      '</div>' +
      '<div id="fx-predict" class="fx-predict"></div>';

    const summary =
      '<div class="results">' +
        '<div class="res"><span class="rk">' + esc(t('flux.d.count')) + '</span>' +
          '<span class="rv">' + (st.n || 0) + '</span></div>' +
        '<div class="res"><span class="rk">' + esc(t('flux.d.avgFactor')) + '</span>' +
          '<span class="rv">' + (st.n ? st.mean.toFixed(1) : '—') + '<span class="u">L</span></span></div>' +
        '<div class="res"><span class="rk">' + esc(t('flux.d.avgBe')) + '</span>' +
          '<span class="rv">' + (isFinite(st.beMean) ? '+' + st.beMean.toFixed(2) : '—') + '</span></div>' +
        '<div class="res"><span class="rk">' + esc(t('flux.d.totalSalt')) + '</span>' +
          '<span class="rv">' + (st.salt ? st.salt.toLocaleString() : '—') + '<span class="u">kg</span></span></div>' +
      '</div>' +
      (st.excluded ? '<p class="fx-basis">' + esc(t('flux.d.excludedNote', { n: st.excluded })) + '</p>' : '');

    // ---- log form (editor only) ----
    const chainPh = isFinite(st.lastPh) ? st.lastPh : '';
    const form = canEdit()
      ? '<div class="panel" style="margin-top:16px"><div class="panel-in" style="border-bottom:none">' +
          '<p class="panel-label">' + esc(t('flux.d.newTitle')) + '</p>' +
          '<div class="grid g3">' +
            fieldHTML('fx-b', t('flux.d.phBefore'), '', '0.05', chainPh) +
            fieldHTML('fx-a', t('flux.d.phAfter'), '', '0.05', '') +
            fieldHTML('fx-l', t('flux.d.liters'), t('flux.d.litersHint'), '1', '') +
          '</div>' +
          '<div class="grid g3" style="margin-top:14px">' +
            fieldHTML('fx-beb', t('flux.d.beBefore'), '', '0.5', '') +
            fieldHTML('fx-bea', t('flux.d.beAfter'), '', '0.5', '') +
            fieldHTML('fx-pct', t('flux.d.pct'), '', '1', 25) +
          '</div>' +
          '<div class="grid g3" style="margin-top:14px">' +
            fieldHTML('fx-salt', t('flux.d.salt'), t('flux.d.saltHint'), '1', '') +
          '</div>' +
          '<label class="fx-check"><input type="checkbox" id="fx-excl"> ' + esc(t('flux.d.exclude')) + '</label>' +
          '<div class="saverow" style="border-top:none;padding-top:14px">' +
            '<div class="field"><label>' + esc(t('flux.d.operator')) + '</label><input type="text" id="fx-op" placeholder="' + esc(t('flux.d.name')) + '"></div>' +
            '<div class="field"><label>' + esc(t('flux.d.note')) + '</label><input type="text" id="fx-note" placeholder="' + esc(t('flux.d.optional')) + '"></div>' +
            '<div><button class="btn" id="fx-save">' + esc(t('flux.d.save')) + '</button></div>' +
          '</div>' +
          '<p id="fx-msg" class="fx-msg"></p>' +
        '</div></div>'
      : '';

    // ---- history table ----
    const rows = list().slice().reverse().map(function (r) {
      const d = num(r.phAfter) - num(r.phBefore);
      const perPh = (isFinite(d) && d >= 0.05 && num(r.liters) > 0) ? (num(r.liters) / d).toFixed(1) : '—';
      const be = (isFinite(num(r.beBefore)) && isFinite(num(r.beAfter)))
        ? (num(r.beBefore).toFixed(1) + ' → ' + num(r.beAfter).toFixed(1)) : '—';
      const perCell = r.excludeFromModel
        ? '<span class="fx-tag">' + esc(t('flux.d.logOnly')) + '</span>'
        : perPh;
      return '<tr' + (r.excludeFromModel ? ' class="fx-excluded"' : '') + '>' +
        '<td class="num">' + esc(r.date || '') + '</td>' +
        '<td class="num">' + (isFinite(num(r.liters)) ? num(r.liters).toLocaleString() : '—') + '</td>' +
        '<td class="num">' + (isFinite(num(r.phBefore)) ? num(r.phBefore).toFixed(2) : '—') +
          ' → ' + (isFinite(num(r.phAfter)) ? num(r.phAfter).toFixed(2) : '—') + '</td>' +
        '<td class="num">' + be + '</td>' +
        '<td class="num">' + (num(r.saltKg) ? num(r.saltKg).toLocaleString() : '—') + '</td>' +
        '<td class="num">' + perCell + '</td>' +
        '<td>' + esc(r.operator || '—') + '</td>' +
        '<td>' + esc(r.note || '') + '</td>' +
        (canEdit() ? '<td><button class="btn mini danger" data-fx-del="' + esc(r._k) + '">' + esc(t('flux.d.delete')) + '</button></td>' : '') +
      '</tr>';
    }).join('');

    const table = list().length
      ? '<div class="tablewrap" style="margin-top:16px"><table><thead><tr>' +
          '<th>' + esc(t('flux.d.col.date')) + '</th>' +
          '<th>' + esc(t('flux.d.col.liters')) + '</th>' +
          '<th>' + esc(t('flux.d.col.ph')) + '</th>' +
          '<th>' + esc(t('flux.d.col.be')) + '</th>' +
          '<th>' + esc(t('flux.d.col.salt')) + '</th>' +
        '<th>' + esc(t('flux.d.col.perPh')) + '</th>' +
          '<th>' + esc(t('flux.d.col.operator')) + '</th>' +
          '<th>' + esc(t('flux.d.col.note')) + '</th>' +
          (canEdit() ? '<th></th>' : '') +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<div class="lab-empty" style="margin-top:16px">' + esc(t('flux.d.empty')) + '</div>';

    mount.innerHTML =
      '<div class="sechead"><span class="secnum">٠</span><h2 class="sectitle">' + esc(t('flux.d.title')) + '</h2></div>' +
      '<p class="secsub">' + esc(t('flux.d.sub')) + '</p>' +
      '<div class="panel">' +
        '<div class="panel-in"><p class="panel-label">' + esc(t('flux.d.predictTitle')) + '</p>' + predInputs + '</div>' +
        '<div class="panel-out"><p class="panel-label">' + esc(t('flux.d.summaryTitle')) + '</p>' + summary + '</div>' +
      '</div>' +
      form + table;

    wire();
    updatePrediction();
  }

  /* ---------------- prediction (live) ---------------- */

  function updatePrediction() {
    const out = document.getElementById('fx-predict');
    if (!out) return;
    const st = stats();
    const cur = num((document.getElementById('fx-cur') || {}).value);
    const tgt = num((document.getElementById('fx-tgt') || {}).value);

    if (!st.n) { out.innerHTML = '<div class="fx-note-empty">' + esc(t('flux.d.needData')) + '</div>'; return; }
    if (!isFinite(cur) || !isFinite(tgt)) { out.innerHTML = '<div class="fx-note-empty">' + esc(t('flux.d.enterPh')) + '</div>'; return; }
    if (tgt <= cur) { out.innerHTML = '<div class="fx-note-empty">' + esc(t('flux.d.tgtHigher')) + '</div>'; return; }

    const d = tgt - cur;
    const rec = round(st.mean * d, 0.5);
    const lo = round(st.min * d, 0.5);
    const hi = round(st.max * d, 0.5);
    out.innerHTML =
      '<div class="res hero fx-rec"><span class="rk">' + esc(t('flux.d.recFor', { d: d.toFixed(2) })) + '</span>' +
        '<span class="rv">≈ ' + rec.toFixed(1) + '<span class="u">' + esc(t('flux.d.litersUnit')) + '</span></span></div>' +
      '<p class="fx-basis">' + esc(t('flux.d.basis', { n: st.n, lo: lo.toFixed(1), hi: hi.toFixed(1) })) + '</p>';
  }

  /* ---------------- wiring ---------------- */

  let wired = false;
  function wire() {
    // prediction inputs recompute live (delegated, so re-render is fine)
    ['fx-cur', 'fx-tgt'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el && !el.dataset.w) { el.dataset.w = '1'; el.addEventListener('input', updatePrediction); }
    });

    const save = document.getElementById('fx-save');
    if (save && !save.dataset.w) { save.dataset.w = '1'; save.addEventListener('click', saveTreatment); }

    const mount = document.getElementById('flux-dose');
    if (mount && !wired) {
      wired = true;
      mount.addEventListener('click', function (ev) {
        const del = ev.target.closest('[data-fx-del]');
        if (del) removeTreatment(del.getAttribute('data-fx-del'));
      });
    }
  }

  function flash(msg, bad) {
    const el = document.getElementById('fx-msg');
    if (!el) return;
    el.textContent = msg;
    el.style.color = bad ? 'var(--crit)' : 'var(--accent)';
    setTimeout(function () { if (el) el.textContent = ''; }, 3500);
  }

  function saveTreatment() {
    if (!canEdit()) { flash(t('flux.d.needAuth'), true); return; }
    const before = num((document.getElementById('fx-b') || {}).value);
    const after = num((document.getElementById('fx-a') || {}).value);
    const liters = num((document.getElementById('fx-l') || {}).value);
    const beB = num((document.getElementById('fx-beb') || {}).value);
    const beA = num((document.getElementById('fx-bea') || {}).value);
    const pct = num((document.getElementById('fx-pct') || {}).value);
    const op = ((document.getElementById('fx-op') || {}).value || '').trim();
    const note = ((document.getElementById('fx-note') || {}).value || '').trim();
    const excl = !!(document.getElementById('fx-excl') || {}).checked;
    const saltKg = num((document.getElementById('fx-salt') || {}).value);

    if (!isFinite(before) || !isFinite(after) || !isFinite(liters) || liters <= 0) {
      flash(t('flux.d.errRequired'), true); return;
    }
    if (after <= before) { flash(t('flux.d.errOrder'), true); return; }

    const dt = new Date();
    const rec = {
      ts: dt.toISOString(),
      date: dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()),
      phBefore: before, phAfter: after, liters: liters,
      beBefore: isFinite(beB) ? beB : null,
      beAfter: isFinite(beA) ? beA : null,
      ammoniaPct: isFinite(pct) ? pct : null,
      saltKg: isFinite(saltKg) && saltKg > 0 ? saltKg : null,
      excludeFromModel: excl,
      operator: op || null, note: note || null
    };
    database.ref('flux_treatments').push(rec)
      .then(function () { flash(t('flux.d.saved', { id: rec.date })); })
      .catch(function (e) { flash(t('flux.d.failed') + ' ' + (e.message || ''), true); });
  }

  function removeTreatment(key) {
    if (!canEdit()) return;
    if (!confirm(t('flux.d.confirmDel'))) return;
    database.ref('flux_treatments/' + key).remove()
      .catch(function (e) { flash(t('flux.d.failed') + ' ' + (e.message || ''), true); });
  }

  /* ---------------- data + refresh ---------------- */

  database.ref('flux_treatments').on('value', function (s) { treatments = s.val() || {}; render(); });
  if (window.I18N) I18N.onChange(render);
  document.addEventListener('DOMContentLoaded', render);

  window.KGCFlux = { _treatments: () => treatments, _stats: stats, render: render };
})();
