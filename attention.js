/* ============================================================
   "Needs your attention" — one place that tells you what to act on
   ------------------------------------------------------------
   Everything the site knows already lived on seven separate pages, so a
   problem was only found by someone going to look for it: shift breaches
   went unnoticed for weeks, a batch sat open since August, and a tank can
   read green off a number nobody has re-measured in a month.

   This panel pulls those signals together and ranks them. It reads from the
   modules that already own each dataset rather than re-deriving anything,
   and it writes nothing.

   Depends on globals from index.html: database, tanks, tankLabel(), t()
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[attention] Firebase database is not available.');
    return;
  }

  // A reading older than this is treated as no longer representing the bath.
  const STALE_DAYS = 3, VERY_STALE_DAYS = 7;
  // How long a batch may stay open before it is worth asking about.
  const BATCH_STUCK_HOURS = 12;
  // Zinc breaches are only interesting while they are recent.
  const ZINC_WINDOW_DAYS = 7;
  const PCT_MIN = 4, PCT_MAX = 9;

  let inventory = {};

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const pad = n => (n < 10 ? '0' : '') + n;
  const dayKey = d => { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

  /* ---------------- collectors ----------------
     Each returns [{sev, icon, title, detail}] with sev 2 = act now, 1 = watch. */

  /** Readings that fall outside the tank's own operating standards. */
  function outOfSpec() {
    const SP = window.KGCSpecs;
    if (!SP || typeof tanks === 'undefined') return [];
    const out = [];
    tanks.forEach(function (tk) {
      if (!SP.hasSpec(tk.id)) return;
      const bad = [];
      SP.paramsFor(tk.id).forEach(function (p) {
        const r = SP.evaluate(tk[p.key], p);
        if (r.tier === 'warn' || r.tier === 'crit') {
          bad.push({ tier: r.tier, label: t('f.' + p.key), value: Number(tk[p.key]), range: SP.rangeText(p) });
        }
      });
      if (!bad.length) return;
      const worst = bad.some(x => x.tier === 'crit') ? 'crit' : 'warn';
      out.push({
        cat: 'spec',
        sev: worst === 'crit' ? 2 : 1,
        icon: worst === 'crit' ? '⛔' : '⚠',
        title: tankLabel(tk.name),
        detail: bad.map(x => x.label + ' ' + fmt(x.value) + ' (' + x.range + ')').join(' · ')
      });
    });
    return out;
  }

  const fmt = v => (!isFinite(v) ? '—' : String(Math.round(v * 100) / 100));

  /** Tanks whose latest reading is old enough that the status may be fiction. */
  function staleReadings() {
    const L = window.KGCLab, SP = window.KGCSpecs;
    if (!L || !L.daysSinceReading || !SP || typeof tanks === 'undefined') return [];
    const out = [];
    tanks.forEach(function (tk) {
      if (!SP.hasSpec(tk.id)) return;
      const info = L.daysSinceReading(tk.id);
      if (!info) return;                      // no history yet — nothing to judge
      if (info.days < STALE_DAYS) return;
      out.push({
        cat: 'stale',
        sev: info.days >= VERY_STALE_DAYS ? 2 : 1,
        icon: '◷',
        title: tankLabel(tk.name),
        detail: t('att.staleFor', { n: info.days }) + ' · ' + info.date
      });
    });
    return out;
  }

  /** Zinc consumption breaches in the recent past, counted per shift. */
  function zincBreaches() {
    const Z = window.KGCZinc;
    if (!Z || !Z._days) return [];
    const days = Z._days() || {};
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - ZINC_WINDOW_DAYS);
    const from = dayKey(cutoff);
    const hits = [];
    Object.values(days).forEach(function (d) {
      if (!d || !d.date || d.date < from) return;
      const bad = [];
      if (d.dayPct > 0 && (d.dayPct < PCT_MIN || d.dayPct > PCT_MAX)) bad.push(t('zn.shift.day') + ' ' + d.dayPct.toFixed(2) + '%');
      if (d.nightPct > 0 && (d.nightPct < PCT_MIN || d.nightPct > PCT_MAX)) bad.push(t('zn.shift.night') + ' ' + d.nightPct.toFixed(2) + '%');
      if (bad.length) hits.push({ date: d.date, txt: bad.join(' · ') });
    });
    if (!hits.length) return [];
    hits.sort((a, b) => a.date < b.date ? 1 : -1);
    return [{
      cat: 'zinc', sev: 2, icon: '⚡',
      title: t('att.zincTitle', { n: hits.length, d: ZINC_WINDOW_DAYS }),
      detail: hits.slice(0, 3).map(h => h.date + ': ' + h.txt).join(' · ') +
              (hits.length > 3 ? ' …' : '')
    }];
  }

  /** Batches still open far longer than a batch should take. */
  function stuckBatches() {
    const P = window.KGCProduction;
    if (!P || !P._batches) return [];
    let list = [];
    try { list = Object.values(P._batches() || {}); } catch (e) { return []; }
    const out = [];
    list.forEach(function (b) {
      if (!b || b.status !== 'active' || !b.startTs) return;
      const hrs = (Date.now() - b.startTs) / 3600000;
      if (hrs < BATCH_STUCK_HOURS) return;
      const segs = Array.isArray(b.segments) ? b.segments : [];
      const open = segs.find(s => s && !s.endTs);
      const stage = open ? (t('pt.stage.' + open.stageKey) === 'pt.stage.' + open.stageKey
        ? (open.stageName || open.stageKey) : t('pt.stage.' + open.stageKey)) : '—';
      out.push({
        cat: 'batch', sev: hrs >= 24 ? 2 : 1, icon: '⏱',
        title: t('att.batchStuck', { n: b.batchNumber || '—' }),
        detail: t('att.stuckFor', { h: Math.round(hrs) }) + ' · ' + stage
      });
    });
    return out;
  }

  /** Chemicals at or below the minimum the plant set for them. */
  function lowStock() {
    const out = [];
    Object.keys(inventory).forEach(function (k) {
      const it = inventory[k];
      if (!it) return;
      const qty = Number(it.qty) || 0, min = Number(it.min) || 0;
      if (!min || qty > min) return;
      const name = t('lab.item.' + k) === 'lab.item.' + k ? k : t('lab.item.' + k);
      out.push({
        cat: 'stock', sev: qty === 0 ? 2 : 1, icon: '▤',
        title: name,
        detail: t('att.stockLeft', { q: qty, u: it.unit || '' })
      });
    });
    return out;
  }

  /** Baths projected to reach the critical iron level soon. */
  function bathLife() {
    const L = window.KGCLab;
    if (!L || !L.lifeEstimate || typeof tanks === 'undefined') return [];
    const out = [];
    tanks.forEach(function (tk) {
      let e;
      try { e = L.lifeEstimate(tk.id); } catch (err) { return; }
      if (!e || e.state !== 'ok') return;
      const d = e.daysToCrit != null ? e.daysToCrit : e.daysToWarn;
      if (d == null || d > 14) return;
      out.push({
        cat: 'life', sev: d <= 7 ? 2 : 1, icon: '◔',
        title: tankLabel(tk.name),
        detail: t('att.lifeLeft', { n: Math.max(0, d) })
      });
    });
    return out;
  }

  /** Instruments whose calibration has lapsed or is about to. */
  function calibration() {
    const K = window.KGCKettle;
    if (!K || !K.calibrationAlerts) return [];
    return K.calibrationAlerts().map(function (a) {
      return {
        cat: 'calib',
        sev: a.tier === 'crit' ? 2 : 1,
        icon: '⚙',
        title: a.name,
        detail: (a.days < 0 ? t('att.calOverdue', { n: Math.abs(a.days) }) : t('att.calSoon', { n: a.days })) + ' · ' + a.due
      };
    });
  }

  /** Baths past, or close to, their usual replacement interval. */
  function dueForChange() {
    const F = window.KGCForecast;
    if (!F || !F.overdue) return [];
    return F.overdue().map(function (o) {
      return {
        cat: 'forecast',
        sev: o.tier === 'crit' ? 2 : 1,
        icon: '⟳',
        title: o.name,
        detail: o.tier === 'crit'
          ? t('att.fcOverdue', { m: o.mean, n: o.since })
          : t('att.fcSoon', { d: o.due })
      };
    });
  }

  /* ---------------- rendering ---------------- */

  function render() {
    const mount = document.getElementById('attention');
    if (!mount) return;

    let items = [];
    [outOfSpec, staleReadings, zincBreaches, stuckBatches, lowStock, bathLife, calibration, dueForChange]
      .forEach(function (fn) { try { items = items.concat(fn() || []); } catch (e) { console.warn('[attention]', e); } });

    if (!items.length) {
      mount.innerHTML =
        '<div class="att-clear"><span class="att-ok">✓</span>' + esc(t('att.allClear')) + '</div>';
      return;
    }

    items.sort((a, b) => b.sev - a.sev);
    const acts = items.filter(i => i.sev === 2).length;

    // grouped so one tank appearing under two headings still reads clearly
    const ORDER = ['spec', 'zinc', 'life', 'forecast', 'batch', 'stale', 'stock', 'calib'];
    const groups = ORDER.map(function (c) {
      return { cat: c, list: items.filter(i => i.cat === c) };
    }).filter(g => g.list.length);

    mount.innerHTML =
      '<div class="att-head">' +
        '<span class="att-title">' + esc(t('att.title')) + '</span>' +
        '<span class="att-count' + (acts ? ' hot' : '') + '">' + items.length + '</span>' +
      '</div>' +
      groups.map(function (g) {
        return '<div class="att-group">' +
          '<div class="att-cat">' + esc(t('att.cat.' + g.cat)) + '</div>' +
          '<div class="att-list">' +
            g.list.map(function (i) {
              return '<div class="att-item sev-' + i.sev + '">' +
                '<span class="att-ico">' + i.icon + '</span>' +
                '<span class="att-body"><b>' + esc(i.title) + '</b>' +
                  '<span>' + esc(i.detail) + '</span></span>' +
              '</div>';
            }).join('') +
          '</div></div>';
      }).join('');
  }

  /* ---------------- wiring ---------------- */

  database.ref('inventory').on('value', s => { inventory = s.val() || {}; render(); });
  database.ref('tanks_data').on('value', render);
  database.ref('readings_log').on('value', render);
  database.ref('zinc_daily').on('value', render);
  database.ref('production/batches').on('value', render);
  database.ref('tank_specs').on('value', render);
  database.ref('calibration').on('value', render);
  // the forecast and bath-life alerts are both derived from the renewal log
  database.ref('renewals').on('value', render);
  if (window.I18N) I18N.onChange(render);
  document.addEventListener('DOMContentLoaded', render);
  setInterval(render, 300000);   // keeps the "open for N hours" figures honest

  window.KGCAttention = { render: render, _items: () => null };
})();
