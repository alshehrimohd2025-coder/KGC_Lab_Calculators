/* ============================================================
   Zinc efficiency & production — KGC
   ------------------------------------------------------------
   Reads the plant's own monthly "Daily production Report" .xlsx
   in the browser and tracks zinc consumption against the limit
   written in that same sheet (B35: "Less Than 4% Or More Than 9%").

   The xlsx is unzipped with the browser's native DecompressionStream
   and parsed with DOMParser — no external library, matching the
   dependency-free approach used everywhere else in this project.

   Parsing is keyed on the Description column text, not on fixed row
   numbers, so inserting a row in the template doesn't break it.

   Depends on globals from index.html:
     database, IS_EDITOR, IS_AUTHED, I18N / t()
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[zinc] Firebase database is not available.');
    return;
  }

  // The plant's own control band, taken from the report sheet itself.
  const PCT_MIN = 4, PCT_MAX = 9;

  let days = {};   // 'YYYY-MM-DD' -> {dayTon, nightTon, totalTon, dayPct, nightPct, totalPct, ...}

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pad = n => (n < 10 ? '0' : '') + n;
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };

  /* ---------------- xlsx reading (no library) ---------------- */

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Minimal ZIP central-directory reader — enough for xlsx parts. */
  async function unzip(buf) {
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    // locate End Of Central Directory
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

      // local header tells us where the data actually starts
      const lNameLen = dv.getUint16(lho + 26, true);
      const lExtraLen = dv.getUint16(lho + 28, true);
      const dataStart = lho + 30 + lNameLen + lExtraLen;
      const raw = u8.subarray(dataStart, dataStart + compSize);

      if (name.endsWith('.xml')) {
        out[name] = method === 0 ? raw : await inflateRaw(raw);
      }
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }

  const colOf = ref => (ref.match(/^[A-Z]+/) || [''])[0];
  const rowOf = ref => parseInt(ref.replace(/^[A-Z]+/, ''), 10);

  /** Parse the workbook into {sheetName, grid: {row: {col: value}}}. */
  async function readWorkbook(file) {
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

    const sheetPath = Object.keys(parts).find(n => /^xl\/worksheets\/sheet1\.xml$/.test(n));
    if (!sheetPath) throw new Error('no sheet');
    const sx = dp.parseFromString(dec.decode(parts[sheetPath]), 'application/xml');

    const grid = {};
    sx.querySelectorAll('c').forEach(c => {
      const ref = c.getAttribute('r'); if (!ref) return;
      const type = c.getAttribute('t');
      let val = null;
      const is = c.querySelector('is');
      const v = c.querySelector('v');
      if (is) val = Array.from(is.querySelectorAll('t')).map(t => t.textContent).join('');
      else if (v) val = type === 's' ? shared[parseInt(v.textContent, 10)] : v.textContent;
      if (val == null) return;
      const r = rowOf(ref);
      (grid[r] = grid[r] || {})[colOf(ref)] = val;
    });
    return grid;
  }

  /* ---------------- report interpretation ---------------- */

  const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

  /** "Daily production Report KGC- SEP 2026" -> {year, month} */
  function periodFrom(grid) {
    const title = (grid[1] && grid[1].A) || '';
    const m = title.match(/([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/);
    if (!m) return null;
    const mon = MONTHS[m[1].toLowerCase()];
    return mon ? { year: parseInt(m[2], 10), month: mon } : null;
  }

  /** Column letter -> day number, read from the day-number header row. */
  function dayColumns(grid) {
    for (let r = 1; r <= 8; r++) {
      const row = grid[r]; if (!row) continue;
      const map = {};
      Object.keys(row).forEach(col => {
        const n = Number(row[col]);
        if (col !== 'A' && col !== 'B' && Number.isInteger(n) && n >= 1 && n <= 31) map[col] = n;
      });
      if (Object.keys(map).length >= 20) return map;   // a real day header, not a stray number row
    }
    return null;
  }

  /* Rows are found by their Description text so the template can gain or
     lose rows without breaking the import. */
  const WANTED = [
    { key: 'jigs',    re: /^jigs$/i },
    { key: 'ton',     re: /^tonnage$/i },
    { key: 'consCM',  re: /^consumption\s*cm$/i },
    { key: 'consPct', re: /^consumption\s*%$/i },
    { key: 'dross',   re: /^drossing$/i },
    { key: 'release', re: /^zinc\s*release$/i },
    { key: 'totTon',  re: /^total\s*ton$/i }
  ];

  /** Walk rows top-down, tracking which block (day/night/total) we're inside. */
  function extract(grid, dayCols) {
    const rows = Object.keys(grid).map(Number).sort((a, b) => a - b);
    let block = null;
    const found = {};   // block -> key -> {col: value}

    rows.forEach(r => {
      const row = grid[r];
      const b = (row.B || '').trim();
      if (/day\s*production/i.test(b)) { block = 'day'; return; }
      if (/night\s*production/i.test(b)) { block = 'night'; return; }
      if (/^total$/i.test(b)) { block = 'total'; return; }
      if (!block || !b) return;
      const hit = WANTED.find(w => w.re.test(b));
      if (!hit) return;
      (found[block] = found[block] || {})[hit.key] = row;
    });
    return found;
  }

  function buildDays(grid) {
    const period = periodFrom(grid);
    const dayCols = dayColumns(grid);
    if (!period || !dayCols) return null;
    const found = extract(grid, dayCols);

    const out = {};
    Object.keys(dayCols).forEach(col => {
      const dnum = dayCols[col];
      const date = period.year + '-' + pad(period.month) + '-' + pad(dnum);

      const get = (block, key) => {
        const row = found[block] && found[block][key];
        return row && row[col] != null ? num(row[col]) : 0;
      };

      const rec = {
        date: date,
        dayTon: get('day', 'ton'),
        nightTon: get('night', 'ton'),
        dayJigs: get('day', 'jigs'),
        nightJigs: get('night', 'jigs'),
        dayCM: get('day', 'consCM'),
        nightCM: get('night', 'consCM'),
        totalCM: get('total', 'consCM'),
        dross: get('total', 'dross'),
        release: get('total', 'release')
      };
      rec.totalTon = get('total', 'totTon') || (rec.dayTon + rec.nightTon);

      // Percentages in the sheet are stored as fractions (0.0734 = 7.34%)
      const pct = v => v > 0 && v < 1 ? v * 100 : v;
      rec.dayPct = pct(get('day', 'consPct'));
      rec.nightPct = pct(get('night', 'consPct'));
      rec.totalPct = pct(get('total', 'consPct'));

      // Only keep days that actually have production — the template ships
      // pre-filled with zeros for the whole month.
      if (rec.totalTon > 0 || rec.dayTon > 0 || rec.nightTon > 0) out[date] = rec;
    });
    return { period: period, days: out };
  }

  /* ---------------- import flow ---------------- */

  async function handleFile(file) {
    const status = document.getElementById('zn-status');
    const say = (msg, bad) => { if (status) { status.textContent = msg; status.style.color = bad ? 'var(--crit)' : 'var(--accent)'; } };

    if (!IS_EDITOR || !IS_AUTHED) { say(t('zn.needAuth'), true); return; }
    if (typeof DecompressionStream === 'undefined') { say(t('zn.noSupport'), true); return; }

    say(t('zn.reading'));
    try {
      const grid = await readWorkbook(file);
      const parsed = buildDays(grid);
      if (!parsed) { say(t('zn.badFormat'), true); return; }
      const keys = Object.keys(parsed.days);
      if (!keys.length) { say(t('zn.noRows'), true); return; }

      const updates = {};
      keys.forEach(d => { updates['zinc_daily/' + d] = parsed.days[d]; });
      await database.ref().update(updates);
      say(t('zn.imported', { n: keys.length }));
    } catch (e) {
      console.error('[zinc] import failed', e);
      say(t('zn.failed') + ' ' + (e.message || ''), true);
    }
  }

  /* ---------------- rendering ---------------- */

  function tier(pct) {
    if (!pct) return null;
    if (pct < PCT_MIN) return 'low';
    if (pct > PCT_MAX) return 'high';
    return 'ok';
  }
  const TIER_VAR = { ok: '--accent', low: '--warn', high: '--crit' };

  function pill(pct) {
    const tr = tier(pct);
    if (!tr) return '<span class="zn-pill" style="color:var(--ink-3);border-color:var(--line);background:var(--recess)">—</span>';
    const v = 'var(' + TIER_VAR[tr] + ')';
    return '<span class="zn-pill" style="color:' + v + ';border-color:' + v + '66;background:' + v + '1a">' +
      pct.toFixed(2) + '% · ' + esc(t('zn.tier.' + tr)) + '</span>';
  }

  function sorted() {
    return Object.values(days).filter(d => d && d.date).sort((a, b) => a.date < b.date ? -1 : 1);
  }

  function chart(list) {
    if (list.length < 2) return '';
    const W = 640, H = 170, PL = 38, PR = 12, PT = 12, PB = 24;
    const iw = W - PL - PR, ih = H - PT - PB;
    const maxP = Math.max(12, ...list.map(d => d.totalPct || 0));
    const X = i => PL + (list.length === 1 ? iw / 2 : i / (list.length - 1) * iw);
    const Y = v => PT + ih - (v / maxP) * ih;

    let grid = '';
    for (let v = 0; v <= maxP; v += 2) {
      grid += '<line class="grid" x1="' + PL + '" y1="' + Y(v).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Y(v).toFixed(1) + '"/>' +
              '<text class="axis-label" x="' + (PL - 6) + '" y="' + (Y(v) + 3).toFixed(1) + '" text-anchor="end">' + v + '</text>';
    }
    // the acceptable 4-9% band from the plant's own sheet
    const band = '<rect x="' + PL + '" y="' + Y(PCT_MAX).toFixed(1) + '" width="' + iw +
      '" height="' + Math.max(0, Y(PCT_MIN) - Y(PCT_MAX)).toFixed(1) + '" fill="var(--accent)" opacity=".08"/>' +
      '<line class="limit-line" stroke="var(--crit)" x1="' + PL + '" y1="' + Y(PCT_MAX).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Y(PCT_MAX).toFixed(1) + '"/>' +
      '<line class="limit-line" stroke="var(--warn)" x1="' + PL + '" y1="' + Y(PCT_MIN).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Y(PCT_MIN).toFixed(1) + '"/>';

    const path = list.map((d, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(d.totalPct || 0).toFixed(1)).join(' ');
    const dots = list.map((d, i) => {
      const tr = tier(d.totalPct);
      const col = tr ? 'var(' + TIER_VAR[tr] + ')' : 'var(--ink-3)';
      return '<circle r="3.2" cx="' + X(i).toFixed(1) + '" cy="' + Y(d.totalPct || 0).toFixed(1) + '" fill="var(--surface)" stroke="' + col + '" stroke-width="2"/>';
    }).join('');

    const axis = '<text class="axis-label" x="' + PL + '" y="' + (H - 7) + '" text-anchor="start">' + list[0].date.slice(5) + '</text>' +
                 '<text class="axis-label" x="' + (W - PR) + '" y="' + (H - 7) + '" text-anchor="end">' + list[list.length - 1].date.slice(5) + '</text>';

    return '<svg class="lab-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" preserveAspectRatio="xMidYMid meet">' +
      grid + band + '<path class="series" d="' + path + '"/>' + dots + axis + '</svg>';
  }

  function render() {
    const mount = document.getElementById('zn-body');
    if (!mount) return;
    const list = sorted();

    if (!list.length) {
      mount.innerHTML = '<div class="lab-empty">' + esc(t('zn.empty')) + '</div>';
      return;
    }

    const totTon = list.reduce((s, d) => s + (d.totalTon || 0), 0);
    const totCM = list.reduce((s, d) => s + (d.totalCM || 0), 0);
    const avgPct = list.filter(d => d.totalPct > 0);
    const mean = avgPct.length ? avgPct.reduce((s, d) => s + d.totalPct, 0) / avgPct.length : 0;
    const outside = avgPct.filter(d => tier(d.totalPct) !== 'ok').length;

    const stat = (k, v, unit, hot) =>
      '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span>' +
      '<span class="v">' + v + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</span></div>';

    const rows = list.slice().reverse().map(d =>
      '<tr>' +
        '<td class="num">' + esc(d.date) + '</td>' +
        '<td class="num">' + (d.dayTon || 0).toLocaleString() + '</td>' +
        '<td class="num">' + (d.nightTon || 0).toLocaleString() + '</td>' +
        '<td class="num">' + (d.totalTon || 0).toLocaleString() + '</td>' +
        '<td>' + pill(d.dayPct) + '</td>' +
        '<td>' + pill(d.nightPct) + '</td>' +
        '<td>' + pill(d.totalPct) + '</td>' +
      '</tr>').join('');

    mount.innerHTML =
      '<div class="pt-stats">' +
        stat(t('zn.days'), list.length) +
        stat(t('zn.totalTon'), Math.round(totTon).toLocaleString()) +
        stat(t('zn.totalCM'), totCM.toFixed(2)) +
        stat(t('zn.avgPct'), mean.toFixed(2), '%', tier(mean) !== 'ok') +
        stat(t('zn.outside'), outside, '', outside > 0) +
      '</div>' +
      (list.length >= 2 ? '<div class="lab-chart-card"><div class="lab-chart-head">' +
        '<span class="lab-chart-title">' + esc(t('zn.chartTitle')) + '</span>' +
        '<span class="lab-chart-meta">' + PCT_MIN + '% – ' + PCT_MAX + '%</span>' +
        '</div>' + chart(list) + '</div>' : '') +
      '<div class="tablewrap"><table><thead><tr>' +
        '<th>' + esc(t('zn.col.date')) + '</th>' +
        '<th>' + esc(t('zn.col.dayTon')) + '</th>' +
        '<th>' + esc(t('zn.col.nightTon')) + '</th>' +
        '<th>' + esc(t('zn.col.totalTon')) + '</th>' +
        '<th>' + esc(t('zn.col.dayPct')) + '</th>' +
        '<th>' + esc(t('zn.col.nightPct')) + '</th>' +
        '<th>' + esc(t('zn.col.totalPct')) + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  /* ---------------- wiring ---------------- */

  function wire() {
    const inp = document.getElementById('zn-file');
    if (!inp || inp.dataset.wired) return;
    inp.dataset.wired = '1';
    inp.addEventListener('change', function () {
      if (inp.files && inp.files[0]) handleFile(inp.files[0]);
      inp.value = '';
    });
  }

  database.ref('zinc_daily').on('value', s => { days = s.val() || {}; render(); });
  if (window.I18N) I18N.onChange(render);
  document.addEventListener('DOMContentLoaded', function () { wire(); render(); });

  window.KGCZinc = { _days: () => days, render: render, _buildDays: buildDays, _readWorkbook: readWorkbook };
})();
