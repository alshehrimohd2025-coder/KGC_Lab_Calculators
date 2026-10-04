/* ============================================================
   Flux salt — how much to add to lift the Baumé, learned from the bath
   ------------------------------------------------------------
   The quantity that matters is how much dissolved salt raises the bath's
   density, so the model works in specific gravity, not in degrees Baumé:
     SG = 145 / (145 - Be)          (heavy-liquid Baumé scale)
     kg salt = (SG_target - SG_now) / s  x  V(m3)
   where s is the SG rise per kg of salt per m3 of bath (= per g/L).

   s comes from the plant's own additions: every logged addition with a
   Baumé reading before and after, in the same bath volume, gives one
   s_i = dSG / (kg / V). Working in SG per g/L rather than kg per degree
   keeps one addition comparable with another even when the bath was at a
   different Baumé or a different level.

   Until there are logged additions the page falls back to a published
   figure for zinc ammonium chloride flux (about 0.0005 SG per g/L: a
   1.15 bath holds roughly 300 g/L) and says plainly that it is a
   starting estimate. With one addition it uses that one and says so;
   from three it takes the median and shows the spread as its confidence.

   Data lives at flux_salt_additions/<pushId>. Writes need the editor login.
   Depends on globals from index.html: database, IS_EDITOR, IS_AUTHED, t()
   and optionally window.KGCSpecs and the flux tank's latest reading.
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') return;

  const S_LITERATURE = 0.0005;      // SG per g/L, zinc ammonium chloride flux (published)
  const DEFAULT_V = 27720;          // litres, the flux bath (as in the dosing calculator)
  const FLUX_TANK = 10;

  let adds = {}, readings = {}, settings = {}, inv = null;
  const stock = () => inv && num(inv.qty) >= 0 ? { qty: num(inv.qty), min: num(inv.min) || 0 } : null;

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const num = v => { const n = Number(v); return v === '' || v == null || !isFinite(n) ? NaN : n; };
  const fmt = (v, d) => Number(v).toLocaleString(undefined, { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 });
  const canEdit = () => typeof IS_EDITOR !== 'undefined' && IS_EDITOR && typeof IS_AUTHED !== 'undefined' && IS_AUTHED;
  const sg = be => 145 / (145 - be);
  const be = g => 145 - 145 / g;
  const vol = () => num(settings.volumeL) > 0 ? num(settings.volumeL) : DEFAULT_V;

  function list() {
    return Object.keys(adds).map(k => Object.assign({ _k: k }, adds[k]))
      .filter(r => r && r.date).sort((a, b) => (a.ts || a.date) < (b.ts || b.date) ? -1 : 1);
  }
  /* one factor per addition that actually moved the Baumé */
  function factors() {
    return list().filter(r => !r.excludeFromModel).map(function (r) {
      const kg = num(r.kg), b0 = num(r.beBefore), b1 = num(r.beAfter);
      const V = num(r.volumeL) > 0 ? num(r.volumeL) : vol();
      if (!(kg > 0) || !isFinite(b0) || !isFinite(b1) || b1 - b0 < 0.3) return null;
      const s = (sg(b1) - sg(b0)) / (kg / (V / 1000));
      return { r: r, s: s, kgPerBe: kg / (b1 - b0), V: V };
    }).filter(Boolean);
  }
  /* The plant's own flux spec pairs a salt range with an SG range (400-550
     with 1.12-1.18), which implies its own SG-per-g/L. That is a better
     starting point than a textbook figure, and here it differs by ~40%
     (about 0.0003 against 0.0005), so it is used whenever the spec has both. */
  function theoryS() {
    try {
      const ps = window.KGCSpecs && window.KGCSpecs.paramsFor(FLUX_TANK);
      const salt = ps && ps.find(p => p.key === 'salt'), g = ps && ps.find(p => p.key === 'sg');
      if (salt && g && salt.min > 0 && salt.max > 0 && g.min > 1 && g.max > 1) {
        const s = ((g.min - 1) / salt.min + (g.max - 1) / salt.max) / 2;
        if (s > 0.0001 && s < 0.001) return { s: s, src: 'spec' };
      }
    } catch (e) {}
    return { s: S_LITERATURE, src: 'lit' };
  }

  function model() {
    const fs = factors();
    if (!fs.length) { const th = theoryS(); return { s: th.s, n: 0, conf: null, basis: 'theory', src: th.src }; }
    const ss = fs.map(f => f.s).sort((a, b) => a - b);
    const med = ss.length % 2 ? ss[(ss.length - 1) / 2] : (ss[ss.length / 2 - 1] + ss[ss.length / 2]) / 2;
    if (fs.length < 3) return { s: med, n: fs.length, conf: null, basis: 'few', fs: fs };
    // confidence from the spread of the plant's own factors around their median
    const mad = ss.map(x => Math.abs(x - med)).sort((a, b) => a - b);
    const spread = mad[Math.floor(mad.length / 2)] / med;
    return { s: med, n: fs.length, conf: Math.max(0, Math.min(99, 100 - spread * 150)), basis: 'plant',
             fs: fs, lo: ss[0], hi: ss[ss.length - 1] };
  }

  function latestBaume() {
    const rows = Object.values(readings || {}).filter(r => r && Number(r.tankId) === FLUX_TANK && num(r.baume) > 0)
      .sort((a, b) => a.date < b.date ? -1 : 1);
    return rows.length ? { v: num(rows[rows.length - 1].baume), date: rows[rows.length - 1].date } : null;
  }
  function baumeSpec() {
    try {
      const p = window.KGCSpecs && window.KGCSpecs.paramsFor(FLUX_TANK).find(x => x.key === 'baume');
      return p || null;
    } catch (e) { return null; }
  }

  /* ---------------- rendering ---------------- */

  const field = (id, label, hint, step, val, type) =>
    '<div class="field"><label for="' + id + '">' + esc(label) + '</label>' +
    '<input type="' + (type || 'number') + '" id="' + id + '"' + (step ? ' step="' + step + '"' : '') +
    ' value="' + esc(val == null ? '' : val) + '">' +
    (hint ? '<p class="hint">' + esc(hint) + '</p>' : '') + '</div>';

  function render() {
    const mount = document.getElementById('flux-salt');
    if (!mount) return;
    const M = model();
    const lb = latestBaume();
    const sp = baumeSpec();
    const tgtDef = sp ? (sp.optimum != null ? sp.optimum : (sp.min != null && sp.max != null ? (sp.min + sp.max) / 2 : 18)) : 18;
    const today = new Date().toISOString().slice(0, 10);
    const rows = list().slice().reverse();
    const fs = M.fs || [];

    const basis = M.basis === 'theory'
      ? '<span class="zb-conf zb-conf-lo">' + esc(t('fs.basis.theory')) + '</span>'
      : M.basis === 'few'
        ? '<span class="zb-conf zb-conf-mid">' + esc(t('fs.basis.few', { n: M.n })) + '</span>'
        : '<span class="zb-conf zb-conf-' + (M.conf >= 90 ? 'hi' : M.conf >= 70 ? 'mid' : 'lo') + '">' +
            esc(t('fs.basis.plant', { n: M.n, p: Math.round(M.conf) })) + '</span>';

    mount.innerHTML =
      '<div class="sechead"><span class="secnum">+</span><h2 class="sectitle">' + esc(t('fs.title')) + '</h2></div>' +
      '<p class="secsub">' + esc(t('fs.sub')) + '</p>' +

      '<p class="panel-label">' + esc(t('fs.calc')) + '</p>' +
      '<div class="grid g3">' +
        field('fs-cur', t('fs.cur'), lb ? t('fs.curHint', { d: lb.date }) : '', '0.1', lb ? lb.v : '') +
        field('fs-tgt', t('fs.tgt'), sp ? t('fs.tgtHint', { lo: sp.min, hi: sp.max }) : '', '0.1', tgtDef) +
        field('fs-vol', t('fs.vol'), t('fs.volHint'), '100', vol()) +
      '</div>' +
      '<div id="fs-out" class="fx-predict"></div>' +
      '<p class="fx-basis">' + basis + ' ' + esc(t('fs.basisNote.' + (M.basis === 'theory' ? 'theory.' + M.src : M.basis),
        { s: (M.s * 1000).toFixed(2) })) + '</p>' +
      (stock() ? '<p class="fx-basis">' + esc(t('fs.stock', { q: fmt(stock().qty), m: fmt(stock().min) })) + '</p>' : '') +

      '<p class="panel-label" style="margin-top:22px">' + esc(t('fs.log')) + '</p>' +
      '<p class="fx-basis">' + esc(t('fs.logHint')) + '</p>' +
      '<div class="grid g3">' +
        field('fs-date', t('fs.date'), '', '', today, 'date') +
        field('fs-kg', t('fs.kg'), t('fs.kgHint'), '1', '') +
        field('fs-vol2', t('fs.vol'), '', '100', vol()) +
      '</div>' +
      '<div class="grid g3" style="margin-top:14px">' +
        field('fs-b0', t('fs.b0'), '', '0.1', lb ? lb.v : '') +
        field('fs-b1', t('fs.b1'), t('fs.b1Hint'), '0.1', '') +
        field('fs-note', t('fs.note'), '', '', '', 'text') +
      '</div>' +
      '<label class="fx-check"><input type="checkbox" id="fs-excl"> ' + esc(t('fs.exclude')) + '</label>' +
      '<div class="saverow" style="border-top:none;padding-top:10px"><div><button class="btn" id="fs-save">' +
        esc(t('fs.save')) + '</button></div></div>' +
      '<p id="fs-msg" class="fx-msg"></p>' +

      (rows.length ? '<div class="tablewrap" style="margin-top:12px"><table><thead><tr>' +
        ['fs.date', 'fs.kg', 'fs.b0', 'fs.b1', 'fs.c.rise', 'fs.c.perBe', 'fs.note', ''].map(k => '<th>' + (k ? esc(t(k)) : '') + '</th>').join('') +
        '</tr></thead><tbody>' + rows.map(function (r) {
          const f = fs.find(x => x.r._k === r._k);
          const rise = num(r.beAfter) - num(r.beBefore);
          return '<tr' + (r.excludeFromModel ? ' style="opacity:.55"' : '') + '><td>' + esc(r.date) + '</td>' +
            '<td class="num">' + fmt(num(r.kg)) + '</td>' +
            '<td class="num">' + (isFinite(num(r.beBefore)) ? num(r.beBefore) : '—') + '</td>' +
            '<td class="num">' + (isFinite(num(r.beAfter)) ? num(r.beAfter) : '—') + '</td>' +
            '<td class="num">' + (isFinite(rise) ? (rise >= 0 ? '+' : '') + rise.toFixed(1) : '—') + '</td>' +
            '<td class="num">' + (f ? fmt(f.kgPerBe) : '—') + '</td>' +
            '<td>' + esc(r.note || '') + '</td>' +
            '<td>' + (canEdit() ? '<button class="btn mini danger" data-fs-del="' + esc(r._k) + '">' + esc(t('fs.del')) + '</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="fx-basis">' + esc(t('fs.empty')) + '</p>');

    wire(mount, M);
  }

  function predict(mount, M) {
    const out = mount.querySelector('#fs-out');
    if (!out) return;
    const b0 = num(mount.querySelector('#fs-cur').value);
    const b1 = num(mount.querySelector('#fs-tgt').value);
    const V = num(mount.querySelector('#fs-vol').value);
    if (!isFinite(b0) || !isFinite(b1) || !(V > 0)) { out.innerHTML = '<span class="fx-hint">' + esc(t('fs.need')) + '</span>'; return; }
    if (b1 <= b0) { out.innerHTML = '<span class="fx-hint">' + esc(t('fs.already')) + '</span>'; return; }
    const kg = (sg(b1) - sg(b0)) / M.s * (V / 1000);
    let range = '';
    if (M.basis === 'plant') {
      const a = (sg(b1) - sg(b0)) / M.hi * (V / 1000), b = (sg(b1) - sg(b0)) / M.lo * (V / 1000);
      range = esc(t('fs.range', { a: fmt(a), b: fmt(b) }));
    } else if (M.basis === 'theory') {
      range = esc(t('fs.rangeTheory', { a: fmt(kg * 0.7), b: fmt(kg * 1.3) }));
    }
    // add in steps: the first addition checks the factor before committing the rest
    const step = M.basis === 'plant' ? kg : kg * 0.6;
    out.innerHTML =
      '<div class="fs-res"><span class="rk">' + esc(t('fs.need.kg')) + '</span>' +
        '<span class="rv">' + fmt(kg) + '<span class="u">kg</span></span>' +
        (range ? '<span class="fx-hint">' + range + '</span>' : '') + '</div>' +
      '<div class="fs-res"><span class="rk">' + esc(t('fs.perBe')) + '</span>' +
        '<span class="rv">' + fmt(kg / (b1 - b0)) + '<span class="u">kg/°Bé</span></span></div>' +
      (M.basis !== 'plant' ? '<p class="fx-basis">' + esc(t('fs.stepAdvice', { a: fmt(step) })) + '</p>' : '');
  }

  function wire(mount, M) {
    ['#fs-cur', '#fs-tgt', '#fs-vol'].forEach(s => { const el = mount.querySelector(s); if (el) el.addEventListener('input', () => predict(mount, M)); });
    predict(mount, M);
    const msg = mount.querySelector('#fs-msg');
    const say = (m, bad) => { if (msg) { msg.textContent = m; msg.style.color = bad ? 'var(--crit)' : 'var(--accent)'; } };
    const save = mount.querySelector('#fs-save');
    if (save) save.addEventListener('click', function () {
      if (!canEdit()) { say(t('coat.needAuth'), true); return; }
      const v = id => (mount.querySelector(id) || {}).value;
      const kg = num(v('#fs-kg')), b0 = num(v('#fs-b0')), b1 = num(v('#fs-b1')), V = num(v('#fs-vol2'));
      const date = v('#fs-date');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) { say(t('fs.errDate'), true); return; }
      if (!(kg > 0)) { say(t('fs.errKg'), true); return; }
      if (isFinite(b0) && isFinite(b1) && b1 < b0) { say(t('fs.errOrder'), true); return; }
      const rec = { ts: new Date().toISOString(), date: date, kg: kg,
        beBefore: isFinite(b0) ? b0 : null, beAfter: isFinite(b1) ? b1 : null,
        volumeL: V > 0 ? V : null, excludeFromModel: !!(mount.querySelector('#fs-excl') || {}).checked,
        note: (v('#fs-note') || '').trim().slice(0, 120) || null };
      database.ref('flux_salt_additions').push(rec)
        // salt in the bath has left the store: keep the stock figure (and its
        // low-stock alert) true without anyone remembering to update it
        .then(() => database.ref('inventory/flux_salt/qty').transaction(q => Math.max(0, (Number(q) || 0) - kg)))
        .then(() => say(isFinite(b1) ? t('fs.saved') : t('fs.savedNoAfter')))
        .catch(e => say(t('coat.failed') + ' ' + e.message, true));
    });
    mount.querySelectorAll('[data-fs-del]').forEach(b => b.addEventListener('click', function () {
      if (!canEdit() || !confirm(t('fs.confirmDel'))) return;
      database.ref('flux_salt_additions/' + b.getAttribute('data-fs-del')).remove();
    }));
  }

  database.ref('flux_salt_additions').on('value', s => { adds = s.val() || {}; render(); });
  database.ref('readings_log').on('value', s => { readings = s.val() || {}; render(); });
  database.ref('fluxsalt_settings').on('value', s => { settings = s.val() || {}; render(); });
  database.ref('inventory/flux_salt').on('value', s => { inv = s.val() || null; render(); });
  if (window.I18N && I18N.onChange) I18N.onChange(render);
  window.KGCFluxSalt = { render: render, _model: model, _sg: sg, _be: be };
})();
