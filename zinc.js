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

  /* The report's "Tonnage" rows are kilograms despite the name: a month
     reading 1.8 million cannot be tonnes, the zinc added divides into it at
     the consumption percentage the same sheet reports, and it puts a jig at
     about a tonne. The stored records keep the sheet's own numbers, so old
     and new imports stay consistent; the conversion happens here, on the way
     to the screen. Output per jig stays in kg, which is what a jig load is. */
  const KG_PER_TONNE = 1000;
  const toT = kg => (Number(kg) || 0) / KG_PER_TONNE;
  const fmtT = kg => toT(kg).toLocaleString(undefined, { maximumFractionDigits: 1 });

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
    { key: 'znOpen',  re: /^zinc\s*opening$/i },
    { key: 'actOpen', re: /^actual\s*opening$/i },
    { key: 'actClose',re: /^actual\s*closing$/i },
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
        release: get('total', 'release'),
        // bath level, theoretical vs measured — the basis of the reconciliation
        dayZnOpen: get('day', 'znOpen'),
        dayActOpen: get('day', 'actOpen'),
        dayActClose: get('day', 'actClose'),
        nightZnOpen: get('night', 'znOpen'),
        nightActOpen: get('night', 'actOpen'),
        nightActClose: get('night', 'actClose')
      };
      rec.totalTon = get('total', 'totTon') || (rec.dayTon + rec.nightTon);

      // Percentages in the sheet are stored as fractions (0.0734 = 7.34%)
      const pct = v => v > 0 && v < 1 ? v * 100 : v;
      rec.dayPct = pct(get('day', 'consPct'));
      rec.nightPct = pct(get('night', 'consPct'));
      rec.totalPct = pct(get('total', 'consPct'));

      /* Keep any day that carries a figure, not just a day that produced.
         The template ships pre-filled with zeros for the whole month, which
         is what this filter is for — but dross is pulled during the weekly
         maintenance stop, on precisely the days that produce nothing, so a
         production-only test threw those readings away. */
      if (rec.totalTon > 0 || rec.dayTon > 0 || rec.nightTon > 0 ||
          rec.dross > 0 || rec.release > 0 || rec.totalCM > 0) out[date] = rec;
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

  /* Weekly off days (and any other day with nothing run) are kept in the log
     when they carry a drossing/release event — see buildDays — but a zero
     tonnage point still bends the trend line down to the floor and back up,
     making every real swing in the % or tonnage series look smaller than it
     is. Charts only care about days something actually moved through the
     kettle, so they draw from this instead of the full log. */
  const productionDays = list => list.filter(d => (d.totalTon || 0) > 0);

  /* Charts carry their own labels and hover detail. The hit targets are much
     larger than the visible dots so pointing at a value is easy on a phone. */

  function chart(list) {
    if (!list.length) return '';
    const W = 680, H = 280, PL = 50, PR = 24, PT = 28, PB = 44;
    const iw = W - PL - PR, ih = H - PT - PB;

    // left scale — zinc consumption %  (full plot height)
    const maxP = Math.max(12, Math.ceil(Math.max(...list.map(d => d.totalPct || 0)) + 1));
    const X = i => PL + (list.length === 1 ? iw / 2 : i / (list.length - 1) * iw);
    const Yp = v => PT + ih - (v / maxP) * ih;

    // horizontal % gridlines + left axis
    let grid = '';
    for (let v = 0; v <= maxP; v += 2) {
      grid += '<line class="grid" x1="' + PL + '" y1="' + Yp(v).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Yp(v).toFixed(1) + '"/>' +
              '<text class="axis-label" x="' + (PL - 8) + '" y="' + (Yp(v) + 3.5).toFixed(1) + '" text-anchor="end">' + v + '%</text>';
    }

    // the acceptable 4-9% band, straight from the plant's own sheet
    const band = '<rect x="' + PL + '" y="' + Yp(PCT_MAX).toFixed(1) + '" width="' + iw +
      '" height="' + Math.max(0, Yp(PCT_MIN) - Yp(PCT_MAX)).toFixed(1) + '" fill="var(--accent)" opacity=".09" rx="2"/>' +
      '<line class="limit-line" stroke="var(--crit)" x1="' + PL + '" y1="' + Yp(PCT_MAX).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Yp(PCT_MAX).toFixed(1) + '"/>' +
      '<line class="limit-line" stroke="var(--warn)" x1="' + PL + '" y1="' + Yp(PCT_MIN).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Yp(PCT_MIN).toFixed(1) + '"/>' +
      '<text class="axis-limit" x="' + (PL + 4) + '" y="' + (Yp(PCT_MAX) - 4).toFixed(1) + '" text-anchor="start" fill="var(--crit)">' + PCT_MAX + '%</text>' +
      '<text class="axis-limit" x="' + (PL + 4) + '" y="' + (Yp(PCT_MIN) + 11).toFixed(1) + '" text-anchor="start" fill="var(--warn)">' + PCT_MIN + '%</text>';

    // ---- zinc % series (left scale) ----
    const pts = list.map((d, i) => ({ x: X(i), y: Yp(d.totalPct || 0), d: d, valid: Number.isFinite(d.totalPct) && d.totalPct > 0 }));
    // Missing readings leave a gap instead of implying zero consumption.
    const line = pts.map((p, i) => p.valid ? ((i && pts[i - 1].valid) ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1) : '').join(' ');
    const area = pts.length > 1 && pts.every(p => p.valid)
      ? '<path d="' + line + ' L' + pts[pts.length - 1].x.toFixed(1) + ' ' + (PT + ih) + ' L' + pts[0].x.toFixed(1) + ' ' + (PT + ih) + ' Z" fill="var(--accent)" opacity=".07"/>'
      : '';

    const dots = pts.filter(p => p.valid).map(function (p) {
      const tr = tier(p.d.totalPct);
      const col = tr ? 'var(' + TIER_VAR[tr] + ')' : 'var(--ink-3)';
      const tip = '<b>' + p.d.date + '</b>' +
        '<i>' + esc(t('zn.legend.pct')) + ': ' + (p.d.totalPct || 0).toFixed(2) + '% · ' + (tr ? esc(t('zn.tier.' + tr)) : '—') + '</i>' +
        '<i>' + esc(t('zn.legend.ton')) + ': ' + fmtT(p.d.totalTon) + ' ' + esc(t('mgr.ton')) + '</i>';
      // dot + hit grouped, so hovering anywhere in the group grows this dot
      return '<g class="pt-g">' +
        '<circle class="pt-dot" r="4" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) +
          '" fill="var(--surface)" stroke="' + col + '" stroke-width="2.2"/>' +
        '<circle class="hit" r="13" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) +
          '" fill="transparent" data-tip="' + esc(tip) + '"/>' +
      '</g>';
    }).join('');

    // one date under every point, thinned out when they would collide
    const every = Math.ceil(list.length / 12);
    const xlabels = list.map(function (d, i) {
      if (i % every !== 0 && i !== list.length - 1) return '';
      return '<text class="axis-label" x="' + X(i).toFixed(1) + '" y="' + (H - 14) + '" text-anchor="middle">' + d.date.slice(5) + '</text>';
    }).join('');

    const legend = '<div class="chart-legend">' +
      '<span class="lg"><i class="sw sw-pct"></i>' + esc(t('zn.legend.pct')) + '</span>' +
      '<span class="lg chart-range">' + esc(t('design.controlBand')) + ': ' + PCT_MIN + '–' + PCT_MAX + '%</span></div>';

    return '<div class="chart-wrap">' + legend + '<div class="chart-tip"></div>' +
      '<svg class="lab-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" preserveAspectRatio="xMidYMid meet">' +
      '<title>' + esc(t('zn.legend.pct')) + '</title>' + band + grid + area + '<path class="series" d="' + line + '"/>' + dots + xlabels + '</svg></div>';
  }

  /** Average output per jig for one shift, over the days that logged both. */
  function jigTon(list, tonKey, jigKey) {
    let ton = 0, jigs = 0;
    list.forEach(function (d) {
      if ((d[jigKey] || 0) > 0 && (d[tonKey] || 0) > 0) { ton += d[tonKey]; jigs += d[jigKey]; }
    });
    return jigs ? ton / jigs : 0;
  }

  /* ---------------- zinc reconciliation ----------------
     The report records a theoretical opening level for each shift alongside
     the level actually measured. Where they part company is zinc that left
     the kettle without being booked — the figure that goes unnoticed while
     only consumption % is watched. */

  function reconcile(list) {
    const rows = [];
    list.forEach(function (d) {
      [['day', d.dayZnOpen, d.dayActOpen], ['night', d.nightZnOpen, d.nightActOpen]].forEach(function (p) {
        const theo = num(p[1]), act = num(p[2]);
        if (!theo || !act) return;            // shift not recorded
        rows.push({ date: d.date, shift: p[0], theo: theo, act: act, diff: act - theo });
      });
    });
    if (!rows.length) return null;

    const diffs = rows.map(r => r.diff);
    const net = diffs.reduce((s, v) => s + v, 0);
    const absSum = diffs.reduce((s, v) => s + Math.abs(v), 0);
    const worst = rows.slice().sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))[0];
    return { rows: rows, net: net, absSum: absSum, mean: net / rows.length, worst: worst };
  }

  function reconcileHTML(list) {
    const r = reconcile(list);
    if (!r) return '';
    const stat = (k, v, unit, hot) =>
      '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span>' +
      '<span class="v">' + v + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</span></div>';
    const sign = v => (v > 0 ? '+' : '') + v.toFixed(2);
    // a persistent one-way gap matters more than noise that cancels out
    const biased = Math.abs(r.net) > r.absSum * 0.5 && Math.abs(r.net) > 1;

    const worstRows = r.rows.slice().sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 8);
    return '<p class="panel-label" style="margin:26px 0 10px">' + esc(t('zn.rec.title')) + '</p>' +
      '<div class="pt-stats">' +
        stat(t('zn.rec.shifts'), r.rows.length) +
        stat(t('zn.rec.net'), sign(r.net), 'cm', biased) +
        stat(t('zn.rec.mean'), sign(r.mean), 'cm') +
        stat(t('zn.rec.gross'), r.absSum.toFixed(2), 'cm') +
      '</div>' +
      '<div class="zn-note" style="' + (biased ? '' : 'color:var(--ink-3);background:var(--recess);border-color:var(--line)') + '">' +
        esc(biased ? t('zn.rec.biased', { d: sign(r.net) }) : t('zn.rec.balanced')) + '</div>' +
      '<div class="tablewrap"><table><thead><tr>' +
        '<th>' + esc(t('zn.col.date')) + '</th><th>' + esc(t('zn.rec.shift')) + '</th>' +
        '<th>' + esc(t('zn.rec.theo')) + '</th><th>' + esc(t('zn.rec.act')) + '</th>' +
        '<th>' + esc(t('zn.rec.diff')) + '</th>' +
      '</tr></thead><tbody>' +
      worstRows.map(function (x) {
        const col = Math.abs(x.diff) >= 0.5 ? (x.diff < 0 ? 'var(--crit)' : 'var(--warn)') : 'var(--ink)';
        return '<tr>' +
          '<td class="num">' + esc(x.date) + '</td>' +
          '<td>' + esc(t(x.shift === 'day' ? 'zn.shift.day' : 'zn.shift.night')) + '</td>' +
          '<td class="num">' + x.theo.toFixed(2) + '</td>' +
          '<td class="num">' + x.act.toFixed(2) + '</td>' +
          '<td class="num" style="color:' + col + '">' + sign(x.diff) + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function render() {
    const mount = document.getElementById('zn-body');
    if (!mount) return;
    const list = sorted();
    const chartDays = productionDays(list);

    if (!list.length) {
      mount.innerHTML = '<div class="lab-empty">' + esc(t('zn.empty')) + '</div>';
      return;
    }

    const totTon = list.reduce((s, d) => s + (d.totalTon || 0), 0);
    const totCM = list.reduce((s, d) => s + (d.totalCM || 0), 0);
    const avgPct = list.filter(d => d.totalPct > 0);
    const mean = avgPct.length ? avgPct.reduce((s, d) => s + d.totalPct, 0) / avgPct.length : 0;
    const outside = avgPct.filter(d => tier(d.totalPct) !== 'ok').length;

    /* Jigs, drossing and zinc release come in with every import but were never
       surfaced. Output per jig is the plant's own productivity measure, and a
       shift can breach the limit while the day's total still looks fine — so
       the shifts are counted separately from the daily totals. */
    const totDross = list.reduce((s, d) => s + (d.dross || 0), 0);
    const totRelease = list.reduce((s, d) => s + (d.release || 0), 0);
    const totJigs = list.reduce((s, d) => s + (d.dayJigs || 0) + (d.nightJigs || 0), 0);
    const perJig = totJigs ? totTon / totJigs : 0;

    const dayJigTon = jigTon(list, 'dayTon', 'dayJigs');
    const nightJigTon = jigTon(list, 'nightTon', 'nightJigs');

    // shifts outside the band, counted one by one
    let shiftBad = 0, hiddenDays = 0;
    list.forEach(function (d) {
      const bad = (d.dayPct > 0 && tier(d.dayPct) !== 'ok' ? 1 : 0) +
                  (d.nightPct > 0 && tier(d.nightPct) !== 'ok' ? 1 : 0);
      shiftBad += bad;
      // the day's total hides the breach — the case worth flagging
      if (bad && d.totalPct > 0 && tier(d.totalPct) === 'ok') hiddenDays++;
    });

    const stat = (k, v, unit, hot) =>
      '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span>' +
      '<span class="v">' + v + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</span></div>';

    const rows = list.slice().reverse().map(function (d) {
      const jigs = (d.dayJigs || 0) + (d.nightJigs || 0);
      const pj = jigs ? (d.totalTon || 0) / jigs : 0;
      const shiftIssue = (d.dayPct > 0 && tier(d.dayPct) !== 'ok') || (d.nightPct > 0 && tier(d.nightPct) !== 'ok');
      const masked = shiftIssue && d.totalPct > 0 && tier(d.totalPct) === 'ok';
      return '<tr' + (masked ? ' class="zn-masked"' : '') + '>' +
        '<td class="num">' + esc(d.date) +
          (masked ? ' <span class="zn-flag" title="' + esc(t('zn.maskedHint')) + '">!</span>' : '') + '</td>' +
        '<td class="num">' + fmtT(d.dayTon) + '</td>' +
        '<td class="num">' + fmtT(d.nightTon) + '</td>' +
        '<td class="num">' + fmtT(d.totalTon) + '</td>' +
        '<td class="num">' + (jigs ? (d.dayJigs || 0) + ' / ' + (d.nightJigs || 0) : '—') + '</td>' +
        '<td class="num">' + (pj ? Math.round(pj).toLocaleString() : '—') + '</td>' +
        '<td>' + pill(d.dayPct) + '</td>' +
        '<td>' + pill(d.nightPct) + '</td>' +
        '<td>' + pill(d.totalPct) + '</td>' +
      '</tr>';
    }).join('');

    mount.innerHTML =
      '<div class="pt-stats">' +
        stat(t('zn.days'), list.length) +
        stat(t('zn.totalTon'), fmtT(totTon), t('mgr.ton')) +
        stat(t('zn.totalCM'), totCM.toFixed(2)) +
        stat(t('zn.avgPct'), mean.toFixed(2), '%', tier(mean) !== 'ok') +
        stat(t('zn.outside'), outside, '', outside > 0) +
        stat(t('zn.shiftOutside'), shiftBad, '', shiftBad > 0) +
        stat(t('zn.perJig'), perJig ? Math.round(perJig).toLocaleString() : '—') +
        stat(t('zn.release'), Math.round(totRelease).toLocaleString()) +
        stat(t('zn.dross'), totDross ? Math.round(totDross).toLocaleString() : '0') +
      '</div>' +
      (hiddenDays ? '<div class="zn-note">' + esc(t('zn.maskedNote', { n: hiddenDays })) + '</div>' : '') +
      ((dayJigTon && nightJigTon) ? '<div class="zn-shifts">' +
        '<span class="zn-shift"><b>' + esc(t('zn.shift.day')) + '</b> ' +
          Math.round(dayJigTon).toLocaleString() + ' <small>' + esc(t('zn.perJigUnit')) + '</small></span>' +
        '<span class="zn-shift"><b>' + esc(t('zn.shift.night')) + '</b> ' +
          Math.round(nightJigTon).toLocaleString() + ' <small>' + esc(t('zn.perJigUnit')) + '</small></span>' +
        '<span class="zn-gap">' + esc(t('zn.shiftGap', {
          p: (Math.abs(dayJigTon - nightJigTon) / Math.max(dayJigTon, nightJigTon) * 100).toFixed(1),
          s: dayJigTon >= nightJigTon ? t('zn.shift.day') : t('zn.shift.night')
        })) + '</span>' +
      '</div>' : '') +
      (chartDays.length >= 2 ? '<div class="lab-chart-card"><div class="lab-chart-head">' +
        '<span class="lab-chart-title">' + esc(t('zn.chartTitle')) + '</span>' +
        '<span class="lab-chart-meta">' + PCT_MIN + '% – ' + PCT_MAX + '%</span>' +
        '</div>' + chart(chartDays) + '</div><div class="lab-chart-card"><div class="lab-chart-head"><span class="lab-chart-title">' + esc(t('mgr.tonChart')) + '</span></div>' + tonnageChart(chartDays) + '</div>' : '') +
      '<div class="tablewrap"><table><thead><tr>' +
        '<th>' + esc(t('zn.col.date')) + '</th>' +
        '<th>' + esc(t('zn.col.dayTon')) + '</th>' +
        '<th>' + esc(t('zn.col.nightTon')) + '</th>' +
        '<th>' + esc(t('zn.col.totalTon')) + '</th>' +
        '<th>' + esc(t('zn.col.jigs')) + '</th>' +
        '<th>' + esc(t('zn.col.perJig')) + '</th>' +
        '<th>' + esc(t('zn.col.dayPct')) + '</th>' +
        '<th>' + esc(t('zn.col.nightPct')) + '</th>' +
        '<th>' + esc(t('zn.col.totalPct')) + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      reconcileHTML(list);

    attachChartTips(mount);
  }

  /* ---------------- manager overview (on the tanks page) ----------------
     Managers only ever see the tanks page, so the production figures have to
     come to them there rather than living on a page they can't open. */

  // bars are drawn from the raw kg but always labelled in tonnes
  const shortTon = kg => { const t = toT(kg); return t >= 1000 ? (t / 1000).toFixed(1) + 'k' : t.toFixed(t < 10 ? 1 : 0); };

  function tonnageChart(list) {
    if (!list.length) return '';
    // A zero baseline and explicit tonne ticks make daily output comparable.
    const W = 680, H = 260, PL = 50, PR = 24, PT = 30, PB = 44;   // top room for value labels
    const iw = W - PL - PR, ih = H - PT - PB;
    const maxT = Math.max(1, ...list.map(d => d.totalTon || 0)) * 1.12;
    const slot = iw / Math.max(1, list.length);
    const bw = Math.max(6, Math.min(30, slot * 0.6));
    const X = i => PL + slot * (i + 0.5);
    const Y = v => PT + ih - (v / maxT) * ih;

    let grid = '';
    const rawStep = maxT / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const step = Math.ceil(rawStep / mag) * mag;
    for (let v = 0; v <= maxT; v += step) {
      grid += '<line class="grid" x1="' + PL + '" y1="' + Y(v).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Y(v).toFixed(1) + '"/>' +
        '<text class="axis-label" x="' + (PL - 8) + '" y="' + (Y(v) + 4).toFixed(1) + '" text-anchor="end">' + shortTon(v) + '</text>';
    }
    grid += '<line class="grid" x1="' + PL + '" y1="' + (PT + ih) + '" x2="' + (W - PR) + '" y2="' + (PT + ih) + '" stroke="var(--line-strong)"/>';

    const every = Math.ceil(list.length / 12);
    const bars = list.map(function (d, i) {
      const val = d.totalTon || 0;
      const y = Y(val), h = Math.max(1, PT + ih - y);
      const tip = '<b>' + d.date + '</b>' +
        '<i>' + esc(t('mgr.tonChart')) + ': ' + fmtT(val) + ' ' + esc(t('mgr.ton')) + '</i>' +
        '<i>' + esc(t('zn.col.dayTon')) + ' ' + fmtT(d.dayTon) +
        ' · ' + esc(t('zn.col.nightTon')) + ' ' + fmtT(d.nightTon) + '</i>' +
        '<i>' + esc(t('zn.avgPct')) + ': ' + (Number.isFinite(d.totalPct) && d.totalPct > 0 ? d.totalPct.toFixed(2) + '%' : '—') + '</i>';
      const showDate = i % every === 0 || i === list.length - 1;
      return '<g class="bar-g">' +
        '<rect class="bar" x="' + (X(i) - bw / 2).toFixed(1) + '" y="' + y.toFixed(1) +
          '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="3"/>' +
        '<text class="bar-val" x="' + X(i).toFixed(1) + '" y="' + (y - 7).toFixed(1) + '" text-anchor="middle">' + shortTon(val) + '</text>' +
        (showDate ? '<text class="axis-label" x="' + X(i).toFixed(1) + '" y="' + (H - 15) + '" text-anchor="middle">' + d.date.slice(5) + '</text>' : '') +
        '<rect class="hit" x="' + (X(i) - slot / 2).toFixed(1) + '" y="' + PT + '" width="' + slot.toFixed(1) +
          '" height="' + ih + '" fill="transparent" data-tip="' + esc(tip) + '"/>' +
      '</g>';
    }).join('');

    return '<div class="chart-wrap"><div class="chart-tip"></div>' +
      '<svg class="lab-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" preserveAspectRatio="xMidYMid meet">' +
      '<title>' + esc(t('mgr.tonChart')) + ' · ' + esc(t('mgr.ton')) + '</title>' + grid + bars + '</svg><div class="chart-caption">' + esc(t('design.chartHelp')) + '</div></div>';
  }

  /** Wire hover/touch tooltips for any chart inside `root`. */
  function attachChartTips(root) {
    if (!root) return;
    root.querySelectorAll('.chart-wrap').forEach(function (wrap) {
      const tip = wrap.querySelector('.chart-tip');
      if (!tip) return;
      const show = function (el) {
        tip.innerHTML = el.getAttribute('data-tip');
        const wr = wrap.getBoundingClientRect(), er = el.getBoundingClientRect();
        // clamp so the bubble never spills outside the card
        const half = tip.offsetWidth / 2;
        let cx = er.left + er.width / 2 - wr.left;
        cx = Math.max(half + 4, Math.min(wr.width - half - 4, cx));
        tip.style.left = cx + 'px';
        tip.style.top = Math.max(0, er.top - wr.top) + 'px';
        tip.classList.add('on');
      };
      wrap.querySelectorAll('[data-tip]').forEach(function (el) {
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'img');
        const label = document.createElement('div');
        label.innerHTML = el.getAttribute('data-tip');
        el.setAttribute('aria-label', label.textContent);
        el.addEventListener('focus', function () { show(el); });
        el.addEventListener('blur', function () { tip.classList.remove('on'); });
        el.addEventListener('keydown', function (e) { if (e.key === 'Escape') tip.classList.remove('on'); });
        el.addEventListener('mouseenter', function () { show(el); });
        el.addEventListener('mouseleave', function () { tip.classList.remove('on'); });
        el.addEventListener('touchstart', function (e) { show(el); e.stopPropagation(); }, { passive: true });
      });
      wrap.addEventListener('mouseleave', function () { tip.classList.remove('on'); });
    });
  }

  /** Where each running batch currently sits on the line. */
  function lineStatusHTML() {
    const P = window.KGCProduction;
    if (!P) return '';
    let batches = [];
    try { batches = Object.values(P._batches() || {}).filter(b => b && b.status === 'active'); } catch (e) { return ''; }
    if (!batches.length) {
      return '<p class="panel-label" style="margin:22px 0 10px">' + esc(t('mgr.line')) + '</p>' +
             '<div class="lab-empty">' + esc(t('mgr.noActive')) + '</div>';
    }
    const rows = batches.sort((a, b) => (a.startTs || 0) - (b.startTs || 0)).map(function (b) {
      const segs = Array.isArray(b.segments) ? b.segments : [];
      const open = segs.find(s => s && !s.endTs);
      const stageKey = open ? open.stageKey : '';
      const stage = stageKey ? (t('pt.stage.' + stageKey) === 'pt.stage.' + stageKey ? (open.stageName || stageKey) : t('pt.stage.' + stageKey)) : '—';
      const since = open ? open.startTs : b.startTs;
      const mins = since ? Math.round((Date.now() - since) / 60000) : 0;
      return '<tr>' +
        '<td class="name">' + esc(b.batchNumber || '—') + '</td>' +
        '<td>' + esc(b.product || t('pt.noProduct')) + '</td>' +
        '<td class="num">' + (Number(b.weight) || 0).toLocaleString() + '</td>' +
        '<td>' + esc(stage) + '</td>' +
        '<td class="num">' + mins + ' ' + esc(t('mgr.min')) + '</td>' +
      '</tr>';
    }).join('');

    return '<p class="panel-label" style="margin:22px 0 10px">' + esc(t('mgr.line')) + '</p>' +
      '<div class="tablewrap"><table><thead><tr>' +
      '<th>' + esc(t('pt.h.batch')) + '</th><th>' + esc(t('pt.h.product')) + '</th>' +
      '<th>' + esc(t('pt.h.weight')) + '</th><th>' + esc(t('pt.currentStage')) + '</th>' +
      '<th>' + esc(t('mgr.elapsed')) + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function renderOverview() {
    const mount = document.getElementById('mgr-production');
    if (!mount) return;
    const list = sorted();
    const line = lineStatusHTML();

    if (!list.length) {
      mount.innerHTML = line
        ? '<div class="sechead"><span class="secnum">٢</span><h2 class="sectitle">' + esc(t('mgr.title')) + '</h2></div>' + line
        : '';
      return;
    }

    const recent = productionDays(list).slice(-14);   // last two working days keeps it readable
    const totTon = list.reduce((s, d) => s + (d.totalTon || 0), 0);
    const withPct = list.filter(d => d.totalPct > 0);
    const mean = withPct.length ? withPct.reduce((s, d) => s + d.totalPct, 0) / withPct.length : 0;
    const last = list[list.length - 1];

    const stat = (k, v, unit, hot) =>
      '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span>' +
      '<span class="v">' + v + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</span></div>';

    mount.innerHTML =
      '<div class="sechead"><span class="secnum">٢</span><h2 class="sectitle">' + esc(t('mgr.title')) + '</h2></div>' +
      '<p class="secsub">' + esc(t('mgr.sub')) + '</p>' +
      '<div class="pt-stats">' +
        stat(t('mgr.lastDay'), fmtT(last.totalTon), t('mgr.ton')) +
        stat(t('zn.totalTon'), fmtT(totTon), t('mgr.ton')) +
        stat(t('zn.avgPct'), mean.toFixed(2), '%', tier(mean) !== 'ok') +
        stat(t('mgr.lastPct'), (last.totalPct || 0).toFixed(2), '%', tier(last.totalPct) !== 'ok') +
      '</div>' +
      '<div class="lab-chart-card"><div class="lab-chart-head">' +
        '<span class="lab-chart-title">' + esc(t('mgr.tonChart')) + '</span>' +
        '<span class="lab-chart-meta">' + esc(t('mgr.lastN', { n: recent.length })) + '</span>' +
      '</div>' + tonnageChart(recent) + '</div>' +
      '<div class="lab-chart-card"><div class="lab-chart-head">' +
        '<span class="lab-chart-title">' + esc(t('zn.chartTitle')) + '</span>' +
        '<span class="lab-chart-meta">' + PCT_MIN + '% – ' + PCT_MAX + '%</span>' +
      '</div>' + chart(recent) + '</div>' +
      line;

    attachChartTips(mount);
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

  function renderAll() { render(); renderOverview(); }

  database.ref('zinc_daily').on('value', s => { days = s.val() || {}; renderAll(); });
  // the line status reflects live batches, so follow those too
  database.ref('production/batches').on('value', renderOverview);
  if (window.I18N) I18N.onChange(renderAll);
  document.addEventListener('DOMContentLoaded', function () { wire(); renderAll(); });
  // keep the "elapsed" column honest without redrawing the charts
  setInterval(renderOverview, 60000);

  window.KGCZinc = { _days: () => days, reconcile: reconcile, render: renderAll, _buildDays: buildDays, _readWorkbook: readWorkbook };
})();
