/* ============================================================
   Tank specifications — the single source of truth for limits
   ------------------------------------------------------------
   Every operating range, optimum and critical threshold lives here
   (or in Firebase, which overrides these defaults). Nothing else in
   the app should hard-code a limit: the dashboard colouring, the
   standards page and the bath-health module all ask this engine.

   A parameter may define any of:
     min / max        operating range  -> outside it = warning
     critMin / critMax hard limits     -> beyond it  = critical
     optimum          target value, shown but never enforced

   Overrides are stored at  tank_specs/<tankId>/params  so the plant
   can retune a limit from the Settings panel without a code change.

   Depends on globals from index.html:
     database, tanks, tankLabel(), IS_EDITOR, IS_AUTHED, I18N / t()
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[specs] Firebase database is not available.');
    return;
  }

  const ACID = [
    { key: 'acidPercent', min: 8,    max: 20,   unit: '% w/w' },
    { key: 'fe',          min: 80,   max: 140,  critMax: 150, unit: 'g/L' },
    { key: 'baume',       min: 18,   max: 24,   unit: '°Be' },
    { key: 'sg',          min: 1.15, max: 1.25 }
  ];

  const DEFAULT_SPECS = {
    // 1 — Acidic Degreasing (ATC-AD20)
    1: [
      { key: 'conc', min: 8,    max: 15,  unit: '% v/v' },
      { key: 'sg',   min: 1.05, max: 1.10 },
      { key: 'temp', min: 20,   max: 40,  optimum: 35, unit: '°C' }
    ],
    // 2 — Rinse (before acid)
    2: [
      { key: 'ph', min: 5.5, max: 8.0 },
      { key: 'ec', max: 3000, unit: 'µS/cm' }
    ],
    // 3-6 — HCl acid tanks 1..4
    3: ACID, 4: ACID, 5: ACID, 6: ACID,
    // 8 — Rinse 1 after acid, monitored like an acid tank (per plant request)
    8: ACID,
    // 7 — Stripping acid
    7: [
      { key: 'acidPercent', min: 8, max: 20, unit: '% w/w' },
      { key: 'zn', max: 120, unit: 'g/L' },
      { key: 'fe', max: 50,  unit: 'g/L' }
    ],
    // 9 — Rinse 2, before flux
    9: [
      { key: 'ph', min: 5.5, max: 7.0, optimum: 6.5 },
      { key: 'fe', max: 0.5,  unit: 'g/L' },
      { key: 'ec', max: 1500, unit: 'µS/cm' }
    ],
    // 10 — Flux FL-01
    10: [
      { key: 'salt',  min: 400,  max: 550,  unit: 'g/L' },
      { key: 'ph',    min: 4.0,  max: 5.0,  optimum: 4.8 },
      { key: 'baume', min: 15,   max: 20,   unit: '°Be' },
      { key: 'sg',    min: 1.13, max: 1.18 },
      { key: 'fe',    max: 1.0,  critMax: 5.0, unit: 'g/L' }
    ]
  };

  const EDITABLE = ['min', 'max', 'critMin', 'critMax', 'optimum'];

  /* A parameter the plant has no instrument for is not a bath running out of
     spec — it is a measurement that cannot be taken. Reporting the two the
     same way blames the process for a procurement gap, and buries the real
     breaches among readings that were never possible to make. This flag keeps
     them apart, and is stored per parameter alongside the limits. */
  const FLAGS = ['unavailable'];

  let overrides = {};   // tankId -> [param, ...]

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /** Effective spec for a tank: stored overrides win over the defaults. */
  function paramsFor(tankId) {
    const base = DEFAULT_SPECS[tankId];
    if (!base) return [];
    const saved = overrides[tankId];
    return base.map(function (p) {
      const hit = saved && saved.find ? saved.find(x => x && x.key === p.key) : null;
      if (!hit) return p;
      const merged = Object.assign({}, p);
      EDITABLE.forEach(function (f) {
        if (hit[f] !== undefined && hit[f] !== null && hit[f] !== '') merged[f] = Number(hit[f]);
        else if (hit[f] === null) delete merged[f];
      });
      FLAGS.forEach(function (f) { merged[f] = !!hit[f]; });
      return merged;
    });
  }

  const hasSpec = tankId => !!DEFAULT_SPECS[tankId];

  /** Compare one reading against its parameter limits. */
  function evaluate(value, p) {
    if (p && p.unavailable) return { tier: 'na' };
    const v = Number(value);
    if (!isFinite(v) || value === null || value === '' || v === 0) return { tier: 'none' };
    if (p.critMax != null && v >= p.critMax) return { tier: 'crit' };
    if (p.critMin != null && v <= p.critMin) return { tier: 'crit' };
    if (p.max != null && v > p.max) return { tier: 'warn' };
    if (p.min != null && v < p.min) return { tier: 'warn' };
    return { tier: 'good' };
  }

  const RANK = { none: -1, good: 0, warn: 1, crit: 2 };

  /** Worst status across every specified parameter of a tank. */
  function tankStatus(tank) {
    if (!tank || !hasSpec(tank.id)) return null;
    let worst = null;
    paramsFor(tank.id).forEach(function (p) {
      const r = evaluate(tank[p.key], p);
      if (r.tier === 'none' || r.tier === 'na') return;
      if (!worst || RANK[r.tier] > RANK[worst.tier]) worst = r;
    });
    return worst;
  }

  /** "8 – 20", "≤ 3000", "≥ 5" — plus the optimum when one is set. */
  function rangeText(p) {
    let s;
    if (p.min != null && p.max != null) s = p.min + ' – ' + p.max;
    else if (p.max != null) s = '≤ ' + p.max;
    else if (p.min != null) s = '≥ ' + p.min;
    else s = '—';
    if (p.unit) s += ' ' + p.unit;
    if (p.optimum != null) s += ' · ' + t('spec.optimum') + ' ' + p.optimum;
    return s;
  }

  function critText(p) {
    if (p.critMax != null) return '≥ ' + p.critMax + (p.unit ? ' ' + p.unit : '');
    if (p.critMin != null) return '≤ ' + p.critMin + (p.unit ? ' ' + p.unit : '');
    return '';
  }

  const TIER_VAR = { good: '--accent', warn: '--warn', crit: '--crit', na: '--ink-3' };
  const tierColor = tier => TIER_VAR[tier] ? 'var(' + TIER_VAR[tier] + ')' : 'var(--ink-3)';

  /* A thin range bar for one reading: the green band is the operating range,
     red ticks are the critical limits, the dot is where the reading sits.
     Drawn left-to-right (low to high) whatever the page direction, so it reads
     like the numbers beside it. Empty when the parameter has no range. */
  function gauge(value, p) {
    if (!p || p.unavailable || (p.min == null && p.max == null)) return '';
    const v = Number(value), has = isFinite(v) && value !== null && value !== '' && v !== 0;
    const pts = [p.min, p.max, p.critMin, p.critMax].filter(x => x != null);
    if (has) pts.push(v);
    let lo = Math.min.apply(null, pts), hi = Math.max.apply(null, pts);
    const core = (p.min != null && p.max != null) ? (p.max - p.min) : Math.max(Math.abs(p.max != null ? p.max : p.min), 1);
    lo -= core * 0.35; hi += core * 0.35;
    if (lo < 0) lo = 0;
    const pos = x => Math.max(0, Math.min(100, (x - lo) / (hi - lo) * 100));
    const bandL = p.min != null ? pos(p.min) : 0, bandR = p.max != null ? pos(p.max) : 100;
    const r = evaluate(value, p);
    const needle = r.tier === 'good' ? 'var(--ink)' : tierColor(r.tier);
    const dot = has ? '<i class="rg-dot" style="left:' + pos(v).toFixed(1) + '%;background:' + needle + '"></i>' : '';
    // three plain zones: green = in range, amber = out of range, red = past the critical limit
    const zone = (a, b, cls) => b - a > 0 ? '<i class="' + cls + '" style="left:' + a.toFixed(1) + '%;width:' + (b - a).toFixed(1) + '%"></i>' : '';
    return '<span class="rg" dir="ltr" aria-hidden="true">' +
      zone(bandL, Math.max(bandR, bandL + 2), 'rg-band') +
      (p.critMin != null ? zone(0, pos(p.critMin), 'rg-crit') : '') +
      (p.critMax != null ? zone(pos(p.critMax), 100, 'rg-crit') : '') + dot + '</span>';
  }

  function badge(tier) {
    if (tier === 'na') {
      return '<span class="sp-badge sp-na">' + esc(t('spec.noInstrument')) + '</span>';
    }
    if (!tier || tier === 'none') {
      return '<span class="sp-badge" style="color:var(--ink-3);border-color:var(--line);background:var(--recess)">' +
        esc(t('spec.noReading')) + '</span>';
    }
    const c = tierColor(tier);
    return '<span class="sp-badge" style="color:' + c + ';border-color:' + c + '66;background:' + c + '1a">' +
      esc(t('spec.tier.' + tier)) + '</span>';
  }

  const paramLabel = key => {
    const k = 'f.' + key;
    const out = t(k);
    return out === k ? key : out;
  };

  /* ---------------- detail cards (standards page) ---------------- */

  function detailCard(tank) {
    const ps = paramsFor(tank.id);
    if (!ps.length) return '';
    const worst = tankStatus(tank);
    const edge = worst ? tierColor(worst.tier) : 'var(--line)';

    const rows = ps.map(function (p) {
      const raw = tank[p.key];
      const r = evaluate(raw, p);
      const col = r.tier === 'none' ? 'var(--ink-3)' : tierColor(r.tier);
      const shown = (raw === undefined || raw === null || raw === '' || Number(raw) === 0)
        ? '—' : Number(raw).toFixed(2).replace(/\.00$/, '');
      const crit = critText(p);
      return '<div class="sp-row">' +
        '<div class="sp-p">' +
          '<span class="sp-name">' + esc(paramLabel(p.key)) + '</span>' +
          '<span class="sp-range">' + esc(rangeText(p)) +
            (crit ? ' <b class="sp-crit">' + esc(t('spec.critical')) + ' ' + esc(crit) + '</b>' : '') +
          '</span>' +
        '</div>' +
        '<div class="sp-val" style="color:' + col + '">' + shown + '</div>' +
        '<div class="sp-st">' + badge(r.tier) + '</div>' +
      '</div>';
    }).join('');

    return '<div class="sp-card" style="border-top-color:' + edge + '">' +
      '<div class="sp-head">' +
        '<span class="sp-num">' + tank.id + '</span>' +
        '<span class="sp-title">' + esc(tankLabel(tank.name)) + '</span>' +
        badge(worst ? worst.tier : 'none') +
      '</div>' + rows + '</div>';
  }

  function renderDetails() {
    const mount = document.getElementById('std-live');
    if (!mount || typeof tanks === 'undefined') return;
    mount.innerHTML = tanks.slice()
      .sort((a, b) => a.id - b.id)
      .filter(tk => hasSpec(tk.id))
      .map(detailCard)
      .join('');
  }

  /* ---------------- settings editor ---------------- */

  function renderEditor() {
    const mount = document.getElementById('spec-editor');
    if (!mount || typeof tanks === 'undefined') return;

    const opts = tanks.slice().sort((a, b) => a.id - b.id).filter(tk => hasSpec(tk.id))
      .map(tk => '<option value="' + tk.id + '">' + esc(tankLabel(tk.name)) + '</option>').join('');

    const prev = mount.querySelector('#spec-tank');
    const chosen = prev ? Number(prev.value) : (tanks.find(tk => hasSpec(tk.id)) || {}).id;

    const ps = paramsFor(chosen);
    const fields = ps.map(function (p) {
      const cell = f => '<td><input type="number" step="any" data-key="' + esc(p.key) + '" data-f="' + f +
        '" value="' + (p[f] != null ? p[f] : '') + '" placeholder="—"></td>';
      return '<tr' + (p.unavailable ? ' class="sp-off"' : '') + '>' +
        '<td class="name">' + esc(paramLabel(p.key)) + (p.unit ? ' <small style="color:var(--ink-3)">' + esc(p.unit) + '</small>' : '') + '</td>' +
        cell('min') + cell('max') + cell('critMin') + cell('critMax') + cell('optimum') +
        '<td><input type="checkbox" data-key="' + esc(p.key) + '" data-f="unavailable"' +
          (p.unavailable ? ' checked' : '') + ' aria-label="' + esc(t('spec.noInstrument')) + '"></td>' +
      '</tr>';
    }).join('');

    mount.innerHTML =
      '<div class="sp-edit-bar">' +
        '<select id="spec-tank">' + opts + '</select>' +
        '<button class="btn" id="spec-save">' + esc(t('spec.save')) + '</button>' +
        '<button class="btn ghost" id="spec-reset">' + esc(t('spec.reset')) + '</button>' +
        '<span id="spec-msg"></span>' +
      '</div>' +
      '<div class="tablewrap"><table><thead><tr>' +
        '<th>' + esc(t('spec.param')) + '</th>' +
        '<th>' + esc(t('spec.min')) + '</th><th>' + esc(t('spec.max')) + '</th>' +
        '<th>' + esc(t('spec.critMin')) + '</th><th>' + esc(t('spec.critMax')) + '</th>' +
        '<th>' + esc(t('spec.optimum')) + '</th>' +
        '<th title="' + esc(t('spec.noInstrumentHelp')) + '">' + esc(t('spec.noInstrumentCol')) + '</th>' +
      '</tr></thead><tbody>' + fields + '</tbody></table></div>';

    const sel = mount.querySelector('#spec-tank');
    if (sel) { sel.value = String(chosen); sel.addEventListener('change', renderEditor); }

    mount.querySelector('#spec-save').addEventListener('click', function () {
      if (!IS_EDITOR || !IS_AUTHED) return;
      const id = Number(mount.querySelector('#spec-tank').value);
      const out = paramsFor(id).map(function (p) {
        const rec = { key: p.key };
        EDITABLE.forEach(function (f) {
          const inp = mount.querySelector('[data-key="' + p.key + '"][data-f="' + f + '"]');
          const v = inp && inp.value !== '' ? Number(inp.value) : null;
          rec[f] = (v != null && isFinite(v)) ? v : null;
        });
        FLAGS.forEach(function (f) {
          const inp = mount.querySelector('[data-key="' + p.key + '"][data-f="' + f + '"]');
          rec[f] = !!(inp && inp.checked);
        });
        return rec;
      });
      database.ref('tank_specs/' + id + '/params').set(out)
        .then(() => flash(t('spec.saved')))
        .catch(e => flash(t('spec.failed') + ' ' + e.message, true));
    });

    mount.querySelector('#spec-reset').addEventListener('click', function () {
      if (!IS_EDITOR || !IS_AUTHED) return;
      if (!confirm(t('spec.confirmReset'))) return;
      const id = Number(mount.querySelector('#spec-tank').value);
      database.ref('tank_specs/' + id).remove().then(() => flash(t('spec.wasReset')));
    });

    function flash(msg, bad) {
      const el = mount.querySelector('#spec-msg');
      if (!el) return;
      el.textContent = msg;
      el.style.color = bad ? 'var(--crit)' : 'var(--accent)';
      setTimeout(function () { el.textContent = ''; }, 3500);
    }
  }

  function renderAll() { renderDetails(); renderEditor(); }

  /* ---------------- wiring ---------------- */

  database.ref('tank_specs').on('value', function (snap) {
    const v = snap.val() || {};
    overrides = {};
    Object.keys(v).forEach(function (id) {
      if (v[id] && v[id].params) overrides[id] = v[id].params;
    });
    renderAll();
    // limits changed, so every status shown elsewhere has to be recomputed
    if (typeof renderAll === 'function' && typeof window.renderTanksAll === 'function') window.renderTanksAll();
    if (window.KGCLab) window.KGCLab.render();
  });
  database.ref('tanks_data').on('value', renderAll);
  if (window.I18N) I18N.onChange(renderAll);
  document.addEventListener('DOMContentLoaded', renderAll);

  window.KGCSpecs = {
    paramsFor: paramsFor,
    hasSpec: hasSpec,
    evaluate: evaluate,
    tankStatus: tankStatus,
    rangeText: rangeText,
    gauge: gauge,
    tierColor: tierColor,
    badge: badge,
    render: renderAll,
    /** Parameters with no instrument, per tank — a procurement gap, not a breach. */
    unavailable: function () {
      const out = [];
      Object.keys(DEFAULT_SPECS).forEach(function (id) {
        const miss = paramsFor(Number(id)).filter(p => p.unavailable);
        if (miss.length) out.push({ tankId: Number(id), params: miss.map(p => paramLabel(p.key)) });
      });
      return out;
    },
    // Fe limits are needed by the bath-health projection
    feLimits: function (tankId) {
      const p = paramsFor(tankId).find(x => x.key === 'fe');
      if (!p) return null;
      return { warn: p.max != null ? p.max : null, crit: p.critMax != null ? p.critMax : null };
    }
  };
})();
