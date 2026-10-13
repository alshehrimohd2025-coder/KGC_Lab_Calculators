/* ============================================================
   Management report → Excel (one sheet, ready to email)
   ------------------------------------------------------------
   Takes the model weekly.js computes for the period on screen and
   writes a single-sheet workbook laid out for A4 landscape: the KSC
   logo and title, a row of key figures against the previous period
   (production, jigs, zinc, the dross to expect, tanks out of standard),
   then the tanks, what changed, what is needed and the materials added,
   each with the engineer's comment under it.

   The file is English only, by the plant's choice. Dates read
   13-Oct-2026 whatever the reader's Excel locale. Numbers are real
   numbers, so the file can still be filtered or recalculated.

   Medium detail: a long table keeps its first rows and says how many
   more the site holds, so the sheet stays a report and not a dump.

   Written by hand rather than through a library: the workbook is a few
   XML parts zipped STORED (KGCReport._zip), which keeps the site free of
   a dependency for one button.

   Depends on: window.KGCReport._zip (report.js).
   ============================================================ */
(function () {
  'use strict';

  const NCOL = 12;              // every table is laid on the same 12-column grid
  const COL_W = 11.6;           // characters; 12 of them fill A4 landscape
  const MAX_ROWS = 10;          // medium detail
  /* Printable height of A4 landscape at these margins, in points. The 12
     columns fit the page width without shrinking, so row heights map to the
     page one to one — which is what lets a heading be kept with its table. */
  const PAGE_H = 512;
  const C = {
    navy: '1F3864', blue: '2F5597', head: 'D9E1F2', band: 'F5F7FB', line: 'BFC7D5',
    ink: '1F2937', muted: '6B7280', white: 'FFFFFF', note: 'F3F4F6',
    okBg: 'E2EFDA', okFg: '375623', warnBg: 'FFF2CC', warnFg: '7F6000', critBg: 'FFC7CE', critFg: '9C0006'
  };
  const THIN = ['thin', C.line];
  const KIND = { day: 'Daily', week: 'Weekly', month: 'Monthly' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /* ---------------- small helpers ---------------- */

  const xe = s => String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const isNum = v => typeof v === 'number' && isFinite(v);
  const fmtDate = iso => {
    if (!iso) return '';
    const p = String(iso).slice(0, 10).split('-');
    return p.length === 3 ? p[2] + '-' + MONTHS[Number(p[1]) - 1] + '-' + p[0] : String(iso);
  };
  const dow = iso => DAYS[new Date(iso + 'T00:00:00').getDay()];
  const serial = iso => (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000;
  const isIso = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const fixed = (v, d) => isNum(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
  const signed = (v, d) => isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + fixed(Math.abs(v), d) : '—';
  /* Text reads right to left only when it starts in Arabic: "Needs
     follow-up — Fe ارتفع" stays left to right, a note typed in Arabic does not. */
  const startsArabic = s => { const m = String(s || '').match(/[A-Za-z\u00C0-\u024F\u0600-\u06FF]/); return !!m && /[\u0600-\u06FF]/.test(m[0]); };
  const colLetter = c => { let s = ''; c += 1; while (c > 0) { const r = (c - 1) % 26; s = String.fromCharCode(65 + r) + s; c = Math.floor((c - 1) / 26); } return s; };

  const preparer = m => m.preparedBy + (m.preparedTitle ? ', ' + m.preparedTitle : '');

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

  /* ---------------- styles ---------------- */

  function Styles() {
    const fonts = [], fills = [], borders = [], numFmts = [], xfs = [];
    const idx = (arr, xml) => { let i = arr.indexOf(xml); if (i === -1) { arr.push(xml); i = arr.length - 1; } return i; };
    const cache = {};
    const font = f => {
      f = f || {};
      return idx(fonts, '<font>' + (f.b ? '<b/>' : '') + (f.i ? '<i/>' : '') + '<sz val="' + (f.sz || 10) + '"/>' +
        '<color rgb="FF' + (f.color || C.ink) + '"/><name val="Calibri"/><family val="2"/></font>');
    };
    const fill = c => c ? idx(fills, '<fill><patternFill patternType="solid"><fgColor rgb="FF' + c + '"/><bgColor indexed="64"/></patternFill></fill>') : 0;
    const border = b => {
      if (!b) return 0;
      const side = (name, sp) => sp ? '<' + name + ' style="' + sp[0] + '"><color rgb="FF' + sp[1] + '"/></' + name + '>' : '<' + name + '/>';
      return idx(borders, '<border>' + side('left', b.l || b.all) + side('right', b.r || b.all) +
        side('top', b.t || b.all) + side('bottom', b.b || b.all) + '<diagonal/></border>');
    };
    const BUILTIN = { 'General': 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10 };
    const numFmt = code => {
      if (!code) return 0;
      if (BUILTIN[code] != null) return BUILTIN[code];
      let f = numFmts.find(x => x.code === code);
      if (!f) { f = { id: 164 + numFmts.length, code: code }; numFmts.push(f); }
      return f.id;
    };
    // the defaults Excel expects in the first slots
    font({}); fills.push('<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>');
    borders.push('<border><left/><right/><top/><bottom/><diagonal/></border>');
    xfs.push('<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');

    this.id = function (st) {
      st = st || {};
      const key = JSON.stringify(st);
      if (cache[key] != null) return cache[key];
      const al = st.align || {};
      const xml = '<xf numFmtId="' + numFmt(st.fmt) + '" fontId="' + font(st.font) + '" fillId="' + fill(st.fill) +
        '" borderId="' + border(st.border) + '" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
        '<alignment' + (al.h ? ' horizontal="' + al.h + '"' : '') + ' vertical="' + (al.v || 'center') + '"' +
        (al.wrap ? ' wrapText="1"' : '') + (al.indent ? ' indent="' + al.indent + '"' : '') +
        (al.rtl ? ' readingOrder="2"' : '') + '/></xf>';
      cache[key] = idx(xfs, xml);
      return cache[key];
    };

    this.xml = () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      (numFmts.length ? '<numFmts count="' + numFmts.length + '">' + numFmts.map(f => '<numFmt numFmtId="' + f.id + '" formatCode="' + xe(f.code) + '"/>').join('') + '</numFmts>' : '') +
      '<fonts count="' + fonts.length + '">' + fonts.join('') + '</fonts>' +
      '<fills count="' + fills.length + '">' + fills.join('') + '</fills>' +
      '<borders count="' + borders.length + '">' + borders.join('') + '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';
  }

  /* ---------------- sheet ---------------- */

  function Sheet(styles) {
    this.st = styles;
    this.rows = [];
    this.merges = [];
    this.breaks = [];
    this.pageStart = 0;
    this.r = 0;
  }
  /** Height already used on the page being filled, counting Excel's own breaks inside long tables. */
  Sheet.prototype.used = function () {
    let h = 0;
    for (let r = this.pageStart; r < this.rows.length; r++) {
      const rh = this.rows[r].h || 15;
      h = h + rh > PAGE_H ? rh : h + rh;
    }
    return h;
  };
  /** Start a new page unless the next `need` points still fit on this one. */
  Sheet.prototype.keep = function (need) {
    if (this.rows.length > this.pageStart && this.used() + need > PAGE_H) {
      this.breaks.push(this.rows.length);
      this.pageStart = this.rows.length;
    }
  };
  Sheet.prototype.next = function (h) {
    const r = this.r++;
    this.rows[r] = { h: h || null, cells: {} };
    return r;
  };
  Sheet.prototype.height = function (r, h) { this.rows[r].h = Math.max(this.rows[r].h || 0, h); };
  /** Write v across columns c1..c2 (merged), every covered cell carrying the style. */
  Sheet.prototype.span = function (r, c1, c2, v, style) {
    const s = this.st.id(style);
    for (let c = c1; c <= c2; c++) this.rows[r].cells[c] = { v: c === c1 ? v : null, s: s };
    if (c2 > c1) this.merges.push(colLetter(c1) + (r + 1) + ':' + colLetter(c2) + (r + 1));
  };
  Sheet.prototype.xml = function (drawing) {
    const rowsXml = this.rows.map(function (row, r) {
      const cells = Object.keys(row.cells).map(Number).sort((a, b) => a - b).map(function (c) {
        const cell = row.cells[c], ref = colLetter(c) + (r + 1);
        const v = cell.v;
        if (v == null || v === '') return '<c r="' + ref + '" s="' + cell.s + '"/>';
        if (isNum(v)) return '<c r="' + ref + '" s="' + cell.s + '"><v>' + v + '</v></c>';
        if (v && v.date) return '<c r="' + ref + '" s="' + cell.s + '"><v>' + serial(v.date) + '</v></c>';
        return '<c r="' + ref + '" s="' + cell.s + '" t="inlineStr"><is><t xml:space="preserve">' + xe(v) + '</t></is></c>';
      }).join('');
      return '<row r="' + (r + 1) + '"' + (row.h ? ' ht="' + row.h.toFixed(1) + '" customHeight="1"' : '') + '>' + cells + '</row>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
      '<dimension ref="A1:' + colLetter(NCOL - 1) + Math.max(1, this.rows.length) + '"/>' +
      '<sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols><col min="1" max="' + NCOL + '" width="' + COL_W + '" customWidth="1"/></cols>' +
      '<sheetData>' + rowsXml + '</sheetData>' +
      (this.merges.length ? '<mergeCells count="' + this.merges.length + '">' + this.merges.map(m => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>' : '') +
      '<printOptions horizontalCentered="1"/>' +
      '<pageMargins left="0.35" right="0.35" top="0.45" bottom="0.55" header="0.25" footer="0.25"/>' +
      '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
      '<headerFooter><oddFooter>' + xe('&L&8&K6B7280KGC Galvanizing Line · ' + this.footer + '&R&8&K6B7280Page &P of &N') + '</oddFooter></headerFooter>' +
      (this.breaks.length ? '<rowBreaks count="' + this.breaks.length + '" manualBreakCount="' + this.breaks.length + '">' +
        this.breaks.map(r => '<brk id="' + r + '" max="16383" man="1"/>').join('') + '</rowBreaks>' : '') +
      (drawing ? '<drawing r:id="rId1"/>' : '') +
      '</worksheet>';
  };

  /* ---------------- cell styles ---------------- */

  const ST = {
    title: { font: { b: 1, sz: 18, color: C.navy }, align: { h: 'right' } },
    company: { font: { b: 1, sz: 12, color: C.navy } },
    subtitle: { font: { sz: 10, color: C.muted }, align: { h: 'right' } },
    meta: { font: { sz: 9, color: C.muted }, align: { h: 'right' } },
    rule: { border: { b: ['medium', C.navy] } },
    bar: { font: { b: 1, sz: 11, color: C.white }, fill: C.navy, align: { h: 'left', indent: 1 } },
    sub: { font: { b: 1, sz: 10, color: C.blue }, align: { h: 'left', v: 'bottom' } },
    th: { font: { b: 1, sz: 9, color: C.navy }, fill: C.head, border: { all: THIN }, align: { h: 'center', wrap: 1 } },
    note: { font: { i: 1, sz: 8.5, color: C.muted }, align: { h: 'left', wrap: 1, v: 'top' } },
    empty: { font: { i: 1, sz: 9, color: C.muted }, border: { all: THIN }, align: { h: 'left', indent: 1 } },
    commentLabel: { font: { b: 1, sz: 9, color: C.navy }, align: { h: 'left', v: 'bottom' } },
    footer: { font: { i: 1, sz: 8, color: C.muted }, align: { h: 'left', wrap: 1 } }
  };

  const TIER = {
    good: { fill: C.okBg, color: C.okFg, word: 'OK' },
    warn: { fill: C.warnBg, color: C.warnFg, word: 'Out' },
    crit: { fill: C.critBg, color: C.critFg, word: 'Critical' },
    none: { fill: null, color: C.muted, word: '—' }
  };

  function td(o, zebra) {
    o = o || {};
    const h = o.rtl && (!o.h || o.h === 'left') ? 'right' : (o.h || 'left');
    return {
      font: { sz: 9, b: o.b ? 1 : 0, color: o.color || C.ink },
      fill: o.fill || (zebra ? C.band : null),
      border: { all: THIN },
      fmt: o.fmt,
      align: { h: h, wrap: 1, indent: h === 'center' ? 0 : 1, rtl: o.rtl ? 1 : 0 }
    };
  }

  /** Lines a text needs in a span of columns — Excel never sizes merged rows itself. */
  function linesFor(text, span, sz) {
    const per = Math.max(4, Math.floor(span * COL_W * 1.12 * (9 / (sz || 9))));
    return String(text == null ? '' : text).split('\n')
      .reduce((n, part) => n + Math.max(1, Math.ceil(part.length / per)), 0);
  }

  /* ---------------- blocks ---------------- */

  function bar(sh, text) {
    sh.keep(6 + 21 + 20 + 18 + 2 * 17);    // the bar, a heading, a header row and two rows
    sh.next(6);
    const r = sh.next(21);
    sh.span(r, 0, NCOL - 1, text, ST.bar);
  }

  function subTitle(sh, text) {
    sh.keep(20 + 18 + 2 * 17);
    const r = sh.next(20);
    sh.span(r, 0, NCOL - 1, text, ST.sub);
  }

  function note(sh, text) {
    if (!text) return;
    const r = sh.next();
    sh.span(r, 0, NCOL - 1, text, ST.note);
    sh.height(r, Math.max(13, linesFor(text, NCOL, 8.5) * 11.5 + 2));
  }

  function emptyLine(sh, text) {
    const r = sh.next(18);
    sh.span(r, 0, NCOL - 1, text, ST.empty);
  }

  /** The engineer's own words, as written (right-to-left when written in Arabic). */
  function comment(sh, text, label) {
    text = String(text || '').trim();
    if (!text) return;
    const boxH = Math.max(18, linesFor(text, NCOL, 9.5) * 13 + 6);
    sh.keep((label !== null ? 16 : 0) + boxH);
    if (label !== null) {
      const r1 = sh.next(16);
      sh.span(r1, 0, NCOL - 1, label || 'Engineer comment', ST.commentLabel);
    }
    const r2 = sh.next();
    const rtl = startsArabic(text);
    sh.span(r2, 0, NCOL - 1, text, {
      font: { sz: 9.5, color: C.ink }, fill: C.note, border: { all: THIN },
      align: { h: rtl ? 'right' : 'left', v: 'top', wrap: 1, indent: 1, rtl: rtl ? 1 : 0 }
    });
    sh.height(r2, boxH);
  }

  /* A table on the grid. cols: [{label, span, h}] summing to 12. rows: arrays
     of cells, each a value or {v, fmt, b, color, fill, h}. */
  function table(sh, cols, rows, opts) {
    opts = opts || {};
    const total = cols.reduce((s, c) => s + c.span, 0);
    if (total !== NCOL) throw new Error('table columns span ' + total);
    const head = sh.next();
    let c0 = 0, hLines = 1;
    cols.forEach(function (c) {
      sh.span(head, c0, c0 + c.span - 1, c.label, ST.th);
      hLines = Math.max(hLines, linesFor(c.label, c.span, 9));
      c0 += c.span;
    });
    sh.height(head, Math.max(18, hLines * 12 + 5));

    const limit = opts.limit || MAX_ROWS;
    rows.slice(0, limit).forEach(function (row, i) {
      const r = sh.next();
      let c = 0, lines = 1;
      cols.forEach(function (col, j) {
        let cell = row[j];
        if (cell == null || typeof cell !== 'object' || cell.date) cell = { v: cell };
        const v = cell.v == null || cell.v === '' ? (cell.blank ? '' : '—') : cell.v;
        const val = isIso(v) ? { date: v } : v;
        const style = td({
          h: cell.h || col.h, fmt: val && val.date ? '[$-409]dd-mmm-yyyy;@' : (cell.fmt || col.fmt),
          b: cell.b, color: cell.color, fill: cell.fill, rtl: typeof v === 'string' && startsArabic(v)
        }, i % 2 === 1);
        sh.span(r, c, c + col.span - 1, val, style);
        if (!isNum(v) && !(val && val.date)) lines = Math.max(lines, linesFor(v, col.span, 9));
        c += col.span;
      });
      sh.height(r, Math.max(17, lines * 12 + 5));
    });
    if (rows.length > limit) note(sh, '+ ' + (rows.length - limit) + ' more row' + (rows.length - limit === 1 ? '' : 's') + ' not shown — the full list is on the site.');
  }

  const status = tier => {
    const t = TIER[tier] || TIER.none;
    return { v: t.word, fill: t.fill, color: t.color, b: 1, h: 'center' };
  };

  /* ---------------- the report ---------------- */

  function header(sh, m, logo) {
    const r1 = sh.next(28), r2 = sh.next(18), r3 = sh.next(15), r3b = sh.next(15);
    if (!logo) sh.span(r1, 0, 4, 'Khereiji Showrooms Company', ST.company);
    sh.span(r1, 5, NCOL - 1, KIND[m.kind].toUpperCase() + ' GALVANIZING LINE REPORT', ST.title);
    sh.span(r2, 5, NCOL - 1, 'KGC Hot-Dip Galvanizing Plant', ST.subtitle);
    const per = (m.kind === 'week'
      ? 'Week: ' + dow(m.S) + ' ' + fmtDate(m.S) + ' to ' + dow(m.E) + ' ' + fmtDate(m.E)
      : m.kind === 'day' ? 'Day: ' + dow(m.S) + ' ' + fmtDate(m.S)
      : 'Month: ' + periodLabel(m) + ' (' + fmtDate(m.S) + ' to ' + fmtDate(m.E) + ')') +
      (m.open ? ' — so far, up to ' + m.generatedAt : '');
    sh.span(r3, 4, NCOL - 1, per, ST.meta);
    sh.span(r3b, 4, NCOL - 1, 'Generated ' + fmtDate(m.generated) + ' ' + m.generatedAt +
      (m.preparedBy ? '   ·   Prepared by ' + preparer(m) : ''), ST.meta);
    const r4 = sh.next(6);
    sh.span(r4, 0, NCOL - 1, '', ST.rule);
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
    sh.next(8);
    const rl = sh.next(26), rv = sh.next(30), rp = sh.next(18);
    list.forEach(function (card, i) {
      const c1 = i * 2, c2 = c1 + 1;
      const side = { l: THIN, r: THIN };
      sh.span(rl, c1, c2, card.label, { font: { b: 1, sz: 7.5, color: C.muted }, fill: C.band,
        border: Object.assign({ t: ['medium', C.navy] }, side), align: { h: 'center', wrap: 1 } });
      sh.span(rv, c1, c2, isNum(card.v) ? card.v : '—', { font: { b: 1, sz: 18, color: card.hot ? C.critFg : C.navy },
        fill: C.band, border: side, fmt: card.fmt, align: { h: 'center' } });
      const prev = fixed(card.p, card.d) + (isNum(card.v) && isNum(card.p) ? '   Δ ' + signed(card.v - card.p, card.d) : '');
      sh.span(rp, c1, c2, 'Prev: ' + prev, { font: { sz: 8, color: C.muted }, fill: C.band,
        border: Object.assign({ b: THIN }, side), align: { h: 'center' } });
    });
    note(sh, 'Each figure is compared with the ' + prevWord(m) + ' (' + (m.kind === 'day' ? fmtDate(m.prevS) : fmtDate(m.prevS) + ' to ' + fmtDate(m.prevE)) + '). ' +
      'Production, jigs and zinc are from the production report.' +
      (partial ? ' * Production data covers ' + cur.records + ' of ' + m.days + ' days, so these figures are partial.' : ''));
    note(sh, drossText(m));
  }

  /** Where the expected dross comes from, in one sentence the reader can check. */
  function drossText(m) {
    const cur = m.production.cur, b = m.dross.basis;
    if (!cur.records) return 'No production data for this period — upload the production report on the zinc efficiency page.';
    if (!b) return 'Expected dross needs at least two drossings in the production report to know the rate; there are not enough yet.';
    return 'Expected dross = ' + fixed(b.rate, 1) + ' kg/t × ' + fixed(cur.tonnes, 1) + ' t produced. The rate is the last ' +
      (b.n === 1 ? 'drossing' : b.n + ' drossings') + ' (' + b.dates.map(fmtDate).join(', ') + ': ' + fixed(b.dross, 0) + ' kg) over the ' +
      fixed(b.tonnes, 1) + ' t produced since the drossing before ' + (b.n === 1 ? 'it' : 'them') + '. ' +
      'Dross actually removed in this period: ' + fixed(m.dross.removed, 0) + ' kg. It is an estimate, not a weighing.';
  }

  /** A short labelled line under a table: the label in colour, the list beside it. */
  function pair(sh, label, text, tier) {
    if (!text) return;
    const tt = TIER[tier] || TIER.none;
    const lines = linesFor(text, NCOL - 2, 9);
    const r = sh.next();
    sh.span(r, 0, 1, label, { font: { b: 1, sz: 9, color: tt.color }, fill: tt.fill, border: { all: THIN },
      align: { h: 'left', indent: 1, wrap: 1, v: 'top' } });
    sh.span(r, 2, NCOL - 1, text, { font: { sz: 9, color: C.ink }, border: { all: THIN },
      align: { h: 'left', indent: 1, wrap: 1, v: 'top' } });
    sh.height(r, Math.max(17, Math.max(lines, linesFor(label, 2, 9)) * 12 + 5));
  }

  function sectionStatus(sh, m) {
    bar(sh, '1   TANKS OUT OF STANDARD');
    subTitle(sh, 'Last reading of each tank up to ' + fmtDate(m.E) + ', and readings out of standard in the period (' + m.readings + ' reading records)');
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
      if (m.breaches.some(x => x.old)) note(sh, 'A reading date in orange is before this period: the tank was not re-measured in the period, so its last reading still stands.');
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
    bar(sh, '2   WHAT CHANGED?');
    subTitle(sh, 'Before / after results of treatments in the period' + (all ? '' : ' — values that changed'));
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
    } else emptyLine(sh, m.quietCards
      ? 'No treatment card changed a reading in this period (' + m.quietCards + ' with no change, or no re-measure yet).'
      : 'No treatment card had an action or a re-measure in this period.');

    subTitle(sh, 'Problems: start of the period against the end');
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
    } else emptyLine(sh, m.still.length ? 'No parameter came back into standard or went out of it in this period.'
      : 'No parameter was out of standard at the start or the end of the period.');
    pair(sh, 'Still out, no change', m.still.map(x => x.tank + ' · ' + x.param).join(',  '), 'warn');
    note(sh, 'Treatment cards open now: ' + m.openCards + '.');
    comment(sh, m.comments.changed);
  }

  function sectionNeeds(sh, m) {
    bar(sh, '3   WHAT DO WE NEED?');
    if (m.needs.length) {
      const P = { high: 'crit', medium: 'warn', low: 'good' };
      table(sh, [
        { label: 'Priority', span: 1, h: 'center' }, { label: 'Type', span: 1, h: 'center' }, { label: 'Needed', span: 3 },
        { label: 'Why', span: 4 }, { label: 'Owner', span: 2 }, { label: 'Needed by', span: 1, h: 'center' }
      ], m.needs.map(x => [
        x.priority ? Object.assign(status(P[x.priority]), { v: x.priorityText }) : null,
        { v: x.kind, h: 'center' }, { v: x.what, b: 1 }, x.why, x.owner, x.due
      ]), { limit: 25 });
    } else emptyLine(sh, 'No needs were listed for this period.');
    comment(sh, m.comments.needs);
  }

  /* Materials always; the production figures and the product mix only when
     the site is set to show them (they wait for the batch data to be complete). */
  function sectionConsumption(sh, m) {
    const cur = m.production.cur, prev = m.production.prev, partial = m.production.partial && cur.records > 0;
    const full = m.options.production;
    bar(sh, full ? '4   CONSUMPTION AND PRODUCTION' : '4   MATERIALS ADDED TO THE BATHS');
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
    note(sh, m.notes.partial ? '* ' + m.notes.partial.replace(/^\*\s*/, '') : '');
    if (full) note(sh, m.notes.zinc);
    note(sh, m.notes.money);
    comment(sh, m.comments.consumption);
  }

  /* ---------------- package ---------------- */

  function pngSize(bytes) {
    if (!bytes || bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { w: dv.getUint32(16), h: dv.getUint32(20) };
  }

  function drawingXml(size) {
    const hPx = 62, wPx = Math.round(hPx * size.w / size.h);
    const EMU = 9525;
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>' + 4 * EMU + '</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>' + 4 * EMU + '</xdr:rowOff></xdr:from>' +
      '<xdr:ext cx="' + wPx * EMU + '" cy="' + hPx * EMU + '"/>' +
      '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="KSC logo" descr="Khereiji Showrooms Company"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
      '<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
      '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + wPx * EMU + '" cy="' + hPx * EMU + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>' +
      '<xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>';
  }

  /** Build the workbook. Returns { blob, file }. */
  function build(m, logo) {
    const styles = new Styles();
    const sh = new Sheet(styles);
    sh.footer = KIND[m.kind] + ' report · ' + periodLabel(m);
    const size = pngSize(logo);

    header(sh, m, size);
    cards(sh, m);
    if (String(m.comments.summary || '').trim()) {
      bar(sh, 'ENGINEER SUMMARY');
      comment(sh, m.comments.summary, null);
    }
    sectionStatus(sh, m);
    sectionChanged(sh, m);
    sectionNeeds(sh, m);
    sectionConsumption(sh, m);
    sh.next(10);
    const rf = sh.next();
    const foot = 'Built from the KGC galvanizing line records on the site: tank readings, treatment cards, addition and treatment logs, and the production report. ' +
      'Readings are judged against the standard limits set on the site on ' + fmtDate(m.generated) + '. No financial figures are computed.';
    sh.span(rf, 0, NCOL - 1, foot, ST.footer);
    sh.height(rf, linesFor(foot, NCOL, 8) * 11 + 4);

    const enc = new TextEncoder();
    const title = 'KGC Galvanizing Line ' + KIND[m.kind] + ' Report — ' + periodLabel(m);
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const lastRow = sh.rows.length;
    const parts = [
      ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        (size ? '<Default Extension="png" ContentType="image/png"/>' : '') +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        (size ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '') +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        '</Types>'],
      ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
        '</Relationships>'],
      ['docProps/core.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        '<dc:title>' + xe(title) + '</dc:title><dc:creator>' + xe(m.preparedBy || 'KGC Galvanizing Line') + '</dc:creator>' +
        '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>' +
        '</cp:coreProperties>'],
      ['docProps/app.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>KGC Galvanizing Site</Application></Properties>'],
      ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="16000"/></bookViews>' +
        '<sheets><sheet name="Line Report" sheetId="1" r:id="rId1"/></sheets>' +
        '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">\'Line Report\'!$A$1:$' + colLetter(NCOL - 1) + '$' + lastRow + '</definedName></definedNames>' +
        '</workbook>'],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>'],
      ['xl/worksheets/sheet1.xml', sh.xml(!!size)],
      ['xl/styles.xml', styles.xml()]
    ];
    if (size) {
      parts.push(
        ['xl/worksheets/_rels/sheet1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
          '</Relationships>'],
        ['xl/drawings/drawing1.xml', drawingXml(size)],
        ['xl/drawings/_rels/drawing1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>' +
          '</Relationships>']
      );
    }
    const entries = parts.map(p => ({ name: p[0], data: enc.encode(p[1]) }));
    if (size) entries.push({ name: 'xl/media/image1.png', data: logo });
    const zip = window.KGCReport && window.KGCReport._zip;
    if (!zip) throw new Error('report.js not loaded');
    return { blob: zip(entries), file: fileName(m), title: title };
  }

  /** A short email to send with the file — what the reader needs before opening it. */
  function emailText(m) {
    const k = m.kpi, cur = m.production.cur, partial = m.production.partial && cur.records > 0;
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
    if (cur.records) {
      lines.push('• Production: ' + fixed(cur.tonnes, 1) + ' t' + (isNum(k.jigs.cur) ? ' · ' + fixed(k.jigs.cur, 0) + ' jigs' : '') +
        (partial ? ' (production data for ' + cur.records + ' of ' + m.days + ' days)' : ''));
      lines.push('• Zinc: ' + fixed(cur.zincKg, 0) + ' kg · ' + fixed(cur.zincPerT, 1) + ' kg/t' +
        (isNum(k.zincPerT.prev) ? ' (' + prevWord(m) + ': ' + fixed(k.zincPerT.prev, 1) + ' kg/t)' : ''));
      if (isNum(k.drossExp.cur)) lines.push('• Expected dross: ' + fixed(k.drossExp.cur, 0) + ' kg (' + fixed(m.dross.basis.rate, 1) + ' kg/t from the last drossings)');
    } else lines.push('• No production data for this period yet');
    lines.push('• Tanks out of standard: ' + k.tanksOut.cur + ' of ' + k.tanksOut.of +
      (m.outTanks.length ? ' (' + m.outTanks.join(', ') + ')' : ''));
    lines.push('• Needs listed: ' + m.needs.length + (high ? ' (high priority: ' + high + ')' : ''));
    const summary = String(m.comments.summary || '').trim();
    if (summary) lines.push('', 'Summary: ' + summary);
    lines.push('', 'Best regards,');
    if (m.preparedBy) lines.push(m.preparedBy);
    if (m.preparedTitle) lines.push(m.preparedTitle);
    return lines.join('\n');
  }

  window.KGCWeeklyXlsx = { build: build, emailText: emailText, fileName: fileName, _fmtDate: fmtDate };
})();
