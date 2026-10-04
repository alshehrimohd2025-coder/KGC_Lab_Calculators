/* ============================================================
   Pickling tanks — duty grade, routing and acid make-up
   ------------------------------------------------------------
   Five baths are graded A-D on how much work they can still do:
   the four HCl pickling tanks, the temporary acid tank (which the
   plant runs as a fifth), and the stripping bath.

   The grade is NOT a second opinion on the approved standard. The
   standard (KGCSpecs) still decides what counts as a breach, and it
   drives the tank cards, the attention panel and the manager's view.
   The grade answers a different question — what work this bath can
   take today — so a bath can be inside the standard and still be too
   tired for heavy sections.

   The two never contradict each other because grade D starts exactly
   where the standard's own iron limit does (140 g/L). Dropping D to
   130, as first drafted, would have printed "never use" next to a
   green "within standard" badge on the same screen.

   The stripping bath is graded on its own approved ceilings (Fe 50,
   Zn 120 g/L), not the pickling iron bands — its chemistry is not the
   same job, and 140 g/L of iron there would be far past dead.

   Data:
     readings_log/<tankId>_<date>   chemistry (shared with lab.js) plus
                                    temperature, level, sludge and notes
     acid_additions/<pushId>        top-ups, in tonnes of stock acid
   Production tonnage for the per-tonne figure comes from zinc_daily,
   so nobody has to type an assumed daily output.

   Every make-up figure is a mass balance on % w/w. Real baths are read
   by level, and density moves with iron, so treat the litres as a
   starting quantity to check on the gauge, not a number to pour blind.

   Depends on globals from index.html:
     database, tanks, tankLabel(), saveToStorage(), IS_EDITOR, IS_AUTHED,
     I18N / t(), KGCSpecs (optional), KGCZinc (optional)
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[pickling] Firebase database is not available.');
    return;
  }

  const PICKLE_IDS = [3, 4, 5, 6, 8];   // HCl pickling + the temporary acid tank
  const STRIP_ID   = 7;                 // stripping / de-zincing
  const ALL_IDS    = PICKLE_IDS.concat([STRIP_ID]);

  /* Grade bands. A-C are the plant's own draft; D is pinned to the
     standard's iron limit so the two readings of the same tank agree. */
  const FE_DEAD   = 140;   // = KGCSpecs acid `fe.max`
  const FE_TIRED  = 110;
  const FE_FRESH  = 90;
  const HCL_STRONG = 10, HCL_WORKING = 6, HCL_WEAK = 3;

  const STRIP_FE_MAX = 50, STRIP_ZN_MAX = 120;   // = KGCSpecs tank 7
  const NEAR = 0.8;                              // within 80% of a ceiling = C

  const NO_TOPUP_FE = 110;   // above this, more acid buys very little

  const RANK = { A: 0, B: 1, C: 2, D: 3 };
  const worse = (a, b) => (!a ? b : !b ? a : (RANK[a] >= RANK[b] ? a : b));

  let readings = {}, additions = {};

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const num = v => { const n = Number(v); return isFinite(n) ? n : NaN; };
  const pad = n => (n < 10 ? '0' : '') + n;
  const canEdit = () => (typeof IS_EDITOR !== 'undefined' && IS_EDITOR) &&
                        (typeof IS_AUTHED !== 'undefined' && IS_AUTHED);
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const val = id => ((document.getElementById(id) || {}).value || '').trim();
  /* An empty box is not a zero. Number('') is 0, so reading inputs straight
     through num() would save a blank iron field as 0 g/L and overwrite the
     real reading held against that day. */
  const inputNum = id => { const s = val(id); return s === '' ? NaN : num(s); };
  const fx = (v, n) => (isFinite(v) ? v.toFixed(n == null ? 1 : n) : '—');

  function nameOf(id) {
    const tk = (typeof tanks !== 'undefined' ? tanks : []).find(x => x.id === id);
    return tk ? tankLabel(tk.name) : ('#' + id);
  }

  /* ---------------- grading ---------------- */

  function hclGrade(v) {
    if (!isFinite(v) || v <= 0) return null;
    return v >= HCL_STRONG ? 'A' : v >= HCL_WORKING ? 'B' : v >= HCL_WEAK ? 'C' : 'D';
  }

  function feGrade(v) {
    if (!isFinite(v) || v <= 0) return null;
    return v < FE_FRESH ? 'A' : v < FE_TIRED ? 'B' : v < FE_DEAD ? 'C' : 'D';
  }

  function ceilingGrade(v, max) {
    if (!isFinite(v) || v <= 0) return null;
    return v >= max ? 'D' : v >= max * NEAR ? 'C' : 'A';
  }

  /** Latest reading logged for a tank, newest date wins. */
  function latest(tankId) {
    let best = null;
    Object.keys(readings).forEach(function (k) {
      const r = readings[k];
      if (!r || Number(r.tankId) !== tankId) return;
      if (!best || (r.date || '') > (best.date || '')) best = r;
    });
    return best;
  }

  /** {grade, reason, reading} for a tank, or grade null when nothing is logged. */
  /* The latest record that actually carries this figure: a day where only
     the acid was titrated must not wipe out the iron measured two days before. */
  function latestValue(tankId, f) {
    let best = null;
    Object.keys(readings).forEach(function (k) {
      const r = readings[k];
      if (!r || Number(r.tankId) !== tankId || r[f] == null || r[f] === '') return;
      if (!best || (r.date || '') > (best.date || '')) best = r;
    });
    return best ? num(best[f]) : NaN;
  }

  function gradeOf(tankId) {
    const r = latest(tankId);
    if (!r) return { grade: null, reading: null };
    const hcl = latestValue(tankId, 'acidPercent'), fe = latestValue(tankId, 'fe'), zn = latestValue(tankId, 'zn');

    let g = hclGrade(hcl), why = 'hcl';
    const other = tankId === STRIP_ID
      ? worse(ceilingGrade(fe, STRIP_FE_MAX), ceilingGrade(zn, STRIP_ZN_MAX))
      : feGrade(fe);
    if (other && (!g || RANK[other] > RANK[g])) { g = other; why = tankId === STRIP_ID ? 'strip' : 'fe'; }
    return { grade: g, why: g ? why : null, reading: r, hcl: hcl, fe: fe, zn: zn };
  }

  function allGrades() {
    return ALL_IDS.map(id => Object.assign({ id: id }, gradeOf(id)));
  }

  /* ---------------- routing ---------------- */

  /* Heavy work wants the strongest acid; light work is better sent to a
     tired bath so the strong ones are kept for what needs them. Rework
     goes to the stripping bath and nowhere else. A D bath takes nothing. */
  const DUTIES = {
    heavy:  ['A', 'B'],
    normal: ['B', 'A'],
    light:  ['C', 'B'],
    rework: null                        // stripping tank only
  };

  function route(duty) {
    const grades = allGrades();
    if (duty === 'rework') {
      const s = grades.find(x => x.id === STRIP_ID);
      return { picks: (s && s.grade && s.grade !== 'D') ? [s] : [], blocked: s && s.grade === 'D' ? [s] : [] };
    }
    const order = DUTIES[duty] || [];
    const pool = grades.filter(x => x.id !== STRIP_ID);
    const picks = [];
    order.forEach(function (g) {
      pool.forEach(function (x) { if (x.grade === g) picks.push(x); });
    });
    return { picks: picks, blocked: pool.filter(x => x.grade === 'D') };
  }

  /* ---------------- make-up calculators ---------------- */

  /** Stock acid needed to lift a bath from Cc to Ct, by mass balance. */
  function topUp(M, Cc, Ct, Cs, freeSpace, fe) {
    if (!(M > 0) || !isFinite(Cc) || !(Ct > 0) || !(Cs > Ct)) return null;
    const stop = isFinite(fe) && fe >= NO_TOPUP_FE;
    const want = M * (Ct - Cc) / (Cs - Ct);
    const capped = isFinite(freeSpace) && freeSpace > 0 && want > freeSpace;
    return {
      stop: stop, fe: fe,
      want: want,
      acid: capped ? freeSpace : want,
      capped: capped, freeSpace: freeSpace,
      reached: capped ? (M * Cc + freeSpace * Cs) / (M + freeSpace) : Ct,
      already: Cc >= Ct
    };
  }

  /** Drain a fraction to bring iron down, then refill to mass with acid + water. */
  function refresh(M, feC, feT, Cc, Ct, Cs, tanker, tripCost) {
    if (!(M > 0) || !(feC > 0) || !(feT > 0) || !(Cs > 0) || !isFinite(Cc) || !(Ct > 0)) return null;
    if (feT >= feC) return { none: true };
    const f = 1 - feT / feC;
    const drained = M * f;
    const acid = (Ct * M - Cc * M * (1 - f)) / Cs;
    const water = drained - acid;
    const trips = (tanker > 0) ? Math.ceil(drained / tanker) : NaN;
    const cost = isFinite(trips) && isFinite(tripCost) ? trips * tripCost : NaN;

    // the alternative: throw the whole charge away and fill from new
    const fullAcid = M * Ct / Cs;
    const fullTrips = (tanker > 0) ? Math.ceil(M / tanker) : NaN;
    const fullCost = isFinite(fullTrips) && isFinite(tripCost) ? fullTrips * tripCost : NaN;

    return {
      f: f, drained: drained, acid: acid, water: water,
      short: water < 0, trips: trips, cost: cost,
      full: { drained: M, acid: fullAcid, water: M - fullAcid, trips: fullTrips, cost: fullCost },
      savedAcid: fullAcid - acid, savedCost: fullCost - cost
    };
  }

  function newFill(M, Ct, Cs) {
    if (!(M > 0) || !(Ct > 0) || !(Cs > Ct)) return null;
    const acid = M * Ct / Cs;
    return { acid: acid, water: M - acid };
  }

  /* ---------------- production, for the per-tonne figure ---------------- */

  /** Tonnes of steel processed in a YYYY-MM month, from the production sheet. */
  function tonnesInMonth(ym) {
    const Z = window.KGCZinc;
    if (!Z || !Z._days) return NaN;
    const days = Z._days() || {};
    let kg = 0, seen = false;
    Object.keys(days).forEach(function (k) {
      const d = days[k];
      if (!d || String(d.date || k).slice(0, 7) !== ym) return;
      kg += Number(d.totalTon) || 0; seen = true;
    });
    return seen ? kg / 1000 : NaN;     // the sheet's "tonnage" column is kilograms
  }

  /* ---------------- rendering helpers ---------------- */

  function field(id, label, hint, step, value, type) {
    return '<div class="field"><label for="' + id + '">' + esc(label) + '</label>' +
      '<input type="' + (type || 'number') + '" id="' + id + '"' +
      (type === 'date' ? '' : ' step="' + (step || 'any') + '"') +
      (value != null && value !== '' ? ' value="' + esc(value) + '"' : '') + '>' +
      (hint ? '<p class="hint">' + esc(hint) + '</p>' : '') + '</div>';
  }

  function tankSelect(id, ids, sel) {
    return '<div class="field"><label for="' + id + '">' + esc(t('pk.tank')) + '</label>' +
      '<select id="' + id + '">' + ids.map(function (i) {
        return '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + esc(nameOf(i)) + '</option>';
      }).join('') + '</select></div>';
  }

  const gradeChip = g => g
    ? '<span class="pk-grade pk-' + g.toLowerCase() + '">' + g + '</span>'
    : '<span class="pk-grade pk-none">—</span>';

  /* ---------------- section 1: status cards ---------------- */

  function statusHTML() {
    const cards = allGrades().map(function (x) {
      const r = x.reading || {};
      const rows = [
        [t('pk.hcl'), isFinite(x.hcl) && x.hcl ? fx(x.hcl, 2) + ' %' : '—'],
        [x.id === STRIP_ID ? t('pk.zn') : t('pk.fe'),
         x.id === STRIP_ID
           ? (isFinite(x.zn) && x.zn ? fx(x.zn, 1) + ' g/L' : '—')
           : (isFinite(x.fe) && x.fe ? fx(x.fe, 1) + ' g/L' : '—')],
        [t('pk.temp'), Number(r.temp) ? fx(Number(r.temp), 1) + ' °C' : '—'],
        [t('pk.level'), Number(r.level) ? fx(Number(r.level), 1) + ' cm' : '—'],
        [t('pk.sludge'), Number(r.sludge) ? fx(Number(r.sludge), 1) + ' cm' : '—']
      ];
      return '<div class="pk-card pk-b-' + (x.grade ? x.grade.toLowerCase() : 'none') + '">' +
        '<div class="pk-card-head"><span class="pk-card-name">' + esc(nameOf(x.id)) + '</span>' +
          gradeChip(x.grade) + '</div>' +
        '<div class="pk-card-body">' +
          rows.map(p => '<div class="pk-row"><span>' + esc(p[0]) + '</span><b>' + esc(p[1]) + '</b></div>').join('') +
        '</div>' +
        '<div class="pk-card-foot">' +
          (x.grade ? esc(t('pk.g.' + x.grade.toLowerCase())) : esc(t('pk.noReading'))) +
          (r.date ? ' · ' + esc(r.date) : '') +
        '</div>' +
        (r.notes ? '<div class="pk-note">' + esc(r.notes) + '</div>' : '') +
      '</div>';
    }).join('');

    return '<section><div class="sechead"><span class="secnum">١</span>' +
      '<h2 class="sectitle">' + esc(t('pk.s1')) + '</h2></div>' +
      '<p class="secsub">' + esc(t('pk.s1sub')) + '</p>' +
      '<div class="pk-cards">' + cards + '</div></section>';
  }

  /* ---------------- section 2: jig routing ---------------- */

  function routingHTML() {
    const opts = ['heavy', 'normal', 'light', 'rework']
      .map(k => '<option value="' + k + '">' + esc(t('pk.duty.' + k)) + '</option>').join('');
    return '<section><div class="sechead"><span class="secnum">٢</span>' +
      '<h2 class="sectitle">' + esc(t('pk.s2')) + '</h2></div>' +
      '<p class="secsub">' + esc(t('pk.s2sub')) + '</p>' +
      '<div class="panel"><div class="panel-in">' +
        '<div class="grid g3"><div class="field"><label for="pk-duty">' + esc(t('pk.duty')) + '</label>' +
        '<select id="pk-duty">' + opts + '</select></div></div>' +
      '</div><div class="panel-out"><div id="pk-route"></div></div></div></section>';
  }

  function renderRoute() {
    const out = document.getElementById('pk-route');
    if (!out) return;
    const duty = (document.getElementById('pk-duty') || {}).value || 'heavy';
    const res = route(duty);

    if (!res.picks.length) {
      out.innerHTML = '<div class="fx-note-empty">' + esc(t('pk.noTank')) + '</div>' +
        (res.blocked && res.blocked.length
          ? '<p class="fx-basis">' + esc(t('pk.blocked', { n: res.blocked.map(x => nameOf(x.id)).join(' · ') })) + '</p>'
          : '');
      return;
    }
    const first = res.picks[0];
    out.innerHTML =
      '<div class="res hero fx-rec"><span class="rk">' + esc(t('pk.sendTo')) + '</span>' +
        '<span class="rv">' + esc(nameOf(first.id)) + ' ' + gradeChip(first.grade) + '</span></div>' +
      (res.picks.length > 1
        ? '<p class="fx-basis">' + esc(t('pk.thenTry', {
            n: res.picks.slice(1).map(x => nameOf(x.id) + ' (' + x.grade + ')').join(' · ')
          })) + '</p>'
        : '') +
      (res.blocked.length
        ? '<p class="fx-basis">' + esc(t('pk.blocked', { n: res.blocked.map(x => nameOf(x.id)).join(' · ') })) + '</p>'
        : '');
  }

  /* ---------------- section 3: daily log ---------------- */

  function dailyRows() {
    return Object.keys(readings).map(function (k) {
      const r = readings[k] || {};
      return Object.assign({ _k: k }, r);
    }).filter(r => ALL_IDS.indexOf(Number(r.tankId)) !== -1 && r.date)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.tankId - b.tankId));
  }

  function dailyHTML() {
    const rows = dailyRows().slice(0, 60).map(function (r) {
      const g = (function () {
        const hcl = num(r.acidPercent), fe = num(r.fe), zn = num(r.zn);
        const other = Number(r.tankId) === STRIP_ID
          ? worse(ceilingGrade(fe, STRIP_FE_MAX), ceilingGrade(zn, STRIP_ZN_MAX))
          : feGrade(fe);
        return worse(hclGrade(hcl), other);
      })();
      return '<tr>' +
        '<td class="num">' + esc(r.date) + '</td>' +
        '<td>' + esc(nameOf(Number(r.tankId))) + '</td>' +
        '<td class="num">' + (Number(r.acidPercent) ? fx(Number(r.acidPercent), 2) : '—') + '</td>' +
        '<td class="num">' + (Number(r.fe) ? fx(Number(r.fe), 1) : '—') + '</td>' +
        '<td class="num">' + (Number(r.temp) ? fx(Number(r.temp), 1) : '—') + '</td>' +
        '<td class="num">' + (Number(r.level) ? fx(Number(r.level), 1) : '—') + '</td>' +
        '<td class="num">' + (Number(r.sludge) ? fx(Number(r.sludge), 1) : '—') + '</td>' +
        '<td class="num">' + gradeChip(g) + '</td>' +
        '<td>' + esc(r.notes || '') + '</td>' +
      '</tr>';
    }).join('');

    const form = canEdit()
      ? '<div class="panel" style="margin-top:16px"><div class="panel-in" style="border-bottom:none">' +
          '<p class="panel-label">' + esc(t('pk.logNew')) + '</p>' +
          '<div class="grid g3">' +
            field('pk-date', t('pk.date'), '', null, today(), 'date') +
            tankSelect('pk-tank', ALL_IDS, PICKLE_IDS[0]) +
            field('pk-temp', t('pk.tempIn'), '', '0.5', '') +
          '</div>' +
          '<div class="grid g3" style="margin-top:14px">' +
            field('pk-hcl', t('pk.hclIn'), t('pk.chemHint'), '0.01', '') +
            field('pk-fe', t('pk.feIn'), t('pk.chemHint'), '0.5', '') +
            field('pk-zn', t('pk.znIn'), t('pk.znHint'), '0.5', '') +
          '</div>' +
          '<div class="grid g3" style="margin-top:14px">' +
            field('pk-level', t('pk.levelIn'), t('pk.levelHint'), '0.5', '') +
            field('pk-sludge', t('pk.sludgeIn'), t('pk.sludgeHint'), '0.5', '') +
          '</div>' +
          '<div class="saverow" style="border-top:none;padding-top:14px">' +
            '<div class="field"><label>' + esc(t('pk.notes')) + '</label>' +
              '<input type="text" id="pk-notes" placeholder="' + esc(t('flux.d.optional')) + '"></div>' +
            '<div><button class="btn" id="pk-save">' + esc(t('flux.d.save')) + '</button></div>' +
          '</div>' +
          '<p id="pk-msg" class="fx-msg"></p>' +
        '</div></div>'
      : '';

    const table = rows
      ? '<div class="tablewrap" style="margin-top:16px"><table><thead><tr>' +
          '<th>' + esc(t('pk.date')) + '</th><th>' + esc(t('pk.tank')) + '</th>' +
          '<th>' + esc(t('pk.hcl')) + '</th><th>' + esc(t('pk.fe')) + '</th>' +
          '<th>' + esc(t('pk.temp')) + '</th><th>' + esc(t('pk.level')) + '</th>' +
          '<th>' + esc(t('pk.sludge')) + '</th><th>' + esc(t('pk.grade')) + '</th>' +
          '<th>' + esc(t('pk.notes')) + '</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<div class="lab-empty" style="margin-top:16px">' + esc(t('pk.logEmpty')) + '</div>';

    return '<section><div class="sechead"><span class="secnum">٣</span>' +
      '<h2 class="sectitle">' + esc(t('pk.s3')) + '</h2></div>' +
      '<p class="secsub">' + esc(t('pk.s3sub')) + '</p>' +
      '<div class="rep-bar"><button class="btn mini" id="pk-csv-log">' + esc(t('pk.csvOut')) + '</button>' +
        (canEdit() ? '<label class="btn mini" style="cursor:pointer">' + esc(t('pk.csvIn')) +
          '<input type="file" id="pk-csv-log-in" accept=".csv,text/csv" hidden></label>' : '') +
      '</div>' +
      form + table + '</section>';
  }

  /* ---------------- section 4: acid additions ---------------- */

  function addList() {
    return Object.keys(additions).map(function (k) {
      return Object.assign({ _k: k }, additions[k] || {});
    }).filter(r => r.date && r.tankId != null)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  function monthlyTotals() {
    const by = {};
    addList().forEach(function (r) {
      const ym = String(r.date).slice(0, 7);
      const id = Number(r.tankId);
      (by[ym] = by[ym] || {})[id] = (by[ym][id] || 0) + (Number(r.tons) || 0);
    });
    return by;
  }

  function additionsHTML() {
    const by = monthlyTotals();
    const months = Object.keys(by).sort().reverse().slice(0, 6);

    const totals = months.map(function (ym) {
      const per = by[ym];
      const tot = Object.keys(per).reduce((s, id) => s + per[id], 0);
      const prod = tonnesInMonth(ym);
      const perTon = isFinite(prod) && prod > 0 ? (tot * 1000) / prod : NaN;
      return '<tr>' +
        '<td class="num">' + esc(ym) + '</td>' +
        ALL_IDS.map(id => '<td class="num">' + (per[id] ? fx(per[id], 2) : '—') + '</td>').join('') +
        '<td class="num"><b>' + fx(tot, 2) + '</b></td>' +
        '<td class="num">' + (isFinite(prod) ? fx(prod, 0) : '—') + '</td>' +
        '<td class="num">' + (isFinite(perTon) ? fx(perTon, 1) : '—') + '</td>' +
      '</tr>';
    }).join('');

    const rows = addList().slice(0, 40).map(function (r) {
      return '<tr>' +
        '<td class="num">' + esc(r.date) + '</td>' +
        '<td>' + esc(nameOf(Number(r.tankId))) + '</td>' +
        '<td class="num">' + fx(Number(r.tons), 2) + '</td>' +
        '<td class="num">' + (Number(r.before) ? fx(Number(r.before), 2) : '—') + '</td>' +
        '<td>' + esc(r.operator || '—') + '</td>' +
        (canEdit() ? '<td><button class="btn mini danger" data-pk-del="' + esc(r._k) + '">' +
          esc(t('flux.d.delete')) + '</button></td>' : '') +
      '</tr>';
    }).join('');

    const form = canEdit()
      ? '<div class="panel" style="margin-top:16px"><div class="panel-in" style="border-bottom:none">' +
          '<p class="panel-label">' + esc(t('pk.addNew')) + '</p>' +
          '<div class="grid g3">' +
            field('pk-a-date', t('pk.date'), '', null, today(), 'date') +
            tankSelect('pk-a-tank', ALL_IDS, PICKLE_IDS[0]) +
            field('pk-a-tons', t('pk.tons'), t('pk.tonsHint'), '0.1', '') +
          '</div>' +
          '<div class="saverow" style="border-top:none;padding-top:14px">' +
            '<div class="field"><label>' + esc(t('pk.before')) + '</label>' +
              '<input type="number" id="pk-a-before" step="0.01"></div>' +
            '<div class="field"><label>' + esc(t('flux.d.operator')) + '</label>' +
              '<input type="text" id="pk-a-op" placeholder="' + esc(t('flux.d.name')) + '"></div>' +
            '<div><button class="btn" id="pk-a-save">' + esc(t('flux.d.save')) + '</button></div>' +
          '</div>' +
          '<p id="pk-a-msg" class="fx-msg"></p>' +
        '</div></div>'
      : '';

    const totalsTable = months.length
      ? '<div class="tablewrap" style="margin-top:16px"><table><thead><tr>' +
          '<th>' + esc(t('pk.month')) + '</th>' +
          ALL_IDS.map(id => '<th>' + esc(nameOf(id)) + '</th>').join('') +
          '<th>' + esc(t('pk.total')) + '</th>' +
          '<th>' + esc(t('pk.prod')) + '</th>' +
          '<th>' + esc(t('pk.perTon')) + '</th>' +
        '</tr></thead><tbody>' + totals + '</tbody></table>' +
        '<p class="hint" style="margin-top:8px">' + esc(t('pk.perTonNote')) + '</p></div>'
      : '<div class="lab-empty" style="margin-top:16px">' + esc(t('pk.addEmpty')) + '</div>';

    const logTable = rows
      ? '<div class="tablewrap" style="margin-top:16px"><table><thead><tr>' +
          '<th>' + esc(t('pk.date')) + '</th><th>' + esc(t('pk.tank')) + '</th>' +
          '<th>' + esc(t('pk.tons')) + '</th><th>' + esc(t('pk.before')) + '</th>' +
          '<th>' + esc(t('flux.d.col.operator')) + '</th>' + (canEdit() ? '<th></th>' : '') +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '';

    return '<section><div class="sechead"><span class="secnum">٤</span>' +
      '<h2 class="sectitle">' + esc(t('pk.s4')) + '</h2></div>' +
      '<p class="secsub">' + esc(t('pk.s4sub')) + '</p>' +
      '<div class="rep-bar"><button class="btn mini" id="pk-csv-add">' + esc(t('pk.csvOut')) + '</button>' +
        (canEdit() ? '<label class="btn mini" style="cursor:pointer">' + esc(t('pk.csvIn')) +
          '<input type="file" id="pk-csv-add-in" accept=".csv,text/csv" hidden></label>' : '') +
      '</div>' +
      form + totalsTable + logTable + '</section>';
  }

  /* ---------------- sections 5-7: calculators ---------------- */

  function calcsHTML() {
    const topup =
      '<section><div class="sechead"><span class="secnum">٥</span>' +
      '<h2 class="sectitle">' + esc(t('pk.s5')) + '</h2></div>' +
      '<p class="secsub">' + esc(t('pk.s5sub')) + '</p>' +
      '<div class="panel"><div class="panel-in">' +
        '<div class="grid g3">' +
          field('tu-m', t('pk.mass'), t('pk.massHint'), '0.1', '') +
          field('tu-cc', t('pk.curPct'), '', '0.1', '') +
          field('tu-ct', t('pk.tgtPct'), '', '0.1', 12) +
        '</div><div class="grid g3" style="margin-top:14px">' +
          field('tu-fe', t('pk.feIn'), t('pk.feStopHint', { n: NO_TOPUP_FE }), '1', '') +
          field('tu-free', t('pk.free'), t('pk.freeHint'), '0.1', '') +
          field('tu-cs', t('pk.stockPct'), '', '0.5', 30) +
        '</div>' +
      '</div><div class="panel-out"><div id="tu-out"></div></div></div></section>';

    const ref =
      '<section><div class="sechead"><span class="secnum">٦</span>' +
      '<h2 class="sectitle">' + esc(t('pk.s6')) + '</h2></div>' +
      '<p class="secsub">' + esc(t('pk.s6sub')) + '</p>' +
      '<div class="panel"><div class="panel-in">' +
        '<div class="grid g3">' +
          field('pr-m', t('pk.mass'), t('pk.massHint'), '0.1', '') +
          field('pr-fec', t('pk.feCur'), '', '1', '') +
          field('pr-fet', t('pk.feTgt'), '', '1', 70) +
        '</div><div class="grid g3" style="margin-top:14px">' +
          field('pr-cc', t('pk.curPct'), '', '0.1', '') +
          field('pr-ct', t('pk.tgtPct'), '', '0.1', 12) +
          field('pr-cs', t('pk.stockPct'), '', '0.5', 30) +
        '</div><div class="grid g3" style="margin-top:14px">' +
          field('pr-cap', t('pk.tanker'), t('pk.tankerHint'), '1', '') +
          field('pr-cost', t('pk.tripCost'), '', '100', 5000) +
        '</div>' +
      '</div><div class="panel-out"><div id="pr-out"></div></div></div></section>';

    const fill =
      '<section><div class="sechead"><span class="secnum">٧</span>' +
      '<h2 class="sectitle">' + esc(t('pk.s7')) + '</h2></div>' +
      '<p class="secsub">' + esc(t('pk.s7sub')) + '</p>' +
      '<div class="panel"><div class="panel-in">' +
        '<div class="grid g3">' +
          field('nf-m', t('pk.mass'), t('pk.massHint'), '0.1', '') +
          field('nf-ct', t('pk.tgtPct'), '', '0.1', 14) +
          field('nf-cs', t('pk.stockPct'), '', '0.5', 30) +
        '</div>' +
      '</div><div class="panel-out"><div id="nf-out"></div></div></div></section>';

    return topup + ref + fill;
  }

  function renderTopUp() {
    const out = document.getElementById('tu-out');
    if (!out) return;
    const r = topUp(inputNum('tu-m'), inputNum('tu-cc'), inputNum('tu-ct'),
                    inputNum('tu-cs'), inputNum('tu-free'), inputNum('tu-fe'));
    if (!r) { out.innerHTML = '<div class="fx-note-empty">' + esc(t('pk.enterAll')) + '</div>'; return; }
    if (r.stop) {
      out.innerHTML = '<div class="res hero fx-rec"><span class="rk">' + esc(t('pk.noAdd')) + '</span>' +
        '<span class="rv">' + esc(t('pk.doRefresh')) + '</span></div>' +
        '<p class="fx-basis">' + esc(t('pk.noAddWhy', { fe: fx(r.fe, 0), n: NO_TOPUP_FE })) + '</p>';
      return;
    }
    if (r.already) {
      out.innerHTML = '<div class="fx-note-empty">' + esc(t('pk.alreadyAt')) + '</div>'; return;
    }
    out.innerHTML =
      '<div class="res hero fx-rec"><span class="rk">' + esc(t('pk.addAcid')) + '</span>' +
        '<span class="rv">' + fx(r.acid, 2) + '<span class="u">' + esc(t('pk.t')) + '</span></span></div>' +
      (r.capped
        ? '<p class="fx-basis">' + esc(t('pk.cappedNote', {
            want: fx(r.want, 2), free: fx(r.freeSpace, 2), got: fx(r.reached, 1)
          })) + '</p>'
        : '') +
      '<p class="fx-basis">' + esc(t('pk.massNote')) + '</p>';
  }

  function renderRefresh() {
    const out = document.getElementById('pr-out');
    if (!out) return;
    const r = refresh(inputNum('pr-m'), inputNum('pr-fec'), inputNum('pr-fet'),
                      inputNum('pr-cc'), inputNum('pr-ct'), inputNum('pr-cs'),
                      inputNum('pr-cap'), inputNum('pr-cost'));
    if (!r) { out.innerHTML = '<div class="fx-note-empty">' + esc(t('pk.enterAll')) + '</div>'; return; }
    if (r.none) { out.innerHTML = '<div class="fx-note-empty">' + esc(t('pk.feTgtLower')) + '</div>'; return; }

    const line = (k, v) => '<div class="res"><span class="rk">' + esc(k) + '</span><span class="rv">' + v + '</span></div>';
    out.innerHTML =
      '<div class="res hero fx-rec"><span class="rk">' + esc(t('pk.drainPct')) + '</span>' +
        '<span class="rv">' + fx(r.f * 100, 1) + '<span class="u">%</span></span></div>' +
      '<div class="results">' +
        line(t('pk.drained'), fx(r.drained, 2) + '<span class="u">' + esc(t('pk.t')) + '</span>') +
        line(t('pk.addAcid'), fx(r.acid, 2) + '<span class="u">' + esc(t('pk.t')) + '</span>') +
        line(t('pk.addWater'), fx(r.water, 2) + '<span class="u">' + esc(t('pk.t')) + '</span>') +
        (isFinite(r.trips) ? line(t('pk.trips'), String(r.trips)) : '') +
        (isFinite(r.cost) ? line(t('pk.disposal'), fx(r.cost, 0) + '<span class="u">SAR</span>') : '') +
      '</div>' +
      (r.short ? '<p class="fx-basis">' + esc(t('pk.shortWater')) + '</p>' : '') +
      '<p class="fx-basis">' + esc(t('pk.vsFull', {
        acid: fx(r.full.acid, 2),
        cost: isFinite(r.full.cost) ? fx(r.full.cost, 0) : '—',
        sacid: fx(r.savedAcid, 2),
        scost: isFinite(r.savedCost) ? fx(r.savedCost, 0) : '—'
      })) + '</p>' +
      '<p class="fx-basis">' + esc(t('pk.massNote')) + '</p>';
  }

  function renderFill() {
    const out = document.getElementById('nf-out');
    if (!out) return;
    const r = newFill(inputNum('nf-m'), inputNum('nf-ct'), inputNum('nf-cs'));
    if (!r) { out.innerHTML = '<div class="fx-note-empty">' + esc(t('pk.enterAll')) + '</div>'; return; }
    out.innerHTML =
      '<div class="results">' +
        '<div class="res hero"><span class="rk">' + esc(t('pk.addAcid')) + '</span>' +
          '<span class="rv">' + fx(r.acid, 2) + '<span class="u">' + esc(t('pk.t')) + '</span></span></div>' +
        '<div class="res hero"><span class="rk">' + esc(t('pk.addWater')) + '</span>' +
          '<span class="rv">' + fx(r.water, 2) + '<span class="u">' + esc(t('pk.t')) + '</span></span></div>' +
      '</div><p class="fx-basis">' + esc(t('pk.massNote')) + '</p>';
  }

  /* ---------------- CSV ---------------- */

  const csvCell = v => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  function download(name, text) {
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function exportDaily() {
    const head = ['date', 'tankId', 'tank', 'hcl', 'fe', 'zn', 'temp', 'level', 'sludge', 'notes'];
    const body = dailyRows().map(r => [
      r.date, r.tankId, nameOf(Number(r.tankId)), r.acidPercent || '', r.fe || '', r.zn || '',
      r.temp || '', r.level || '', r.sludge || '', r.notes || ''
    ].map(csvCell).join(','));
    download('KGC_pickling_log_' + today() + '.csv', [head.join(',')].concat(body).join('\n'));
  }

  function exportAdditions() {
    const head = ['date', 'tankId', 'tank', 'tons', 'before', 'operator'];
    const body = addList().map(r => [
      r.date, r.tankId, nameOf(Number(r.tankId)), r.tons || '', r.before || '', r.operator || ''
    ].map(csvCell).join(','));
    download('KGC_acid_additions_' + today() + '.csv', [head.join(',')].concat(body).join('\n'));
  }

  /** Minimal CSV reader — quoted fields, doubled quotes, CRLF tolerant. */
  function parseCSV(text) {
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }

  function importCSV(file, kind) {
    if (!canEdit() || !file) return;
    const say = kind === 'add' ? msgAdd : msgLog;
    const reader = new FileReader();
    reader.onload = function () {
      let rows;
      try { rows = parseCSV(String(reader.result || '')); }
      catch (e) { say(t('pk.csvBad'), true); return; }
      if (rows.length < 2) { say(t('pk.csvBad'), true); return; }

      const head = rows[0].map(h => String(h).trim().toLowerCase());
      const col = n => head.indexOf(n);
      const updates = {};
      let ok = 0, skip = 0;

      rows.slice(1).forEach(function (r) {
        const date = String(r[col('date')] || '').trim();
        const id = Number(r[col('tankid')]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || ALL_IDS.indexOf(id) === -1) { skip++; return; }

        if (kind === 'add') {
          const tons = Number(r[col('tons')]);
          if (!(tons > 0)) { skip++; return; }
          const key = 'imp_' + id + '_' + date + '_' + Math.round(tons * 100);
          updates['acid_additions/' + key] = {
            date: date, tankId: id, tons: tons,
            before: Number(r[col('before')]) || null,
            operator: String(r[col('operator')] || '').trim() || null,
            ts: Date.now()
          };
        } else {
          const base = 'readings_log/' + id + '_' + date + '/';
          const map = { acidPercent: 'hcl', fe: 'fe', zn: 'zn', temp: 'temp', level: 'level', sludge: 'sludge' };
          let any = false;
          Object.keys(map).forEach(function (f) {
            const c = col(map[f]); if (c === -1) return;
            const v = Number(r[c]);
            if (isFinite(v) && v !== 0) { updates[base + f] = v; any = true; }
          });
          const nc = col('notes');
          if (nc !== -1 && String(r[nc] || '').trim()) { updates[base + 'notes'] = String(r[nc]).trim(); any = true; }
          if (!any) { skip++; return; }
          updates[base + 'tankId'] = id;
          updates[base + 'date'] = date;
          updates[base + 'ts'] = Date.now();
        }
        ok++;
      });

      if (!ok) { say(t('pk.csvNone'), true); return; }
      database.ref().update(updates)
        .then(() => say(t('pk.csvOk', { n: ok, s: skip })))
        .catch(e => say(t('flux.d.failed') + ' ' + (e.message || ''), true));
    };
    reader.readAsText(file);
  }

  /* ---------------- saving ---------------- */

  function flash(id, msg, bad) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.style.color = bad ? 'var(--crit)' : 'var(--accent)';
    setTimeout(function () { if (el) el.textContent = ''; }, 4000);
  }
  const msgLog = (m, b) => flash('pk-msg', m, b);
  const msgAdd = (m, b) => flash('pk-a-msg', m, b);

  function saveDaily() {
    if (!canEdit()) { msgLog(t('flux.d.needAuth'), true); return; }
    const date = val('pk-date') || today();
    const id = Number(val('pk-tank'));
    if (ALL_IDS.indexOf(id) === -1) { msgLog(t('pk.errTank'), true); return; }

    const nums = {
      acidPercent: inputNum('pk-hcl'), fe: inputNum('pk-fe'), zn: inputNum('pk-zn'),
      temp: inputNum('pk-temp'), level: inputNum('pk-level'), sludge: inputNum('pk-sludge')
    };
    const notes = val('pk-notes');
    const entered = Object.keys(nums).filter(k => isFinite(nums[k]));
    if (!entered.length && !notes) { msgLog(t('pk.errEmpty'), true); return; }

    const base = 'readings_log/' + id + '_' + date + '/';
    const updates = { };
    entered.forEach(function (k) { updates[base + k] = nums[k]; });
    if (notes) updates[base + 'notes'] = notes;
    updates[base + 'tankId'] = id;
    updates[base + 'date'] = date;
    updates[base + 'ts'] = Date.now();

    database.ref().update(updates).then(function () {
      /* Chemistry entered for today also belongs on the tank card, or the
         dashboard, the spec badge and the attention panel would keep
         showing yesterday's figure. A back-dated entry is a correction to
         the record and must not move the card. */
      const chem = ['acidPercent', 'fe', 'zn'].filter(k => isFinite(nums[k]));
      if (date === today() && chem.length &&
          typeof tanks !== 'undefined' && typeof saveToStorage === 'function') {
        const tk = tanks.find(x => x.id === id);
        if (tk) {
          chem.forEach(function (k) {
            if ((tk.fields || []).indexOf(k) === -1) return;
            tk[k] = nums[k];
            if (typeof markMeasured === 'function') markMeasured(tk, k);
          });
          try { saveToStorage(); if (typeof renderAll === 'function') renderAll(); } catch (e) {}
        }
      }
      msgLog(t('pk.saved', { d: date }));
      ['pk-hcl', 'pk-fe', 'pk-zn', 'pk-temp', 'pk-level', 'pk-sludge', 'pk-notes']
        .forEach(function (x) { const el = document.getElementById(x); if (el) el.value = ''; });
    }).catch(e => msgLog(t('flux.d.failed') + ' ' + (e.message || ''), true));
  }

  function saveAddition() {
    if (!canEdit()) { msgAdd(t('flux.d.needAuth'), true); return; }
    const date = val('pk-a-date') || today();
    const id = Number(val('pk-a-tank'));
    const tons = inputNum('pk-a-tons');
    if (ALL_IDS.indexOf(id) === -1) { msgAdd(t('pk.errTank'), true); return; }
    if (!(tons > 0)) { msgAdd(t('pk.errTons'), true); return; }

    database.ref('acid_additions').push({
      date: date, tankId: id, tons: tons,
      before: isFinite(inputNum('pk-a-before')) ? inputNum('pk-a-before') : null,
      operator: val('pk-a-op') || null,
      ts: Date.now()
    }).then(function () {
      msgAdd(t('pk.saved', { d: date }));
      ['pk-a-tons', 'pk-a-before'].forEach(function (x) {
        const el = document.getElementById(x); if (el) el.value = '';
      });
    }).catch(e => msgAdd(t('flux.d.failed') + ' ' + (e.message || ''), true));
  }

  function removeAddition(key) {
    if (!canEdit()) return;
    if (!confirm(t('flux.d.confirmDel'))) return;
    database.ref('acid_additions/' + key).remove()
      .catch(e => msgAdd(t('flux.d.failed') + ' ' + (e.message || ''), true));
  }

  /* ---------------- wiring ---------------- */

  let bound = false;

  function wire() {
    const on = (id, ev, fn) => {
      const el = document.getElementById(id);
      if (el && !el.dataset.w) { el.dataset.w = '1'; el.addEventListener(ev, fn); }
    };
    on('pk-duty', 'change', renderRoute);
    on('pk-save', 'click', saveDaily);
    on('pk-a-save', 'click', saveAddition);
    on('pk-csv-log', 'click', exportDaily);
    on('pk-csv-add', 'click', exportAdditions);
    on('pk-csv-log-in', 'change', function (e) { importCSV(e.target.files[0], 'log'); e.target.value = ''; });
    on('pk-csv-add-in', 'change', function (e) { importCSV(e.target.files[0], 'add'); e.target.value = ''; });

    ['tu-m', 'tu-cc', 'tu-ct', 'tu-fe', 'tu-free', 'tu-cs'].forEach(id => on(id, 'input', renderTopUp));
    ['pr-m', 'pr-fec', 'pr-fet', 'pr-cc', 'pr-ct', 'pr-cs', 'pr-cap', 'pr-cost']
      .forEach(id => on(id, 'input', renderRefresh));
    ['nf-m', 'nf-ct', 'nf-cs'].forEach(id => on(id, 'input', renderFill));

    const mount = document.getElementById('page-pickling');
    if (mount && !bound) {
      bound = true;
      mount.addEventListener('click', function (ev) {
        const del = ev.target.closest && ev.target.closest('[data-pk-del]');
        if (del) removeAddition(del.getAttribute('data-pk-del'));
      });
    }
  }

  /* ---------------- render ---------------- */

  function render() {
    const mount = document.getElementById('page-pickling');
    if (!mount) return;
    mount.innerHTML = statusHTML() + routingHTML() + dailyHTML() + additionsHTML() + calcsHTML();
    wire();
    renderRoute(); renderTopUp(); renderRefresh(); renderFill();
  }

  database.ref('readings_log').on('value', function (s) { readings = s.val() || {}; render(); });
  database.ref('acid_additions').on('value', function (s) { additions = s.val() || {}; render(); });
  database.ref('zinc_daily').on('value', render);
  database.ref('tanks_data').on('value', render);
  if (window.I18N) I18N.onChange(render);
  document.addEventListener('DOMContentLoaded', render);

  window.KGCPickling = {
    render: render,
    grades: allGrades,
    route: route,
    _topUp: topUp, _refresh: refresh, _newFill: newFill
  };
})();
