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

  /* Each card compares the same figure over three windows, stacked so the
     difference reads straight down: this month so far, last month in full,
     and the last 30 calendar days (which always has a month's worth of days,
     so it stays comparable in the first week of a month). Stop days with no
     tonnage still count for zinc added and dross, not for per-tonne rates. */
  function windows() {
    const Z = window.KGCZinc;
    const days = Object.values((Z && Z._days && Z._days()) || {}).filter(d => d && d.date)
      .sort((a, b) => a.date < b.date ? -1 : 1);
    if (!days.length) return null;
    const last = days[days.length - 1].date;
    const cur = last.slice(0, 7);
    const pd = new Date(cur + '-01T00:00:00'); pd.setMonth(pd.getMonth() - 1);
    const prev = pd.getFullYear() + '-' + String(pd.getMonth() + 1).padStart(2, '0');
    const c30 = new Date(last + 'T00:00:00'); c30.setDate(c30.getDate() - 29);
    const from30 = c30.toISOString().slice(0, 10);
    const agg = pick => {
      const r = { kg: 0, zn: 0, rel: 0, dross: 0, days: 0, first: '', last: '', daily: [] };
      days.filter(pick).forEach(function (d) {
        const kg = num(d.dayTon) + num(d.nightTon);
        const zn = num(d.dayPct) / 100 * num(d.dayTon) + num(d.nightPct) / 100 * num(d.nightTon);
        r.rel += num(d.release); r.dross += num(d.dross);
        if (kg > 0 && zn > 0) {
          r.kg += kg; r.zn += zn; r.days++;
          if (!r.first) r.first = d.date; r.last = d.date;
          r.daily.push({ date: d.date, v: zn / kg * 1000 });
        }
      });
      r.cons = r.kg ? r.zn / r.kg * 1000 : null;
      r.perDay = r.days ? r.kg / r.days / 1000 : null;
      r.relT = r.kg ? r.rel / r.kg * 1000 : null;
      r.drossT = r.kg ? r.dross / r.kg * 1000 : null;
      return r;
    };
    return { cur: cur, prev: prev, last: last,
             C: agg(d => d.date.slice(0, 7) === cur),
             P: agg(d => d.date.slice(0, 7) === prev),
             R: agg(d => d.date >= from30 && d.date <= last) };
  }

  /* daily kg/t over the last 30 days, last month's average as a dashed line */
  function spark(daily, ref) {
    if (daily.length < 2) return '';
    const W = 220, H = 44, pad = 3;
    const vals = daily.map(d => d.v).concat(ref != null ? [ref] : []);
    const lo = Math.min(...vals) - 2, hi = Math.max(...vals) + 2;
    const x = i => pad + i * (W - 2 * pad) / (daily.length - 1);
    const y = v => H - pad - (v - lo) / (hi - lo) * (H - 2 * pad);
    return '<svg class="mg-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' +
      esc(t('mg.sparkAria')) + '">' +
      (ref != null ? '<line x1="0" x2="' + W + '" y1="' + y(ref).toFixed(1) + '" y2="' + y(ref).toFixed(1) + '" class="mg-spark-ref"/>' : '') +
      '<polyline points="' + daily.map((d, i) => x(i).toFixed(1) + ',' + y(d.v).toFixed(1)).join(' ') + '" class="mg-spark-line"/>' +
      daily.map((d, i) => '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(d.v).toFixed(1) + '" r="1.6" class="mg-spark-dot"><title>' +
        esc(d.date + ': ' + fmt(d.v, 1) + ' kg/t') + '</title></circle>').join('') + '</svg>';
  }

  /* one card: the current month big, then last month and the last 30 days
     beneath it, each with its difference from the current month */
  /* lumpy = removed or topped up in batches (dross every ~2 weeks, ingots in
     bursts after a stop): a few days of a new month can hold a whole cycle,
     so the headline is the last 30 days and the months sit underneath. */
  const monthName = ym => {
    try {
      const lang = document.documentElement.classList.contains('lang-en') ? 'en' : 'ar';
      return new Date(ym + '-01T00:00:00').toLocaleDateString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { month: 'long' });
    } catch (e) { return ym; }
  };

  function card(title, unit, digits, W, key, lowerIsBetter, extra, lumpy) {
    const v = r => r && r[key] != null && (key !== 'cons' || r.kg) ? r[key] : null;
    const main = lumpy ? W.R : W.C;
    const cv = v(main);
    const diff = function (other) {
      if (lumpy || cv == null || other == null) return '';
      const d = cv - other, pct = other ? d / other * 100 : 0;
      if (Math.abs(pct) < 1.5) return '<span class="mg-trend mg-flat">=</span>';
      const bad = lowerIsBetter == null ? null : (lowerIsBetter ? d > 0 : d < 0);
      const cls = bad == null ? 'flat' : bad ? 'up' : 'down';
      return '<span class="mg-trend mg-' + cls + '">' + (d > 0 ? '▲ ' : '▼ ') + fmt(Math.abs(d), digits) + '</span>';
    };
    const row = (lbl, r, note) => '<div class="mg-row"><span>' + esc(lbl) +
      (note ? ' <small>' + esc(note) + '</small>' : '') + '</span><b>' +
      (v(r) != null ? fmt(v(r), digits) : '—') + '</b>' + diff(v(r)) + '</div>';
    return '<div class="mg-card"><span class="mg-k">' + esc(title) + '</span>' +
      '<span class="mg-v">' + (cv != null ? fmt(cv, digits) : '—') + '<small>' + esc(unit) + '</small></span>' +
      '<span class="mg-sub">' + esc(lumpy ? t('mg.last30Sub', { n: W.R.days }) : t('mg.curSub', { m: monthName(W.cur), n: W.C.days })) + '</span>' +
      (extra || '') +
      '<div class="mg-rows">' +
        (lumpy ? row(t('mg.thisMonth', { m: monthName(W.cur) }), W.C, t('mg.days', { n: W.C.days })) : '') +
        row(t('mg.prevMonth', { m: monthName(W.prev) }), W.P, W.P.days ? t('mg.days', { n: W.P.days }) : '') +
        (lumpy ? '' : row(t('mg.last30'), W.R, t('mg.days', { n: W.R.days }))) +
      '</div>' + (lumpy ? '<span class="mg-sub">' + esc(t('mg.lumpyNote')) + '</span>' : '') + '</div>';
  }

  function render() {
    const mount = document.getElementById('mgr-kpis');
    if (!mount) return;
    const W = windows();
    if (!W) { mount.innerHTML = ''; return; }
    const prevCons = W.P.kg ? W.P.cons : null;
    mount.innerHTML = '<div class="mg-grid">' +
      card(t('mg.cons'), 'kg/t', 1, W, 'cons', true, spark(W.R.daily, prevCons)) +
      card(t('mg.prod'), 't/' + t('mg.dayShort'), 1, W, 'perDay', false) +
      card(t('mg.added'), 'kg/t', 1, W, 'relT', true, '', true) +
      card(t('mg.dross'), 'kg/t', 1, W, 'drossT', true, '', true) +
      '</div><p class="mg-foot">' + esc(t('mg.foot')) + ' ' + esc(t('mg.diffNote')) + '</p>';
  }

  database.ref('zinc_daily').on('value', () => setTimeout(render, 0));
  if (window.I18N && I18N.onChange) I18N.onChange(render);
  window.KGCMgr = { render: render };
})();
