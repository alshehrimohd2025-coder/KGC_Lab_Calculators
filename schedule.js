/* ============================================================
   Bath replacement schedule — import of "Acid tank Schedules.xlsx"
   ------------------------------------------------------------
   The plant keeps its replacement history in a sheet per year: one row
   per tank, one column per month, and each cell reading "DD/Supplier".
   This reads that sheet in the browser and writes the events into the
   same `renewals` log the bath-health page already uses, so the tank
   cards can say when a bath was last changed and how old it is.

   Rows are matched by the sheet's own tank names, and months by the
   date in the header row, so adding a year or shifting a column does
   not break the import. Each event gets a deterministic key built from
   tank and date, which makes re-importing the same file safe — it
   overwrites rather than duplicating.

   Depends on globals from index.html: database, IS_EDITOR, IS_AUTHED, t()
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[schedule] Firebase database is not available.');
    return;
  }

  /* The sheet's names mapped onto this site's tank ids.
     "Acid 5" is the old Rinsing 1 position, now run as a reserve acid
     tank — both rows therefore describe tank 8 in its two roles. */
  const TANK_MAP = [
    { re: /^acid\s*1$/i,            id: 3,  type: 'renewal' },
    { re: /^acid\s*2$/i,            id: 4,  type: 'renewal' },
    { re: /^acid\s*3$/i,            id: 5,  type: 'renewal' },
    { re: /^acid\s*4$/i,            id: 6,  type: 'renewal' },
    { re: /^acid\s*5$/i,            id: 8,  type: 'renewal' },
    { re: /^strep?ing\s*acid$/i,    id: 7,  type: 'renewal' },
    { re: /^stripping\s*acid$/i,    id: 7,  type: 'renewal' },
    { re: /^rinsing\s*1/i,          id: 8,  type: 'renewal', note: 'as Rinsing 1' },
    { re: /^rinsing\s*2/i,          id: 9,  type: 'renewal' },
    { re: /^flux$/i,                id: 10, type: 'cleaning' }
  ];

  // Acid baths are always made up to the same charge.
  const ACID_TANKS = [3, 4, 5, 6, 7, 8];
  const ACID_QTY = 25, ACID_UNIT = 't';

  const pad = n => (n < 10 ? '0' : '') + n;

  /* ---------------- xlsx reading ---------------- */

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
  }

  async function unzip(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= 0 && i > u8.length - 65558; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = {};
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
      if (name.endsWith('.xml')) out[name] = method === 0 ? raw.slice() : await inflateRaw(raw);
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }

  const colOf = ref => (ref.match(/^[A-Z]+/) || [''])[0];
  const rowOf = ref => parseInt(ref.replace(/^[A-Z]+/, ''), 10);

  /** Every worksheet in the book, as {name, grid}. */
  async function readSheets(file) {
    const parts = await unzip(await file.arrayBuffer());
    const dec = new TextDecoder();
    const dp = new DOMParser();

    const shared = [];
    if (parts['xl/sharedStrings.xml']) {
      const sx = dp.parseFromString(dec.decode(parts['xl/sharedStrings.xml']), 'application/xml');
      sx.querySelectorAll('si').forEach(si => {
        shared.push(Array.from(si.querySelectorAll('t')).map(t => t.textContent).join(''));
      });
    }

    return Object.keys(parts)
      .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort()
      .map(function (path) {
        const sx = dp.parseFromString(dec.decode(parts[path]), 'application/xml');
        const grid = {};
        sx.querySelectorAll('c').forEach(function (c) {
          const ref = c.getAttribute('r'); if (!ref) return;
          const type = c.getAttribute('t');
          let val = null;
          const is = c.querySelector('is'), v = c.querySelector('v');
          if (is) val = Array.from(is.querySelectorAll('t')).map(t => t.textContent).join('');
          else if (v) val = type === 's' ? shared[parseInt(v.textContent, 10)] : v.textContent;
          if (val == null) return;
          (grid[rowOf(ref)] = grid[rowOf(ref)] || {})[colOf(ref)] = val;
        });
        return { path: path, grid: grid };
      });
  }

  /* ---------------- interpretation ---------------- */

  /** Excel serial -> {year, month}; the header row carries the 1st of each month. */
  function monthOf(serial) {
    const n = Number(serial);
    if (!isFinite(n) || n < 30000 || n > 60000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
  }

  /** Find the header row and the month each column stands for. */
  function monthColumns(grid) {
    for (let r = 1; r <= 6; r++) {
      const row = grid[r]; if (!row) continue;
      const map = {};
      Object.keys(row).forEach(function (col) {
        const mo = monthOf(row[col]);
        if (mo) map[col] = mo;
      });
      if (Object.keys(map).length >= 3) return { row: r, months: map };
    }
    return null;
  }

  function parse(sheets) {
    const events = [];
    const skipped = [];

    sheets.forEach(function (sheet) {
      const found = monthColumns(sheet.grid);
      if (!found) return;
      const rows = Object.keys(sheet.grid).map(Number).sort((a, b) => a - b);

      rows.forEach(function (rn) {
        if (rn <= found.row) return;
        const row = sheet.grid[rn];
        const name = (row.B || '').trim();
        if (!name) return;
        const hit = TANK_MAP.find(m => m.re.test(name));
        if (!hit) return;

        Object.keys(found.months).forEach(function (col) {
          const cell = (row[col] || '').trim();
          if (!cell) return;
          const mo = found.months[col];
          // cells read "DD" or "DD/Supplier"
          const m = cell.match(/^\s*(\d{1,2})\s*(?:\/\s*(.*))?$/);
          if (!m) { skipped.push({ name: name, cell: cell, month: mo.y + '-' + pad(mo.m) }); return; }
          const day = parseInt(m[1], 10);
          const supplier = (m[2] || '').trim();
          const d = new Date(mo.y, mo.m - 1, day);
          if (d.getDate() !== day || d.getMonth() !== mo.m - 1) {
            skipped.push({ name: name, cell: cell, month: mo.y + '-' + pad(mo.m) }); return;
          }
          const date = mo.y + '-' + pad(mo.m) + '-' + pad(day);
          const isAcid = ACID_TANKS.indexOf(hit.id) !== -1 && hit.type === 'renewal' && !hit.note;
          const notes = [];
          if (supplier) notes.push(supplier);
          if (hit.note) notes.push(hit.note);
          events.push({
            key: 'sched_' + hit.id + '_' + date,
            tankId: hit.id,
            date: date,
            ts: d.getTime(),
            type: hit.type,
            qty: isAcid ? ACID_QTY : 0,
            unit: isAcid ? ACID_UNIT : '',
            source: 'schedule',
            note: notes.join(' · ')
          });
        });
      });
    });

    // one event per tank per day; a later sheet wins
    const byKey = {};
    events.forEach(e => { byKey[e.key] = e; });
    return { events: Object.values(byKey), skipped: skipped };
  }

  /* ---------------- import ---------------- */

  async function handleFile(file) {
    const status = document.getElementById('sched-status');
    const say = (m, bad) => { if (status) { status.textContent = m; status.style.color = bad ? 'var(--crit)' : 'var(--accent)'; } };

    if (!IS_EDITOR || !IS_AUTHED) { say(t('sched.needAuth'), true); return; }
    if (typeof DecompressionStream === 'undefined') { say(t('sched.noSupport'), true); return; }

    say(t('sched.reading'));
    try {
      const sheets = await readSheets(file);
      const parsed = parse(sheets);
      if (!parsed.events.length) { say(t('sched.noRows'), true); return; }

      const updates = {};
      parsed.events.forEach(function (e) {
        updates['renewals/' + e.key] = {
          tankId: e.tankId, date: e.date, ts: e.ts, type: e.type,
          qty: e.qty, unit: e.unit, note: e.note, source: e.source
        };
      });
      await database.ref().update(updates);
      say(t('sched.imported', { n: parsed.events.length }) +
          (parsed.skipped.length ? ' ' + t('sched.skipped', { n: parsed.skipped.length }) : ''));
      if (parsed.skipped.length) console.info('[schedule] skipped cells', parsed.skipped);
    } catch (e) {
      console.error('[schedule] import failed', e);
      say(t('sched.failed') + ' ' + (e.message || ''), true);
    }
  }

  function wire() {
    const inp = document.getElementById('sched-file');
    if (!inp || inp.dataset.wired) return;
    inp.dataset.wired = '1';
    inp.addEventListener('change', function () {
      if (inp.files && inp.files[0]) handleFile(inp.files[0]);
      inp.value = '';
    });
  }
  document.addEventListener('DOMContentLoaded', wire);

  window.KGCSchedule = { _parse: parse, _readSheets: readSheets, _map: TANK_MAP };
})();
