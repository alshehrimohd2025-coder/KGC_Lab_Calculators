/* ============================================================
   Bath status report → Excel, from the tank dashboard
   ------------------------------------------------------------
   The dashboard's export button builds this file in the same look as the
   galvanizing line report (xlsx_kit.js): the KSC logo, six key figures,
   then one short table per question:
     1. Tank status        each tank in one row: in standard or not, which
                           readings are out, and how old its last reading is
     2. Bath changes and remaining life
                           when each bath was last changed, how many changes
                           the last 12 months hold, the average life between
                           them, how much of it is used and how many days
                           are left
     3. Reading details    every measured parameter (off unless chosen)
     4. Recent changes     renewals, additions and treatments over the last
                           7, 30 or 90 days
     +  an empty notes box to fill in Excel before sending.

   Remaining life is taken from the changes of the last 12 months only, as
   the plant asked: the average days between the bath changes recorded in
   that year (a renewal; for the flux, a clean-out), less the days since the
   last one. It is how long the bath has lasted lately, not a measurement,
   and the file says so.

   A dialog chooses the tanks and the parts before the download; the choice
   is kept at tank_report_settings:
     { tanksOff: { <tankId>: true }, parts: { <part>: true|false }, days,
       preparedBy, preparedTitle }
   The lab's earlier template (report.js) stays one click away in it.

   Readings are the ones on the tank cards, so the file says what the
   dashboard shows. English only, like the line report.

   Depends on globals from index.html: database, tanks, tankLabel(),
   normalizeStatus(), IS_EDITOR, IS_AUTHED, t(), I18N, and KGCXlsx /
   KGCTasks / KGCSpecs / KGCLab / KGCFlux / KGCPeroxide / KGCActions /
   KGCReport when loaded.
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[tankreport] Firebase database is not available.');
    return;
  }

  // the same groups the earlier export offered, as quick picks
  const PRESETS = { all: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], acid: [3, 4, 5, 6, 7, 8], flux: [10], rinse: [1, 2, 9] };
  // the parts, and whether each is in unless the dialog says otherwise
  const PARTS = { attention: true, status: true, life: true, readings: false, events: true, notes: true };
  const WINDOWS = [7, 30, 90];
  const STALE_DAYS = 7;         // a reading older than this is flagged
  const DUE_SOON = 14;          // a bath change due within this many days counts as due
  const YEAR = 365;             // remaining life is judged on this many days of changes
  const RESETS = { renewal: 1, cleaning: 1 };   // a top-up addition does not start a new bath
  const DEFAULT_TITLE = 'Chemical Engineer';

  let acidAdds = {}, saltAdds = {}, settings = {};

  /* ---------------- helpers ---------------- */

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pad = n => (n < 10 ? '0' : '') + n;
  const dayKey = d => { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const parse = s => new Date(s + 'T00:00:00');
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return dayKey(d); };
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const fmt = (v, d) => (v == null || !isFinite(v)) ? '—'
    : Number(v).toLocaleString('en-US', { maximumFractionDigits: d == null ? 2 : d, minimumFractionDigits: 0 });
  const values = o => Object.keys(o || {}).map(k => Object.assign({ _k: k }, o[k])).filter(Boolean);
  const inRange = (d, S, E) => !!d && d >= S && d <= E;
  const tsOf = r => { const n = typeof r.ts === 'number' ? r.ts : Date.parse(r.ts); return isFinite(n) ? n : 0; };
  const canEdit = () => (typeof IS_EDITOR !== 'undefined' && IS_EDITOR) &&
                        (typeof IS_AUTHED !== 'undefined' && IS_AUTHED);
  const T = () => window.KGCTasks;
  const measurable = id => T() ? T().measurable(id) : [];
  const paramLabel = k => T() ? T().paramLabel(k) : k;
  const tankById = id => (typeof tanks !== 'undefined' ? tanks.find(x => x.id === Number(id)) : null);
  const tankName = id => { const tk = tankById(id); return tk ? tankLabel(tk.name) : String(id); };
  const reading = v => v != null && v !== '' && isFinite(Number(v)) && Number(v) !== 0;

  /** Tanks with a standard, in line order: the ones the report can speak about. */
  function reportTanks() {
    return typeof tanks === 'undefined' ? [] : tanks.slice().sort((a, b) => a.id - b.id).filter(tk => measurable(tk.id).length);
  }
  const included = (s, id) => !(s.tanksOff && s.tanksOff[id]);
  const partOn = (s, k) => s.parts && s.parts[k] != null ? !!s.parts[k] : PARTS[k];
  const windowOf = s => WINDOWS.indexOf(Number(s.days)) !== -1 ? Number(s.days) : 30;

  /* ---------------- bath changes ---------------- */

  /* Renewals, additions and treatments between two days, newest first. The
     logs are the plant's own record; a before/after card adds its action only
     when no log already covers the same material, tank and day. Kind is
     'renew' for a renewal or clean-out, 'adjust' for everything else. */
  function events(S, E) {
    const out = [];
    const logged = {};
    const add = (r, tankId, kind, type, detail, by, mat) => {
      out.push({ date: r.date, ts: tsOf(r), tankId: tankId, kind: kind, type: type, detail: detail, by: by || '' });
      if (mat) logged[mat + '|' + tankId + '|' + r.date] = 1;
    };
    const L = window.KGCLab;
    values(L && L._renewals ? L._renewals() : {}).forEach(function (r) {
      if (!inRange(r.date, S, E)) return;
      const qty = num(r.qty) ? fmt(r.qty) + ' ' + (r.unit || '') : '';
      add(r, Number(r.tankId), r.type === 'addition' ? 'adjust' : 'renew', t('lab.type.' + r.type),
        [qty.trim(), r.note || ''].filter(Boolean).join(' — '), '', r.type === 'addition' ? 'hcl' : null);
    });
    values(acidAdds).forEach(function (r) {
      if (!inRange(r.date, S, E)) return;
      add(r, Number(r.tankId), 'adjust', t('tr.ev.acid'),
        fmt(r.tons) + ' t HCl' + (r.before != null ? ' · ' + t('tr.ev.feBefore', { v: fmt(r.before) }) : ''), r.operator, 'hcl');
    });
    const F = window.KGCFlux, P = window.KGCPeroxide;
    values(F && F._treatments ? F._treatments() : {}).forEach(function (r) {
      if (!inRange(r.date, S, E)) return;
      add(r, 10, 'adjust', t('tr.ev.ammonia'), fmt(r.liters) + ' L · pH ' + fmt(r.phBefore) + ' → ' + fmt(r.phAfter), r.operator, 'ammonia');
    });
    values(P && P._treatments ? P._treatments() : {}).forEach(function (r) {
      if (!inRange(r.date, S, E)) return;
      add(r, 10, 'adjust', t('tr.ev.peroxide'), fmt(r.liters) + ' L · Fe ' + fmt(r.feBefore) + ' → ' + fmt(r.feAfter) + ' g/L', r.operator, 'peroxide');
    });
    values(saltAdds).forEach(function (r) {
      if (!inRange(r.date, S, E)) return;
      add(r, 10, 'adjust', t('tr.ev.salt'), fmt(r.kg) + ' kg' +
        (r.beBefore != null ? ' · Bé ' + fmt(r.beBefore) + ' → ' + (r.beAfter != null ? fmt(r.beAfter) : '?') : ''), '', 'flux_salt');
    });
    const A = window.KGCActions;
    if (A) A.list().forEach(function (c) {
      const a = c.action;
      const d = a ? String(a.at || '').slice(0, 10) : '';
      if (!a || !inRange(d, S, E) || logged[a.material + '|' + Number(c.tankId) + '|' + d]) return;
      out.push({ date: d, ts: Date.parse(a.at) || 0, tankId: Number(c.tankId), kind: 'adjust', type: t('tr.ev.card'),
        detail: A.materialText(a) + ' — ' + fmt(a.actualQty) + ' ' + (a.actualUnit || ''), by: a.by || '' });
    });
    return out.sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : b.ts - a.ts);
  }

  /* How long the bath has lasted lately: the bath changes of the last 12
     months, the average days between them, and what that leaves. One change
     a day at most — a renewal logged twice is still one renewal. */
  function lifeOf(tankId, today) {
    const L = window.KGCLab;
    const byDate = {};
    values(L && L._renewals ? L._renewals() : {}).forEach(function (r) {
      if (Number(r.tankId) === tankId && RESETS[r.type] && r.date && r.date <= today) byDate[r.date] = r;
    });
    const dates = Object.keys(byDate).sort();
    if (!dates.length) return null;
    const last = dates[dates.length - 1];
    const since = daysBetween(last, today);
    const year = dates.filter(d => d >= addDays(today, -YEAR));
    const iv = [];
    for (let i = 1; i < year.length; i++) iv.push(daysBetween(year[i - 1], year[i]));
    const avg = iv.length ? iv.reduce((x, y) => x + y, 0) / iv.length : null;
    return {
      last: last, type: t('lab.type.' + byDate[last].type), since: since, inYear: year.length, n: iv.length,
      avg: avg, used: avg ? since / avg : null,
      remaining: avg != null ? Math.round(avg - since) : null,
      due: avg != null ? addDays(last, Math.round(avg)) : null
    };
  }

  /* ---------------- the model ---------------- */

  /* Everything the file shows, in whatever language t() is answering in;
     the export asks for English. */
  function model(s) {
    const today = dayKey(), now = new Date();
    const SP = window.KGCSpecs;
    const list = reportTanks().filter(tk => included(s, tk.id));
    const days = windowOf(s);
    const allEvents = events('0000-01-01', today);
    const recent = allEvents.filter(e => e.date >= addDays(today, -(days - 1)) && list.some(tk => tk.id === e.tankId));

    const tanksOut = list.map(function (tk) {
      const params = measurable(tk.id).map(function (p) {
        const v = tk[p.key];
        const has = reading(v);
        const date = has ? (tk.measured && tk.measured[p.key]) || null : null;
        return {
          label: paramLabel(p.key),
          param: paramLabel(p.key) + (p.unit ? ' (' + p.unit + ')' : ''),
          unit: p.unit || '',
          v: has ? Number(v) : null, date: date,
          age: date ? daysBetween(date, today) : null,
          tier: has && SP ? SP.evaluate(Number(v), p).tier : 'none',
          range: T() ? T().rangeOf(p) : ''
        };
      });
      const measured = params.filter(x => x.v != null);
      const level = params.some(x => x.tier === 'crit') ? 'crit' : params.some(x => x.tier === 'warn') ? 'warn'
        : measured.length ? 'good' : 'none';
      const latest = measured.map(x => x.date || '').sort().pop() || null;
      const adj = allEvents.find(e => e.tankId === tk.id && e.kind === 'adjust') || null;
      const service = typeof normalizeStatus === 'function' ? normalizeStatus(tk.status) : 'in_service';
      return {
        id: tk.id, name: tankName(tk.id), service: t('st.' + service), serviceKey: service,
        note: tk.note || '', params: params, level: level,
        out: params.filter(x => x.tier === 'warn' || x.tier === 'crit')
          .map(x => x.label + ' ' + fmt(x.v) + (x.unit ? ' ' + x.unit : '') + ' (' + x.range + ')'),
        latest: latest, age: latest ? daysBetween(latest, today) : null,
        stale: !measured.length || !latest || daysBetween(latest, today) > STALE_DAYS,
        life: lifeOf(tk.id, today),
        adjust: adj ? { date: adj.date, type: adj.type } : null
      };
    });

    const withLife = tanksOut.filter(x => x.life && x.life.remaining != null);
    return {
      generated: today, generatedAt: pad(now.getHours()) + ':' + pad(now.getMinutes()),
      preparedBy: s.preparedBy || '', preparedTitle: s.preparedTitle != null ? s.preparedTitle : DEFAULT_TITLE,
      parts: Object.keys(PARTS).reduce((o, k) => { o[k] = partOn(s, k); return o; }, {}),
      days: days, tanks: tanksOut,
      excluded: reportTanks().filter(tk => !included(s, tk.id)).map(tk => tankName(tk.id)),
      kpi: {
        total: tanksOut.length,
        good: tanksOut.filter(x => x.level === 'good').length,
        out: tanksOut.filter(x => x.level === 'warn' || x.level === 'crit').length,
        crit: tanksOut.filter(x => x.level === 'crit').length,
        stale: tanksOut.filter(x => x.stale).length,
        due: withLife.filter(x => x.life.remaining >= 0 && x.life.remaining <= DUE_SOON).length,
        overdue: withLife.filter(x => x.life.remaining < 0).length
      },
      events: recent.map(e => ({ date: e.date, tank: tankName(e.tankId), type: e.type, detail: e.detail, by: e.by }))
    };
  }

  /* ---------------- the file ---------------- */

  function fileName(m) { return 'KGC_Tank_Status_and_Bath_Life_Report_' + window.KGCXlsx.fmtDate(m.generated) + '.xlsx'; }

  function build(m, logo) {
    const X = window.KGCXlsx;
    const { NCOL, C, THIN, TIER, fmtDate, dow, Styles, Sheet, bar, subTitle, note, emptyLine, table, status, pair } = X;
    const styles = new Styles();
    const sh = new Sheet(styles);
    sh.footer = 'Tank status and bath life · ' + fmtDate(m.generated);

    X.header(sh, { title: 'TANK STATUS AND BATH LIFE', lines: [
      'As of: ' + dow(m.generated) + ' ' + fmtDate(m.generated) + ', ' + m.generatedAt,
      'Generated ' + fmtDate(m.generated) + ' ' + m.generatedAt +
        (m.preparedBy ? '   ·   Prepared by ' + m.preparedBy + (m.preparedTitle ? ', ' + m.preparedTitle : '') : '')
    ] }, X.pngSize(logo));

    const k = m.kpi;
    X.cardRow(sh, [
      { label: 'TANKS IN REPORT', v: k.total, fmt: '0', sub: m.excluded.length ? 'Not included: ' + m.excluded.length : 'All tanks with a standard' },
      { label: 'WITHIN STANDARD', v: k.good, fmt: '0', sub: 'Every reading in range' },
      { label: 'OUT OF STANDARD', v: k.out, fmt: '0', hot: k.out > 0, sub: 'Critical: ' + k.crit },
      { label: 'NOT MEASURED IN ' + STALE_DAYS + ' DAYS', v: k.stale, fmt: '0', hot: k.stale > 0, sub: 'Last reading older, or none' },
      { label: 'BATH CHANGE DUE IN ' + DUE_SOON + ' DAYS', v: k.due, fmt: '0', sub: 'From the last 12 months' },
      { label: 'BATH CHANGE OVERDUE', v: k.overdue, fmt: '0', hot: k.overdue > 0, sub: 'Past its average life' }
    ]);
    if (m.excluded.length) note(sh, 'Not included in this report (chosen on the site): ' + m.excluded.join(', ') + '.');

    const lifeText = L => !L || L.remaining == null ? '—'
      : L.remaining < 0 ? Math.abs(L.remaining) + ' d overdue' : L.remaining + ' d left';
    const lifeTier = L => !L || L.remaining == null ? null : L.remaining < 0 ? 'crit' : L.remaining <= DUE_SOON ? 'warn' : 'good';

    /* The line at a glance: one tile per tank in process order, coloured by
       its readings, with the days its bath has left underneath. */
    if (m.tanks.length) {
      subTitle(sh, 'The line at a glance, in process order');
      const list = m.tanks.slice(0, NCOL);
      const off = Math.floor((NCOL - list.length) / 2);
      const gap = ['medium', C.white];
      const r1 = sh.next(30), r2 = sh.next(20), r3 = sh.next(18);
      list.forEach(function (x, i) {
        const c = off + i;
        const tt = x.level === 'none' ? { fill: C.note, color: C.muted, word: 'No reading' } : TIER[x.level];
        const lt = lifeTier(x.life);
        sh.span(r1, c, c, x.name, { font: { b: 1, sz: 8, color: C.white }, fill: C.navy,
          border: { l: gap, r: gap }, align: { h: 'center', wrap: 1 } });
        sh.span(r2, c, c, tt.word, { font: { b: 1, sz: 9, color: tt.color }, fill: tt.fill,
          border: { l: gap, r: gap }, align: { h: 'center' } });
        sh.span(r3, c, c, lifeText(x.life), { font: { b: lt && lt !== 'good' ? 1 : 0, sz: 8, color: lt === 'crit' ? C.critFg : lt === 'warn' ? C.warnFg : C.muted },
          fill: C.band, border: { l: gap, r: gap, b: THIN }, align: { h: 'center' } });
      });
      note(sh, 'Top: the tank. Middle: its readings against the standard. Bottom: days its bath has left at its average life of the last 12 months.');
    }

    let n = 0;

    /* What a manager should read first, worst first; an empty list says so. */
    if (m.parts.attention) {
      const crit = m.tanks.filter(x => x.level === 'crit');
      const out = m.tanks.filter(x => x.level === 'warn');
      const over = m.tanks.filter(x => lifeTier(x.life) === 'crit');
      const soon = m.tanks.filter(x => lifeTier(x.life) === 'warn');
      const stale = m.tanks.filter(x => x.stale);
      const items = [];
      if (crit.length) items.push(['Critical', crit.map(x => x.name + ': ' + x.out.join(', ')).join('   ·   '), 'crit']);
      if (over.length) items.push(['Bath change overdue', over.map(x => x.name + ': ' + Math.abs(x.life.remaining) +
        ' days past its average life of ' + Math.round(x.life.avg) + ' days').join('   ·   '), 'crit']);
      if (out.length) items.push(['Out of standard', out.map(x => x.name + ': ' + x.out.join(', ')).join('   ·   '), 'warn']);
      if (soon.length) items.push(['Bath change due', soon.map(x => x.name + ': in ' + x.life.remaining + ' days (' +
        fmtDate(x.life.due) + ')').join('   ·   '), 'warn']);
      if (stale.length) items.push(['Not measured in ' + STALE_DAYS + ' days', stale.map(x => x.name +
        (x.age != null ? ' (' + x.age + ' d)' : ' (no reading)')).join(',  '), 'warn']);
      bar(sh, 'NEEDS ATTENTION');
      if (items.length) items.forEach(it => pair(sh, it[0], it[1], it[2]));
      else pair(sh, 'All clear', 'Every tank in this report is within standard, measured in the last ' + STALE_DAYS +
        ' days, and no bath change is due in the next ' + DUE_SOON + ' days.', 'good');
    }

    const old = (date, age) => date && age != null && age <= STALE_DAYS ? date
      : { v: date || 'No reading', color: C.warnFg, b: 1, h: 'center' };
    const service = x => x.serviceKey === 'in_service' ? { v: x.service, h: 'center' }
      : Object.assign(status(x.serviceKey === 'out_of_service' ? 'crit' : 'warn'), { v: x.service });

    if (m.parts.status) {
      bar(sh, ++n + '   TANK STATUS');
      table(sh, [
        { label: 'Tank', span: 2 }, { label: 'Status', span: 1, h: 'center' }, { label: 'Readings out of standard', span: 5 },
        { label: 'Last reading', span: 1, h: 'center' }, { label: 'Age (days)', span: 1, h: 'center' },
        { label: 'Tank in service', span: 2, h: 'center' }
      ], m.tanks.map(x => [
        { v: x.name, b: 1 },
        x.level === 'none' ? { v: 'No reading', color: C.muted, h: 'center' } : status(x.level),
        x.out.length ? { v: x.out.join('\n'), color: x.level === 'crit' ? C.critFg : C.warnFg }
          : { v: x.level === 'none' ? '—' : 'All readings in range', color: C.muted },
        old(x.latest, x.age),
        x.age == null ? null : Object.assign({ v: x.age, h: 'center' }, x.age > STALE_DAYS ? { color: C.warnFg, b: 1 } : {}),
        service(x)
      ]), { limit: 20 });
      note(sh, 'Readings are the ones on the tank dashboard, judged against the standard limits on the site. ' +
        'A last reading in orange is more than ' + STALE_DAYS + ' days old: the bath may have moved since.');
      pair(sh, 'Tank notes', m.tanks.filter(x => x.note).map(x => x.name + ': ' + x.note).join('  ·  '), 'none');
    }

    if (m.parts.life) {
      bar(sh, ++n + '   BATH CHANGES AND REMAINING LIFE');
      subTitle(sh, 'Average life from the bath changes of the last 12 months');
      const head = sh.rows.length;
      table(sh, [
        { label: 'Tank', span: 2 }, { label: 'Last change', span: 1, h: 'center' }, { label: 'Change', span: 1, h: 'center' },
        { label: 'Days since', span: 1, h: 'center' }, { label: 'Changes in 12 months', span: 1, h: 'center' },
        { label: 'Average life (days)', span: 1, h: 'center' }, { label: 'Life used', span: 1, h: 'center' },
        { label: 'Days remaining', span: 1, h: 'center' }, { label: 'Next change due', span: 1, h: 'center' },
        { label: 'Last adjustment', span: 2 }
      ], m.tanks.map(function (x) {
        const L = x.life;
        const tier = !L || L.used == null ? null : L.used >= 1 ? 'crit' : L.remaining <= DUE_SOON ? 'warn' : 'good';
        const left = !L || L.remaining == null ? null : L.remaining < 0
          ? Object.assign(status('crit'), { v: Math.abs(L.remaining) + ' overdue' })
          : Object.assign(status(tier), { v: L.remaining });
        return [
          { v: x.name, b: 1 },
          L ? L.last : null,
          L ? { v: L.type, h: 'center' } : null,
          L ? { v: L.since, h: 'center' } : null,
          L ? { v: L.inYear, h: 'center' } : null,
          L && L.avg != null ? { v: Math.round(L.avg), h: 'center' }
            : { v: L ? 'Too few changes' : '—', color: C.muted, h: 'center' },
          L && L.used != null ? { v: L.used, fmt: '0%', h: 'center', color: tier === 'crit' ? C.critFg : tier === 'warn' ? C.warnFg : null, b: tier !== 'good' ? 1 : 0 } : null,
          left,
          L && L.due ? L.due : null,
          x.adjust ? fmtDate(x.adjust.date) + ' · ' + x.adjust.type : null
        ];
      }), { limit: 20 });
      // a bar in "life used": empty at a fresh bath, full at its average life
      sh.bars.push({ ref: 'H' + (head + 2) + ':H' + (head + 1 + Math.min(m.tanks.length, 20)), color: '8EA9DB', max: 1 });
      note(sh, 'Average life: the average number of days between the bath changes recorded in the last 12 months (a renewal; for the flux tank, a clean-out) — two changes in the year are needed. ' +
        'Days remaining = average life − days since the last change; life used = days since ÷ average life. ' +
        'It is how long the bath has lasted lately, not a measurement: a heavier month uses a bath faster. ' +
        'A dash: nothing recorded on the site. The last adjustment is the latest addition or treatment; its details are under recent changes.');
    }

    if (m.parts.readings) {
      bar(sh, ++n + '   READING DETAILS');
      const rows = [];
      // parameters never measured would fill the page with dashes; a tank with
      // no reading at all keeps one row so it is still seen
      m.tanks.forEach(function (x) {
        const shown = x.params.filter(p => p.v != null);
        (shown.length ? shown : [{ param: 'No reading', v: null, range: '' }]).forEach(function (p, i) {
          const stale = p.v != null && (p.age == null || p.age > STALE_DAYS);
          rows.push([
            i ? { v: '', blank: 1 } : { v: x.name, b: 1 },
            p.param,
            p.v,
            p.v == null ? null : p.date ? Object.assign({ v: p.date }, stale ? { color: C.warnFg, b: 1 } : {}) : { v: 'date unknown', color: C.warnFg, h: 'center' },
            p.age == null ? null : Object.assign({ v: p.age, h: 'center' }, stale ? { color: C.warnFg, b: 1 } : {}),
            p.v == null ? { v: 'Not measured', color: C.muted, h: 'center' } : p.tier === 'none' ? null : status(p.tier),
            p.range
          ]);
        });
      });
      table(sh, [
        { label: 'Tank', span: 2 }, { label: 'Parameter', span: 3 }, { label: 'Reading', span: 1, h: 'right' },
        { label: 'Reading date', span: 1, h: 'center' }, { label: 'Age (days)', span: 1, h: 'center' },
        { label: 'Status', span: 1, h: 'center' }, { label: 'Standard range', span: 3, h: 'center' }
      ], rows, { limit: 80 });
      note(sh, 'Parameters never measured on a tank are left out.');
    }

    if (m.parts.events) {
      bar(sh, ++n + '   RECENT CHANGES (LAST ' + m.days + ' DAYS)');
      if (m.events.length) {
        table(sh, [
          { label: 'Date', span: 1, h: 'center' }, { label: 'Tank', span: 2 }, { label: 'Change', span: 2 },
          { label: 'Details', span: 5 }, { label: 'By', span: 2 }
        ], m.events.map(e => [e.date, { v: e.tank, b: 1 }, e.type, e.detail, e.by]), { limit: 30 });
      } else emptyLine(sh, 'No renewals, additions or treatments were recorded in the last ' + m.days + ' days.');
    }

    if (m.parts.notes) X.notesBox(sh);
    X.closing(sh, 'Built from the KGC galvanizing line records on the site: the tank dashboard readings, the renewal, addition and treatment logs, and the before/after cards. ' +
      'Readings are judged against the standard limits set on the site on ' + fmtDate(m.generated) + '.');

    const title = 'KGC Tank Status and Bath Life — ' + fmtDate(m.generated);
    return { blob: X.pack(sh, styles, { title: title, creator: m.preparedBy, sheetName: 'Tank Status', logo: logo }),
      file: fileName(m), title: title };
  }

  /* ---------------- the dialog ---------------- */

  function openDialog() {
    const s = JSON.parse(JSON.stringify(settings || {}));
    const list = reportTanks();
    const wrap = document.createElement('div');
    wrap.className = 'pt-overlay';
    wrap.innerHTML =
      '<div class="pt-modal">' +
        '<div class="pt-modal-head"><h3>' + esc(t('tr.x.title')) + '</h3>' +
        '<button class="pt-x" data-close aria-label="close">&times;</button></div>' +
        '<div class="pt-modal-body">' +
          '<p class="tk-hint">' + esc(t('tr.x.sub')) + '</p>' +
          '<p class="wk-sub">' + esc(t('tr.x.tanks')) + '</p>' +
          '<div class="tr-presets">' + Object.keys(PRESETS).map(k =>
            '<button class="btn mini ghost" data-tr-preset="' + k + '">' + esc(t('rep.scope.' + k)) + '</button>').join('') + '</div>' +
          '<div class="wk-chips">' + list.map(tk =>
            '<label class="wk-chk"><input type="checkbox" data-tr-tank="' + tk.id + '"' + (included(s, tk.id) ? ' checked' : '') + '> ' +
              esc(tankName(tk.id)) + '</label>').join('') + '</div>' +
          '<p class="wk-sub">' + esc(t('tr.x.parts')) + '</p>' +
          '<div class="wk-chips col">' + Object.keys(PARTS).map(k =>
            '<label class="wk-chk"><input type="checkbox" data-tr-part="' + k + '"' + (partOn(s, k) ? ' checked' : '') + '> ' +
              esc(t('tr.part.' + k)) + '</label>').join('') + '</div>' +
          '<div class="tr-row"><label>' + esc(t('tr.x.days')) + ' <select id="tr-days">' + WINDOWS.map(d =>
            '<option value="' + d + '"' + (windowOf(s) === d ? ' selected' : '') + '>' + esc(t('tr.x.daysN', { n: d })) + '</option>').join('') +
            '</select></label></div>' +
          '<div class="tr-row"><label>' + esc(t('wk.preparedBy')) + ' <input type="text" id="tr-by" maxlength="80" value="' + esc(s.preparedBy || '') + '"></label>' +
            '<label>' + esc(t('wk.jobTitle')) + ' <input type="text" id="tr-title" maxlength="80" value="' +
              esc(s.preparedTitle != null ? s.preparedTitle : DEFAULT_TITLE) + '"></label></div>' +
          (window.KGCReport && window.KGCReport.export
            ? '<p class="tk-hint"><button class="tr-old" id="tr-old">' + esc(t('tr.x.old')) + '</button></p>' : '') +
        '</div>' +
        '<div class="pt-modal-foot">' +
          '<button class="btn" id="tr-go">' + esc(t('wk.x.go')) + '</button>' +
          '<button class="btn ghost" data-close>' + esc(t('pt.cancel')) + '</button>' +
          '<span class="tk-msg" id="tr-msg"></span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    wrap.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
    wrap.querySelectorAll('[data-tr-preset]').forEach(function (b) {
      b.addEventListener('click', function () {
        const ids = PRESETS[b.getAttribute('data-tr-preset')];
        wrap.querySelectorAll('[data-tr-tank]').forEach(el => { el.checked = ids.indexOf(Number(el.getAttribute('data-tr-tank'))) !== -1; });
      });
    });
    const old = wrap.querySelector('#tr-old');
    if (old) old.addEventListener('click', function () { close(); window.KGCReport.export(); });
    wrap.querySelector('#tr-go').addEventListener('click', function () {
      const msg = wrap.querySelector('#tr-msg');
      const next = { tanksOff: {}, parts: {}, days: Number(wrap.querySelector('#tr-days').value),
        preparedBy: wrap.querySelector('#tr-by').value.trim(), preparedTitle: wrap.querySelector('#tr-title').value.trim() };
      wrap.querySelectorAll('[data-tr-tank]').forEach(el => { if (!el.checked) next.tanksOff[el.getAttribute('data-tr-tank')] = true; });
      wrap.querySelectorAll('[data-tr-part]').forEach(el => { next.parts[el.getAttribute('data-tr-part')] = el.checked; });
      if (Object.keys(next.tanksOff).length === list.length) {
        msg.textContent = t('tr.x.noTanks'); msg.style.color = 'var(--crit)';
        return;
      }
      // the choice holds for the next report; the editor's is kept for every device
      settings = next;
      if (canEdit()) database.ref('tank_report_settings').set(next);
      this.disabled = true;
      exportFile(next).then(close, function (e) {
        console.error('[tankreport] export failed', e);
        msg.textContent = t('wk.x.failed') + ' ' + (e.message || ''); msg.style.color = 'var(--crit)';
        wrap.querySelector('#tr-go').disabled = false;
      });
    });
  }

  async function exportFile(s) {
    const X = window.KGCXlsx;
    if (!X) throw new Error('xlsx_kit.js not loaded');
    const m = window.I18N && I18N.withLang ? I18N.withLang('en', () => model(s)) : model(s);
    const logo = await X.loadLogo();
    const out = build(m, logo);
    X.download(out.blob, out.file);
    const msg = document.getElementById('rep-msg');
    if (msg) { msg.textContent = t('tr.x.done', { f: out.file }); msg.style.color = 'var(--accent)'; }
    return out;
  }

  /* ---------------- wiring ---------------- */

  database.ref('acid_additions').on('value', s => { acidAdds = s.val() || {}; });
  database.ref('flux_salt_additions').on('value', s => { saltAdds = s.val() || {}; });
  database.ref('tank_report_settings').on('value', s => { settings = s.val() || {}; });

  function wire() {
    const b = document.getElementById('rep-export');
    if (!b || b.dataset.wired) return;
    b.dataset.wired = '1';
    b.addEventListener('click', openDialog);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  window.KGCTankReport = { open: openDialog, exportFile: exportFile, model: model, build: build, _events: events };
})();
