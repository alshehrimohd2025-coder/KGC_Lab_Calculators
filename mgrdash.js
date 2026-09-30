/* ============================================================
   Manager's summary — four figures above the tank cards
   ------------------------------------------------------------
   Only what leads to a decision, in process units, not money:
     1. zinc consumption this month against last (kg/t)
     2. avoidable excess zinc from over-thick coating (kg, an estimate)
     3. customers whose reactive steel took the most zinc
     4. re-pass tonnage and its share of production
   1 comes from the production report; 2-4 from the jig sheets, over
   whatever period has been imported, and each card names its period.

   Depends on globals from index.html: database, t(), and on
   window.KGCZinc (zinc.js) and window.KGCZincBal (zincbal.js).
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') return;

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const fmt = (v, d) => Number(v).toLocaleString(undefined, { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 });

  /* consumption per month from the production report */
  function monthly() {
    const Z = window.KGCZinc;
    const days = Object.values((Z && Z._days && Z._days()) || {}).filter(d => d && d.date);
    const m = {};
    days.forEach(function (d) {
      const kg = num(d.dayTon) + num(d.nightTon);
      const zn = num(d.dayPct) / 100 * num(d.dayTon) + num(d.nightPct) / 100 * num(d.nightTon);
      if (!(kg > 0) || !(zn > 0)) return;
      const k = d.date.slice(0, 7);
      const r = m[k] = m[k] || { kg: 0, zn: 0, days: 0, last: '' };
      r.kg += kg; r.zn += zn; r.days++; if (d.date > r.last) r.last = d.date;
    });
    const keys = Object.keys(m).sort();
    if (!keys.length) return null;
    const cur = m[keys[keys.length - 1]], prev = keys.length > 1 ? m[keys[keys.length - 2]] : null;
    return { curKey: keys[keys.length - 1], prevKey: keys.length > 1 ? keys[keys.length - 2] : null,
             cur: cur.zn / cur.kg * 1000, curDays: cur.days, curLast: cur.last,
             prev: prev ? prev.zn / prev.kg * 1000 : null };
  }

  const card = (k, v, unit, sub, extra) =>
    '<div class="mg-card"><span class="mg-k">' + esc(k) + '</span>' +
    '<span class="mg-v">' + v + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</span>' +
    (extra || '') + (sub ? '<span class="mg-sub">' + esc(sub) + '</span>' : '') + '</div>';

  function render() {
    const mount = document.getElementById('mgr-kpis');
    if (!mount) return;
    const mo = monthly();
    const B = window.KGCZincBal && window.KGCZincBal._compute ? window.KGCZincBal._compute() : null;
    const cards = [];

    if (mo) {
      let arrow = '';
      if (mo.prev != null) {
        const d = mo.cur - mo.prev;
        // more zinc per tonne is the bad direction
        const cls = Math.abs(d) < 1 ? 'flat' : d > 0 ? 'up' : 'down';
        arrow = '<span class="mg-trend mg-' + cls + '">' + (d >= 0 ? '▲ ' : '▼ ') + fmt(Math.abs(d), 1) +
          ' ' + esc(t('mg.vsPrev', { m: mo.prevKey, v: fmt(mo.prev, 1) })) + '</span>';
      }
      cards.push(card(t('mg.cons'), fmt(mo.cur, 1), 'kg/t',
        t('mg.consSub', { m: mo.curKey, n: mo.curDays, d: mo.curLast }), arrow));
    }

    if (B && B.P && !B.empty) {
      const P = B.P, period = t('mg.period', { a: B.first, b: B.last });
      cards.push(card(t('mg.avoid'), fmt(P.avoid), 'kg',
        t('mg.avoidSub', { pt: fmt(P.avoid / (P.kg / 1000), 1) }) + ' · ' + period));

      const top = Object.keys(B.reactCust).map(k => Object.assign({ cust: k }, B.reactCust[k]))
        .sort((a, b) => b.extra - a.extra).slice(0, 3);
      if (top.length) {
        const list = '<ul class="mg-list">' + top.map(r =>
          '<li><b>' + esc(r.cust) + '</b><span dir="ltr">' + fmt(r.kg / 1000, 1) + ' t · ' +
          (r.mKg ? fmt(r.muKg / r.mKg) + ' µm · ' : '') + fmt(r.extra) + ' kg</span></li>').join('') + '</ul>';
        cards.push(card(t('mg.react'), '', '', t('mg.reactSub') + ' · ' + period, list));
      }

      cards.push(card(t('mg.repass'), fmt(P.repassKg / 1000, 1), 't',
        t('mg.repassSub', { p: (P.repassKg / P.kg * 100).toFixed(1), zn: fmt(P.repassZn) }) + ' · ' + period));
    }

    mount.innerHTML = cards.length ? '<div class="mg-grid">' + cards.join('') + '</div>' : '';
  }

  database.ref('zinc_daily').on('value', () => setTimeout(render, 0));
  database.ref('jig_batches').on('value', () => setTimeout(render, 0));
  database.ref('zinc_losses').on('value', () => setTimeout(render, 0));
  if (window.I18N && I18N.onChange) I18N.onChange(render);
  window.KGCMgr = { render: render };
})();
