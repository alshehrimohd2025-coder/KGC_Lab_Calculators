/* ============================================================
   Management report → Excel (one sheet, ready to email)
   ------------------------------------------------------------
   Takes the model weekly.js computes for the period on screen and
   writes a single-sheet workbook laid out for A4 landscape: the KSC
   logo and title, a row of key figures against the previous period
   (production, jigs, zinc, the dross to expect, tanks out of standard),
   then the tanks, what changed, what is needed and the materials added,
   each with the engineer's comment under it, and an empty notes box at
   the end to write in before the file is sent.

   The file is English only, by the plant's choice. Dates read
   13-Oct-2026 whatever the reader's Excel locale. Numbers are real
   numbers, so the file can still be filtered or recalculated.

   Medium detail: a long table keeps its first rows and says how many
   more the site holds, so the sheet stays a report and not a dump.

   How the file looks (styles, tables, logo, packaging) is shared with the
   tank status report and lives in xlsx_kit.js.

   Depends on: window.KGCXlsx (xlsx_kit.js).
   ============================================================ */
(function () {
  'use strict';

  const X = window.KGCXlsx;
  if (!X) { console.error('[weekly_xlsx] xlsx_kit.js is not loaded.'); return; }
  const { C, MONTHS, MONTHS_LONG, isNum, fmtDate, dow, fixed, signed,
    Styles, Sheet, td, bar, subTitle, note, emptyLine, comment, table, status, pair, notesBox } = X;
  const KIND = { day: 'Daily', week: 'Weekly', month: 'Monthly' };

  const preparer = m => m.preparedBy + (m.preparedTitle ? ', ' + m.preparedTitle : '');
  const exportOptions = () => window.KGCWeeklyExportOptions ? window.KGCWeeklyExportOptions.get() :
    { summary: true, kpis: true, status: true, operations: true, changed: true, needs: true, consumption: true, notes: true, managerNote: '' };

  function periodLabel(m) {
    if (m.kind === 'day') return fmtDate(m.S);
    if (m.kind === 'month') return MONTHS_LONG[Number(m.S.slice(5, 7)) - 1] + ' ' + m.S.slice(0, 4);
    return fmtDate(m.S) + ' to ' + fmtDate(m.E);
  }
  const prevWord = m => ({ day: 'previous day', week: 'previous week', month: 'previous month' })[m.kind];

  function fileName(m) {
    if (m.kind === 'day') return 'KGC_Galvanizing_Line_Daily_Report_' + fmtDate(m.S) + '.xlsx';
    if (m.kind === 'month') return 'KGC_Galvanizing_Line_Monthly_Report_' + MONTHS[Number(m.S.slice(5, 7)) - 1] + '-' + m.S.slice(0, 4) + '.xlsx';
    return 'KGC_Galvanizing_Line_Weekly_Report_' + fmtDate(m.S) + '_to_' + fmtDate(m.E) + '.xlsx';
  }

  /* ---------------- the report ---------------- */

  function header(sh, m, size) {
    const per = (m.kind === 'week'
      ? 'Week: ' + dow(m.S) + ' ' + fmtDate(m.S) + ' to ' + dow(m.E) + ' ' + fmtDate(m.E)
      : m.kind === 'day' ? 'Day: ' + dow(m.S) + ' ' + fmtDate(m.S)
      : 'Month: ' + periodLabel(m) + ' (' + fmtDate(m.S) + ' to ' + fmtDate(m.E) + ')') +
      (m.open ? ' — so far, up to ' + m.generatedAt : '');
    X.header(sh, { title: KIND[m.kind].toUpperCase() + ' GALVANIZING LINE REPORT', lines: [per,
      'Generated ' + fmtDate(m.generated) + ' ' + m.generatedAt + (m.preparedBy ? '   ·   Prepared by ' + preparer(m) : '')] }, size);
  }

  /* Six key figures across the page, each against the previous period. */
  function cards(sh, m) {
    const k = m.kpi, cur = m.production.cur, partial = m.production.partial && cur.records > 0;
    const star = partial ? ' *' : '';
    const list = [
      { label: 'PRODUCTION (t)' + star, v: k.tonnes.cur, p: k.tonnes.prev, fmt: '#,##0.0', d: 1 },
      { label: 'JIGS PRODUCED' + star, v: k.jigs.cur, p: k.jigs.prev, fmt: '#,##0', d: 0 },
      { label: 'ZINC CONSUMED (kg)' + star, v: k.zincKg.cur, p: k.zincKg.prev, fmt: '#,##0', d: 0 },
      { label: 'ZINC CONSUMPTION (kg/t)' + star, v: k.zincPerT.cur, p: k.zincPerT.prev, fmt: '0.0', d: 1 },
      { label: 'EXPECTED DROSS (kg)' + star, v: k.drossExp.cur, p: k.drossExp.prev, fmt: '#,##0', d: 0 },
      { label: 'TANKS OUT OF STANDARD', v: k.tanksOut.cur, p: k.tanksOut.prev, fmt: '0" / ' + k.tanksOut.of + '"', d: 0,
        hot: k.tanksOut.cur > 0 }
    ];
    X.cardRow(sh, list.map(card => Object.assign({}, card, {
      sub: 'Prev: ' + fixed(card.p, card.d) + (isNum(card.v) && isNum(card.p) ? '   Δ ' + signed(card.v - card.p, card.d) : '')
    })));
    note(sh, 'Compared with the ' + prevWord(m) + ' (' + (m.kind === 'day' ? fmtDate(m.prevS) : fmtDate(m.prevS) + ' to ' + fmtDate(m.prevE)) + ').' +
      (partial ? ' * Production data covers ' + cur.records + ' of ' + m.days + ' days; the comparison is partial.' : ''));
    note(sh, drossText(m));
  }

  /** Where the expected dross comes from, in one sentence the reader can check. */
  function drossText(m) {
    const cur = m.production.cur, b = m.dross.basis;
    if (!cur.records) return 'No production data for this period — upload the production report on the zinc efficiency page.';
    if (!b) return 'Expected dross needs at least two drossings in the production report to know the rate; there are not enough yet.';
    return 'Estimated dross: ' + fixed(m.kpi.drossExp.cur, 0) + ' kg. Basis: ' + fixed(b.dross, 0) + ' kg over ' +
      fixed(b.tonnes, 1) + ' t from the last ' + (b.n === 1 ? 'drossing' : b.n + ' drossings') +
      ' (about ' + fixed(b.rate, 1) + ' kg/t). Dross removed in this period: ' + fixed(m.dross.removed, 0) + ' kg.';
  }

  function sectionStatus(sh, m) {
    bar(sh, 'TANKS OUTSIDE LIMITS');
    subTitle(sh, 'Latest routine tank readings up to ' + fmtDate(m.E) + '. Routine records this period: ' + m.readings + '.');
    if (m.breaches.length) {
      const old = x => ({ v: x.lastDate || 'date unknown', color: C.warnFg, b: 1, h: 'center' });
      table(sh, [
        { label: 'Tank', span: 2 }, { label: 'Parameter', span: 1 }, { label: 'Last reading', span: 1, h: 'right' },
        { label: 'Reading date', span: 1, h: 'center' }, { label: 'Status', span: 1, h: 'center' }, { label: 'Standard range', span: 2, h: 'center' },
        { label: 'Out / readings in period', span: 1, h: 'center' }, { label: 'Critical in period', span: 1, h: 'center' },
        { label: 'Worst in period', span: 1, h: 'right' }, { label: 'Worst date', span: 1, h: 'center' }
      ], m.breaches.map(x => [
        { v: x.tank, b: 1 }, x.param, x.last, x.old ? old(x) : x.lastDate,
        ['warn', 'crit'].indexOf(x.lastTier) !== -1 ? status(x.lastTier) : Object.assign(status('good'), { v: 'Back in' }),
        x.range, x.n ? x.bad + ' / ' + x.n : '—',
        x.crit ? { v: x.crit, color: C.critFg, b: 1 } : (x.n ? 0 : '—'),
        x.worst, x.worstDate
      ]), { limit: 25 });
      if (m.breaches.some(x => x.old)) note(sh, 'Orange dates are before this period. Current tank conditions are unverified by a routine reading.');
    } else emptyLine(sh, m.inStandard.length ? 'No tank is out of standard on its last reading, and no reading went out of standard in this period.'
      : 'No readings were recorded for these tanks.');
    pair(sh, 'Within standard', m.inStandard.map(x => x.tank + ' (' + (x.date ? fmtDate(x.date) : 'date unknown') + ')').join('  ·  '), 'good');
    pair(sh, 'No reading yet', m.noReading.join('  ·  '), 'warn');
    if (m.excluded.length) note(sh, 'Not included in this report (chosen on the site): ' + m.excluded.join(', ') + '.');

    if (m.completeness) {
      subTitle(sh, 'Analysis completeness against the schedule' +
        (m.completenessShare != null ? ' — ' + Math.round(m.completenessShare * 100) + '% of the samples due' : ''));
      if (m.completeness.length) {
        const word = x => x.pct == null ? { v: 'Not due', color: C.muted, h: 'center' }
          : x.pct >= 1 ? Object.assign(status('good'), { v: 'Complete' })
          : x.pct > 0 ? Object.assign(status('warn'), { v: 'Incomplete' })
          : Object.assign(status('crit'), { v: 'Missing' });
        table(sh, [
          { label: 'Tank', span: 2 }, { label: 'Schedule', span: 4 }, { label: 'Samples due', span: 1, h: 'center' },
          { label: 'Full samples', span: 1, h: 'center' }, { label: 'Partial', span: 1, h: 'center' },
          { label: 'Completeness', span: 1, h: 'center' }, { label: 'Status', span: 2, h: 'center' }
        ], m.completeness.map(x => [{ v: x.tank, b: 1 }, x.schedule, x.expected, x.full, x.partial,
          x.pct == null ? { v: 'n/a', color: C.muted } : { v: x.pct, fmt: '0%' }, word(x)]), { limit: 20 });
      }
      note(sh, m.notes.full);
    }
    note(sh, m.notes.limits);
    comment(sh, m.comments.status);
  }

  function sectionChanged(sh, m) {
    const all = m.options.unchanged;
    bar(sh, 'TREATMENT AND STATUS');
    const treatments = m.treatments || [];
    if (treatments.length) {
      subTitle(sh, 'Treatment readings before and after');
      table(sh, [
        { label: 'Date', span: 1 }, { label: 'Tank / solution', span: 2 }, { label: 'Material', span: 2 },
        { label: 'Parameter', span: 1 }, { label: 'Before', span: 1, h: 'right' },
        { label: 'After', span: 1, h: 'right' }, { label: 'Unit', span: 1 },
        { label: 'Source', span: 1 }, { label: 'Note', span: 2 }
      ], treatments.map(x => [x.date, x.tank, x.material, x.parameter, x.before, x.after, x.unit, x.source, x.note]),
      { limit: treatments.length });
    }
    const fluxMaterials = (m.materialEntries || []).filter(x => Number(x.tankId) === 10);
    const fluxEvents = (m.operations || []).filter(e =>
      Number(e.tankId) === 10 || /flux|rinse|pump|broken|failure|breakdown|فلكس|شطف|مضخ|عطل/i.test([e.title, e.action, e.impact].join(' ')));
    const fluxByDate = {};
    const fluxDay = d => fluxByDate[d] || (fluxByDate[d] = { actions: [], additions: [], readings: [], issues: [], notes: [] });
    treatments.forEach(x => fluxDay(x.date).readings.push(x.parameter + ': ' +
      (isNum(x.before) ? fixed(x.before, 2) : '—') + ' → ' + (isNum(x.after) ? fixed(x.after, 2) : '—') + (x.unit ? ' ' + x.unit : '')));
    fluxMaterials.forEach(x => {
      const r = fluxDay(x.date);
      r.additions.push(x.name + ': ' + fixed(x.q, 1) + ' ' + (x.unit || ''));
      if (x.note) r.notes.push(x.note);
    });
    fluxEvents.forEach(e => {
      const r = fluxDay(e.start);
      r.actions.push([e.title, e.kindText, e.action].filter(Boolean).join(' — '));
      if (e.impact || /pump|broken|failure|breakdown|مضخ|عطل|مشكلة/i.test([e.title, e.kindText, e.action].join(' ')))
        r.issues.push([e.kindText, e.title, e.action, e.impact].filter(Boolean).join(' — '));
    });
    const fluxDates = Object.keys(fluxByDate).sort();
    subTitle(sh, 'Flux treatment — simple timeline');
    const zkg = m.kpi.zincKg.cur, zpt = m.kpi.zincPerT.cur;
    note(sh, 'Zinc consumed this period: ' + (isNum(zkg) ? fixed(zkg, 0) + ' kg' : 'not recorded') +
      (isNum(zpt) ? ' (' + fixed(zpt, 1) + ' kg/t)' : '') +
      '. This is the total for the period; it does not establish a treatment effect by itself.');
    if (fluxDates.length) {
      table(sh, [
        { label: 'Date', span: 1, h: 'center' }, { label: 'Step / action', span: 3 },
        { label: 'Additions', span: 2 }, { label: 'Before → after', span: 3 },
        { label: 'Recorded issue / note', span: 3 }
      ], fluxDates.map(d => {
        const r = fluxByDate[d];
        return [d, r.actions.join(' · ') || '—', r.additions.join(' · ') || '—',
          r.readings.join(' · ') || '—', (r.issues.concat(r.notes)).join(' · ') || '—'];
      }));
    } else emptyLine(sh, 'No flux treatment record was logged in this period.');
    if (!fluxEvents.some(e => e.impact || /pump|broken|failure|breakdown|مضخ|عطل|مشكلة/i.test([e.title, e.kindText, e.action].join(' '))))
      note(sh, 'No flux issue was logged in this period.');
    if (m.cards.length) subTitle(sh, 'Treatment-card results' + (all ? '' : ' — values that changed'));
    if (m.cards.length) {
      table(sh, [
        { label: 'Tank', span: 2 }, { label: 'Material', span: 2 }, { label: 'Parameter', span: 1 },
        { label: 'Before', span: 1, h: 'right' }, { label: 'After', span: 1, h: 'right' }, { label: 'Change', span: 1, h: 'right' },
        { label: 'After status', span: 1, h: 'center' }, { label: 'Evaluation', span: 2 }, { label: 'Card stage', span: 1, h: 'center' }
      ], m.cards.map(x => [
        { v: x.tank, b: 1 }, x.material, x.param, x.before, x.after,
        isNum(x.before) && isNum(x.after) ? { v: x.after - x.before, fmt: '+0.0#;-0.0#;0' } : null,
        x.after != null ? status(x.afterTier) : null,
        x.evalNote ? x.evaluation + ' — ' + x.evalNote : x.evaluation,
        { v: x.stage, h: 'center' }
      ]));
      if (m.quietCards) note(sh, 'Not listed: ' + m.quietCards + ' treatment card' + (m.quietCards === 1 ? '' : 's') + ' with no change, or no re-measure yet.');
    } else if (!treatments.length) emptyLine(sh, m.quietCards
      ? 'No treatment card changed a reading in this period (' + m.quietCards + ' with no change, or no re-measure yet).'
      : 'No treatment card had an action or a re-measure in this period.');

    subTitle(sh, 'Status during the period');
    if (m.movement.length) {
      const MOVE = { closed: ['Back in standard', 'good'], opened: ['New this period', 'warn'], still: ['Still out', 'warn'] };
      table(sh, [
        { label: 'Movement', span: 2 }, { label: 'Tank', span: 2 }, { label: 'Parameter', span: 1 },
        { label: 'At start', span: 1, h: 'right' }, { label: 'At end', span: 1, h: 'right' }, { label: 'End date', span: 1, h: 'center' },
        { label: 'Status', span: 1, h: 'center' }, { label: 'Standard range', span: 3, h: 'center' }
      ], m.movement.map(x => [
        Object.assign(status(MOVE[x.move][1]), { v: MOVE[x.move][0], h: 'left' }),
        { v: x.tank, b: 1 }, x.param, x.from, x.to, x.toDate, status(x.tier), x.range
      ]));
    } else emptyLine(sh, m.still.length ? 'No status change was recorded in this period.'
      : 'No parameter was out of standard at the start or the end of the period.');
    pair(sh, 'Last readings out of limits', m.still.map(x => x.tank + ' · ' + x.param).join(',  '), 'warn');
    note(sh, 'Open treatment cards: ' + m.openCards + '.');
    comment(sh, m.comments.changed);
  }

  function sectionOperations(sh, m) {
    bar(sh, 'OPERATING EVENTS AND BREAKDOWNS');
    const events = m.operations || [];
    note(sh, 'Open events carry forward from earlier periods until their end date is recorded. Expected effects are not measured results.');
    if (events.length) events.forEach(e => {
      subTitle(sh, e.title);
      table(sh, [
        { label: 'Start', span: 2 }, { label: 'End', span: 2 }, { label: 'Affected tank', span: 3 },
        { label: 'Type', span: 3 }, { label: 'Status at period end', span: 2 }
      ], [[e.start, e.end && e.end <= m.E ? e.end : null, e.tank, e.kindText, e.state]]);
      pair(sh, 'Action / follow-up', e.action);
      pair(sh, 'Impact / evidence', e.impact ? e.impactType + ': ' + e.impact : 'Not recorded', 'warn');
    });
    else emptyLine(sh, 'No operating events recorded for this period.');
    if ((m.currentOutages || []).length) {
      subTitle(sh, 'Current service status — start date not recorded');
      m.currentOutages.forEach(x => pair(sh, x.tank, x.status + (x.note ? ' — ' + x.note : ''), 'warn'));
      note(sh, 'These statuses describe the tanks now. Add a dated event to document when an outage began.');
    }
  }

  /* The needs listed on the site, then empty rows to fill in Excel before
     sending, with drop-down lists for the priority and the type. */
  const BLANK_NEEDS = 3;
  function sectionNeeds(sh, m) {
    bar(sh, 'ACTIONS AND SUPPORT NEEDED');
    const P = { high: 'crit', medium: 'warn', low: 'good' };
    const cols = [
      { label: 'Priority', span: 1, h: 'center' }, { label: 'Type', span: 1, h: 'center' }, { label: 'Needed', span: 3 },
      { label: 'Why', span: 4 }, { label: 'Owner', span: 2 }, { label: 'Needed by', span: 1, h: 'center' }
    ];
    table(sh, cols, m.needs.map(x => [
      x.priority ? Object.assign(status(P[x.priority]), { v: x.priorityText }) : null,
      { v: x.kind, h: 'center' }, { v: x.what, b: 1 }, x.why, x.owner, x.due
    ]), { limit: 25 });
    const first = sh.rows.length;
    for (let i = 0; i < BLANK_NEEDS; i++) {
      const r = sh.next(24);
      let c = 0;
      cols.forEach(function (col) {
        sh.span(r, c, c + col.span - 1, '', td({ h: col.h }, (m.needs.length + i) % 2 === 1));
        c += col.span;
      });
    }
    const rows = (first + 1) + ':' + (first + BLANK_NEEDS);
    sh.lists.push({ ref: 'A' + rows.replace(':', ':A'), items: ['High', 'Medium', 'Low'] },
                  { ref: 'B' + rows.replace(':', ':B'), items: ['Decision', 'Purchase', 'Maintenance'] });
    comment(sh, m.comments.needs);
  }

  /* Materials always; the production figures and the product mix only when
     the site is set to show them (they wait for the batch data to be complete). */
  function sectionConsumption(sh, m) {
    const cur = m.production.cur, prev = m.production.prev, partial = m.production.partial && cur.records > 0;
    const full = m.options.production;
    bar(sh, full ? 'CONSUMPTION AND PRODUCTION' : 'BATH ADDITIONS');
    if (full) {
      if (cur.records || prev.records) {
        subTitle(sh, 'Key figures');
        const row = (label, a, b, fmt, d, noteText) => [
          { v: label, b: 1 }, isNum(a) ? { v: a, fmt: fmt } : null, isNum(b) ? { v: b, fmt: fmt } : null,
          isNum(a) && isNum(b) ? { v: a - b, fmt: fmt.indexOf('.') !== -1 ? '+#,##0.0;-#,##0.0;0.0' : '+#,##0;-#,##0;0' } : null,
          noteText || { v: '', blank: 1 }
        ];
        const perT = (x) => x.tonnes > 0 && x.records ? x.dross / x.tonnes : null;
        table(sh, [
          { label: 'Figure', span: 4 }, { label: 'This period', span: 2, h: 'right' }, { label: 'Previous period', span: 2, h: 'right' },
          { label: 'Change', span: 2, h: 'right' }, { label: 'Note', span: 2 }
        ], [
          [{ v: 'Days with production data', b: 1 }, { v: cur.records + ' / ' + m.days, h: 'right' }, { v: prev.records + ' / ' + m.prevDays, h: 'right' }, null, { v: '', blank: 1 }],
          row('Steel produced (t)' + (partial ? ' *' : ''), cur.records ? cur.tonnes : null, prev.records ? prev.tonnes : null, '#,##0.0', 1),
          row('Zinc consumption (kg/t)' + (partial ? ' *' : ''), cur.zincPerT, prev.zincPerT, '0.0', 1, 'Lower is not an improvement by itself'),
          row('Zinc consumed (kg)' + (partial ? ' *' : ''), cur.records ? cur.zincKg : null, prev.records ? prev.zincKg : null, '#,##0', 0),
          row('Dross removed (kg)' + (partial ? ' *' : ''), cur.records ? cur.dross : null, prev.records ? prev.dross : null, '#,##0', 0),
          row('Dross per tonne (kg/t)' + (partial ? ' *' : ''), perT(cur), perT(prev), '0.0', 1)
        ]);
        if (m.znNote) note(sh, m.znNote);
      } else emptyLine(sh, 'No production data for this period — upload the production report on the zinc efficiency page.');

      subTitle(sh, 'Product mix (from production timing)');
      if (m.mix.length) {
        table(sh, [{ label: 'Product', span: 6 }, { label: 'Steel (t)', span: 2, h: 'right' }, { label: 'Share', span: 2, h: 'right' }, { label: 'Batches', span: 2, h: 'right' }],
          m.mix.map(x => [{ v: x.product, b: 1 }, { v: x.tonnes, fmt: '#,##0.0' }, x.share != null ? { v: x.share, fmt: '0%' } : null, x.n]), { limit: 8 });
      } else emptyLine(sh, 'No batches were recorded in production timing, so the product mix cannot be compared.');
      subTitle(sh, 'Materials added to the baths');
    } else sh.next(4);

    if (m.materials.length) {
      table(sh, [{ label: 'Material', span: 4 }, { label: 'Quantity', span: 2, h: 'right' }, { label: 'Unit', span: 1, h: 'center' },
        { label: 'Per tonne produced' + (partial ? ' *' : ''), span: 2, h: 'right' }, { label: 'Source', span: 3 }],
        m.materials.map(x => [{ v: x.name, b: 1 }, { v: x.q, fmt: '#,##0.0' }, { v: x.unit, h: 'center' },
          isNum(x.perT) ? { v: x.perT, fmt: '0.000' } : null, x.source]));
    } else emptyLine(sh, 'No additions were recorded in this period.');
    const entries = m.materialEntries || [];
    if (entries.length) {
      subTitle(sh, 'Additions by date');
      table(sh, [
        { label: 'Date', span: 1 }, { label: 'Tank', span: 2 }, { label: 'Material', span: 2 },
        { label: 'Quantity', span: 1 }, { label: 'Unit', span: 1 },
        { label: 'Before °Bé', span: 1 }, { label: 'After °Bé', span: 1 }, { label: 'Notes / source', span: 3 }
      ], entries.map(r => [r.date, r.tank, r.name, { v: r.q, fmt: '#,##0.0' }, r.unit,
        isNum(r.before) ? r.before : null, isNum(r.after) ? r.after : null,
        (r.note ? r.note + '\n' : '') + r.source]), { limit: entries.length });
      note(sh, 'Additions awaiting a follow-up reading are included. The execution date controls the period, not the entry date. ' +
        'A specialist log takes priority over a treatment card for the same material, tank and day to avoid duplicate totals.');
    }
    note(sh, m.notes.partial ? '* ' + m.notes.partial.replace(/^\*\s*/, '') : '');
    if (full) note(sh, m.notes.zinc);
    note(sh, m.notes.money);
    comment(sh, m.comments.consumption);
  }

  /** Build the workbook. Returns { blob, file, title }. */
  function build(m, logo) {
    const styles = new Styles();
    const sh = new Sheet(styles);
    sh.footer = KIND[m.kind] + ' report · ' + periodLabel(m);

    header(sh, m, X.pngSize(logo));
    const selected = exportOptions();
    if (selected.kpis) cards(sh, m);
    if (selected.summary && String(m.comments.summary || '').trim()) {
      bar(sh, 'ENGINEER SUMMARY');
      comment(sh, m.comments.summary, null);
    }
    if (selected.managerNote) { bar(sh, 'REPORT NOTE'); comment(sh, selected.managerNote, null); }
    if (selected.status) sectionStatus(sh, m);
    if (selected.operations) sectionOperations(sh, m);
    if (selected.changed) sectionChanged(sh, m);
    if (selected.needs) sectionNeeds(sh, m);
    if (selected.consumption) sectionConsumption(sh, m);
    if (selected.notes) notesBox(sh);
    X.closing(sh, 'Built from the KGC galvanizing line records on the site: tank readings, treatment cards, addition and treatment logs, and the production report. ' +
      'Readings are judged against the standard limits set on the site on ' + fmtDate(m.generated) + '. No financial figures are computed.');

    const title = 'KGC Galvanizing Line ' + KIND[m.kind] + ' Report — ' + periodLabel(m);
    const blob = X.pack(sh, styles, { title: title, creator: m.preparedBy, sheetName: 'Line Report', logo: logo });
    return { blob: blob, file: fileName(m), title: title };
  }

  /** A short email to send with the file — what the reader needs before opening it. */
  function emailText(m) {
    const k = m.kpi, cur = m.production.cur, partial = m.production.partial && cur.records > 0;
    const selected = exportOptions();
    const high = m.needs.filter(n => n.priority === 'high').length;
    const lines = [
      'Subject: KGC Galvanizing Line ' + KIND[m.kind] + ' Report — ' + periodLabel(m),
      '',
      'Dear all,',
      '',
      'Please find attached the KGC galvanizing line ' + KIND[m.kind].toLowerCase() + ' report for ' + periodLabel(m) +
        (m.open ? ' (so far, up to ' + m.generatedAt + ')' : '') + '.',
      '',
      'Key points:'
    ];
    if (selected.kpis && cur.records) {
      lines.push('• Production: ' + fixed(cur.tonnes, 1) + ' t' + (isNum(k.jigs.cur) ? ' · ' + fixed(k.jigs.cur, 0) + ' jigs' : '') +
        (partial ? ' (production data for ' + cur.records + ' of ' + m.days + ' days)' : ''));
      lines.push('• Zinc: ' + fixed(cur.zincKg, 0) + ' kg · ' + fixed(cur.zincPerT, 1) + ' kg/t' +
        (isNum(k.zincPerT.prev) ? ' (' + prevWord(m) + ': ' + fixed(k.zincPerT.prev, 1) + ' kg/t)' : ''));
      if (isNum(k.drossExp.cur)) lines.push('• Expected dross: ' + fixed(k.drossExp.cur, 0) + ' kg (' + fixed(m.dross.basis.rate, 1) + ' kg/t from the last drossings)');
    } else if (selected.kpis) lines.push('• No production data for this period yet');
    if (selected.status || selected.kpis) lines.push('• Tanks out of standard: ' + k.tanksOut.cur + ' of ' + k.tanksOut.of +
      (m.outTanks.length ? ' (' + m.outTanks.join(', ') + ')' : ''));
    if (selected.needs) lines.push('• Needs listed: ' + m.needs.length + (high ? ' (high priority: ' + high + ')' : ''));
    if (selected.consumption) (m.materials || []).forEach(x => lines.push('• Added: ' + x.name + ' — ' + fixed(x.q, 1) + ' ' + x.unit));
    if (selected.operations) (m.operations || []).forEach(e => lines.push('• ' + e.tank + ': ' + e.title + ' (' + e.state + ', since ' + fmtDate(e.start) + ')'));
    const summary = String(m.comments.summary || '').trim();
    if (selected.summary && summary) lines.push('', 'Summary: ' + summary);
    if (selected.managerNote) lines.push('', 'Report note: ' + selected.managerNote);
    lines.push('', 'Best regards,');
    if (m.preparedBy) lines.push(m.preparedBy);
    if (m.preparedTitle) lines.push(m.preparedTitle);
    return lines.join('\n');
  }

  window.KGCWeeklyXlsx = { build: build, emailText: emailText, fileName: fileName, _fmtDate: fmtDate };
})();
