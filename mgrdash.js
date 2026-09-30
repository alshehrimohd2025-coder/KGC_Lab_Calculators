/* ============================================================
   Manager's summary — measured figures only
   ------------------------------------------------------------
   Everything here is weighed or read off the kettle, never inferred from
   handwritten thickness readings:
     - zinc consumption this month against last (level drop x 555 kg/cm,
       a factor that weighed ingots confirm to 0.3% over 52 days)
     - production tonnage (weighed)
     - zinc added (weighed ingots)
     - dross removed per tonne (weighed)
   Estimates built on the jig sheets (avoidable zinc, reactive steel,
   re-pass) stay on the engineer's zinc-balance page with their confidence
   beside them, and do not appear here.

   Depends on globals from index.html: database, t(), and window.KGCZinc.
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') return;

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const fmt = (v, d) => Number(v).toLocaleString(undefined, { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 });

  function months() {
    const Z = window.KGCZinc;
    const days = Object.values((Z && Z._days && Z._days()) || {}).filter(d => d && d.date).sort((a, b) => a.date < b.date ? -1 : 1);
    const m = {};
    days.forEach(function (d) {
      const k = d.date.slice(0, 7);
      const r = m[k] = m[k] || { kg: 0, zn: 0, rel: 0, dross: 0, days: 0, last: '', daily: [] };
      const kg = num(d.dayTon) + num(d.nightTon);
      const zn = num(d.dayPct) / 100 * num(d.dayTon) + num(d.nightPct) / 100 * num(d.nightTon);
      r.rel += num(d.release); r.dross += num(d.dross);
      if (kg > 0 && zn > 0) {
        r.kg += kg; r.zn += zn; r.days++; if (d.date > r.last) r.last = d.date;
        r.daily.push({ date: d.date, v: zn / kg * 1000 });
      }
    });
    const keys = Object.keys(m).filter(k => m[k].kg > 0).sort();
    if (!keys.length) return null;
    return { keys: keys, m: m };
  }

  /* daily kg/t for the month, with last month's average as a dashed line */
  function spark(daily, prevAvg) {
    if (daily.length < 2) return '';
    const W = 220, H = 44, pad = 3;
    const vals = daily.map(d => d.v).concat(prevAvg != null ? [prevAvg] : []);
    const lo = Math.min(...vals) - 2, hi = Math.max(...vals) + 2;
    const x = i => pad + i * (W - 2 * pad) / (daily.length - 1);
    const y = v => H - pad - (v - lo) / (hi - lo) * (H - 2 * pad);
    const pts = daily.map((d, i) => x(i).toFixed(1) + ',' + y(d.v).toFixed(1)).join(' ');
    return '<svg class="mg-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' +
      esc(t('mg.sparkAria')) + '">' +
      (prevAvg != null ? '<line x1="0" x2="' + W + '" y1="' + y(prevAvg).toFixed(1) + '" y2="' + y(prevAvg).toFixed(1) +
        '" class="mg-spark-ref"/>' : '') +
      '<polyline points="' + pts + '" class="mg-spark-line"/>' +
      daily.map((d, i) => '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(d.v).toFixed(1) + '" r="1.6" class="mg-spark-dot"><title>' +
        esc(d.date + ': ' + fmt(d.v, 1) + ' kg/t') + '</title></circle>').join('') +
      '</svg>';
  }

  const card = (k, v, unit, sub, extra) =>
    '<div class="mg-card"><span class="mg-k">' + esc(k) + '</span>' +
    '<span class="mg-v">' + v + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</span>' +
    (extra || '') + (sub ? '<span class="mg-sub">' + esc(sub) + '</span>' : '') + '</div>';

  function trend(cur, prev, prevKey, lowerIsBetter, digits) {
    if (prev == null || !prev) return '';
    const d = cur - prev;
    const pct = d / prev * 100;
    const bad = lowerIsBetter ? d > 0 : d < 0;
    const cls = Math.abs(pct) < 1.5 ? 'flat' : bad ? 'up' : 'down';
    return '<span class="mg-trend mg-' + cls + '">' + (d >= 0 ? '▲ ' : '▼ ') + fmt(Math.abs(d), digits) +
      ' ' + esc(t('mg.vsPrev', { m: prevKey, v: fmt(prev, digits) })) + '</span>';
  }

  function render() {
    const mount = document.getElementById('mgr-kpis');
    if (!mount) return;
    const M = months();
    if (!M) { mount.innerHTML = ''; return; }
    const ck = M.keys[M.keys.length - 1], pk = M.keys.length > 1 ? M.keys[M.keys.length - 2] : null;
    const c = M.m[ck], p = pk ? M.m[pk] : null;
    const cons = c.zn / c.kg * 1000, pcons = p ? p.zn / p.kg * 1000 : null;
    // month-to-date against the same number of days of last month would be fairer
    // for tonnage; per production day keeps it comparable while a month is open
    const perDay = c.kg / c.days / 1000, pPerDay = p ? p.kg / p.days / 1000 : null;
    const sub = t('mg.monthSub', { m: ck, n: c.days, d: c.last });

    mount.innerHTML = '<div class="mg-grid">' +
      card(t('mg.cons'), fmt(cons, 1), 'kg/t', sub,
        trend(cons, pcons, pk, true, 1) + spark(c.daily, pcons)) +
      card(t('mg.prod'), fmt(c.kg / 1000), 't', t('mg.prodSub', { v: fmt(perDay, 1) }),
        trend(perDay, pPerDay, pk, false, 1)) +
      card(t('mg.added'), fmt(c.rel / 1000, 1), 't', t('mg.addedSub', { v: fmt(c.rel / c.kg * 1000, 1) })) +
      card(t('mg.dross'), c.dross ? fmt(c.dross / c.kg * 1000, 1) : '0', 'kg/t',
        c.dross ? t('mg.drossSub', { v: fmt(c.dross) }) : t('mg.drossNone')) +
      '</div>' +
      '<p class="mg-foot">' + esc(t('mg.foot')) + '</p>';
  }

  database.ref('zinc_daily').on('value', () => setTimeout(render, 0));
  if (window.I18N && I18N.onChange) I18N.onChange(render);
  window.KGCMgr = { render: render };
})();
