/* ============================================================
   Zinc bath chemistry, dross, and instrument calibration
   ------------------------------------------------------------
   Two records a galvanizing plant is expected to keep and this site
   did not.

   1. Bath analysis. The kettle is not pure zinc, and the elements in
      it decide what the coating looks like:
        Al  — brightness and how the flux behaves; too much and the
              flux is attacked, too little and the surface dulls
        Ni  — suppresses the Sandelin reaction, so reactive steel
              stops growing thick grey coatings
        Fe  — dissolved iron, the raw material of dross
        Pb  — drainage and the spangle
      Ranges are the ones commonly held in general galvanizing; they
      are editable because every kettle is run to its own recipe.

   2. Dross generation, as a share of the zinc consumed. Around 1.5-2.5%
      is normal; above that the iron is coming in faster than it should,
      which points upstream at pickling or flux rather than at the kettle.

   3. Calibration. Every instrument whose reading this site trusts — pH
      meter, hydrometer, thermometer, thickness gauge — needs a due date
      an auditor can see. An overdue instrument makes every number it
      produced arguable.

   Depends on globals from index.html: database, IS_EDITOR, IS_AUTHED, t()
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[kettle] Firebase database is not available.');
    return;
  }

  /* Working ranges for a general-galvanizing kettle. `crit` is the point
     past which the bath is out of control rather than merely drifting. */
  const ELEMENTS = [
    { key: 'al', min: 0.003, max: 0.010, crit: 0.020, unit: '%', dp: 4 },
    { key: 'ni', min: 0.040, max: 0.060, crit: 0.100, unit: '%', dp: 3 },
    { key: 'fe', min: 0,     max: 0.030, crit: 0.050, unit: '%', dp: 3 },
    { key: 'pb', min: 0,     max: 0.900, crit: 1.200, unit: '%', dp: 3 },
    { key: 'temp', min: 445, max: 460,   crit: 470,   unit: '°C', dp: 0 }
  ];

  const DROSS_OK = 2.5;          // % of zinc consumed
  const DROSS_HIGH = 4.0;

  /* The instruments whose readings this site records. */
  const INSTRUMENTS = ['ph', 'hydrometer', 'thermometer', 'gauge', 'balance', 'burette'];
  const DUE_SOON_DAYS = 30;

  let bath = {}, calib = {};

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pad = n => (n < 10 ? '0' : '') + n;
  const num = v => { const n = Number(v); return isFinite(n) ? n : null; };
  const dayKey = d => { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);

  /* ---------------- evaluation ---------------- */

  function gradeElement(key, value) {
    const e = ELEMENTS.find(x => x.key === key);
    const v = num(value);
    if (!e || v == null || v === 0) return { tier: 'none', e: e };
    if (e.crit != null && v >= e.crit) return { tier: 'crit', e: e };
    if (v > e.max || v < e.min) return { tier: 'warn', e: e };
    return { tier: 'good', e: e };
  }

  const TIER_COLOR = { good: 'var(--accent)', warn: 'var(--warn)', crit: 'var(--crit)', none: 'var(--ink-3)' };

  const bathList = () => Object.keys(bath).map(k => Object.assign({ _k: k }, bath[k]))
    .filter(x => x && x.date).sort((a, b) => a.date < b.date ? 1 : -1);

  /** Dross as a share of zinc consumed, from the production import. */
  function drossRate() {
    const Z = window.KGCZinc;
    if (!Z || !Z._days) return null;
    const days = Object.values(Z._days() || {});
    let dross = 0, consumed = 0;
    days.forEach(function (d) {
      if (!d) return;
      dross += Number(d.dross) || 0;
      consumed += Number(d.release) || 0;      // zinc actually added to the kettle
    });
    if (!consumed) return null;
    return { dross: dross, consumed: consumed, pct: dross / consumed * 100 };
  }

  /** Calibration status of one instrument. */
  function calStatus(rec) {
    if (!rec || !rec.due) return null;
    const days = daysBetween(dayKey(), rec.due);
    return {
      due: rec.due, last: rec.last || '', days: days,
      tier: days < 0 ? 'crit' : days <= DUE_SOON_DAYS ? 'warn' : 'good'
    };
  }

  /** Instruments that are overdue or nearly so — read by the attention panel. */
  function calibrationAlerts() {
    const out = [];
    INSTRUMENTS.forEach(function (k) {
      const st = calStatus(calib[k]);
      if (!st || st.tier === 'good') return;
      out.push({ key: k, name: t('kettle.inst.' + k), due: st.due, days: st.days, tier: st.tier });
    });
    return out;
  }

  /* ---------------- rendering ---------------- */

  const stat = (k, v, unit, hot) =>
    '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span>' +
    '<span class="v">' + v + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</span></div>';

  function bathHTML() {
    const rows = bathList();
    const latest = rows[0] || null;
    const dr = drossRate();

    const cards = ELEMENTS.map(function (e) {
      const g = gradeElement(e.key, latest ? latest[e.key] : null);
      const val = latest && num(latest[e.key]) ? Number(latest[e.key]).toFixed(e.dp) : '—';
      const range = e.min > 0 ? (e.min + ' – ' + e.max) : ('≤ ' + e.max);
      return '<div class="lab-life t-' + (g.tier === 'none' ? '' : g.tier) + '">' +
        '<div class="lab-life-name">' + esc(t('kettle.el.' + e.key)) + '</div>' +
        '<div class="lab-life-big" style="color:' + TIER_COLOR[g.tier] + '">' + val +
          '<small>' + esc(e.unit) + '</small></div>' +
        '<div class="lab-life-sub">' + esc(t('kettle.range')) + ' ' + range + ' ' + esc(e.unit) + '</div>' +
      '</div>';
    }).join('');

    const form =
      '<div class="lab-form" id="kettle-form">' +
      ELEMENTS.map(e =>
        '<div><label>' + esc(t('kettle.el.' + e.key)) + ' <span class="unit">' + esc(e.unit) + '</span></label>' +
        '<input type="number" step="any" id="kt-' + e.key + '"></div>').join('') +
      '<div><label>' + esc(t('kettle.f.lab')) + '</label><input type="text" id="kt-lab"></div>' +
      '<div><button class="btn" id="kt-save" style="width:100%;justify-content:center">' + esc(t('kettle.f.save')) + '</button></div>' +
      '<div style="grid-column:1/-1"><span id="kt-msg"></span></div>' +
      '</div>';

    const hist = rows.length
      ? '<div class="tablewrap"><table><thead><tr><th>' + esc(t('coat.c.date')) + '</th>' +
        ELEMENTS.map(e => '<th>' + esc(t('kettle.el.' + e.key)) + '</th>').join('') +
        '<th>' + esc(t('kettle.f.lab')) + '</th><th></th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr><td class="num">' + esc(r.date) + '</td>' +
            ELEMENTS.map(function (e) {
              const g = gradeElement(e.key, r[e.key]);
              const v = num(r[e.key]) ? Number(r[e.key]).toFixed(e.dp) : '—';
              return '<td class="num" style="color:' + TIER_COLOR[g.tier] + '">' + v + '</td>';
            }).join('') +
            '<td>' + esc(r.lab || '') + '</td>' +
            '<td>' + (IS_EDITOR ? '<button class="btn mini danger" data-del-bath="' + esc(r._k) + '">' + esc(t('lab.delete')) + '</button>' : '') + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table></div>'
      : '<div class="lab-empty">' + esc(t('kettle.empty')) + '</div>';

    const drossBlock = dr
      ? '<div class="pt-stats">' +
          stat(t('kettle.dross.rate'), dr.pct.toFixed(2), '%', dr.pct > DROSS_OK) +
          stat(t('kettle.dross.total'), Math.round(dr.dross).toLocaleString()) +
          stat(t('kettle.dross.zinc'), Math.round(dr.consumed).toLocaleString()) +
        '</div>' +
        (dr.dross === 0
          ? '<div class="zn-note">' + esc(t('kettle.dross.none')) + '</div>'
          : dr.pct > DROSS_HIGH
            ? '<div class="zn-note">' + esc(t('kettle.dross.high', { p: dr.pct.toFixed(1) })) + '</div>'
            : '')
      : '';

    return '<div class="lab-life-grid">' + cards + '</div>' +
      (latest ? '<p class="lab-life-sub" style="margin:10px 2px 0">' + esc(t('kettle.lastAnalysis', { d: latest.date })) + '</p>' : '') +
      '<p class="panel-label" style="margin:26px 0 10px">' + esc(t('kettle.dross.title')) + '</p>' + drossBlock +
      '<p class="panel-label" style="margin:26px 0 10px">' + esc(t('kettle.newAnalysis')) + '</p>' + form + hist;
  }

  function calibHTML() {
    const alerts = calibrationAlerts();
    const rows = INSTRUMENTS.map(function (k) {
      const rec = calib[k] || {};
      const st = calStatus(rec);
      const col = st ? TIER_COLOR[st.tier] : 'var(--ink-3)';
      const when = st
        ? (st.days < 0 ? t('kettle.cal.overdue', { n: Math.abs(st.days) }) : t('kettle.cal.inDays', { n: st.days }))
        : t('kettle.cal.notSet');
      return '<tr>' +
        '<td class="name">' + esc(t('kettle.inst.' + k)) + '</td>' +
        '<td class="num">' + esc(rec.last || '—') + '</td>' +
        '<td class="num" style="color:' + col + '">' + esc(rec.due || '—') + '</td>' +
        '<td style="color:' + col + '">' + esc(when) + '</td>' +
        '<td>' + esc(rec.by || '') + '</td>' +
        (IS_EDITOR ? '<td><button class="btn mini" data-cal="' + k + '">' + esc(t('kettle.cal.edit')) + '</button></td>' : '<td></td>') +
      '</tr>';
    }).join('');

    return '<div class="pt-stats">' +
        stat(t('kettle.cal.due'), alerts.filter(a => a.tier === 'warn').length, '', alerts.some(a => a.tier === 'warn')) +
        stat(t('kettle.cal.expired'), alerts.filter(a => a.tier === 'crit').length, '', alerts.some(a => a.tier === 'crit')) +
      '</div>' +
      '<div class="tablewrap"><table><thead><tr>' +
        '<th>' + esc(t('kettle.cal.instrument')) + '</th><th>' + esc(t('kettle.cal.last')) + '</th>' +
        '<th>' + esc(t('kettle.cal.dueDate')) + '</th><th>' + esc(t('kettle.cal.state')) + '</th>' +
        '<th>' + esc(t('kettle.cal.by')) + '</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function render() {
    const b = document.getElementById('kettle-body');
    if (b) { b.innerHTML = bathHTML(); wireBath(b); }
    const c = document.getElementById('calib-body');
    if (c) { c.innerHTML = calibHTML(); wireCalib(c); }
  }

  /* ---------------- forms ---------------- */

  function wireBath(mount) {
    const save = mount.querySelector('#kt-save');
    if (save) save.addEventListener('click', function () {
      const msg = mount.querySelector('#kt-msg');
      const say = (m, bad) => { if (msg) { msg.textContent = m; msg.style.color = bad ? 'var(--crit)' : 'var(--accent)'; } };
      if (!IS_EDITOR || !IS_AUTHED) { say(t('coat.needAuth'), true); return; }

      const rec = { date: dayKey(), ts: Date.now(), lab: (mount.querySelector('#kt-lab').value || '').trim() || null };
      let any = false;
      ELEMENTS.forEach(function (e) {
        const v = num(mount.querySelector('#kt-' + e.key).value);
        rec[e.key] = v;
        if (v != null && v !== 0) any = true;
      });
      if (!any) { say(t('kettle.errEmpty'), true); return; }

      database.ref('zinc_bath').push(rec)
        .then(() => say(t('kettle.saved')))
        .catch(e => say(t('coat.failed') + ' ' + e.message, true));
    });

    mount.querySelectorAll('[data-del-bath]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!IS_EDITOR || !IS_AUTHED) return;
        if (!confirm(t('kettle.confirmDel'))) return;
        database.ref('zinc_bath/' + b.getAttribute('data-del-bath')).remove();
      });
    });
  }

  function wireCalib(mount) {
    mount.querySelectorAll('[data-cal]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!IS_EDITOR || !IS_AUTHED) return;
        const key = btn.getAttribute('data-cal');
        const cur = calib[key] || {};
        const last = prompt(t('kettle.cal.askLast'), cur.last || dayKey());
        if (last === null) return;
        const due = prompt(t('kettle.cal.askDue'), cur.due || '');
        if (due === null) return;
        const by = prompt(t('kettle.cal.askBy'), cur.by || '');
        if (by === null) return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(last) || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
          alert(t('kettle.cal.badDate')); return;
        }
        database.ref('calibration/' + key).set({ last: last, due: due, by: by.trim() || null });
      });
    });
  }

  /* ---------------- wiring ---------------- */

  database.ref('zinc_bath').on('value', s => { bath = s.val() || {}; render(); });
  database.ref('calibration').on('value', s => { calib = s.val() || {}; render(); });
  database.ref('zinc_daily').on('value', render);
  if (window.I18N) I18N.onChange(render);
  document.addEventListener('DOMContentLoaded', render);

  window.KGCKettle = {
    render: render, gradeElement: gradeElement, drossRate: drossRate,
    calibrationAlerts: calibrationAlerts,
    _bath: () => bath, _calib: () => calib, _elements: ELEMENTS
  };
})();
