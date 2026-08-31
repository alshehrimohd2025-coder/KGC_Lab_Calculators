/* ============================================================
   Operating standards — live alerts for the acid tanks + flux
   ------------------------------------------------------------
   Renders the "current status" cards on the Standards page from
   the SAME `tanks` data the dashboard uses (Fe g/L from titration,
   Free Acid % from the acid calculator's "save to tank"). No new
   lab step: it reads what the lab already measures.

   Depends on globals defined in index.html:
     tanks, tankLabel(), database, I18N / t()
   Loads after index.html's tanks script, so `tanks` is populated.
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[standards] Firebase database is not available.');
    return;
  }

  // Acid tanks + stripping, then flux — in factory process order.
  const TRACKED_IDS = [3, 4, 5, 6, 7, 10];

  // Maps a production-tracker tank key to the dashboard tank id it refers to,
  // so throughput (kg processed) can be shown as context — informational only.
  const PROD_TANK_MAP = { acid_1: 3, acid_2: 4, acid_3: 5, acid_4: 6, stripping: 7 };

  /* ---------------- HCl aqueous density (real physical data, 20°C) ----------------
     Used to convert the measured Free Acid % (by weight) into g/L accurately,
     instead of assuming density = 1.0 (which understates g/L by ~5-8%). */
  const HCL_DENSITY = [
    [0, 1.000], [2, 1.009], [4, 1.019], [6, 1.029], [8, 1.039],
    [10, 1.049], [12, 1.059], [14, 1.069], [16, 1.079], [18, 1.089],
    [20, 1.098], [22, 1.108], [24, 1.119], [26, 1.129], [28, 1.139], [30, 1.149]
  ];

  function hclDensity(wtPercent) {
    const t = HCL_DENSITY;
    if (wtPercent <= t[0][0]) return t[0][1];
    if (wtPercent >= t[t.length - 1][0]) return t[t.length - 1][1];
    for (let i = 0; i < t.length - 1; i++) {
      const a = t[i], b = t[i + 1];
      if (wtPercent >= a[0] && wtPercent <= b[0]) {
        return a[1] + (b[1] - a[1]) * (wtPercent - a[0]) / (b[0] - a[0]);
      }
    }
    return 1.0;
  }

  function freeAcidGL(wtPercent) {
    const wt = Number(wtPercent) || 0;
    return wt / 100 * hclDensity(wt) * 1000;
  }

  // Three tiers, matching the color language already used across the site
  // (accent = good, warn = attention, crit = action needed).
  function feStatus(fe) {
    fe = Number(fe) || 0;
    if (fe <= 0) return null;
    if (fe < 120) return { tier: 'good', key: 'std.stage.good' };
    if (fe < 150) return { tier: 'warn', key: 'std.stage.warn' };
    return { tier: 'crit', key: 'std.stage.crit' };
  }

  function acidStatus(wt) {
    wt = Number(wt) || 0;
    if (wt <= 0) return null;
    if (wt < 10) return { tier: 'warn', key: 'std.band.low' };
    if (wt <= 16) return { tier: 'good', key: 'std.band.target' };
    if (wt <= 20) return { tier: 'warn', key: 'std.band.wide' };
    return { tier: 'crit', key: 'std.band.high' };
  }

  const TIER_VAR = { good: '--accent', warn: '--warn', crit: '--crit' };

  function badge(status) {
    if (!status) return '<span class="std-badge" style="color:var(--ink-3); border-color:var(--line); background:var(--recess);">' + esc(t('std.noReading')) + '</span>';
    const v = 'var(' + TIER_VAR[status.tier] + ')';
    return '<span class="std-badge" style="color:' + v + '; border-color:' + v + '66; background:' + v + '1a;">' + esc(t(status.key)) + '</span>';
  }

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function throughputByTank() {
    const sums = {};
    try {
      const batches = (window.KGCProduction && window.KGCProduction._batches) ? window.KGCProduction._batches() : {};
      Object.values(batches).forEach(b => {
        const w = Number(b && b.weight) || 0;
        if (!w || !b.segments) return;
        const seenTanks = new Set();
        b.segments.forEach(s => {
          if (s && s.tank && PROD_TANK_MAP[s.tank] != null) seenTanks.add(PROD_TANK_MAP[s.tank]);
        });
        seenTanks.forEach(id => { sums[id] = (sums[id] || 0) + w; });
      });
    } catch (e) { /* production tracker not loaded yet — throughput just stays blank */ }
    return sums;
  }

  function cardHTML(tank, throughput) {
    const isFlux = tank.id === 10;
    const acid = acidStatus(tank.acidPercent);
    const fe = feStatus(tank.fe);
    const gl = tank.acidPercent > 0 ? Math.round(freeAcidGL(tank.acidPercent)) : null;
    const kg = throughput[tank.id];

    const rows = [];
    if (!isFlux) {
      rows.push(
        '<div class="std-row"><span class="std-k">' + esc(t('std.freeAcid')) + '</span>' +
        '<span class="std-v">' + Number(tank.acidPercent || 0).toFixed(2) + '%' +
        (gl ? ' <small>(' + esc(t('std.asGL')) + ' ' + gl + ' g/L)</small>' : '') + '</span></div>' +
        '<div class="std-row"><span></span>' + badge(acid) + '</div>'
      );
    }
    rows.push(
      '<div class="std-row"><span class="std-k">' + esc(t('std.dissolvedFe')) + '</span>' +
      '<span class="std-v">' + Number(tank.fe || 0).toFixed(1) + ' g/L</span></div>' +
      '<div class="std-row"><span></span>' + badge(fe) + '</div>'
    );
    if (kg) {
      rows.push('<div class="std-row"><span class="std-k">' + esc(t('std.throughput')) + '</span>' +
        '<span class="std-v">' + Math.round(kg).toLocaleString() + ' kg</span></div>');
    }

    const worst = [acid, fe].filter(Boolean).reduce((w, s) => {
      const rank = { good: 0, warn: 1, crit: 2 };
      return !w || rank[s.tier] > rank[w.tier] ? s : w;
    }, null);
    const edge = worst ? 'var(' + TIER_VAR[worst.tier] + ')' : 'var(--line)';

    return '<div class="std-card" style="border-top-color:' + edge + '">' +
      '<div class="std-name"><span class="tank-num" style="display:inline-grid;place-items:center;width:22px;height:22px;font-size:11px;border-radius:6px;border:1px solid var(--line-strong);margin-left:8px;">' + tank.id + '</span>' + esc(tankLabel(tank.name)) + '</div>' +
      rows.join('') +
      '</div>';
  }

  function render() {
    const mount = document.getElementById('std-live');
    if (!mount || typeof tanks === 'undefined') return;
    const kgByTank = throughputByTank();
    const cards = TRACKED_IDS
      .map(id => tanks.find(x => x.id === id))
      .filter(Boolean)
      .map(tank => cardHTML(tank, kgByTank))
      .join('');
    mount.innerHTML = cards;
  }

  // Live on tank data changes (own listener — doesn't touch the dashboard's).
  database.ref('tanks_data').on('value', render);
  // Live on production batches too, so throughput updates as batches finish.
  database.ref('production/batches').on('value', render);
  // Re-render on language change (badges + labels are localized).
  if (window.I18N) I18N.onChange(render);
})();
