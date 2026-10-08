/* ============================================================
   Replacement forecasting — when each bath is next due
   ------------------------------------------------------------
   The plant has kept a replacement schedule since 2023, and until now
   nothing read it except to show the last date. Mined, it turns out the
   intervals are regular: the acid tanks run 87-103 days with a standard
   deviation of 15-28, which is tight enough that the next change can be
   predicted rather than waited for.

   The forecast is deliberately plain — last replacement plus the mean
   interval, with the spread carried alongside as a confidence band. A
   fancier model would imply a precision eleven or twelve cycles cannot
   support, and would hide the one thing that matters: whether a bath is
   past its usual life.

   A tank is called overdue only past mean + one standard deviation, so
   ordinary variation is not flagged as a problem. On the current data
   that catches acid tank 1 at 142 days against its own 87-day average,
   and leaves the rest alone.

   Depends on globals from index.html: database, tanks, tankLabel(), t()
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[forecast] Firebase database is not available.');
    return;
  }

  const MIN_CYCLES = 3;          // fewer than this and an average means little
  const RESETS = { renewal: 1, cleaning: 1 };
  const MAX_SANE_DAYS = 400;     // a longer gap is a record gap, not a cycle

  let renewals = {};

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pad = n => (n < 10 ? '0' : '') + n;
  const dayKey = d => { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const parse = s => new Date(s + 'T00:00:00');
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return dayKey(d); };

  /* ---------------- the model ---------------- */

  /** Replacement dates for one tank, oldest first. */
  function datesFor(tankId) {
    const out = [];
    Object.values(renewals || {}).forEach(function (r) {
      if (!r || Number(r.tankId) !== tankId || !RESETS[r.type] || !r.date) return;
      out.push(r.date);
    });
    return out.sort();
  }

  /** Interval statistics, and the forecast that follows from them. */
  function forecast(tankId) {
    const ds = datesFor(tankId);
    if (ds.length < 2) return null;

    const iv = [];
    for (let i = 1; i < ds.length; i++) {
      const d = daysBetween(ds[i - 1], ds[i]);
      if (d > 0 && d < MAX_SANE_DAYS) iv.push(d);
    }
    if (iv.length < MIN_CYCLES) return { state: 'insufficient', have: iv.length, need: MIN_CYCLES, last: ds[ds.length - 1] };

    const mean = iv.reduce((s, v) => s + v, 0) / iv.length;
    const sd = Math.sqrt(iv.reduce((s, v) => s + (v - mean) * (v - mean), 0) / iv.length);
    const last = ds[ds.length - 1];
    const since = daysBetween(last, dayKey());
    const due = addDays(last, Math.round(mean));
    const remaining = Math.round(mean - since);

    /* Recent behaviour against the long-run average: a run of shorter cycles
       means the bath is being spent faster than history suggests. */
    const recent = iv.slice(-3);
    const recentMean = recent.reduce((s, v) => s + v, 0) / recent.length;
    const drift = recentMean < mean * 0.8 ? 'faster'
                : recentMean > mean * 1.25 ? 'slower' : 'steady';

    // one standard deviation of grace before calling a bath late
    const tier = since > mean + sd ? 'crit'
               : since >= mean - sd ? 'warn' : 'good';

    return {
      state: 'ok', n: iv.length, mean: mean, sd: sd,
      min: Math.min.apply(null, iv), max: Math.max.apply(null, iv),
      last: last, since: since, due: due, remaining: remaining,
      earliest: addDays(last, Math.round(mean - sd)),
      latest: addDays(last, Math.round(mean + sd)),
      recentMean: recentMean, drift: drift, tier: tier
    };
  }

  /** Every tank with a usable forecast, soonest due first. */
  function all() {
    if (typeof tanks === 'undefined') return [];
    return tanks.map(function (tk) {
      const f = forecast(tk.id);
      return f && f.state === 'ok' ? { tank: tk, f: f } : null;
    }).filter(Boolean).sort((a, b) => a.f.remaining - b.f.remaining);
  }

  /** The same list in plant line order (tank ids run along the line:
      degreasing 1, acid 1-4, ... flux 10) — how the cards are laid out. */
  function byLine() {
    return all().sort((a, b) => a.tank.id - b.tank.id);
  }

  /** Baths past their usual life — read by the attention panel. */
  function overdue() {
    return all().filter(x => x.f.tier !== 'good').map(function (x) {
      return {
        name: tankLabel(x.tank.name), tier: x.f.tier,
        since: x.f.since, mean: Math.round(x.f.mean),
        remaining: x.f.remaining, due: x.f.due
      };
    });
  }

  /* ---------------- rendering ---------------- */

  const TIER = { good: 'var(--accent)', warn: 'var(--warn)', crit: 'var(--crit)' };

  function render() {
    const mount = document.getElementById('forecast-body');
    if (!mount) return;
    const list = all();  // soonest first, for the "next up" figure

    if (!list.length) {
      mount.innerHTML = '<div class="lab-empty">' + esc(t('fc.empty', { n: MIN_CYCLES })) + '</div>';
      return;
    }

    const late = list.filter(x => x.f.tier === 'crit').length;
    const soon = list.filter(x => x.f.tier === 'warn').length;
    const stat = (k, v, unit, hot) =>
      '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span>' +
      '<span class="v">' + v + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</span></div>';

    const cards = byLine().map(function (x) {
      const f = x.f, c = TIER[f.tier];
      const when = f.remaining < 0
        ? t('fc.overdueBy', { n: Math.abs(f.remaining) })
        : t('fc.inDays', { n: f.remaining });
      return '<div class="lab-life t-' + f.tier + '">' +
        '<div class="lab-life-name">' + esc(tankLabel(x.tank.name)) + '</div>' +
        '<div class="lab-life-big" style="color:' + c + '">' + esc(when) + '</div>' +
        '<div class="lab-life-sub">' +
          esc(t('fc.dueOn', { d: f.due })) + '<br>' +
          esc(t('fc.window', { a: f.earliest, b: f.latest })) + '<br>' +
          esc(t('fc.basis', { n: f.n, m: Math.round(f.mean), s: Math.round(f.sd) })) +
          (f.drift !== 'steady' ? '<br><b style="color:var(--warn)">' + esc(t('fc.drift.' + f.drift, { r: Math.round(f.recentMean) })) + '</b>' : '') +
        '</div>' +
      '</div>';
    }).join('');

    mount.innerHTML =
      '<div class="pt-stats">' +
        stat(t('fc.tracked'), list.length) +
        stat(t('fc.late'), late, '', late > 0) +
        stat(t('fc.soon'), soon, '', soon > 0) +
        stat(t('fc.nextUp'), list[0] ? esc(tankLabel(list[0].tank.name)) : '—') +
      '</div>' +
      '<div class="lab-life-grid">' + cards + '</div>';
  }

  /* ---------------- wiring ---------------- */

  database.ref('renewals').on('value', s => { renewals = s.val() || {}; render(); });
  database.ref('tanks_data').on('value', render);
  if (window.I18N) I18N.onChange(render);
  document.addEventListener('DOMContentLoaded', render);

  window.KGCForecast = { forecast: forecast, all: all, byLine: byLine, overdue: overdue, render: render };
})();
