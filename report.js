/* ============================================================
   "Export report" — produces the plant's own Acid Bath Status Report,
   filled with the tanks' actual readings.
   ------------------------------------------------------------
   The workbook that comes out is the lab's real template (report_template.js)
   with one part swapped: the worksheet. Everything that gives the file its
   identity — styles, column widths, page setup, the KSC logo and its drawing
   relationships — is carried over untouched, so the result opens as the same
   document the lab already circulates, only with today's numbers in it.

   The template ships with four acid-tank rows; this writes the ten process
   tanks (1-10), leaving out drying and zinc, which carry no bath readings.

   Zip entries are written STORED rather than deflated: Excel accepts them and
   it keeps the writer to a CRC32, with no compression stream involved.

   Depends on globals from index.html: tanks, tankLabel(), t(), KGCSpecs
   ============================================================ */
(function () {
  'use strict';

  const TANK_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];   // process baths only
  const SHEET = 'xl/worksheets/sheet1.xml';

  /* The template is an English document that goes to management, so its
     contents are written in English no matter which language the operator has
     the site set to. */
  const te = (k, v) => (window.I18N && I18N.tIn) ? I18N.tIn('en', k, v) : t(k, v);
  const tankNameEn = name => te('tank.' + name) === 'tank.' + name ? name : te('tank.' + name);

  const xe = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  /* ---------------- zip reading ---------------- */

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
  }

  /** Read every entry of the zip, keeping the raw bytes. */
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

  /* ---------------- zip writing (stored) ---------------- */

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
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
      lh.setUint16(4, 20, true);            // version needed
      lh.setUint16(6, 0x0800, true);        // UTF-8 names
      lh.setUint16(8, 0, true);             // stored
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);
      lh.setUint32(22, size, true);
      lh.setUint16(26, nameBytes.length, true);
      chunks.push(new Uint8Array(lh.buffer), nameBytes, e.data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true);
      ch.setUint32(24, size, true);
      ch.setUint16(28, nameBytes.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nameBytes);

      offset += 30 + nameBytes.length + size;
    });

    let cSize = 0;
    central.forEach(c => { cSize += c.length; });
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, cSize, true);
    eocd.setUint32(16, offset, true);

    return new Blob(chunks.concat(central, [new Uint8Array(eocd.buffer)]),
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  /* ---------------- report content ---------------- */

  /** Readings of one tank, compacted into the single cell the sheet allows. */
  function readingsText(tank) {
    const SP = window.KGCSpecs;
    if (!SP || !SP.hasSpec(tank.id)) return '-';
    const parts = SP.paramsFor(tank.id).map(function (p) {
      const v = tank[p.key];
      if (v === undefined || v === null || v === '' || Number(v) === 0) return null;
      const n = Math.round(Number(v) * 100) / 100;
      return te('f.' + p.key) + ' ' + n + (p.unit ? ' ' + p.unit : '');
    }).filter(Boolean);
    return parts.length ? parts.join('  ·  ') : '-';
  }

  /** Status in the report's own vocabulary, taken from the spec engine. */
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

  const serialDate = d => Math.floor((d - new Date(Date.UTC(1899, 11, 30))) / 86400000);

  function summaryText(rows) {
    const crit = rows.filter(r => r.tier === 'crit').length;
    const warn = rows.filter(r => r.tier === 'warn').length;
    const ok = rows.filter(r => r.tier === 'good').length;
    return te('rep.summary', { ok: ok, warn: warn, crit: crit, n: rows.length });
  }

  /* ---------------- worksheet ---------------- */

  function cell(ref, style, text) {
    if (text === null || text === undefined || text === '')
      return '<c r="' + ref + '" s="' + style + '"/>';
    return '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' +
      xe(text) + '</t></is></c>';
  }

  function buildSheet(rows, dateObj, preparedBy) {
    const FIRST = 6;
    const last = FIRST + rows.length - 1;      // 10 tanks -> rows 6..15
    const shift = rows.length - 4;             // template ships with 4 rows

    let body = '';
    // title, date and section headings keep the template's own styles
    body += '<row r="1" spans="1:7"><c r="A1" s="17" t="inlineStr"><is><t>' + xe(te('rep.title')) +
            '</t></is></c><c r="B1" s="14"/><c r="C1" s="14"/><c r="D1" s="14"/><c r="E1" s="14"/><c r="F1" s="14"/></row>';
    body += '<row r="2" spans="1:7"><c r="A2" s="14"/><c r="B2" s="14"/><c r="C2" s="14"/><c r="D2" s="14"/><c r="E2" s="14"/><c r="F2" s="14"/></row>';
    body += '<row r="3" spans="1:7">' + cell('A3', 13, te('rep.date')) +
            '<c r="B3" s="14"/><c r="C3" s="9"><v>' + serialDate(dateObj) + '</v></c>' +
            '<c r="D3" s="10"/><c r="E3" s="10"/><c r="F3" s="10"/></row>';
    body += '<row r="4" spans="1:7" ht="37.75" customHeight="1" thickBot="1">' + cell('A4', 20, te('rep.results')) +
            '<c r="B4" s="21"/><c r="C4" s="21"/><c r="D4" s="21"/><c r="E4" s="21"/><c r="F4" s="21"/></row>';
    body += '<row r="5" spans="1:7">' + cell('A5', 3, te('rep.col.tank')) + cell('B5', 22, te('rep.col.name')) +
            '<c r="C5" s="23"/>' + cell('D5', 34, te('rep.col.readings')) + '<c r="E5" s="34"/>' +
            cell('F5', 4, te('rep.col.status')) + '</row>';

    rows.forEach(function (r, i) {
      const n = FIRST + i, isLast = n === last;
      body += '<row r="' + n + '" spans="1:7" ht="38" customHeight="1"' + (isLast ? ' thickBot="1"' : '') + '>' +
        cell('A' + n, 8, r.no) +
        cell('B' + n, isLast ? 30 : 11, r.name) +
        '<c r="C' + n + '" s="' + (isLast ? 31 : 12) + '"/>' +
        cell('D' + n, 15, r.readings) +
        '<c r="E' + n + '" s="16"/>' +
        cell('F' + n, 6, r.status) +
        '</row>';
    });

    // everything below the table keeps its layout, just moved down
    const R = n => n + shift;
    body += '<row r="' + R(11) + '" spans="1:7">' + cell('A' + R(11), 32, te('rep.summaryHead')) +
            ['B', 'C', 'D', 'E', 'F'].map(c => '<c r="' + c + R(11) + '" s="33"/>').join('') + '</row>';
    body += '<row r="' + R(12) + '" spans="1:7">' + cell('A' + R(12), 28, summaryText(rows)) +
            ['B', 'C', 'D', 'E', 'F'].map(c => '<c r="' + c + R(12) + '" s="29"/>').join('') + '</row>';
    [13, 14].forEach(function (n) {
      body += '<row r="' + R(n) + '" spans="1:7">' +
        ['A', 'B', 'C', 'D', 'E', 'F'].map(c => '<c r="' + c + R(n) + '" s="29"/>').join('') + '</row>';
    });
    body += '<row r="' + R(15) + '" spans="1:7">' + cell('A' + R(15), 1, te('rep.preparedBy')) +
            '<c r="B' + R(15) + '" s="2"/><c r="C' + R(15) + '" s="2"/>' +
            ['D', 'E', 'F'].map(c => '<c r="' + c + R(15) + '" s="18"/>').join('') + '</row>';
    body += '<row r="' + R(16) + '" spans="1:7">' + cell('A' + R(16), 26, preparedBy) +
            '<c r="B' + R(16) + '" s="27"/><c r="C' + R(16) + '" s="27"/>' +
            ['D', 'E', 'F'].map(c => '<c r="' + c + R(16) + '" s="19"/>').join('') + '</row>';
    body += '<row r="' + R(17) + '" spans="1:6">' +
            ['A', 'B', 'C'].map(c => '<c r="' + c + R(17) + '" s="27"/>').join('') +
            ['D', 'E', 'F'].map(c => '<c r="' + c + R(17) + '" s="19"/>').join('') + '</row>';
    body += '<row r="' + R(18) + '" spans="1:6">' +
            ['A', 'B', 'C'].map(c => '<c r="' + c + R(18) + '" s="27"/>').join('') + '</row>';

    const merges = ['A1:F2', 'A3:B3', 'C3:F3', 'A4:F4', 'B5:C5', 'D5:E5'];
    for (let n = FIRST; n <= last; n++) { merges.push('B' + n + ':C' + n); merges.push('D' + n + ':E' + n); }
    merges.push('A' + R(11) + ':F' + R(11));
    merges.push('A' + R(12) + ':F' + R(14));
    merges.push('D' + R(15) + ':F' + R(17));
    merges.push('A' + R(16) + ':C' + R(18));

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
      '<dimension ref="A1:G' + R(18) + '"/>' +
      '<sheetViews><sheetView showGridLines="0" tabSelected="1" workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr baseColWidth="10" defaultColWidth="8.83203125" defaultRowHeight="15"/>' +
      '<cols><col min="1" max="1" width="12.5" customWidth="1"/>' +
      '<col min="2" max="2" width="12.83203125" customWidth="1"/>' +
      '<col min="3" max="3" width="10.5" customWidth="1"/>' +
      '<col min="4" max="5" width="18" customWidth="1"/>' +
      '<col min="6" max="6" width="28.1640625" customWidth="1"/></cols>' +
      '<sheetData>' + body + '</sheetData>' +
      '<mergeCells count="' + merges.length + '">' +
      merges.map(m => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>' +
      '<pageMargins left="0.3" right="0.3" top="0.35" bottom="0.35" header="0.5" footer="0.5"/>' +
      '<pageSetup paperSize="9" scale="97" orientation="portrait" r:id="rId1"/>' +
      '<drawing r:id="rId2"/></worksheet>';
  }

  /* ---------------- export ---------------- */

  function collectRows() {
    const SP = window.KGCSpecs;
    return TANK_IDS.map(function (id) {
      const tk = (typeof tanks !== 'undefined' ? tanks : []).find(x => x.id === id);
      if (!tk) return null;
      const st = SP && SP.hasSpec(id) ? SP.tankStatus(tk) : null;
      return {
        no: te('rep.tankNo', { n: id }),
        name: tankNameEn(tk.name),
        readings: readingsText(tk),
        status: statusText(tk),
        tier: st ? st.tier : 'none'
      };
    }).filter(Boolean);
  }

  async function exportReport() {
    const btn = document.getElementById('rep-export');
    const msg = document.getElementById('rep-msg');
    const say = (s, bad) => { if (msg) { msg.textContent = s; msg.style.color = bad ? 'var(--crit)' : 'var(--accent)'; } };

    if (typeof DecompressionStream === 'undefined' || !window.KGC_REPORT_TEMPLATE_B64) {
      say(t('rep.unsupported'), true); return;
    }
    if (btn) btn.disabled = true;
    say(t('rep.working'));

    try {
      const bin = atob(window.KGC_REPORT_TEMPLATE_B64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      const entries = await unzipAll(bytes.buffer);
      const rows = collectRows();
      if (!rows.length) { say(t('rep.noTanks'), true); if (btn) btn.disabled = false; return; }

      const now = new Date();
      const xml = buildSheet(rows, now, te('rep.preparerName'));
      const enc = new TextEncoder();
      entries.forEach(function (e) { if (e.name === SHEET) e.data = enc.encode(xml); });

      const blob = zip(entries);
      const pad = n => (n < 10 ? '0' : '') + n;
      const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'KGC_Bath_Status_Report_' + stamp + '.xlsx';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      say(t('rep.done', { n: rows.length }));
    } catch (e) {
      console.error('[report] export failed', e);
      say(t('rep.failed') + ' ' + (e.message || ''), true);
    }
    if (btn) btn.disabled = false;
  }

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

  window.KGCReport = { export: exportReport, _rows: collectRows, _sheet: buildSheet };
})();
