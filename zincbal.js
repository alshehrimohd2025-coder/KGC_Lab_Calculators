/* ============================================================
   Zinc mass balance — where each kilogram of zinc went
   ------------------------------------------------------------
   The production report says how much zinc left the kettle per shift
   (bath-level drop). The jig sheets say what went through it, batch by
   batch: product, weight, and five thickness readings. Between them the
   zinc can be split into the part the specification demands and the part
   that did not have to go.

   Coating zinc on a batch = specific area x mean thickness x 7.14 g/m2/um.
   For sheet products (tray, cover, trunking, ladder, channel) the specific
   area depends only on the gauge: 2 / (7.85 x t) m2/kg, both faces, and
   folding a sheet into a tray does not change it. That is why ISO 1461
   bands its minimums by thickness, and why no drawing is needed here.

     required   = area x the thickness the spec asks for
                  (ISO 1461 minimum mean for the gauge, or the customer's
                  figure where the sheet writes one, e.g. "65 microns")
     excess     = area x whatever was put on above that, normal steel
     reactive   = the same, on batches the operators marked reactive
                  (silicon/phosphorus steel growing an uncontrolled layer)
     residual   = zinc that left the bath minus all coating: ash and skim,
                  drag-out that drips off, splash. Dross is weighed apart.

   Shift-level residuals scatter because five readings sample a whole
   batch and the bath level is read by hand; the period total is the
   figure to act on. The page says so rather than letting one shift be
   read as a verdict.

   Depends on globals from index.html: database, IS_EDITOR, IS_AUTHED, t()
   and on window.KGCZinc (zinc.js) for the per-shift consumption.
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[zincbal] Firebase database is not available.');
    return;
  }

  const ZN_G_PER_M2_UM = 7.14;
  const STEEL_DENSITY = 7.85;

  /* Product families, matched on the sheet's own wording. Sheet gauges were
     confirmed by the plant (1.5 mm sheet products, 2 mm channel); the
     structural ones are working assumptions and can be changed on the page.
     Order matters: the first pattern that matches wins. */
  const FAMILIES = [
    { key: 'channel',  re: /channel|btb/i,                                    t: 2.0 },
    { key: 'pfo',      re: /^\s*pfo?\b/i,                                      t: 1.5 },
    { key: 'tray',     re: /tray|basket/i,                                    t: 1.5 },
    { key: 'cover',    re: /cover|plain sheet|plane sheet|barrier|fish ?plate/i, t: 1.5 },
    { key: 'trunking', re: /trunking/i,                                       t: 1.5 },
    { key: 'ladder',   re: /ladder/i,                                         t: 1.5 },
    { key: 'fitting',  re: /fitting|connector|cantilever|cable stand|caplar|coupler|stand/i, t: 2.0 },
    { key: 'tube',     re: /tube|pipe/i,                                      t: 3.0 },
    { key: 'upin',     re: /u-?\s?pin|clamp/i,                                t: 6.0 },
    { key: 'angle',    re: /angle|frame/i,                                    t: 5.0 },
    { key: 'plate',    re: /plate|bracket|beam|chakar|push|upsh/i,            t: 6.0 },
    { key: 'other',    re: /.*/,                                              t: 5.0 }
  ];

  const DEFAULT_MARGIN = 5;   // um above spec treated as a sensible target, not waste

  let batches = {};    // date -> {date, day:{rows:[]}, night:{rows:[]}}
  let settings = {};   // {margin, gauge:{family:t}}
  let prices = {};
  let losses = {};     // push-id -> {date, shift, ash, repass, note}

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const fmt = (v, d) => Number(v).toLocaleString(undefined, { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 });

  function familyOf(desc) {
    const d = String(desc || '');
    return FAMILIES.find(f => f.re.test(d)) || FAMILIES[FAMILIES.length - 1];
  }
  function gaugeOf(fam) {
    const g = settings.gauge && num(settings.gauge[fam.key]);
    return g > 0 ? g : fam.t;
  }
  function margin() {
    const m = num(settings.margin);
    return settings.margin == null ? DEFAULT_MARGIN : m;
  }
  /* ISO 1461 Table 3, minimum mean coating thickness by steel thickness */
  function isoMin(t) {
    if (t >= 6) return 85;
    if (t >= 3) return 70;
    if (t >= 1.5) return 55;
    return 45;
  }
  const areaPerKg = t => 2 / (STEEL_DENSITY * t);   // m2 per kg of steel

  /* The plant runs 1.5, 2 and 3 mm sheet under the same product names, so
     one gauge per family is not enough. Per batch, in order of trust:
       1. the gauge the sheet writes ("Cover 400 x1.5", "Channel 41x21x2.5")
       2. the gauge the weight implies: kg / (pieces x developed width x
          length x 7.85), with the developed width taken as base + two sides
          + ~40 mm of folds. Perforated tray reads thin on this, so it only
          overrides the default when it clearly says thicker (>= 1.8 mm) and
          is snapped to a stock gauge.
       3. the family default. */
  const GAUGES = [1.5, 2.0, 2.5, 3.0];
  function writtenGauge(desc) {
    const d = String(desc || '').toLowerCase();
    let m = d.match(/x\s*(\d(?:\.\d)?)\b(?!\d)/);
    if (m && +m[1] >= 1 && +m[1] <= 6) return +m[1];
    m = d.match(/41\s*x\s*[24]1\s*x\s*(\d(?:\.\d)?)/);
    return m ? +m[1] : null;
  }
  function impliedGauge(desc, qty, kg) {
    if (!(kg > 0)) return null;
    const d = String(desc || '').toLowerCase().replace(/\s+/g, '').replace(/x1\.5/g, '');
    const m = d.match(/^(tray|trunking|cover)([\d+]+)x(\d+)?(?:x(\d{3,4}))?/);
    if (!m || d.slice(m[0].length).indexOf('+') >= 0) return null;
    const fam = m[1];
    const ws = m[2].split('+').filter(Boolean).map(Number);
    const qs = (String(qty || '').match(/\d+/g) || []).map(Number);
    if (!qs.length || qs.length !== ws.length) return null;
    let h = m[3] ? +m[3] : 0, L = m[4] ? +m[4] : 0;
    if (fam === 'cover') { L = L || h; h = 0; }
    L = L || 3000;
    const fold = fam === 'cover' ? 30 : 40;
    const area = ws.reduce((a, w, i) => a + qs[i] * (w + 2 * h + fold) / 1000 * L / 1000, 0);
    return area > 0 ? kg / (area * STEEL_DENSITY) : null;
  }
  function batchGauge(line, kg, fam) {
    const w = writtenGauge(line.desc);
    if (w) return { t: w, src: 'written' };
    const ig = impliedGauge(line.desc, line.qty, kg);
    if (ig && ig >= 1.8) return { t: GAUGES.reduce((b, g) => Math.abs(g - ig) < Math.abs(b - ig) ? g : b), src: 'weight' };
    return { t: gaugeOf(fam), src: 'default' };
  }

  /* Rows without a weight are further lines of the jig above them — the
     sheet weighs the whole jig once and lists what hung on it. */
  function jigsOf(rows) {
    const jigs = [];
    (rows || []).forEach(function (r) {
      if (!r) return;
      if (num(r.kg) > 0) jigs.push({ kg: num(r.kg), lines: [r] });
      else if (jigs.length) jigs[jigs.length - 1].lines.push(r);
    });
    return jigs;
  }
  /* Re-pass: galvanized once, rejected, stripped in acid and dipped again.
     Its first coat already left the kettle on an earlier day and dissolved in
     the stripping bath; the second coat is zinc spent on steel that is not new
     product. The sheets sometimes say so in the description. */
  const REPASS_RE = /re-?\s?pass|repair|re-?\s?dip|re-?\s?galv|re-?\s?jite|re-?\s?process/i;
  const readingsOf = r => (Array.isArray(r.r) ? r.r : []).map(num).filter(x => x > 20 && x < 400);

  function balanceShift(rows, consumedKg) {
    const jigs = jigsOf(rows);
    // family means stand in for batches the operators did not measure
    const famReads = {};
    jigs.forEach(j => j.lines.forEach(function (l) {
      const f = familyOf(l.desc).key;
      const rd = readingsOf(l);
      if (rd.length) (famReads[f] = famReads[f] || []).push(...rd);
    }));
    const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
    const famMean = {};
    Object.keys(famReads).forEach(f => { famMean[f] = mean(famReads[f]); });

    const out = { kg: 0, area: 0, req: 0, over: 0, react: 0, avoid: 0, measuredKg: 0, items: [],
                  repassKg: 0, repassZn: 0,
                  gaugeKg: { written: 0, weight: 0, default: 0 } };
    jigs.forEach(function (j) {
      const head = j.lines[0];
      const fam = familyOf(head.desc);
      const g = batchGauge(head, j.kg, fam);
      const t = g.t;
      out.gaugeKg[g.src] += j.kg;
      const rd = [].concat(...j.lines.map(readingsOf));
      const reactive = j.lines.some(l => l.reactive === true || l.reactive === 'true' || l.reactive === 1);
      const mu = rd.length ? mean(rd) : (famMean[fam.key] || 68);
      const spec = Math.max(isoMin(t), ...j.lines.map(l => num(l.spec)));
      const A = areaPerKg(t) * j.kg;
      const req = A * Math.min(mu, spec) * ZN_G_PER_M2_UM / 1000;
      const extra = A * Math.max(mu - spec, 0) * ZN_G_PER_M2_UM / 1000;
      const avoid = reactive ? 0 : A * Math.max(mu - spec - margin(), 0) * ZN_G_PER_M2_UM / 1000;
      out.kg += j.kg; out.area += A; out.req += req; out.avoid += avoid;
      if (rd.length) out.measuredKg += j.kg;
      if (reactive) out.react += extra; else out.over += extra;
      if (j.lines.some(l => REPASS_RE.test(l.desc || ''))) { out.repassKg += j.kg; out.repassZn += req + extra; }
      out.items.push({ desc: head.desc, cust: head.cust, kg: j.kg, fam: fam.key, t: t,
                       mu: mu, spec: spec, reactive: reactive, measured: !!rd.length,
                       zn: req + extra, extra: extra });
    });
    out.coat = out.req + out.over + out.react;
    out.consumed = consumedKg;
    out.residual = consumedKg != null ? consumedKg - out.coat : null;
    return out;
  }

  /* ---------------- the period ---------------- */

  function compute() {
    const Z = window.KGCZinc;
    const report = (Z && Z._days && Z._days()) || {};
    const dates = Object.keys(batches).filter(d => batches[d]).sort();
    if (!dates.length) return null;

    const shifts = [];
    const P = { kg: 0, area: 0, req: 0, over: 0, react: 0, avoid: 0, cons: 0, measuredKg: 0, coat: 0,
                gaugeKg: { written: 0, weight: 0, default: 0 } };
    const unmatched = [];
    dates.forEach(function (date) {
      const b = batches[date];
      const rep = report[date];
      [['day', 'dayTon', 'dayPct'], ['night', 'nightTon', 'nightPct']].forEach(function (k) {
        const sh = b[k[0]];
        if (!sh || !sh.rows) return;
        const cons = rep && num(rep[k[2]]) > 0 && num(rep[k[1]]) > 0
          ? num(rep[k[2]]) / 100 * num(rep[k[1]]) : null;
        const s = balanceShift(sh.rows, cons);
        s.date = date; s.shift = k[0];
        s.reportKg = rep ? num(rep[k[1]]) : null;
        shifts.push(s);
        if (cons == null) { unmatched.push(date + ' ' + k[0]); return; }
        P.kg += s.kg; P.area += s.area; P.req += s.req; P.over += s.over;
        P.react += s.react; P.avoid += s.avoid; P.cons += cons; P.measuredKg += s.measuredKg;
        P.coat += s.coat;
        Object.keys(P.gaugeKg).forEach(k => { P.gaugeKg[k] += s.gaugeKg[k]; });
      });
    });
    if (!P.cons) return { shifts: shifts, empty: true, unmatched: unmatched };
    P.residual = P.cons - P.coat;

    /* Weighed ash and re-pass, per shift. Ash only splits the residual on
       the shifts where it was actually weighed, so an unlogged shift is not
       counted as zero ash. */
    const L = lossIndex();
    P.ash = 0; P.ashShifts = 0; P.ashResid = 0; P.repass = 0; P.matchedShifts = 0;
    P.repassKg = 0; P.repassZn = 0; P.repassLogged = 0;
    shifts.forEach(function (s) {
      const l = L[s.date + '_' + s.shift];
      s.ash = l ? l.ash : null; s.repass = l ? l.repass : null;
      if (s.consumed == null) return;
      P.matchedShifts++;
      if (l && l.repass) P.repass += l.repass;
      // the log wins over the sheet's own marks for the same shift, never both
      if (l && l.repass != null) {
        P.repassKg += l.repass; P.repassZn += l.repass * (s.kg ? s.coat / s.kg : 0); P.repassLogged++;
      } else { P.repassKg += s.repassKg; P.repassZn += s.repassZn; }
      if (l && l.ash != null) { P.ash += l.ash; P.ashShifts++; P.ashResid += s.residual; }
    });

    // dross is removed on stop days, so it is taken over the same calendar window
    const first = dates[0], last = dates[dates.length - 1];
    P.dross = Object.values(report).filter(d => d && d.date >= first && d.date <= last)
      .reduce((s, d) => s + num(d.dross), 0);

    // by product family and by customer, over matched shifts only
    const fam = {}, reactCust = {};
    shifts.filter(s => s.consumed != null).forEach(s => s.items.forEach(function (i) {
      const f = fam[i.fam] = fam[i.fam] || { kg: 0, zn: 0, extra: 0, reads: 0, muSum: 0, n: 0, tKg: 0 };
      f.tKg += i.t * i.kg;
      f.kg += i.kg; f.zn += i.zn; f.extra += i.extra; f.n++;
      if (i.measured) { f.reads++; f.muSum += i.mu; }
      if (i.reactive) {
        const c = reactCust[i.cust || '—'] = reactCust[i.cust || '—'] || { kg: 0, extra: 0, n: 0 };
        c.kg += i.kg; c.extra += i.extra; c.n++;
      }
    }));

    const res = { P: P, shifts: shifts, fam: fam, reactCust: reactCust, first: first, last: last,
                  unmatched: unmatched, days: dates.length };
    res.fc = forecast(res);
    return res;
  }

  function lossIndex() {
    const out = {};
    Object.values(losses || {}).forEach(function (l) {
      if (!l || !l.date || !l.shift) return;
      const k = l.date + '_' + l.shift;
      const o = out[k] = out[k] || { ash: null, repass: null };
      if (l.ash != null && l.ash !== '') o.ash = (o.ash || 0) + num(l.ash);
      if (l.repass != null && l.repass !== '') o.repass = (o.repass || 0) + num(l.repass);
    });
    return out;
  }

  /* ---------------- expected consumption from the jig mix ----------------
     What a day "should" have used given what went through the kettle, not
     just how heavy it was: each batch at its own gauge (so its own m2/t),
     at the thickness its product usually comes out at, reactive batches at
     the reactive average, plus the zinc that ends up outside the coating at
     the rate seen on the other days. Judged per day, because the split
     between day and night shift depends on when the level is read.

     The band is the forecast's own track record: leave each day out, predict
     it from the rest, and take the spread of the misses. The page shows the
     same figure for a weight-only forecast beside it, so it is plain how much
     the product mix adds; logged ash and re-pass are what should shrink it. */
  function typicalMicrons(shifts) {
    const fam = {}; const re = [];
    shifts.forEach(s => s.items.forEach(function (i) {
      if (!i.measured) return;
      if (i.reactive) re.push(i.mu); else (fam[i.fam] = fam[i.fam] || []).push(i.mu);
    }));
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const out = {}; Object.keys(fam).forEach(k => { out[k] = mean(fam[k]); });
    return { fam: out, reactive: re.length ? mean(re) : 130, all: mean([].concat(...Object.values(fam))) || 68 };
  }
  function typicalCoat(items, mu) {
    return items.reduce((a, i) => a + areaPerKg(i.t) * i.kg *
      (i.reactive ? mu.reactive : (mu.fam[i.fam] || mu.all)) * ZN_G_PER_M2_UM / 1000, 0);
  }
  function forecast(c) {
    const mu = typicalMicrons(c.shifts);
    const byDay = {};
    c.shifts.forEach(function (s) {
      const d = byDay[s.date] = byDay[s.date] || { date: s.date, kg: 0, area: 0, items: [], cons: 0, full: true,
                                                   ash: null, repass: null };
      d.kg += s.kg; d.area += s.area; d.items = d.items.concat(s.items);
      if (s.consumed == null) d.full = false; else d.cons += s.consumed;
      if (s.ash != null) d.ash = (d.ash || 0) + s.ash;
      if (s.repass != null) d.repass = (d.repass || 0) + s.repass;
    });
    const days = Object.values(byDay).sort((a, b) => a.date < b.date ? -1 : 1);
    days.forEach(d => { d.coatT = typicalCoat(d.items, mu); });
    const known = days.filter(d => d.full && d.cons > 0);
    const sum = (a, f) => a.reduce((x, y) => x + f(y), 0);
    // one rate for everything outside the coating, from the days that have both sides
    const rateAll = known.length ? sum(known, d => d.cons - d.coatT) / sum(known, d => d.kg) : 0;
    const avgAll = known.length ? sum(known, d => d.cons) / sum(known, d => d.kg) : 0;
    const errMix = [], errW = [];
    days.forEach(function (d) {
      const others = known.filter(o => o !== d);
      const rate = others.length ? sum(others, o => o.cons - o.coatT) / sum(others, o => o.kg) : rateAll;
      const avg = others.length ? sum(others, o => o.cons) / sum(others, o => o.kg) : avgAll;
      d.exp = (d.coatT + rate * d.kg) / d.kg * 1000;          // kg zinc per tonne
      d.act = d.full && d.cons > 0 ? d.cons / d.kg * 1000 : null;
      if (d.act != null && others.length) { errMix.push(d.act - d.exp); errW.push(d.act - avg * 1000); }
    });
    const rms = a => a.length ? Math.sqrt(a.reduce((x, y) => x + y * y, 0) / a.length) : null;
    const band = rms(errMix);
    days.forEach(function (d) {
      if (d.act == null || band == null) { d.verdict = null; return; }
      const z = d.act - d.exp;
      d.verdict = z > band ? 'high' : z < -band ? 'low' : 'normal';
    });
    return { days: days, mu: mu, band: band, bandW: rms(errW), rate: rateAll, n: errMix.length };
  }
  function plan(tonnesByFam, reactiveT, fc) {
    let kg = 0, zn = 0;
    FAMILIES.forEach(function (f) {
      const tt = num(tonnesByFam[f.key]); if (!(tt > 0)) return;
      const g = gaugeOf(f);
      kg += tt * 1000;
      zn += areaPerKg(g) * tt * 1000 * (fc.mu.fam[f.key] || fc.mu.all) * ZN_G_PER_M2_UM / 1000;
    });
    if (reactiveT > 0) { kg += reactiveT * 1000; zn += areaPerKg(1.5) * reactiveT * 1000 * fc.mu.reactive * ZN_G_PER_M2_UM / 1000; }
    zn += fc.rate * kg;
    return kg ? { kg: kg, zn: zn, perT: zn / kg * 1000, pct: zn / kg * 100 } : null;
  }

  /* ---------------- rendering ---------------- */

  const stat = (k, v, unit, hot) =>
    '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span>' +
    '<span class="v">' + v + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</span></div>';

  function barHTML(P) {
    const parts = [
      { k: 'req',   v: P.req,   cls: 'zb-req' },
      { k: 'over',  v: P.over,  cls: 'zb-over' },
      { k: 'react', v: P.react, cls: 'zb-react' },
      { k: 'resid', v: Math.max(P.residual - P.ash, 0), cls: 'zb-resid' }
    ];
    if (P.ash > 0) parts.splice(3, 0, { k: 'ash', v: P.ash, cls: 'zb-ash' });
    const tot = parts.reduce((s, p) => s + p.v, 0) || 1;
    const perT = v => v / (P.kg / 1000);
    return '<div class="zb-bar" role="img" aria-label="' + esc(t('zb.barAria')) + '">' +
      parts.map(p => '<span class="' + p.cls + '" style="flex:' + p.v.toFixed(1) + '" title="' +
        esc(t('zb.part.' + p.k)) + ': ' + fmt(p.v) + ' kg"></span>').join('') + '</div>' +
      '<div class="zb-legend">' + parts.map(p =>
        '<div class="zb-leg"><i class="' + p.cls + '"></i><span>' + esc(t('zb.part.' + p.k)) + '</span>' +
        '<b>' + fmt(perT(p.v), 1) + '</b><small>kg/t</small>' +
        '<em>' + (p.v / P.cons * 100).toFixed(1) + '%</em></div>').join('') + '</div>' +
      '<p class="lab-life-sub" style="margin:6px 2px 0">' + esc(t('zb.part.hint')) + '</p>';
  }

  function render() {
    const mount = document.getElementById('zb-body');
    if (!mount) return;
    const c = compute();
    const tools = toolsHTML();

    if (!c || c.empty) {
      mount.innerHTML = '<div class="lab-empty">' + esc(t(c ? 'zb.noReport' : 'zb.empty')) + '</div>' + tools;
      wire(mount);
      return;
    }
    const P = c.P;
    const tonnes = P.kg / 1000;
    const zincPrice = num(prices.zinc) || 12;

    const head =
      '<div class="pt-stats">' +
        stat(t('zb.k.cons'), fmt(P.cons / tonnes, 1), 'kg/t') +
        stat(t('zb.k.explained'), (P.coat / P.cons * 100).toFixed(0), '%') +
        stat(t('zb.k.avoid'), fmt(P.avoid), 'kg', true) +
        stat(t('zb.k.area'), fmt(P.area / tonnes), 'm²/t') +
      '</div>' +
      '<p class="lab-life-sub" style="margin:0 2px 12px">' + esc(t('zb.period', {
        a: c.first, b: c.last, n: c.days, t: fmt(tonnes), jigs: c.shifts.reduce((s, x) => s + x.items.length, 0),
        m: (P.measuredKg / P.kg * 100).toFixed(0) })) + '</p>' +
      '<p class="lab-life-sub" style="margin:0 2px 12px">' + esc(t('zb.gaugeSrc', {
        w: fmt(P.gaugeKg.written / 1000), g: fmt(P.gaugeKg.weight / 1000), d: fmt(P.gaugeKg.default / 1000) })) + '</p>' +
      barHTML(P) +
      (P.dross ? '<div class="zn-note" style="color:var(--ink-2);background:var(--recess);border-color:var(--line)">' +
        esc(t('zb.dross', { kg: fmt(P.dross), pt: fmt(P.dross / tonnes, 1) })) + '</div>' : '');

    /* the three levers, each with its own size */
    const custRows = Object.keys(c.reactCust).map(k => Object.assign({ cust: k }, c.reactCust[k]))
      .sort((a, b) => b.extra - a.extra);
    const levers =
      '<div class="zb-levers">' +
        '<div class="zb-lever"><span class="zb-lever-k">' + esc(t('zb.l1.k')) + '</span>' +
          '<b>' + fmt(P.avoid) + ' kg</b><small>' + esc(t('zb.l.value', { v: fmt(P.avoid * zincPrice) })) + '</small>' +
          '<p>' + esc(t('zb.l1.p', { m: margin() })) + '</p></div>' +
        '<div class="zb-lever"><span class="zb-lever-k">' + esc(t('zb.l2.k')) + '</span>' +
          '<b>' + fmt(P.react) + ' kg</b><small>' + esc(t('zb.l.value', { v: fmt(P.react * zincPrice) })) + '</small>' +
          '<p>' + esc(t('zb.l2.p', { n: custRows.length })) + '</p></div>' +
        '<div class="zb-lever"><span class="zb-lever-k">' + esc(t('zb.l4.k')) + '</span>' +
          '<b>' + fmt(P.repassZn) + ' kg</b><small>' + esc(t('zb.l4.small', { t: fmt(P.repassKg / 1000, 1),
            v: fmt(P.repassZn * zincPrice) })) + '</small>' +
          '<p>' + esc(t(P.repassLogged ? 'zb.l4.pLog' : 'zb.l4.p')) + '</p></div>' +
        '<div class="zb-lever"><span class="zb-lever-k">' + esc(t('zb.l3.k')) + '</span>' +
          '<b>' + fmt(P.residual) + ' kg</b><small>' + (P.residual / P.cons * 100).toFixed(1) + '%</small>' +
          '<p>' + esc(t('zb.l3.p')) + '</p></div>' +
      '</div>';

    const famRows = Object.keys(c.fam).map(k => Object.assign({ key: k }, c.fam[k]))
      .sort((a, b) => b.kg - a.kg).map(function (f) {
        const mu = f.reads ? f.muSum / f.reads : null;
        return '<tr><td class="name">' + esc(t('zb.fam.' + f.key)) + '</td>' +
          '<td class="num">' + fmt(f.tKg / f.kg, 2) + '</td>' +
          '<td class="num">' + fmt(f.kg / 1000, 1) + '</td>' +
          '<td class="num">' + f.n + '</td>' +
          '<td class="num">' + fmt(f.zn / f.kg * 1000, 1) + '</td>' +
          '<td class="num">' + (mu ? fmt(mu, 1) : '—') + '</td>' +
          '<td class="num">' + isoMin(f.tKg / f.kg) + '</td>' +
          '<td class="num">' + fmt(f.extra) + '</td></tr>';
      }).join('');

    const custTable = custRows.length ?
      '<div class="tablewrap"><table><thead><tr><th>' + esc(t('zb.c.cust')) + '</th><th>' + esc(t('zb.c.jigs')) +
      '</th><th>' + esc(t('zb.c.t')) + '</th><th>' + esc(t('zb.c.extra')) + '</th><th>' + esc(t('zb.c.perT')) +
      '</th></tr></thead><tbody>' + custRows.map(r =>
        '<tr><td class="name">' + esc(r.cust) + '</td><td class="num">' + r.n + '</td><td class="num">' +
        fmt(r.kg / 1000, 1) + '</td><td class="num">' + fmt(r.extra) + '</td><td class="num">' +
        fmt(r.extra / (r.kg / 1000), 1) + '</td></tr>').join('') + '</tbody></table></div>' : '';

    const shiftRows = c.shifts.map(function (s) {
      const r = s.residual;
      const pct = r != null && s.consumed ? r / s.consumed * 100 : null;
      const cls = pct == null ? '' : (pct < -5 || pct > 18) ? ' style="color:var(--warn)"' : '';
      const off = s.reportKg && Math.abs(s.reportKg - s.kg) > 250;
      return '<tr><td>' + esc(s.date) + '</td><td>' + esc(t('zb.shift.' + s.shift)) + '</td>' +
        '<td class="num"' + (off ? ' style="color:var(--warn)" title="' + esc(t('zb.kgOff', { r: fmt(s.reportKg) })) + '"' : '') + '>' +
          fmt(s.kg / 1000, 1) + '</td>' +
        '<td class="num">' + fmt(s.area / s.kg * 1000) + '</td>' +
        '<td class="num">' + fmt(s.coat) + '</td>' +
        '<td class="num">' + (s.consumed != null ? fmt(s.consumed) : '—') + '</td>' +
        '<td class="num"' + cls + '>' + (pct != null ? pct.toFixed(1) + '%' : '—') + '</td></tr>';
    }).join('');

    mount.innerHTML = head +
      '<h3 class="zb-h">' + esc(t('zb.h.levers')) + '</h3>' + levers +
      '<h3 class="zb-h">' + esc(t('zb.h.fam')) + '</h3>' +
      '<p class="lab-life-sub" style="margin:0 2px 8px">' + esc(t('zb.fam.sub')) + '</p>' +
      '<div class="tablewrap"><table><thead><tr>' +
        ['zb.c.fam', 'zb.c.gauge', 'zb.c.t', 'zb.c.jigs', 'zb.c.znT', 'zb.c.mu', 'zb.c.iso', 'zb.c.extra']
          .map(k => '<th>' + esc(t(k)) + '</th>').join('') +
      '</tr></thead><tbody>' + famRows + '</tbody></table></div>' +
      (custTable ? '<h3 class="zb-h">' + esc(t('zb.h.react')) + '</h3>' +
        '<p class="lab-life-sub" style="margin:0 2px 8px">' + esc(t('zb.react.sub')) + '</p>' + custTable : '') +
      '<h3 class="zb-h">' + esc(t('zb.h.shifts')) + '</h3>' +
      '<p class="lab-life-sub" style="margin:0 2px 8px">' + esc(t('zb.shifts.sub')) + '</p>' +
      '<div class="tablewrap"><table><thead><tr>' +
        ['zb.c.date', 'zb.c.shift', 'zb.c.t', 'zb.c.area', 'zb.c.coat', 'zb.c.cons', 'zb.c.resid']
          .map(k => '<th>' + esc(t(k)) + '</th>').join('') +
      '</tr></thead><tbody>' + shiftRows + '</tbody></table></div>' +
      (c.unmatched.length ? '<p class="lab-life-sub" style="margin:8px 2px 0">' +
        esc(t('zb.unmatched', { list: c.unmatched.join('، ') })) + '</p>' : '') +
      forecastHTML(c) + lossHTML(c) + planHTML(c.fc) +
      tools;
    wire(mount);
  }

  function forecastHTML(c) {
    const fc = c.fc;
    if (!fc || !fc.days.length) return '';
    const pill = v => v ? '<span class="zb-v zb-v-' + v + '">' + esc(t('zb.v.' + v)) + '</span>' : '—';
    const rows = fc.days.slice().reverse().map(d =>
      '<tr><td>' + esc(d.date) + '</td>' +
      '<td class="num">' + fmt(d.kg / 1000, 1) + '</td>' +
      '<td class="num">' + fmt(d.area / d.kg * 1000) + '</td>' +
      '<td class="num">' + fmt(d.exp, 1) + '</td>' +
      '<td class="num">' + (d.act != null ? fmt(d.act, 1) : '—') + '</td>' +
      '<td class="num">' + (d.act != null ? (d.act - d.exp >= 0 ? '+' : '') + fmt(d.act - d.exp, 1) : '—') + '</td>' +
      '<td>' + pill(d.verdict) + '</td>' +
      '<td class="num">' + (d.ash != null ? fmt(d.ash) : '—') + '</td>' +
      '<td class="num">' + (d.repass != null ? fmt(d.repass) : '—') + '</td></tr>').join('');
    return '<h3 class="zb-h">' + esc(t('zb.h.fc')) + '</h3>' +
      '<p class="lab-life-sub" style="margin:0 2px 8px">' + esc(t('zb.fc.sub')) + '</p>' +
      (fc.band != null ? '<div class="zn-note" style="color:var(--ink-2);background:var(--recess);border-color:var(--line)">' +
        esc(t('zb.fc.track', { m: fmt(fc.band, 1), w: fmt(fc.bandW, 1), n: fc.n })) + '</div>' : '') +
      '<div class="tablewrap"><table><thead><tr>' +
        ['zb.c.date', 'zb.c.t', 'zb.c.area', 'zb.c.exp', 'zb.c.act', 'zb.c.diff', 'zb.c.verdict', 'zb.c.ash', 'zb.c.repass']
          .map(k => '<th>' + esc(t(k)) + '</th>').join('') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function lossHTML(c) {
    const today = new Date().toISOString().slice(0, 10);
    const list = Object.keys(losses || {}).map(k => Object.assign({ key: k }, losses[k]))
      .filter(l => l && l.date).sort((a, b) => (b.date + b.shift) < (a.date + a.shift) ? -1 : 1).slice(0, 20);
    const P = c.P;
    const cover = P.matchedShifts ? t('zb.log.cover', { a: P.ashShifts, n: P.matchedShifts,
      p: P.ashShifts && P.ashResid > 0 ? (P.ash / P.ashResid * 100).toFixed(0) : '—' }) : '';
    return '<h3 class="zb-h">' + esc(t('zb.h.log')) + '</h3>' +
      '<p class="lab-life-sub" style="margin:0 2px 8px">' + esc(t('zb.log.sub')) + '</p>' +
      (cover ? '<p class="lab-life-sub" style="margin:0 2px 10px">' + esc(cover) + '</p>' : '') +
      '<div class="lab-form" id="zb-log-form">' +
        '<div><label>' + esc(t('zb.c.date')) + '</label><input type="date" id="zbl-date" value="' + today + '"></div>' +
        '<div><label>' + esc(t('zb.c.shift')) + '</label><select id="zbl-shift">' +
          '<option value="day">' + esc(t('zb.shift.day')) + '</option><option value="night">' + esc(t('zb.shift.night')) + '</option></select></div>' +
        '<div><label>' + esc(t('zb.log.ash')) + ' <span class="unit">kg</span></label><input type="number" step="any" min="0" id="zbl-ash"></div>' +
        '<div><label>' + esc(t('zb.log.repass')) + ' <span class="unit">kg</span></label><input type="number" step="any" min="0" id="zbl-repass"></div>' +
        '<div style="grid-column:span 2"><label>' + esc(t('zb.log.note')) + '</label><input type="text" id="zbl-note" maxlength="120"></div>' +
        '<div><button class="btn" id="zbl-save" style="width:100%;justify-content:center">' + esc(t('zb.log.save')) + '</button></div>' +
        '<div style="grid-column:1/-1"><span id="zbl-msg"></span></div>' +
      '</div>' +
      (list.length ? '<div class="tablewrap" style="margin-top:10px"><table><thead><tr>' +
        ['zb.c.date', 'zb.c.shift', 'zb.c.ash', 'zb.c.repass', 'zb.log.note', ''].map(k => '<th>' + (k ? esc(t(k)) : '') + '</th>').join('') +
        '</tr></thead><tbody>' + list.map(l =>
          '<tr><td>' + esc(l.date) + '</td><td>' + esc(t('zb.shift.' + l.shift)) + '</td>' +
          '<td class="num">' + (l.ash != null && l.ash !== '' ? fmt(l.ash) : '—') + '</td>' +
          '<td class="num">' + (l.repass != null && l.repass !== '' ? fmt(l.repass) : '—') + '</td>' +
          '<td>' + esc(l.note || '') + '</td>' +
          '<td><button class="btn mini danger" data-zbl-del="' + esc(l.key) + '">' + esc(t('zb.log.del')) + '</button></td></tr>').join('') +
        '</tbody></table></div>' : '');
  }

  function planHTML(fc) {
    if (!fc) return '';
    const fams = FAMILIES.filter(f => f.key !== 'other');
    return '<h3 class="zb-h">' + esc(t('zb.h.plan')) + '</h3>' +
      '<p class="lab-life-sub" style="margin:0 2px 8px">' + esc(t('zb.plan.sub')) + '</p>' +
      '<div class="lab-form" id="zb-plan">' +
        fams.map(f => '<div><label>' + esc(t('zb.fam.' + f.key)) + ' <span class="unit">t</span></label>' +
          '<input type="number" step="any" min="0" data-plan="' + f.key + '"></div>').join('') +
        '<div><label>' + esc(t('zb.plan.react')) + ' <span class="unit">t</span></label><input type="number" step="any" min="0" id="zbp-react"></div>' +
      '</div>' +
      '<div class="pt-stats" id="zb-plan-out" style="margin-top:12px"></div>';
  }

  /* ---------------- settings, import, export ---------------- */

  function toolsHTML() {
    const gauges = FAMILIES.filter(f => f.key !== 'other').map(f =>
      '<div><label>' + esc(t('zb.fam.' + f.key)) + ' <span class="unit">mm</span></label>' +
      '<input type="number" step="0.1" min="0.5" data-gauge="' + f.key + '" value="' + gaugeOf(f) + '"></div>').join('');
    return '<details class="zb-tools"' + (Object.keys(batches).length ? '' : ' open') + '>' +
      '<summary>' + esc(t('zb.tools')) + '</summary>' +
      '<p class="lab-life-sub" style="margin:10px 2px">' + esc(t('zb.tools.sub')) + '</p>' +
      '<div class="lab-form">' +
        '<div><label>' + esc(t('zb.margin')) + ' <span class="unit">µm</span></label>' +
        '<input type="number" step="1" min="0" id="zb-margin" value="' + margin() + '"></div>' +
        gauges +
        '<div><button class="btn" id="zb-save" style="width:100%;justify-content:center">' + esc(t('zb.save')) + '</button></div>' +
      '</div>' +
      '<div class="zb-io">' +
        '<button class="btn" id="zb-import">' + esc(t('zb.import')) + '</button>' +
        '<button class="btn" id="zb-export">' + esc(t('zb.export')) + '</button>' +
        '<input type="file" id="zb-file" accept=".csv,text/csv" hidden>' +
        '<span id="zb-msg"></span>' +
      '</div>' +
      '<p class="lab-life-sub" style="margin:8px 2px 0">' + esc(t('zb.csvFormat')) + '</p>' +
    '</details>';
  }

  const CSV_HEAD = ['date', 'shift', 'row', 'description', 'customer', 'qty', 'kg',
                    'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'reactive', 'spec'];

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function parseCSV(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(c => c.trim() !== '')) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some(c => c.trim() !== '')) rows.push(row);
    return rows;
  }
  function isoDate(s) {
    s = String(s || '').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
    if (m) return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    return null;
  }

  function doExport() {
    const lines = [CSV_HEAD.join(',')];
    Object.keys(batches).sort().forEach(function (date) {
      ['day', 'night'].forEach(function (s) {
        const sh = batches[date][s];
        (sh && sh.rows || []).forEach(function (r) {
          const rd = Array.isArray(r.r) ? r.r : [];
          lines.push([date, s, r.n, r.desc, r.cust, r.qty, r.kg || '']
            .concat([0, 1, 2, 3, 4, 5, 6].map(i => rd[i] != null ? rd[i] : ''))
            .concat([r.reactive ? 1 : '', r.spec || '']).map(csvCell).join(','));
        });
      });
    });
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'jig_batches.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function doImport(text, say) {
    const rows = parseCSV(text.replace(/^﻿/, ''));
    if (!rows.length) { say(t('zb.csvEmpty'), true); return; }
    const head = rows[0].map(h => h.trim().toLowerCase());
    const col = k => head.indexOf(k);
    if (col('date') < 0 || col('shift') < 0 || col('description') < 0) { say(t('zb.csvBad'), true); return; }
    const out = {}; let n = 0, skipped = 0;
    rows.slice(1).forEach(function (r) {
      const date = isoDate(r[col('date')]);
      const shift = /n/i.test(r[col('shift')] || '') ? 'night' : (/d/i.test(r[col('shift')] || '') ? 'day' : null);
      const desc = (r[col('description')] || '').trim();
      if (!date || !shift || !desc) { skipped++; return; }
      const rd = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'].map(k => num(r[col(k)])).filter(x => x > 0);
      const kg = num(r[col('kg')]);
      const rec = { n: String(r[col('row')] || ''), desc: desc, cust: (r[col('customer')] || '').trim(),
                    qty: String(r[col('qty')] || ''), kg: kg > 0 ? kg : null, r: rd };
      if (/^(1|true|yes|y|نعم)$/i.test(String(r[col('reactive')] || '').trim())) rec.reactive = true;
      if (num(r[col('spec')]) > 0) rec.spec = num(r[col('spec')]);
      out[date] = out[date] || { date: date };
      (out[date][shift] = out[date][shift] || { rows: [] }).rows.push(rec);
      n++;
    });
    if (!n) { say(t('zb.csvEmpty'), true); return; }
    // a shift in the file replaces that shift in the store; others are left alone
    const updates = {};
    Object.keys(out).forEach(function (d) {
      updates['jig_batches/' + d + '/date'] = d;
      ['day', 'night'].forEach(s => { if (out[d][s]) updates['jig_batches/' + d + '/' + s] = out[d][s]; });
    });
    database.ref().update(updates)
      .then(() => say(t('zb.csvOk', { n: n, d: Object.keys(out).length, s: skipped })))
      .catch(e => say(t('coat.failed') + ' ' + e.message, true));
  }

  function wire(mount) {
    const msg = mount.querySelector('#zb-msg');
    const say = (m, bad) => { if (msg) { msg.textContent = m; msg.style.color = bad ? 'var(--crit)' : 'var(--accent)'; } };
    const save = mount.querySelector('#zb-save');
    if (save) save.addEventListener('click', function () {
      if (!IS_EDITOR || !IS_AUTHED) { say(t('coat.needAuth'), true); return; }
      const gauge = {};
      mount.querySelectorAll('[data-gauge]').forEach(function (el) {
        const v = Number(el.value);
        if (v > 0) gauge[el.getAttribute('data-gauge')] = v;
      });
      const m = Number((mount.querySelector('#zb-margin') || {}).value);
      database.ref('zincbal_settings').set({ margin: isFinite(m) && m >= 0 ? m : DEFAULT_MARGIN, gauge: gauge })
        .then(() => say(t('zb.saved')))
        .catch(e => say(t('coat.failed') + ' ' + e.message, true));
    });
    const imp = mount.querySelector('#zb-import'), file = mount.querySelector('#zb-file');
    if (imp && file) {
      imp.addEventListener('click', function () {
        if (!IS_EDITOR || !IS_AUTHED) { say(t('coat.needAuth'), true); return; }
        file.click();
      });
      file.addEventListener('change', function () {
        const f = file.files && file.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => doImport(String(rd.result || ''), say);
        rd.onerror = () => say(t('zb.csvBad'), true);
        rd.readAsText(f, 'utf-8');
        file.value = '';
      });
    }
    const exp = mount.querySelector('#zb-export');
    if (exp) exp.addEventListener('click', doExport);

    const lsave = mount.querySelector('#zbl-save');
    if (lsave) lsave.addEventListener('click', function () {
      const m = mount.querySelector('#zbl-msg');
      const sayL = (x, bad) => { if (m) { m.textContent = x; m.style.color = bad ? 'var(--crit)' : 'var(--accent)'; } };
      if (!IS_EDITOR || !IS_AUTHED) { sayL(t('coat.needAuth'), true); return; }
      const v = id => (mount.querySelector(id) || {}).value || '';
      const date = v('#zbl-date'), shift = v('#zbl-shift');
      const ash = v('#zbl-ash'), repass = v('#zbl-repass');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { sayL(t('zb.log.errDate'), true); return; }
      if (ash === '' && repass === '') { sayL(t('zb.log.errEmpty'), true); return; }
      const rec = { date: date, shift: shift, ts: Date.now() };
      if (ash !== '') rec.ash = Number(ash);
      if (repass !== '') rec.repass = Number(repass);
      if (v('#zbl-note').trim()) rec.note = v('#zbl-note').trim().slice(0, 120);
      if ((rec.ash != null && !(rec.ash >= 0)) || (rec.repass != null && !(rec.repass >= 0))) { sayL(t('zb.log.errEmpty'), true); return; }
      database.ref('zinc_losses').push(rec)
        .then(() => sayL(t('zb.saved')))
        .catch(e => sayL(t('coat.failed') + ' ' + e.message, true));
    });
    mount.querySelectorAll('[data-zbl-del]').forEach(b => b.addEventListener('click', function () {
      if (!IS_EDITOR || !IS_AUTHED) return;
      if (!confirm(t('zb.log.confirmDel'))) return;
      database.ref('zinc_losses/' + b.getAttribute('data-zbl-del')).remove();
    }));

    const planBox = mount.querySelector('#zb-plan');
    if (planBox) {
      const upd = function () {
        const c = compute(); const out = mount.querySelector('#zb-plan-out');
        if (!c || !c.fc || !out) return;
        const tons = {};
        planBox.querySelectorAll('[data-plan]').forEach(el => { tons[el.getAttribute('data-plan')] = Number(el.value) || 0; });
        const r = plan(tons, Number((mount.querySelector('#zbp-react') || {}).value) || 0, c.fc);
        out.innerHTML = r
          ? stat(t('zb.plan.perT'), fmt(r.perT, 1), 'kg/t') + stat(t('zb.plan.pct'), r.pct.toFixed(2), '%') +
            stat(t('zb.plan.zn'), fmt(r.zn), 'kg') + stat(t('zb.plan.band'), '± ' + fmt(c.fc.band || 0, 1), 'kg/t')
          : '<p class="lab-life-sub" style="margin:0 2px">' + esc(t('zb.plan.empty')) + '</p>';
      };
      planBox.addEventListener('input', upd);
      upd();
    }
  }

  /* ---------------- wiring ---------------- */

  database.ref('jig_batches').on('value', s => { batches = s.val() || {}; render(); });
  database.ref('zincbal_settings').on('value', s => { settings = s.val() || {}; render(); });
  database.ref('prices').on('value', s => { prices = s.val() || {}; render(); });
  database.ref('zinc_losses').on('value', s => { losses = s.val() || {}; render(); });
  database.ref('zinc_daily').on('value', render);
  if (window.I18N && I18N.onChange) I18N.onChange(render);

  window.KGCZincBal = { render: render, _compute: compute, _balanceShift: balanceShift,
                        _familyOf: familyOf, _import: doImport, _batchGauge: batchGauge, _plan: plan };
})();
