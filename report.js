/* ============================================================
   "Export report" — the plant's own bath status report, filled in.
   ------------------------------------------------------------
   The workbook that comes out is the lab's real template
   (report_template.js) with two parts swapped: the worksheet and the
   drawing anchor. Everything that gives the file its identity — styles,
   fonts, borders, print setup and the KSC logo itself — is carried over
   untouched, so it opens as the same document the lab already circulates.

   Every measured parameter gets its own column rather than being crammed
   into one cell, and the columns are built from whichever tanks were
   selected, so a flux-only sheet carries exactly the flux parameters.

   Bath changes — renewals, chemical additions and flux treatments — are
   listed underneath, so the report says what was done, not just what was
   measured.

   Zip entries are written STORED: Excel accepts them, and it keeps the
   writer to a CRC32 with no compression stream involved.

   Depends on globals from index.html: database, tanks, t(), KGCSpecs
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[report] Firebase database is not available.');
    return;
  }

  const SHEET = 'xl/worksheets/sheet1.xml';
  const DRAWING = 'xl/drawings/drawing1.xml';

  /* Which tanks each scope covers. Drying (11) and zinc (12) are never
     included — they hold no bath readings. */
  const SCOPES = {
    all:   [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    acid:  [3, 4, 5, 6, 7, 8],
    flux:  [10],
    rinse: [1, 2, 9]
  };

  /* Canonical column order, so a parameter always lands in the same place
     whatever mix of tanks was chosen. */
  const PARAM_ORDER = ['conc', 'acidPercent', 'salt', 'ph', 'fe', 'zn', 'baume', 'sg', 'ec', 'temp'];

  const EVENT_DAYS = 30;          // how far back the changes section looks

  let renewals = {}, treatments = {}, peroxTreatments = {};

  /* ---------------- helpers ---------------- */

  const te = (k, v) => (window.I18N && I18N.tIn) ? I18N.tIn('en', k, v) : t(k, v);
  const tankNameEn = name => te('tank.' + name) === 'tank.' + name ? name : te('tank.' + name);

  const xe = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  /** 0-based column index -> spreadsheet letter (A, B, ... Z, AA). */
  function colLetter(i) {
    let s = '';
    i += 1;
    while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  const pad = n => (n < 10 ? '0' : '') + n;
  const dayKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const serialDate = d => Math.floor((d - new Date(Date.UTC(1899, 11, 30))) / 86400000);

  /* ---------------- zip ---------------- */

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
  }

  async function unzipAll(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= 0 && i > u8.length - 65558; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('template is not a zip');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);

    const out = [];
    const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const cmtLen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      const lNameLen = dv.getUint16(lho + 26, true);
      const lExtraLen = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lNameLen + lExtraLen;
      const raw = u8.subarray(start, start + compSize);
      out.push({ name: name, data: method === 0 ? raw.slice() : await inflateRaw(raw) });
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }

  const CRC_TABLE = (function () {
    const tb = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      tb[n] = c >>> 0;
    }
    return tb;
  })();
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zip(entries) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    entries.forEach(function (e) {
      const nameBytes = enc.encode(e.name);
      const crc = crc32(e.data), size = e.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
      lh.setUint16(26, nameBytes.length, true);
      chunks.push(new Uint8Array(lh.buffer), nameBytes, e.data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
      ch.setUint16(28, nameBytes.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nameBytes);
      offset += 30 + nameBytes.length + size;
    });
    let cSize = 0; central.forEach(c => { cSize += c.length; });
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, cSize, true); eocd.setUint32(16, offset, true);
    return new Blob(chunks.concat(central, [new Uint8Array(eocd.buffer)]),
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  /* ---------------- content ---------------- */

  /** Parameters actually measured by the chosen tanks, in canonical order. */
  function columnsFor(ids) {
    const SP = window.KGCSpecs;
    const seen = {};
    ids.forEach(function (id) {
      if (!SP || !SP.hasSpec(id)) return;
      SP.paramsFor(id).forEach(p => { seen[p.key] = p; });
    });
    return PARAM_ORDER.filter(k => seen[k]).map(k => ({ key: k, unit: seen[k].unit || '' }));
  }

  function statusText(tank) {
    const SP = window.KGCSpecs;
    const manual = String(tank.status || '');
    if (manual === 'out') return te('rep.st.out');
    if (manual === 'maint') return te('rep.st.maint');
    const st = SP && SP.hasSpec(tank.id) ? SP.tankStatus(tank) : null;
    if (!st || st.tier === 'none') return te('rep.st.noData');
    if (st.tier === 'crit') return te('rep.st.crit');
    if (st.tier === 'warn') return te('rep.st.warn');
    return te('rep.st.ok');
  }

  function collectRows(ids) {
    const SP = window.KGCSpecs;
    return ids.map(function (id) {
      const tk = (typeof tanks !== 'undefined' ? tanks : []).find(x => x.id === id);
      if (!tk) return null;
      const st = SP && SP.hasSpec(id) ? SP.tankStatus(tk) : null;
      const vals = {};
      if (SP && SP.hasSpec(id)) {
        SP.paramsFor(id).forEach(function (p) {
          const v = tk[p.key];
          vals[p.key] = (v === undefined || v === null || v === '' || Number(v) === 0)
            ? null : Math.round(Number(v) * 100) / 100;
        });
      }
      return {
        no: te('rep.tankNo', { n: id }),
        name: tankNameEn(tk.name),
        vals: vals,
        status: statusText(tk),
        tier: st ? st.tier : 'none'
      };
    }).filter(Boolean);
  }

  /** Bath changes recorded in the period — renewals, additions, treatments. */
  function collectEvents(ids) {
    const from = new Date(); from.setDate(from.getDate() - EVENT_DAYS);
    const fromKey = dayKey(from);
    const out = [];

    Object.values(renewals || {}).forEach(function (r) {
      if (!r || !r.date || r.date < fromKey) return;
      const id = Number(r.tankId);
      if (ids.indexOf(id) === -1) return;
      const tk = (typeof tanks !== 'undefined' ? tanks : []).find(x => x.id === id);
      out.push({
        date: r.date,
        tank: tk ? tankNameEn(tk.name) : te('rep.tankNo', { n: id }),
        type: r.type === 'renewal' ? te('rep.ev.renewal') : te('rep.ev.addition'),
        qty: (Number(r.qty) || 0) ? (Number(r.qty) + ' ' + (r.unit || 'L')) : '',
        note: r.note || ''
      });
    });

    // flux treatments only belong on a sheet that includes the flux tank
    if (ids.indexOf(10) !== -1) {
      Object.values(treatments || {}).forEach(function (r) {
        if (!r || !r.date || r.date < fromKey) return;
        const tk = (typeof tanks !== 'undefined' ? tanks : []).find(x => x.id === 10);
        out.push({
          date: r.date,
          tank: tk ? tankNameEn(tk.name) : 'Flux tank',
          type: te('rep.ev.treatment'),
          qty: (Number(r.liters) || 0) ? (Number(r.liters) + ' L') : '',
          note: te('rep.ev.phRaise', { a: r.phBefore, b: r.phAfter }) + (r.note ? ' — ' + r.note : '')
        });
      });
    }

    // peroxide treatments only belong on a sheet that includes the flux tank
    if (ids.indexOf(10) !== -1) {
      Object.values(peroxTreatments || {}).forEach(function (r) {
        if (!r || !r.date || r.date < fromKey) return;
        const tk = (typeof tanks !== 'undefined' ? tanks : []).find(x => x.id === 10);
        out.push({
          date: r.date,
          tank: tk ? tankNameEn(tk.name) : 'Flux tank',
          type: te('rep.ev.peroxTreatment'),
          qty: (Number(r.liters) || 0) ? (Number(r.liters) + ' L') : '',
          note: te('rep.ev.feDrop', { a: r.feBefore, b: r.feAfter }) + (r.note ? ' — ' + r.note : '')
        });
      });
    }

    return out.sort((a, b) => a.date < b.date ? 1 : -1);
  }

  function summaryText(rows) {
    const crit = rows.filter(r => r.tier === 'crit').length;
    const warn = rows.filter(r => r.tier === 'warn').length;
    const ok = rows.filter(r => r.tier === 'good').length;
    return te('rep.summary', { ok: ok, warn: warn, crit: crit, n: rows.length });
  }

  /* ---------------- worksheet ---------------- */

  const sCell = (ref, style, text) =>
    (text === null || text === undefined || text === '')
      ? '<c r="' + ref + '" s="' + style + '"/>'
      : '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' + xe(text) + '</t></is></c>';

  const nCell = (ref, style, num) =>
    (num === null || num === undefined || !isFinite(num))
      ? '<c r="' + ref + '" s="' + style + '"/>'
      : '<c r="' + ref + '" s="' + style + '"><v>' + num + '</v></c>';

  function buildSheet(rows, cols, events, dateObj, preparedBy) {
    const nCols = 2 + cols.length + 1;          // no | name | params… | status
    const lastL = colLetter(nCols - 1);
    const bandCells = (r, style) => {
      let s = '';
      for (let i = 1; i < nCols; i++) s += '<c r="' + colLetter(i) + r + '" s="' + style + '"/>';
      return s;
    };

    let body = '', merges = [];
    let r = 1;

    // title band (rows 1-2)
    body += '<row r="1" spans="1:' + nCols + '">' + sCell('A1', 17, te('rep.title')) + bandCells(1, 14) + '</row>';
    body += '<row r="2" spans="1:' + nCols + '">' + sCell('A2', 14, '') + bandCells(2, 14) + '</row>';
    merges.push('A1:' + lastL + '2');
    r = 3;

    // report date
    body += '<row r="3" spans="1:' + nCols + '">' + sCell('A3', 13, te('rep.date')) +
            '<c r="B3" s="14"/><c r="C3" s="9"><v>' + serialDate(dateObj) + '</v></c>';
    for (let i = 3; i < nCols; i++) body += '<c r="' + colLetter(i) + '3" s="10"/>';
    body += '</row>';
    merges.push('A3:B3', 'C3:' + lastL + '3');

    // results banner
    body += '<row r="4" spans="1:' + nCols + '" ht="30" customHeight="1" thickBot="1">' +
            sCell('A4', 20, te('rep.results')) + bandCells(4, 21) + '</row>';
    merges.push('A4:' + lastL + '4');

    // header row — one column per parameter, unit in the heading
    let hdr = sCell('A5', 3, te('rep.col.tank')) + sCell('B5', 22, te('rep.col.name'));
    cols.forEach(function (c, i) {
      const label = te('f.' + c.key) + (c.unit ? ' (' + c.unit + ')' : '');
      hdr += sCell(colLetter(2 + i) + '5', 34, label);
    });
    hdr += sCell(lastL + '5', 4, te('rep.col.status'));
    body += '<row r="5" spans="1:' + nCols + '" ht="32" customHeight="1">' + hdr + '</row>';

    // tank rows
    const first = 6, last = first + rows.length - 1;
    rows.forEach(function (row, i) {
      const rn = first + i, isLast = rn === last;
      let line = sCell('A' + rn, 8, row.no) + sCell('B' + rn, isLast ? 30 : 11, row.name);
      cols.forEach(function (c, j) {
        line += nCell(colLetter(2 + j) + rn, 15, row.vals[c.key]);
      });
      line += sCell(lastL + rn, 6, row.status);
      body += '<row r="' + rn + '" spans="1:' + nCols + '" ht="26" customHeight="1"' +
              (isLast ? ' thickBot="1"' : '') + '>' + line + '</row>';
    });
    r = last + 2;

    // changes section — only when there is something to report
    if (events.length) {
      body += '<row r="' + r + '" spans="1:' + nCols + '">' + sCell('A' + r, 32, te('rep.changes')) +
              bandCells(r, 33) + '</row>';
      merges.push('A' + r + ':' + lastL + r);
      r++;
      const evCols = [te('rep.ev.date'), te('rep.ev.tank'), te('rep.ev.type'), te('rep.ev.qty'), te('rep.ev.note')];
      let eh = '';
      evCols.forEach(function (label, i) {
        eh += sCell(colLetter(i) + r, i === 0 ? 3 : (i === evCols.length - 1 ? 4 : 34), label);
      });
      for (let i = evCols.length; i < nCols; i++) eh += '<c r="' + colLetter(i) + r + '" s="34"/>';
      body += '<row r="' + r + '" spans="1:' + nCols + '" ht="26" customHeight="1">' + eh + '</row>';
      // the note column runs to the end of the sheet
      merges.push(colLetter(4) + r + ':' + lastL + r);
      r++;

      events.forEach(function (e) {
        let line = sCell('A' + r, 8, e.date) + sCell('B' + r, 11, e.tank) +
                   sCell('C' + r, 15, e.type) + sCell('D' + r, 15, e.qty) +
                   sCell('E' + r, 15, e.note);
        for (let i = 5; i < nCols; i++) line += '<c r="' + colLetter(i) + r + '" s="15"/>';
        body += '<row r="' + r + '" spans="1:' + nCols + '" ht="24" customHeight="1">' + line + '</row>';
        if (nCols > 5) merges.push('E' + r + ':' + lastL + r);
        r++;
      });
      r++;
    }

    // summary
    body += '<row r="' + r + '" spans="1:' + nCols + '">' + sCell('A' + r, 32, te('rep.summaryHead')) +
            bandCells(r, 33) + '</row>';
    merges.push('A' + r + ':' + lastL + r);
    r++;
    body += '<row r="' + r + '" spans="1:' + nCols + '">' + sCell('A' + r, 28, summaryText(rows)) +
            bandCells(r, 29) + '</row>';
    const sumStart = r;
    r++;
    body += '<row r="' + r + '" spans="1:' + nCols + '">' + sCell('A' + r, 29, '') + bandCells(r, 29) + '</row>';
    merges.push('A' + sumStart + ':' + lastL + r);
    r += 2;

    // prepared by
    body += '<row r="' + r + '" spans="1:' + nCols + '">' + sCell('A' + r, 1, te('rep.preparedBy')) +
            bandCells(r, 2) + '</row>';
    r++;
    const nameStart = r;
    body += '<row r="' + r + '" spans="1:' + nCols + '" ht="34" customHeight="1">' +
            sCell('A' + r, 26, preparedBy) + bandCells(r, 27) + '</row>';
    r++;
    body += '<row r="' + r + '" spans="1:' + nCols + '">' + sCell('A' + r, 27, '') + bandCells(r, 27) + '</row>';
    merges.push('A' + nameStart + ':C' + r);
    const lastRow = r;

    // column widths: identity columns wide, parameters even, status widest
    let colsXml = '<cols><col min="1" max="1" width="11" customWidth="1"/>' +
      '<col min="2" max="2" width="22" customWidth="1"/>';
    if (cols.length) colsXml += '<col min="3" max="' + (2 + cols.length) + '" width="15" customWidth="1"/>';
    colsXml += '<col min="' + nCols + '" max="' + nCols + '" width="30" customWidth="1"/></cols>';

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
      '<dimension ref="A1:' + lastL + lastRow + '"/>' +
      '<sheetViews><sheetView showGridLines="0" tabSelected="1" workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr baseColWidth="10" defaultColWidth="8.83203125" defaultRowHeight="15"/>' +
      colsXml +
      '<sheetData>' + body + '</sheetData>' +
      '<mergeCells count="' + merges.length + '">' +
      merges.map(m => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>' +
      '<pageMargins left="0.3" right="0.3" top="0.35" bottom="0.35" header="0.5" footer="0.5"/>' +
      '<pageSetup paperSize="9" scale="80" orientation="landscape" fitToWidth="1" fitToHeight="0" r:id="rId1"/>' +
      '<drawing r:id="rId2"/></worksheet>';
  }

  /** Re-anchor the logo to the last columns so it stays top-right however
      many parameter columns the chosen scope produced. */
  function buildDrawing(nCols) {
    const anchorCol = Math.max(0, nCols - 2);
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<xdr:oneCellAnchor>' +
        '<xdr:from><xdr:col>' + anchorCol + '</xdr:col><xdr:colOff>85725</xdr:colOff>' +
        '<xdr:row>0</xdr:row><xdr:rowOff>28575</xdr:rowOff></xdr:from>' +
        '<xdr:ext cx="1132495" cy="607843"/>' +
        '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Picture 2"/>' +
        '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
        '<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/>' +
        '<a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
        '<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>' +
        '<xdr:clientData/>' +
      '</xdr:oneCellAnchor></xdr:wsDr>';
  }

  /* ---------------- options dialog ---------------- */

  function askOptions(cb) {
    const wrap = document.createElement('div');
    wrap.className = 'pt-overlay';
    const opts = ['all', 'acid', 'flux', 'rinse'].map(k =>
      '<option value="' + k + '">' + t('rep.scope.' + k) + '</option>').join('');
    wrap.innerHTML =
      '<div class="pt-modal">' +
        '<div class="pt-modal-head"><h3>' + t('rep.opt.title') + '</h3>' +
        '<button class="pt-x" data-close aria-label="close">&times;</button></div>' +
        '<div class="pt-modal-body"><div class="pt-form">' +
          '<div class="pt-field full"><label>' + t('rep.opt.scope') + '</label>' +
            '<select id="rep-scope">' + opts + '</select></div>' +
          '<label class="fx-check"><input type="checkbox" id="rep-events" checked> ' +
            t('rep.opt.events', { n: EVENT_DAYS }) + '</label>' +
        '</div></div>' +
        '<div class="pt-modal-foot">' +
          '<button class="btn" id="rep-go">' + t('rep.opt.go') + '</button>' +
          '<button class="btn ghost" data-close>' + t('pt.cancel') + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    wrap.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
    wrap.querySelector('#rep-go').addEventListener('click', function () {
      const scope = wrap.querySelector('#rep-scope').value;
      const withEvents = wrap.querySelector('#rep-events').checked;
      close();
      cb({ scope: scope, events: withEvents });
    });
  }

  /* ---------------- export ---------------- */

  async function build(opts) {
    const msg = document.getElementById('rep-msg');
    const btn = document.getElementById('rep-export');
    const say = (s, bad) => { if (msg) { msg.textContent = s; msg.style.color = bad ? 'var(--crit)' : 'var(--accent)'; } };

    if (typeof DecompressionStream === 'undefined' || !window.KGC_REPORT_TEMPLATE_B64) {
      say(t('rep.unsupported'), true); return;
    }
    if (btn) btn.disabled = true;
    say(t('rep.working'));

    try {
      const ids = SCOPES[opts.scope] || SCOPES.all;
      const rows = collectRows(ids);
      if (!rows.length) { say(t('rep.noTanks'), true); if (btn) btn.disabled = false; return; }
      const cols = columnsFor(ids);
      const events = opts.events ? collectEvents(ids) : [];

      const bin = atob(window.KGC_REPORT_TEMPLATE_B64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const entries = await unzipAll(bytes.buffer);

      const now = new Date();
      const xml = buildSheet(rows, cols, events, now, te('rep.preparerName'));
      const draw = buildDrawing(2 + cols.length + 1);
      const enc = new TextEncoder();
      entries.forEach(function (e) {
        if (e.name === SHEET) e.data = enc.encode(xml);
        if (e.name === DRAWING) e.data = enc.encode(draw);
      });

      const blob = zip(entries);
      const stamp = dayKey(now);
      const tag = opts.scope === 'all' ? '' : '_' + opts.scope;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'KGC_Bath_Status_Report' + tag + '_' + stamp + '.xlsx';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      say(t('rep.done', { n: rows.length }) + (events.length ? ' ' + t('rep.withEvents', { n: events.length }) : ''));
    } catch (e) {
      console.error('[report] export failed', e);
      say(t('rep.failed') + ' ' + (e.message || ''), true);
    }
    if (btn) btn.disabled = false;
  }

  function exportReport() { askOptions(build); }

  /* ---------------- wiring ---------------- */

  database.ref('renewals').on('value', s => { renewals = s.val() || {}; });
  database.ref('flux_treatments').on('value', s => { treatments = s.val() || {}; });
  database.ref('peroxide_treatments').on('value', s => { peroxTreatments = s.val() || {}; });

  function wire() {
    const b = document.getElementById('rep-export');
    if (!b || b.dataset.wired) return;
    b.dataset.wired = '1';
    b.addEventListener('click', exportReport);
  }
  document.addEventListener('DOMContentLoaded', wire);
  if (window.I18N) I18N.onChange(function () {
    const b = document.getElementById('rep-export');
    if (b) b.textContent = t('rep.button');
  });

  window.KGCReport = {
    export: exportReport,
    _build: build,
    _rows: collectRows,
    _cols: columnsFor,
    _events: collectEvents,
    _scopes: SCOPES
  };
})();
