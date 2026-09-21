/* ============================================================
   Cost per tonne galvanized
   ------------------------------------------------------------
   The plant already records everything this needs; what was missing
   was the division. Zinc added and tonnage come from the production
   reports, acid from the replacement schedule (25 t a charge), and
   flux chemicals from the treatment log.

   Prices are entered once and stored, because they are the only part
   the plant has to supply. Everything else is counted from data that
   is already there, so the figure moves on its own as reports come in.

   The number this produces is a direct cost — materials only. Labour,
   gas and overhead are not counted, and the page says so rather than
   letting the figure be read as a full cost.

   Depends on globals from index.html: database, IS_EDITOR, IS_AUTHED, t()
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[cost] Firebase database is not available.');
    return;
  }

  /* Unit prices the plant sets. Defaults are placeholders, not quotes —
     they exist so the page renders before anyone has filled it in. */
  const PRICES = [
    { key: 'zinc',    def: 12.0, unit: 'SAR/kg' },
    { key: 'acid',    def: 900,  unit: 'SAR/t'  },
    { key: 'ammonia', def: 4.5,  unit: 'SAR/L'  },
    { key: 'flux',    def: 9.0,  unit: 'SAR/kg' },
    { key: 'peroxide', def: 6.0, unit: 'SAR/L'  }
  ];

  const ACID_CHARGE_T = 25;      // one full acid replacement, per the schedule

  /* The production report's "Tonnage" row is recorded in kilograms, not
     tonnes, whatever the row is called. Three things agree on this: a month
     reading 1.8 million would be beyond any galvanizing plant in tonnes; the
     zinc added divided by it lands on 8.0%, which is the consumption figure
     the same sheet reports; and it puts a jig at about a tonne rather than a
     thousand. Dividing by this is what makes the cost per tonne a real
     number instead of a cost per kilo wearing the wrong label. */
  const PRODUCTION_KG_PER_UNIT = 1000;

  let prices = {}, renewals = {}, treatments = {}, peroxTreatments = {};

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const priceOf = k => { const p = PRICES.find(x => x.key === k); const v = num(prices[k]); return v || (p ? p.def : 0); };
  const money = v => v.toLocaleString(undefined, { maximumFractionDigits: 2 });

  /* ---------------- the sum ---------------- */

  /** Direct material cost over the period the production data covers. */
  function compute() {
    const Z = window.KGCZinc;
    if (!Z || !Z._days) return null;
    const days = Object.values(Z._days() || {}).filter(d => d && d.date);
    if (!days.length) return null;

    days.sort((a, b) => a.date < b.date ? -1 : 1);
    const from = days[0].date, to = days[days.length - 1].date;

    const producedKg = days.reduce((s, d) => s + num(d.totalTon), 0);
    if (!producedKg) return null;
    const tonnage = producedKg / PRODUCTION_KG_PER_UNIT;      // real tonnes

    // zinc actually added to the kettle over the same period
    const zincKg = days.reduce((s, d) => s + num(d.release), 0);
    const zincCost = zincKg * priceOf('zinc');

    // acid replacements that fall inside the window
    const acidEvents = Object.values(renewals || {}).filter(function (r) {
      return r && r.type === 'renewal' && r.date >= from && r.date <= to && num(r.qty) > 0;
    });
    const acidTonnes = acidEvents.reduce((s, r) => s + (num(r.qty) || ACID_CHARGE_T), 0);
    const acidCost = acidTonnes * priceOf('acid');

    // flux treatments in the window
    const treat = Object.values(treatments || {}).filter(r => r && r.date >= from && r.date <= to);
    const ammoniaL = treat.reduce((s, r) => s + num(r.liters), 0);
    const ammoniaCost = ammoniaL * priceOf('ammonia');

    const saltKg = treat.reduce((s, r) => s + num(r.saltKg), 0);
    const saltCost = saltKg * priceOf('flux');

    // peroxide treatments in the same window
    const peroxTreat = Object.values(peroxTreatments || {}).filter(r => r && r.date >= from && r.date <= to);
    const peroxideL = peroxTreat.reduce((s, r) => s + num(r.liters), 0);
    const peroxideCost = peroxideL * priceOf('peroxide');

    const total = zincCost + acidCost + ammoniaCost + saltCost + peroxideCost;

    return {
      from: from, to: to, days: days.length,
      tonnage: tonnage, producedKg: producedKg,
      zincPct: zincKg / producedKg * 100,
      lines: [
        { key: 'zinc',    qty: zincKg,     unit: 'kg', cost: zincCost },
        { key: 'acid',    qty: acidTonnes, unit: 't',  cost: acidCost, n: acidEvents.length },
        { key: 'ammonia', qty: ammoniaL,   unit: 'L',  cost: ammoniaCost, n: treat.length },
        { key: 'flux',    qty: saltKg,     unit: 'kg', cost: saltCost },
        { key: 'peroxide', qty: peroxideL, unit: 'L',  cost: peroxideCost, n: peroxTreat.length }
      ],
      total: total,
      perTon: total / tonnage,
      zincPerTon: zincCost / tonnage
    };
  }

  /* ---------------- rendering ---------------- */

  const stat = (k, v, unit, hot) =>
    '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span>' +
    '<span class="v">' + v + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</span></div>';

  function render() {
    const mount = document.getElementById('cost-body');
    if (!mount) return;
    const c = compute();

    const form =
      '<p class="panel-label" style="margin:24px 0 10px">' + esc(t('cost.prices')) + '</p>' +
      '<div class="lab-form" id="cost-form">' +
      PRICES.map(p =>
        '<div><label>' + esc(t('cost.p.' + p.key)) + ' <span class="unit">' + esc(p.unit) + '</span></label>' +
        '<input type="number" step="any" id="cp-' + p.key + '" value="' + (num(prices[p.key]) || p.def) + '"></div>').join('') +
      '<div><button class="btn" id="cost-save" style="width:100%;justify-content:center">' + esc(t('cost.save')) + '</button></div>' +
      '<div style="grid-column:1/-1"><span id="cost-msg"></span></div>' +
      '</div>';

    if (!c) {
      mount.innerHTML = '<div class="lab-empty">' + esc(t('cost.empty')) + '</div>' + form;
      wire(mount);
      return;
    }

    const rows = c.lines.map(function (l) {
      const share = c.total ? (l.cost / c.total * 100) : 0;
      return '<tr>' +
        '<td class="name">' + esc(t('cost.p.' + l.key)) + (l.n != null ? ' <small style="color:var(--ink-3)">(' + l.n + ')</small>' : '') + '</td>' +
        '<td class="num">' + money(l.qty) + ' ' + esc(l.unit) + '</td>' +
        '<td class="num">' + money(l.cost) + '</td>' +
        '<td class="num">' + share.toFixed(1) + '%</td>' +
        '<td class="num">' + money(l.cost / c.tonnage) + '</td>' +
      '</tr>';
    }).join('');

    mount.innerHTML =
      '<div class="pt-stats">' +
        stat(t('cost.perTon'), money(c.perTon), 'SAR/t') +
        stat(t('cost.total'), money(c.total), 'SAR') +
        stat(t('cost.tonnage'), money(Math.round(c.tonnage))) +
        stat(t('cost.zincShare'), c.total ? (c.lines[0].cost / c.total * 100).toFixed(0) : '—', '%') +
      '</div>' +
      '<p class="lab-life-sub" style="margin:0 2px 6px">' + esc(t('cost.period', { a: c.from, b: c.to, n: c.days })) + '</p>' +
      '<p class="lab-life-sub" style="margin:0 2px 14px">' +
        esc(t('cost.kgNote', { kg: Math.round(c.producedKg).toLocaleString(), p: c.zincPct.toFixed(2) })) + '</p>' +
      '<div class="tablewrap"><table><thead><tr>' +
        '<th>' + esc(t('cost.c.item')) + '</th><th>' + esc(t('cost.c.qty')) + '</th>' +
        '<th>' + esc(t('cost.c.cost')) + '</th><th>' + esc(t('cost.c.share')) + '</th>' +
        '<th>' + esc(t('cost.c.perTon')) + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="zn-note" style="color:var(--ink-3);background:var(--recess);border-color:var(--line)">' +
        esc(t('cost.directOnly')) + '</div>' +
      form;

    wire(mount);
  }

  function wire(mount) {
    const save = mount.querySelector('#cost-save');
    if (!save) return;
    save.addEventListener('click', function () {
      const msg = mount.querySelector('#cost-msg');
      const say = (m, bad) => { if (msg) { msg.textContent = m; msg.style.color = bad ? 'var(--crit)' : 'var(--accent)'; } };
      if (!IS_EDITOR || !IS_AUTHED) { say(t('coat.needAuth'), true); return; }
      const out = {};
      PRICES.forEach(function (p) {
        const el = mount.querySelector('#cp-' + p.key);
        out[p.key] = el && el.value !== '' ? Number(el.value) : p.def;
      });
      database.ref('prices').set(out)
        .then(() => say(t('cost.saved')))
        .catch(e => say(t('coat.failed') + ' ' + e.message, true));
    });
  }

  /* ---------------- wiring ---------------- */

  database.ref('prices').on('value', s => { prices = s.val() || {}; render(); });
  database.ref('renewals').on('value', s => { renewals = s.val() || {}; render(); });
  database.ref('flux_treatments').on('value', s => { treatments = s.val() || {}; render(); });
  database.ref('peroxide_treatments').on('value', s => { peroxTreatments = s.val() || {}; render(); });
  database.ref('zinc_daily').on('value', render);
  if (window.I18N) I18N.onChange(render);
  document.addEventListener('DOMContentLoaded', render);

  window.KGCCost = { compute: compute, render: render, _prices: () => prices };
})();
