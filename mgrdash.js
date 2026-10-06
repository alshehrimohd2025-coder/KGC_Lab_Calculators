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
      const r = { kg: 0, zn: 0, rel: 0, dross: 0, days: 0, first: '', last: '', daily: [], drossDays: [], stopDays: [] };
      days.filter(pick).forEach(function (d) {
        const kg = num(d.dayTon) + num(d.nightTon);
        const zn = num(d.dayPct) / 100 * num(d.dayTon) + num(d.nightPct) / 100 * num(d.nightTon);
        r.rel += num(d.release); r.dross += num(d.dross);
        if (num(d.dross) > 0) r.drossDays.push({ date: d.date, kg: num(d.dross), rel: num(d.release) });
        if (!(num(d.dayTon) + num(d.nightTon) > 0) && num(d.release) > 0) r.stopDays.push({ date: d.date, rel: num(d.release) });
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

  const monthName = ym => {
    try {
      const en = document.documentElement.classList.contains('lang-en');
      return new Date(ym + '-01T00:00:00').toLocaleDateString(en ? 'en-GB' : 'ar-SA-u-ca-gregory-nu-latn', { month: 'long' });
    } catch (e) { return ym; }
  };

  /* A verdict on a month that has barely started is unfair to it -- two
     days against a full month, or a single drossing day. The arrow appears
     once the month has this many production days; before that the card
     says it is too early. */
  const MIN_DAYS = 7;

  /* last month | this month, side by side, one line of difference beneath */
  function card(title, unit, digits, W, key, lowerIsBetter, why, total) {
    const v = r => r && r.kg && r[key] != null ? r[key] : null;
    const cv = v(W.C), pv = v(W.P);
    // total: optional (period) => text with the period's absolute quantity
    const col = (lbl, val, days, now, r) => '<div class="mg-col' + (now ? ' now' : '') + '"><span class="mg-col-k">' + esc(lbl) + '</span>' +
      '<span class="mg-col-v">' + (val != null ? fmt(val, digits) : '—') + '<small>' + esc(unit) + '</small></span>' +
      (total ? '<span class="mg-col-tot">' + total(r) + '</span>' : '') +
      '<span class="mg-col-d">' + esc(t('mg.days', { n: days })) + '</span></div>';
    let verdict;
    if (cv == null || pv == null) verdict = '';
    else if (W.C.days < MIN_DAYS) verdict = '<span class="mg-verdict mg-flat">' + esc(t('mg.early', { n: W.C.days, m: MIN_DAYS })) + '</span>';
    else {
      const d = cv - pv, pct = pv ? d / pv * 100 : 0;
      const bad = lowerIsBetter ? d > 0 : d < 0;
      verdict = Math.abs(pct) < 1.5
        ? '<span class="mg-verdict mg-flat">' + esc(t('mg.same')) + '</span>'
        : '<span class="mg-verdict mg-' + (bad ? 'up' : 'down') + '">' + (d > 0 ? '▲ ' : '▼ ') + fmt(Math.abs(d), digits) + ' ' +
          esc(unit) + ' (' + (d > 0 ? '+' : '−') + Math.abs(pct).toFixed(0) + '%)</span>';
    }
    return '<div class="mg-card"><span class="mg-k">' + esc(title) + '</span>' +
      '<div class="mg-pair">' + col(monthName(W.prev), pv, W.P.days, false, W.P) + col(monthName(W.cur), cv, W.C.days, true, W.C) + '</div>' +
      verdict + (why && W.C.days < MIN_DAYS ? '<p class="mg-why">' + esc(why) + '</p>' : '') + '</div>';
  }

  /* Why an early-month figure looks high, from the month's own records:
     a drossing or a refill on a stop day lands in full on the few tonnes
     produced so far. */
  function reasons(W) {
    const C = W.C, tns = fmt(C.kg / 1000);
    const day = ds => ds.map(x => Number(x.date.slice(8))).join(t('mg.and'));
    const out = {};
    if (C.drossDays.length) {
      out.dross = t('mg.why.dross', { kg: fmt(C.drossDays.reduce((a, x) => a + x.kg, 0)), d: day(C.drossDays), t: tns, n: C.days });
    }
    if (C.stopDays.length) {
      out.added = t('mg.why.added', { kg: fmt(C.stopDays.reduce((a, x) => a + x.rel, 0)), d: day(C.stopDays), t: tns });
    }
    out.cons = t('mg.why.early', { n: C.days });
    out.prod = C.stopDays.length ? t('mg.why.prod', { d: day(C.stopDays) }) : t('mg.why.early', { n: C.days });
    return out;
  }

  function render() {
    const mount = document.getElementById('mgr-kpis');
    if (!mount) return;
    const W = windows();
    if (!W) { mount.innerHTML = ''; return; }
    const why = reasons(W);
    mount.innerHTML = '<div class="mg-grid">' +
      card(t('mg.cons'), 'kg/t', 1, W, 'cons', true, why.cons) +
      card(t('mg.prod'), 't', 1, W, 'perDay', false, why.prod) +
      card(t('mg.added'), 'kg/t', 1, W, 'relT', true, why.added || why.cons) +
      card(t('mg.dross'), 'kg/t', 1, W, 'drossT', true, why.dross || why.cons, function (r) {
        // the weighed total behind the rate, and how many times it was taken out
        return '<b>' + fmt(r.dross) + '</b> ' + esc(t('mg.kgTotal')) +
          (r.drossDays.length ? '<small>' + esc(t('mg.drossTimes', { n: r.drossDays.length, d: r.drossDays.map(x => Number(x.date.slice(8))).join('، ') })) + '</small>' : '');
      }) +
      '</div><p class="mg-foot">' + esc(t('mg.foot')) + '</p>';
  }

  database.ref('zinc_daily').on('value', () => setTimeout(render, 0));
  if (window.I18N && I18N.onChange) I18N.onChange(render);
  window.KGCMgr = { render: render };
})();
