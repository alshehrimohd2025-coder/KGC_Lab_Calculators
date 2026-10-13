/* ============================================================
   Excel kit — the look every KGC report file shares
   ------------------------------------------------------------
   One sheet on a 12-column grid laid out for A4 landscape, the KSC logo
   and title at the top, dark blue section bars, tables with a status
   colour and word, notes, comment boxes and an empty notes box to fill
   in before sending — written by hand as a few XML parts zipped STORED
   (KGCReport._zip), so the site needs no spreadsheet library.

   Used by the line report (weekly_xlsx.js) and the tank status report
   (tanks_xlsx.js): what a report says lives there, how it looks lives here.

   Dates read 13-Oct-2026 whatever the reader's Excel locale; numbers are
   real numbers, so a file can still be filtered or recalculated.

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
    this.lists = [];          // drop-down choices: { ref, items }
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
      (this.lists.length ? '<dataValidations count="' + this.lists.length + '">' + this.lists.map(d =>
        '<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="' + d.ref + '"><formula1>' +
        xe('"' + d.items.join(',') + '"') + '</formula1></dataValidation>').join('') + '</dataValidations>' : '') +
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


  /* An empty box at the end to type in before sending, for what the site
     does not hold. Excel does not grow a merged cell to fit, so it starts
     tall; a longer note needs the row dragged taller. */
  const NOTES_H = 120;
  function notesBox(sh) {
    sh.keep(6 + 21 + NOTES_H);
    bar(sh, 'ENGINEER NOTES');
    const r = sh.next(NOTES_H);
    sh.span(r, 0, NCOL - 1, '', { font: { sz: 10, color: C.ink }, border: { all: THIN },
      align: { h: 'left', v: 'top', wrap: 1, indent: 1 } });
  }

  /* ---------------- page furniture ---------------- */

  /** Logo on the left, the title block on the right, a rule under both.
      o: { title, subtitle, lines: [text, ...] } — the lines in small grey. */
  function header(sh, o, size) {
    const r1 = sh.next(28), r2 = sh.next(18);
    if (!size) sh.span(r1, 0, 4, 'Khereiji Showrooms Company', ST.company);
    sh.span(r1, 5, NCOL - 1, o.title, ST.title);
    sh.span(r2, 5, NCOL - 1, o.subtitle || 'KGC Hot-Dip Galvanizing Plant', ST.subtitle);
    (o.lines || []).forEach(function (text) {
      const r = sh.next(15);
      sh.span(r, 4, NCOL - 1, text, ST.meta);
    });
    const r4 = sh.next(6);
    sh.span(r4, 0, NCOL - 1, '', ST.rule);
  }

  /** Up to six key figures across the page. Each: { label, v, fmt, hot, sub }. */
  function cardRow(sh, list) {
    sh.next(8);
    const rl = sh.next(26), rv = sh.next(30), rp = sh.next(18);
    const w = Math.floor(NCOL / list.length);
    list.forEach(function (card, i) {
      const c1 = i * w, c2 = i === list.length - 1 ? NCOL - 1 : c1 + w - 1;
      const side = { l: THIN, r: THIN };
      sh.span(rl, c1, c2, card.label, { font: { b: 1, sz: 7.5, color: C.muted }, fill: C.band,
        border: Object.assign({ t: ['medium', C.navy] }, side), align: { h: 'center', wrap: 1 } });
      sh.span(rv, c1, c2, isNum(card.v) ? card.v : (card.v == null ? '—' : card.v), { font: { b: 1, sz: 18, color: card.hot ? C.critFg : C.navy },
        fill: C.band, border: side, fmt: card.fmt, align: { h: 'center' } });
      sh.span(rp, c1, c2, card.sub || '', { font: { sz: 8, color: C.muted }, fill: C.band,
        border: Object.assign({ b: THIN }, side), align: { h: 'center' } });
    });
  }

  /** The small italic line that closes a report: where its figures came from. */
  function closing(sh, text) {
    sh.next(10);
    const rf = sh.next();
    sh.span(rf, 0, NCOL - 1, text, ST.footer);
    sh.height(rf, linesFor(text, NCOL, 8) * 11 + 4);
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

  /** Zip the sheet into a workbook. o: { title, creator, sheetName, logo }. Returns a Blob. */
  function pack(sh, styles, o) {
    const logo = o.logo, size = pngSize(logo);
    const name = o.sheetName || 'Report';
    const enc = new TextEncoder();
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
        '<dc:title>' + xe(o.title) + '</dc:title><dc:creator>' + xe(o.creator || 'KGC Galvanizing Line') + '</dc:creator>' +
        '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>' +
        '</cp:coreProperties>'],
      ['docProps/app.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>KGC Galvanizing Site</Application></Properties>'],
      ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="16000"/></bookViews>' +
        '<sheets><sheet name="' + xe(name) + '" sheetId="1" r:id="rId1"/></sheets>' +
        '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">' + xe("'" + name + "'") + '!$A$1:$' + colLetter(NCOL - 1) + '$' + lastRow + '</definedName></definedNames>' +
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
    return zip(entries);
  }

  /** The KSC logo the reports carry, or null when it cannot be read. */
  function loadLogo() {
    return fetch('logo.png').then(r => r.ok ? r.arrayBuffer() : null).then(b => b ? new Uint8Array(b) : null).catch(() => null);
  }

  /** Hand a built file to the browser as a download. */
  function download(blob, file) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  window.KGCXlsx = {
    NCOL: NCOL, C: C, THIN: THIN, ST: ST, TIER: TIER, MONTHS: MONTHS, MONTHS_LONG: MONTHS_LONG,
    isNum: isNum, fmtDate: fmtDate, dow: dow, fixed: fixed, signed: signed, startsArabic: startsArabic,
    Styles: Styles, Sheet: Sheet, td: td, linesFor: linesFor,
    bar: bar, subTitle: subTitle, note: note, emptyLine: emptyLine, comment: comment, table: table,
    status: status, pair: pair, notesBox: notesBox, header: header, cardRow: cardRow, closing: closing,
    pack: pack, pngSize: pngSize, loadLogo: loadLogo, download: download
  };
})();
