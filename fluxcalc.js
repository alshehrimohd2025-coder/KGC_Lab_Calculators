/* ============================================================
   Flux purification dosing — peroxide and ammonia from the iron load
   ------------------------------------------------------------
   Replaces the original three-calculator script that shipped with the
   first version of this page. Two of those calculators were superseded:
   free-acid titration by the dedicated acid page, which uses the plant's
   own formula and syncs, and the zinc level correction by the
   reconciliation that now reads the real production reports. Their
   shared operations log wrote to localStorage only — never to Firebase —
   so it was device-local, unsynced and outside the backup, which is a
   quiet way to lose records rather than keep them.

   What remains and is kept here is the part nothing else does: how much
   peroxide oxidises the dissolved iron, and how much ammonia precipitates
   it. Those come straight from the balanced equations:

     2FeCl2 + H2O2 + 2HCl -> 2FeCl3 + 2H2O    0.3046 g H2O2 per g Fe
     FeCl3 + 3NH4OH -> Fe(OH)3 + 3NH4Cl       0.9149 g NH3  per g Fe

   The ammonia figure is what to PREPARE, not what to pump: the real dose
   is decided by watching the pH, which is why the empirical panel above
   (flux.js) learns the plant's actual litres-per-pH from its own history.

   Depends on globals from index.html: t(), and the flux page markup.
   ============================================================ */
(function () {
  'use strict';

  /* Molar masses, and the gram ratios that follow from the equations above. */
  const M_Fe = 55.845, M_H2O2 = 34.0147, M_NH3 = 17.031, M_NH4Cl = 53.491;
  const G_H2O2_PER_G_FE = (M_H2O2 / 2) / M_Fe;
  const G_NH3_PER_G_FE = (3 * M_NH3) / M_Fe;
  const G_NH4CL_PER_G_FE = (3 * M_NH4Cl) / M_Fe;

  const DEFAULTS = { v: 27720, fe0: 1.8, fe1: 0.5, hc: 35, hd: 1.13, ex: 1.3, ac: 25, ad: 0.907, ph: 4.5 };
  const STORE = 'kgc-fluxcalc-inputs';

  const $ = id => document.getElementById(id);
  const n = id => { const el = $(id); if (!el) return NaN; const x = parseFloat(el.value); return isFinite(x) ? x : NaN; };
  const fmt = (v, d) => isFinite(v)
    ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';

  function setRes(id, val, dec) {
    const el = $(id); if (!el) return;
    const u = el.querySelector('.u');
    el.textContent = fmt(val, dec);
    if (u) el.appendChild(u);
  }

  function flag(host, cls, icon, html) {
    const el = $(host); if (!el) return;
    el.innerHTML = html
      ? '<div class="flag flag-' + cls + '"><span class="fi">' + icon + '</span><span>' + html + '</span></div>'
      : '';
  }

  /** Stock levels and units come from the shared inventory. */
  function stock(key) {
    try {
      const inv = window.KGCLab && window.KGCLab._inventory && window.KGCLab._inventory();
      const v = inv && inv[key];
      const qty = v && Number(v.qty);
      return isFinite(qty) ? { qty: qty, unit: String(v.unit || 'L') } : null;
    } catch (e) { return null; }
  }

  function calc() {
    const V = n('v'), fe0 = n('fe0'), fe1 = n('fe1');
    const hc = n('hc') / 100, hd = n('hd'), ex = n('ex');
    const ac = n('ac') / 100, ad = n('ad'), ph = n('ph');

    const feKg = Math.max(0, fe0 - fe1) * V / 1000;
    const h2o2L = (feKg * G_H2O2_PER_G_FE) / (hc * hd) * ex;
    const nh3L = (feKg * G_NH3_PER_G_FE) / (ac * ad);
    const saltKg = feKg * G_NH4CL_PER_G_FE;

    setRes('o-fe', feKg, 2); setRes('o-h2o2', h2o2L, 1);
    setRes('o-nh3', nh3L, 1); setRes('o-salt', saltKg, 1);

    /* The pH decides whether the ammonia figure means anything at all. Below
       the action limit it is consumed neutralising free acid before it
       precipitates any iron; above it, adding more attacks the flux itself. */
    if (!isFinite(ph)) flag('f-ph', '', '', '');
    else if (ph < 3.5) flag('f-ph', 'crit', '!', t('fxc.phLow'));
    else if (ph > 5.5) flag('f-ph', 'crit', '!', t('fxc.phHigh'));
    else if (ph > 5.0) flag('f-ph', 'warn', '!', t('fxc.phOver'));
    else flag('f-ph', 'ok', '✓', t('fxc.phOk'));

    const msgs = [];
    const perox = stock('peroxide'), amm = stock('ammonia');
    let overStock = false;
    function compareStock(item, name, required) {
      if (!item || !isFinite(required)) return;
      if (item.unit.trim().toLowerCase() !== 'l') {
        msgs.push(t('fxc.stockUnitMismatch', { what: name, haveUnit: item.unit, needUnit: 'L' }));
        return;
      }
      if (required > item.qty) {
        overStock = true;
        msgs.push(t('fxc.overStock', { what: name, need: fmt(required, 0), have: fmt(item.qty, 0), unit: 'L' }));
      }
    }
    compareStock(perox, t('lab.item.peroxide'), h2o2L);
    compareStock(amm, t('lab.item.ammonia'), nh3L);

    if (msgs.length) flag('f-stock', overStock ? 'crit' : 'warn', '!', '<b>' + t('fxc.stockWarn') + '</b> ' + msgs.join(' — ') + '.');
    else if (isFinite(nh3L) && (perox || amm)) flag('f-stock', 'ok', '✓', t('fxc.stockOk'));
    else flag('f-stock', '', '', '');

    save();
    return { feKg: feKg, h2o2L: h2o2L, nh3L: nh3L, saltKg: saltKg };
  }

  /* Inputs are per-device working values, not plant records, so localStorage
     is the right home for them — unlike the log this replaced. */
  function save() {
    try {
      const out = {};
      Object.keys(DEFAULTS).forEach(k => { const el = $(k); if (el) out[k] = el.value; });
      localStorage.setItem(STORE, JSON.stringify(out));
    } catch (e) {}
  }

  function restore() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) {}
    Object.keys(DEFAULTS).forEach(function (k) {
      const el = $(k); if (!el) return;
      const v = saved[k] != null && saved[k] !== '' ? saved[k] : DEFAULTS[k];
      if (v != null) el.value = v;
    });
  }

  function init() {
    if (!$('v')) return;                   // flux page not present
    restore();
    Object.keys(DEFAULTS).forEach(function (k) {
      const el = $(k);
      if (el) el.addEventListener('input', calc);
    });
    calc();
  }

  document.addEventListener('DOMContentLoaded', init);
  if (window.I18N) I18N.onChange(function () { if ($('v')) calc(); });

  window.KGCFluxCalc = { calc: calc, _ratios: { G_H2O2_PER_G_FE, G_NH3_PER_G_FE, G_NH4CL_PER_G_FE } };
})();
