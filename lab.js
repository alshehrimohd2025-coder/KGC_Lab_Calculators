/* ============================================================
   Bath health & supplies — KGC galvanizing lab
   ------------------------------------------------------------
   Four things a process engineer needs that the daily readings
   alone don't answer:

     1. readings_log  — one row per tank per day, written
                        automatically whenever a value is edited.
                        This is what makes any trend possible;
                        without it every reading overwrites the last.
     2. Fe trend      — dissolved-iron curve per acid tank, drawn
                        only from readings taken SINCE the tank's
                        last renewal (a renewal resets the bath, so
                        mixing across one would flatten the slope
                        and badly overstate remaining life).
     3. Life estimate — least-squares slope on that segment,
                        projected to the 120 / 150 g/L limits.
     4. Renewals + inventory — the events and stock levels the
                        trend and the flux calculator depend on.

   Depends on globals from index.html:
     database, tanks, tankLabel(), IS_EDITOR, IS_AUTHED, I18N / t()
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[lab] Firebase database is not available.');
    return;
  }

  const ACID_IDS = [3, 4, 5, 6, 7];          // acid tanks + stripping
  // Fe limits come from the spec engine so they track any plant-side override.
  // The fallback (120/150) matches the original plant document.
  function feLimits(tankId) {
    if (window.KGCSpecs) {
      const lim = window.KGCSpecs.feLimits(tankId);
      if (lim) return { warn: lim.warn || 120, crit: lim.crit || 150 };
    }
    return { warn: 120, crit: 150 };
  }
  /* These guards decide when the projection is allowed to speak, and the
     first version set them far too low. Five points over five days passed,
     which let the estimate fit a line through what were really data-entry
     corrections — one tank read 42 g/L then 140 three days later because the
     number was updated, not because iron rose 98 g/L — and then report the
     bath as finished. A bath that lives about ninety days needs a window long
     enough to show a real slope, so the estimate now stays quiet until it has
     one rather than producing a confident wrong answer. */
  const MIN_POINTS = 6;                       // below this a slope is noise
  const MIN_SPAN_DAYS = 14;

  /* A jump this large between consecutive readings is a correction, not
     chemistry: iron cannot climb that fast in a working bath. */
  const MAX_DAILY_FE_JUMP = 15;               // g/L per day

  const DEFAULT_INVENTORY = [
    { key: 'flux_salt', qty: 2500, min: 1000, unit: 'kg' },
    { key: 'ammonia',   qty: 1100, min: 300,  unit: 'L' },
    { key: 'peroxide',  qty: 1470, min: 650,  unit: 'L' },
    { key: 'hcl',       qty: 0,    min: 0,    unit: 'L' }
  ];

  let readings = {};   // key -> {tankId, date, ts, ph, fe, baume, acidPercent}
  let renewals = {};   // pushId -> {tankId, date, ts, type, qty, unit, note}
  let inventory = {};  // key -> {qty, min, unit}

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const pad = n => (n < 10 ? '0' : '') + n;
  function dayKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  const dayNum = dateStr => Math.floor(new Date(dateStr + 'T00:00:00').getTime() / 86400000);

  /* ---------------- 1. daily readings capture ---------------- */

  /* Keyed by tank+date so repeated edits on the same day overwrite rather
     than pile up — the log stays exactly one row per tank per day. */
  /* Every measured parameter is snapshotted, for every tank that has a spec —
     tanks_data only ever holds the latest value, so without this there is no
     history to trend and no way to tell a fresh reading from a stale one.

     saveToStorage() also fires on a status change, which is not a measurement,
     so a tank whose numbers are unchanged is skipped. That keeps the log an
     honest record of when a reading was actually taken. */
  const LOGGED_FIELDS = ['ph', 'fe', 'baume', 'acidPercent', 'sg', 'conc', 'temp', 'ec', 'zn', 'salt'];

  function latestReadingFor(tankId) {
    let best = null;
    Object.keys(readings).forEach(function (k) {
      const r = readings[k];
      if (!r || Number(r.tankId) !== tankId) return;
      if (!best || (r.date || '') > (best.date || '')) best = r;
    });
    return best;
  }

  function captureReadings() {
    if (!IS_EDITOR || !IS_AUTHED || typeof tanks === 'undefined') return;
    const SP = window.KGCSpecs;
    const date = dayKey();
    const now = Date.now();
    const updates = {};

    tanks.forEach(function (tk) {
      const tracked = SP && SP.hasSpec(tk.id) ? true : (ACID_IDS.indexOf(tk.id) !== -1 || tk.id === 10);
      if (!tracked) return;

      /* Only the fields this tank actually carries. Writing a zero for every
         other field fills the record with noise, and would blank figures the
         pickling log keeps against the same day — temperature especially,
         which acid tanks have no card input for. */
      /* ...and of those, only the ones measured today. Deciding by "did the
         number change" copied a value forward every day nobody re-measured
         it -- acid tank 2 showed the same 3.78% / 140 g/L for 22 days as if
         titrated daily, which skews the trends, the bath-life estimate and
         the reading age. Each card input now stamps the day it was measured. */
      const fields = LOGGED_FIELDS.filter(f => (tk.fields || []).indexOf(f) !== -1)
        .filter(f => tk.measured && tk.measured[f] === date && tk[f] != null && tk[f] !== '');
      if (!fields.length) return;
      const row = { tankId: tk.id, date: date, ts: now };
      fields.forEach(function (f) { row[f] = Number(tk[f]); });

      // field-level paths, so the level, sludge and notes stored against the
      // same day by the pickling log survive this write
      const base = 'readings_log/' + tk.id + '_' + date + '/';
      Object.keys(row).forEach(function (f) { updates[base + f] = row[f]; });
    });

    if (!Object.keys(updates).length) return;
    database.ref().update(updates)
      .catch(e => console.error('[lab] readings capture failed', e));
  }

  /** Days since this tank last had a reading recorded — null if never. */
  function daysSinceReading(tankId) {
    const r = latestReadingFor(tankId);
    if (!r || !r.date) return null;
    const then = new Date(r.date + 'T00:00:00');
    const today = new Date(dayKey() + 'T00:00:00');
    if (isNaN(then)) return null;
    return { days: Math.max(0, Math.round((today - then) / 86400000)), date: r.date };
  }

  /* ---------------- 2/3. trend + life ---------------- */

  /* A flux clean-out strips the iron just as a renewal does, so both start a
     fresh bath cycle; a top-up addition does not. */
  const RESETS_BATH = { renewal: 1, cleaning: 1 };

  function lastRenewalDay(tankId) {
    let latest = null;
    Object.values(renewals).forEach(function (r) {
      if (!r || Number(r.tankId) !== tankId || !RESETS_BATH[r.type]) return;
      if (!latest || r.date > latest) latest = r.date;
    });
    return latest;
  }

  /** When this bath was last changed, and how many days ago. */
  function lastChange(tankId) {
    let best = null;
    Object.values(renewals).forEach(function (r) {
      if (!r || Number(r.tankId) !== tankId || !RESETS_BATH[r.type]) return;
      if (!best || r.date > best.date) best = r;
    });
    if (!best) return null;
    const then = new Date(best.date + 'T00:00:00');
    const today = new Date(dayKey() + 'T00:00:00');
    if (isNaN(then)) return null;
    return {
      date: best.date,
      days: Math.max(0, Math.round((today - then) / 86400000)),
      type: best.type,
      note: best.note || ''
    };
  }

  /** Readings for one tank, ascending, limited to the current bath cycle. */
  function seriesFor(tankId) {
    const since = lastRenewalDay(tankId);
    const pts = Object.values(readings)
      .filter(r => r && Number(r.tankId) === tankId && Number(r.fe) > 0)
      .filter(r => !since || r.date >= since)
      .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

    /* Drop steps that are physically impossible for a working bath. They are
       corrections to a previously wrong figure, and leaving them in lets a
       single keystroke set the slope for the whole projection. The reading is
       kept in the log either way — it is only excluded from the fit. */
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      if (out.length) {
        const prev = out[out.length - 1];
        const gap = Math.max(1, Math.round((dayNum(pts[i].date) - dayNum(prev.date))));
        const jump = Math.abs(Number(pts[i].fe) - Number(prev.fe)) / gap;
        if (jump > MAX_DAILY_FE_JUMP) { out.length = 0; out.push(pts[i]); continue; }
      }
      out.push(pts[i]);
    }
    return out;
  }

  /** Least-squares fit of Fe against day number. */
  function fit(points) {
    const n = points.length;
    if (n < 2) return null;
    const xs = points.map(p => dayNum(p.date));
    const ys = points.map(p => Number(p.fe));
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += Math.pow(xs[i] - mx, 2); }
    if (den === 0) return null;
    const slope = num / den;              // g/L per day
    const intercept = my - slope * mx;
    // R² so a scattered series can be reported as unreliable rather than sold as a forecast
    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < n; i++) {
      ssRes += Math.pow(ys[i] - (slope * xs[i] + intercept), 2);
      ssTot += Math.pow(ys[i] - my, 2);
    }
    return {
      slope: slope, intercept: intercept,
      r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot,
      spanDays: xs[xs.length - 1] - xs[0],
      n: n
    };
  }

  function lifeEstimate(tankId) {
    const pts = seriesFor(tankId);
    if (pts.length < MIN_POINTS) return { state: 'insufficient', have: pts.length, need: MIN_POINTS };
    const f = fit(pts);
    if (!f) return { state: 'insufficient', have: pts.length, need: MIN_POINTS };
    if (f.spanDays < MIN_SPAN_DAYS) return { state: 'shortspan', spanDays: f.spanDays, need: MIN_SPAN_DAYS };

    const currentFe = Number(pts[pts.length - 1].fe);
    if (f.slope <= 0) return { state: 'flat', currentFe: currentFe, r2: f.r2, n: f.n };

    const L = feLimits(tankId);
    const daysTo = target => Math.round((target - currentFe) / f.slope);

    /* Iron accumulates because steel is pickled, not because time passes, so a
       rate in g/L per day silently assumes the line runs at a constant pace.
       Dividing the same rise by the tonnage actually put through over the same
       window gives the honest figure — and the remaining life in tonnes, which
       does not move when the plant has a slow week or a shutdown. */
    const tpd = tonnesPerDayOver(pts[0].date, pts[pts.length - 1].date);
    const perTonne = tpd ? f.slope / tpd : null;          // g/L per tonne
    const tonnesTo = target => (perTonne && perTonne > 0)
      ? Math.round((target - currentFe) / perTonne) : null;

    return {
      state: 'ok',
      currentFe: currentFe,
      slope: f.slope,
      r2: f.r2,
      n: f.n,
      spanDays: f.spanDays,
      daysToWarn: daysTo(L.warn),
      daysToCrit: daysTo(L.crit),
      tonnesPerDay: tpd,
      fePerTonne: perTonne,
      tonnesToWarn: tonnesTo(L.warn),
      tonnesToCrit: tonnesTo(L.crit)
    };
  }

  /** Average tonnes of steel put through per day between two dates.
      The production rows are kilograms despite the column name. */
  function tonnesPerDayOver(fromDate, toDate) {
    const Z = window.KGCZinc;
    if (!Z || !Z._days) return null;
    let kg = 0, days = 0;
    Object.values(Z._days() || {}).forEach(function (d) {
      if (!d || !d.date || d.date < fromDate || d.date > toDate) return;
      kg += Number(d.totalTon) || 0;
      days++;
    });
    if (!days || !kg) return null;
    return (kg / 1000) / days;
  }

  /* ---------------- chart ---------------- */

  function chartSVG(pts, f, lim) {
    const FE_WARN = lim ? lim.warn : 120, FE_CRIT = lim ? lim.crit : 150;
    const W = 640, H = 190, PL = 42, PR = 12, PT = 12, PB = 26;
    const iw = W - PL - PR, ih = H - PT - PB;

    const xs = pts.map(p => dayNum(p.date));
    const x0 = xs[0], x1 = xs[xs.length - 1];
    const xSpan = Math.max(1, x1 - x0);
    const maxFe = Math.max(FE_CRIT + 20, ...pts.map(p => Number(p.fe)));
    const X = d => PL + (d - x0) / xSpan * iw;
    const Y = v => PT + ih - (v / maxFe) * ih;

    const path = pts.map((p, i) => (i ? 'L' : 'M') + X(dayNum(p.date)).toFixed(1) + ' ' + Y(Number(p.fe)).toFixed(1)).join(' ');
    const dots = pts.map(p => '<circle class="pt" r="3" cx="' + X(dayNum(p.date)).toFixed(1) + '" cy="' + Y(Number(p.fe)).toFixed(1) + '"/>').join('');

    // horizontal gridlines + labels
    let grid = '';
    const step = maxFe > 200 ? 50 : 25;
    for (let v = 0; v <= maxFe; v += step) {
      grid += '<line class="grid" x1="' + PL + '" y1="' + Y(v).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Y(v).toFixed(1) + '"/>' +
              '<text class="axis-label" x="' + (PL - 6) + '" y="' + (Y(v) + 3).toFixed(1) + '" text-anchor="end">' + v + '</text>';
    }

    // limit bands + lines
    const bands =
      '<rect class="band-warn" x="' + PL + '" y="' + Y(FE_CRIT).toFixed(1) + '" width="' + iw + '" height="' + Math.max(0, Y(FE_WARN) - Y(FE_CRIT)).toFixed(1) + '"/>' +
      '<rect class="band-crit" x="' + PL + '" y="' + PT + '" width="' + iw + '" height="' + Math.max(0, Y(FE_CRIT) - PT).toFixed(1) + '"/>' +
      '<line class="limit-line" stroke="var(--warn)" x1="' + PL + '" y1="' + Y(FE_WARN).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Y(FE_WARN).toFixed(1) + '"/>' +
      '<line class="limit-line" stroke="var(--crit)" x1="' + PL + '" y1="' + Y(FE_CRIT).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Y(FE_CRIT).toFixed(1) + '"/>';

    // projected trend to whichever limit it reaches first
    let trend = '';
    if (f && f.slope > 0) {
      const xEnd = Math.min(x0 + xSpan * 2.2, (FE_CRIT - f.intercept) / f.slope);
      if (xEnd > x1) {
        const xe = Math.min(xEnd, x0 + xSpan * 2.2);
        trend = '<line class="trend" x1="' + X(x1).toFixed(1) + '" y1="' + Y(f.slope * x1 + f.intercept).toFixed(1) +
                '" x2="' + X(xe).toFixed(1) + '" y2="' + Y(Math.min(maxFe, f.slope * xe + f.intercept)).toFixed(1) + '"/>';
      }
    }

    const firstLbl = pts[0].date.slice(5), lastLbl = pts[pts.length - 1].date.slice(5);
    const axis =
      '<text class="axis-label" x="' + PL + '" y="' + (H - 8) + '" text-anchor="start">' + firstLbl + '</text>' +
      '<text class="axis-label" x="' + (W - PR) + '" y="' + (H - 8) + '" text-anchor="end">' + lastLbl + '</text>';

    return '<svg class="lab-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" preserveAspectRatio="xMidYMid meet">' +
      grid + bands + trend + '<path class="series" d="' + path + '"/>' + dots + axis + '</svg>';
  }

  /* ---------------- rendering ---------------- */

  function renderTrends() {
    const mount = document.getElementById('lab-trends');
    if (!mount || typeof tanks === 'undefined') return;

    const blocks = ACID_IDS.map(function (id) {
      const tk = tanks.find(x => x.id === id);
      if (!tk) return '';
      const pts = seriesFor(id);
      const f = pts.length >= 2 ? fit(pts) : null;
      const since = lastRenewalDay(id);

      const meta = pts.length
        ? pts.length + ' ' + t('lab.readings') + (since ? ' · ' + t('lab.sinceRenewal') + ' ' + since : '')
        : t('lab.noReadings');

      const body = pts.length >= 2
        ? chartSVG(pts, f, feLimits(id))
        : '<div class="lab-empty">' + esc(t('lab.needTwo')) + '</div>';

      return '<div class="lab-chart-card">' +
        '<div class="lab-chart-head">' +
          '<span class="lab-chart-title">' + esc(tankLabel(tk.name)) + '</span>' +
          '<span class="lab-chart-meta">' + esc(meta) + '</span>' +
        '</div>' + body + '</div>';
    }).join('');

    mount.innerHTML = blocks;
  }

  function renderLife() {
    const mount = document.getElementById('lab-life');
    if (!mount || typeof tanks === 'undefined') return;

    mount.innerHTML = ACID_IDS.map(function (id) {
      const tk = tanks.find(x => x.id === id);
      if (!tk) return '';
      const e = lifeEstimate(id);
      let tier = '', big = '', sub = '';

      if (e.state === 'insufficient') {
        tier = ''; big = '<span class="lab-life-none">' + esc(t('lab.needMore', { have: e.have, need: e.need })) + '</span>';
      } else if (e.state === 'shortspan') {
        tier = ''; big = '<span class="lab-life-none">' + esc(t('lab.needSpan', { need: e.need })) + '</span>';
      } else if (e.state === 'flat') {
        tier = 't-good';
        big = '<span class="lab-life-none">' + esc(t('lab.flat')) + '</span>';
        sub = t('lab.currentFe') + ': ' + e.currentFe.toFixed(1) + ' g/L';
      } else {
        const d = e.daysToWarn;
        tier = d <= 7 ? 't-crit' : d <= 21 ? 't-warn' : 't-good';
        big = (d <= 0 ? '0' : d) + '<small>' + esc(t('lab.days')) + '</small>';
        sub = t('lab.rate') + ': ' + e.slope.toFixed(2) + ' g/L/' + t('lab.day') +
              ' · ' + t('lab.currentFe') + ': ' + e.currentFe.toFixed(1) +
              '<br>' + t('lab.toCrit') + ': ' + (e.daysToCrit <= 0 ? 0 : e.daysToCrit) + ' ' + t('lab.days') +
              ' · R² ' + e.r2.toFixed(2) + ' · n=' + e.n;
        /* The tonnage view only appears once production covers the same window,
           because without it the figure would be a guess dressed as a number. */
        if (e.tonnesToWarn != null) {
          sub += '<br><b>' + esc(t('lab.tonnesLeft', {
            n: Math.max(0, e.tonnesToWarn).toLocaleString()
          })) + '</b> · ' + esc(t('lab.fePerTonne', { v: e.fePerTonne.toFixed(3) }));
        }
      }

      return '<div class="lab-life ' + tier + '">' +
        '<div class="lab-life-name">' + esc(tankLabel(tk.name)) + '</div>' +
        '<div class="lab-life-big">' + big + '</div>' +
        (sub ? '<div class="lab-life-sub">' + sub + '</div>' : '') +
      '</div>';
    }).join('');
  }

  function renderRenewals() {
    const mount = document.getElementById('lab-renewal-log');
    if (!mount) return;
    const rows = Object.entries(renewals)
      .map(([k, r]) => Object.assign({ _k: k }, r))
      .filter(r => r && r.date)
      .sort((a, b) => (b.date + (b.ts || 0)) > (a.date + (a.ts || 0)) ? 1 : -1);

    if (!rows.length) { mount.innerHTML = '<div class="lab-empty">' + esc(t('lab.noRenewals')) + '</div>'; return; }

    const canEdit = IS_EDITOR && IS_AUTHED;
    mount.innerHTML = '<div class="tablewrap"><table><thead><tr>' +
      '<th>' + esc(t('lab.col.date')) + '</th><th>' + esc(t('lab.col.tank')) + '</th>' +
      '<th>' + esc(t('lab.col.type')) + '</th><th>' + esc(t('lab.col.qty')) + '</th>' +
      '<th>' + esc(t('lab.col.note')) + '</th>' + (canEdit ? '<th></th>' : '') +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        const tk = (typeof tanks !== 'undefined') ? tanks.find(x => x.id === Number(r.tankId)) : null;
        const cls = r.type === 'renewal' ? 'pill-renewal' : 'pill-addition';
        return '<tr>' +
          '<td class="num">' + esc(r.date) + '</td>' +
          '<td class="name">' + esc(tk ? tankLabel(tk.name) : r.tankId) + '</td>' +
          '<td><span class="lab-type-pill ' + cls + '">' + esc(t('lab.type.' + r.type)) + '</span></td>' +
          '<td class="num">' + (r.qty ? esc(r.qty) + ' ' + esc(r.unit || '') : '—') + '</td>' +
          '<td>' + esc(r.note || '') + '</td>' +
          (canEdit ? '<td><button class="btn mini danger" data-del-renewal="' + esc(r._k) + '">' + esc(t('lab.delete')) + '</button></td>' : '') +
        '</tr>';
      }).join('') + '</tbody></table></div>';

    mount.querySelectorAll('[data-del-renewal]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!IS_EDITOR || !IS_AUTHED) return;
        if (!confirm(t('lab.confirmDelete'))) return;
        database.ref('renewals/' + b.getAttribute('data-del-renewal')).remove();
      });
    });
  }

  function renderInventory() {
    const mount = document.getElementById('lab-inventory');
    if (!mount) return;
    mount.innerHTML = DEFAULT_INVENTORY.map(function (d) {
      const item = inventory[d.key] || d;
      const qty = Number(item.qty) || 0;
      const min = Number(item.min) || 0;
      const low = min > 0 && qty <= min;
      const pct = min > 0 ? Math.max(0, Math.min(100, qty / (min * 3) * 100)) : (qty > 0 ? 100 : 0);
      return '<div class="lab-inv' + (low ? ' low' : '') + '">' +
        '<div class="lab-inv-name">' + esc(t('lab.item.' + d.key)) + '</div>' +
        '<div class="lab-inv-qty">' + qty.toLocaleString() + '<small>' + esc(item.unit || d.unit) + '</small></div>' +
        '<div class="lab-inv-bar"><span style="width:' + pct.toFixed(0) + '%"></span></div>' +
        '<div class="lab-inv-min">' + esc(t('lab.min')) + ' ' + min.toLocaleString() + ' ' + esc(item.unit || d.unit) +
          (low ? ' — <b style="color:var(--crit)">' + esc(t('lab.lowStock')) + '</b>' : '') + '</div>' +
        '<input class="lab-inv-edit" type="number" step="1" value="' + qty + '" data-inv="' + d.key + '" aria-label="' + esc(t('lab.item.' + d.key)) + '">' +
      '</div>';
    }).join('');

    mount.querySelectorAll('[data-inv]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        if (!IS_EDITOR || !IS_AUTHED) return;
        const key = inp.getAttribute('data-inv');
        const def = DEFAULT_INVENTORY.find(x => x.key === key);
        database.ref('inventory/' + key).update({
          qty: Number(inp.value) || 0,
          min: (inventory[key] && inventory[key].min != null) ? inventory[key].min : def.min,
          unit: (inventory[key] && inventory[key].unit) || def.unit
        });
      });
    });
  }

  function renderAllLab() {
    renderTrends(); renderLife(); renderRenewals(); renderInventory();
  }

  /* ---------------- renewal form ---------------- */

  function wireForm() {
    const form = document.getElementById('lab-renewal-form');
    if (!form || form.dataset.wired) return;
    form.dataset.wired = '1';

    const sel = document.getElementById('lab-rn-tank');
    if (sel && typeof tanks !== 'undefined') {
      sel.innerHTML = ACID_IDS.map(function (id) {
        const tk = tanks.find(x => x.id === id);
        return tk ? '<option value="' + id + '">' + esc(tankLabel(tk.name)) + '</option>' : '';
      }).join('');
    }
    const dateInp = document.getElementById('lab-rn-date');
    if (dateInp && !dateInp.value) dateInp.value = dayKey();

    document.getElementById('lab-rn-save').addEventListener('click', function () {
      if (!IS_EDITOR || !IS_AUTHED) return;
      const tankId = Number(document.getElementById('lab-rn-tank').value);
      const date = document.getElementById('lab-rn-date').value || dayKey();
      const type = document.getElementById('lab-rn-type').value;
      const qty = Number(document.getElementById('lab-rn-qty').value) || 0;
      const note = document.getElementById('lab-rn-note').value.trim();
      if (!tankId) return;
      database.ref('renewals').push({
        tankId: tankId, date: date, ts: Date.now(),
        type: type, qty: qty, unit: 'L', note: note
      }).then(function () {
        document.getElementById('lab-rn-qty').value = '';
        document.getElementById('lab-rn-note').value = '';
      }).catch(e => console.error('[lab] renewal save failed', e));
    });
  }

  /* ---------------- wiring ---------------- */

  database.ref('readings_log').on('value', s => {
    readings = s.val() || {};
    renderTrends(); renderLife();
    // the tank cards show reading freshness, so they need the history too
    if (typeof window.renderTanksAll === 'function') window.renderTanksAll();
  });
  database.ref('renewals').on('value', s => {
    renewals = s.val() || {};
    renderTrends(); renderLife(); renderRenewals();
    // the tank cards carry the bath age, so they follow this log
    if (typeof window.renderTanksAll === 'function') window.renderTanksAll();
  });
  database.ref('inventory').on('value', s => { inventory = s.val() || {}; renderInventory(); });
  /* The life estimate divides the iron rise by the tonnage put through, so a
     new production import changes the answer and has to redraw it. */
  database.ref('zinc_daily').on('value', renderLife);
  database.ref('tanks_data').on('value', function () { renderTrends(); renderLife(); renderRenewals(); wireForm(); });

  if (window.I18N) I18N.onChange(renderAllLab);
  document.addEventListener('DOMContentLoaded', function () { wireForm(); renderAllLab(); });

  window.KGCLab = {
    captureReadings: captureReadings,
    daysSinceReading: daysSinceReading,
    lastChange: lastChange,
    lifeEstimate: lifeEstimate,
    tonnesPerDayOver: tonnesPerDayOver,
    render: renderAllLab,
    _readings: () => readings,
    _renewals: () => renewals,
    /* The effective inventory, not just the stored overrides: an item nobody
       has edited yet still has the level the inventory page shows for it, and
       anything reading stock needs to see the same number the operator does. */
    _inventory: function () {
      const out = {};
      DEFAULT_INVENTORY.forEach(function (d) {
        const saved = inventory[d.key] || {};
        out[d.key] = {
          qty: saved.qty != null ? Number(saved.qty) : d.qty,
          min: saved.min != null ? Number(saved.min) : d.min,
          unit: d.unit
        };
      });
      Object.keys(inventory).forEach(function (k) { if (!out[k]) out[k] = inventory[k]; });
      return out;
    }
  };
})();
