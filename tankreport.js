/* ============================================================
   Bath status report → Excel, from the tank dashboard
   ------------------------------------------------------------
   The dashboard's export button builds this file in the same look as the
   galvanizing line report (xlsx_kit.js): the KSC logo, six key figures,
   then
     1. Tank readings      each tank's current readings against its
                           standard, with the day each was measured
     2. Bath changes and expected life
                           last renewal, last adjustment (an addition or a
                           treatment), the next change the tank's usual
                           interval points to, and when iron reaches its limit
     3. Recent changes     renewals, additions and treatments in the last
                           7, 30 or 90 days
     +  an empty notes box to fill in Excel before sending.

   A dialog chooses the tanks and the parts before the download; the choice
   is kept at tank_report_settings:
     { tanksOff: { <tankId>: true }, sectionsOff: { <part>: true }, days,
       preparedBy, preparedTitle }
   The lab's earlier template (report.js) stays one click away in it.

   Readings are the ones on the tank cards, so the file says what the
   dashboard shows. Expected life is two estimates, each labelled as one:
   the tank's usual replacement interval (KGCForecast) and its iron trend
   (KGCLab.lifeEstimate).

   English only, like the line report.

   Depends on globals from index.html: database, tanks, tankLabel(),
   normalizeStatus(), IS_EDITOR, IS_AUTHED, t(), I18N, and KGCXlsx /
   KGCTasks / KGCSpecs / KGCLab / KGCForecast / KGCFlux / KGCPeroxide /
   KGCActions / KGCReport when loaded.
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[tankreport] Firebase database is not available.');
    return;
  }

  // the same groups the earlier export offered, as quick picks
  const PRESETS = { all: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], acid: [3, 4, 5, 6, 7, 8], flux: [10], rinse: [1, 2, 9] };
  const SECTIONS = ['readings', 'life', 'events', 'notes'];
  const WINDOWS = [7, 30, 90];
  const STALE_DAYS = 7;         // a reading older than this is flagged
  const DUE_SOON = 14;          // a bath change due within this many days counts as due
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
  const partOn = (s, k) => !(s.sectionsOff && s.sectionsOff[k]);
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

  /** The day iron was last measured in a tank, for dating the iron trend. */
  function lastFeDay(tankId) {
    const L = window.KGCLab;
    let best = null;
    values(L && L._readings ? L._readings() : {}).forEach(function (r) {
      if (Number(r.tankId) === tankId && Number(r.fe) > 0 && r.date && (!best || r.date > best)) best = r.date;
    });
    return best;
  }

  /* ---------------- the model ---------------- */

  /* Everything the file shows, in whatever language t() is answering in;
     the export asks for English. */
  function model(s) {
    const today = dayKey(), now = new Date();
    const SP = window.KGCSpecs, L = window.KGCLab, FC = window.KGCForecast;
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
          param: paramLabel(p.key) + (p.unit ? ' (' + p.unit + ')' : ''),
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
      const stale = !measured.length || !latest || daysBetween(latest, today) > STALE_DAYS;

      const ch = L && L.lastChange ? L.lastChange(tk.id) : null;
      const adj = allEvents.find(e => e.tankId === tk.id && e.kind === 'adjust') || null;
      const fc = FC && FC.forecast ? FC.forecast(tk.id) : null;
      const life = L && L.lifeEstimate && measurable(tk.id).some(p => p.key === 'fe') ? L.lifeEstimate(tk.id) : null;
      const feDay = life && life.state === 'ok' ? lastFeDay(tk.id) : null;
      const limits = SP && SP.feLimits ? SP.feLimits(tk.id) : null;
      return {
        id: tk.id, name: tankName(tk.id),
        service: t('st.' + (typeof normalizeStatus === 'function' ? normalizeStatus(tk.status) : 'in_service')),
        serviceKey: typeof normalizeStatus === 'function' ? normalizeStatus(tk.status) : 'in_service',
        note: tk.note || '', params: params, level: level, stale: stale,
        renewal: ch ? { date: ch.date, days: ch.days } : null,
        adjust: adj ? { date: adj.date, text: adj.type + ': ' + adj.detail } : null,
        interval: fc && fc.state === 'ok' ? { due: fc.due, remaining: fc.remaining, mean: fc.mean, n: fc.n } : null,
        intervalHave: fc && fc.state === 'insufficient' ? fc.have : null,
        iron: life && life.state === 'ok' && feDay ? {
          days: life.daysToWarn, date: addDays(feDay, Math.max(0, life.daysToWarn)), atLimit: life.daysToWarn <= 0,
          limit: limits && limits.warn, current: life.currentFe
        } : null
      };
    });

    const due = tanksOut.filter(x => x.interval && x.interval.remaining <= DUE_SOON);
    return {
      generated: today, generatedAt: pad(now.getHours()) + ':' + pad(now.getMinutes()),
      preparedBy: s.preparedBy || '', preparedTitle: s.preparedTitle != null ? s.preparedTitle : DEFAULT_TITLE,
      parts: { readings: partOn(s, 'readings'), life: partOn(s, 'life'), events: partOn(s, 'events'), notes: partOn(s, 'notes') },
      days: days, tanks: tanksOut,
      excluded: reportTanks().filter(tk => !included(s, tk.id)).map(tk => tankName(tk.id)),
      kpi: {
        total: tanksOut.length,
        good: tanksOut.filter(x => x.level === 'good').length,
        out: tanksOut.filter(x => x.level === 'warn' || x.level === 'crit').length,
        crit: tanksOut.filter(x => x.level === 'crit').length,
        stale: tanksOut.filter(x => x.stale).length,
        due: due.length, overdue: due.filter(x => x.interval.remaining < 0).length
      },
      events: recent.map(e => ({ date: e.date, tank: tankName(e.tankId), type: e.type, detail: e.detail, by: e.by }))
    };
  }

  /* ---------------- the file ---------------- */

  function fileName(m) { return 'KGC_Bath_Status_Report_' + window.KGCXlsx.fmtDate(m.generated) + '.xlsx'; }

  function build(m, logo) {
    const X = window.KGCXlsx;
    const { C, fmtDate, dow, Styles, Sheet, bar, subTitle, note, emptyLine, table, status, pair } = X;
    const styles = new Styles();
    const sh = new Sheet(styles);
    sh.footer = 'Bath status report · ' + fmtDate(m.generated);

    X.header(sh, { title: 'BATH STATUS REPORT', lines: [
      'As of: ' + dow(m.generated) + ' ' + fmtDate(m.generated) + ', ' + m.generatedAt,
      'Generated ' + fmtDate(m.generated) + ' ' + m.generatedAt +
        (m.preparedBy ? '   ·   Prepared by ' + m.preparedBy + (m.preparedTitle ? ', ' + m.preparedTitle : '') : '')
    ] }, X.pngSize(logo));

    const k = m.kpi;
    X.cardRow(sh, [
      { label: 'TANKS IN REPORT', v: k.total, fmt: '0', sub: m.excluded.length ? 'Not included: ' + m.excluded.length : 'All tanks with a standard' },
      { label: 'WITHIN STANDARD', v: k.good, fmt: '0', sub: 'Every reading in range' },
      { label: 'OUT OF STANDARD', v: k.out, fmt: '0', hot: k.out > 0, sub: 'A reading out of range' },
      { label: 'CRITICAL', v: k.crit, fmt: '0', hot: k.crit > 0, sub: 'Beyond the critical limit' },
      { label: 'NOT MEASURED IN ' + STALE_DAYS + ' DAYS', v: k.stale, fmt: '0', hot: k.stale > 0, sub: 'Last reading older, or none' },
      { label: 'BATH CHANGES DUE IN ' + DUE_SOON + ' DAYS', v: k.due, fmt: '0', hot: k.overdue > 0, sub: 'Overdue: ' + k.overdue }
    ]);
    if (m.excluded.length) note(sh, 'Not included in this report (chosen on the site): ' + m.excluded.join(', ') + '.');

    let n = 0;
    if (m.parts.readings) {
      bar(sh, ++n + '   TANK READINGS');
      subTitle(sh, 'Current readings, as on the tank dashboard, against the standard limits');
      const rows = [];
      // parameters never measured would fill the page with dashes; a tank with
      // no reading at all keeps one row so it is still seen
      m.tanks.forEach(function (x) {
        const shown = x.params.filter(p => p.v != null);
        (shown.length ? shown : [{ param: 'No reading', v: null, range: '' }]).forEach(function (p, i) {
          const old = p.v != null && (p.age == null || p.age > STALE_DAYS);
          rows.push([
            i ? { v: '', blank: 1 } : { v: x.name, b: 1 },
            p.param,
            p.v,
            p.v == null ? null : p.date ? Object.assign({ v: p.date }, old ? { color: C.warnFg, b: 1 } : {}) : { v: 'date unknown', color: C.warnFg, h: 'center' },
            p.age == null ? null : Object.assign({ v: p.age, h: 'center' }, old ? { color: C.warnFg, b: 1 } : {}),
            p.v == null ? { v: 'Not measured', color: C.muted, h: 'center' } : p.tier === 'none' ? null : status(p.tier),
            p.range,
            i ? { v: '', blank: 1 } : (x.serviceKey === 'in_service' ? x.service
              : Object.assign(status(x.serviceKey === 'out_of_service' ? 'crit' : 'warn'), { v: x.service }))
          ]);
        });
      });
      table(sh, [
        { label: 'Tank', span: 2 }, { label: 'Parameter', span: 2 }, { label: 'Reading', span: 1, h: 'right' },
        { label: 'Reading date', span: 1, h: 'center' }, { label: 'Age (days)', span: 1, h: 'center' },
        { label: 'Status', span: 1, h: 'center' }, { label: 'Standard range', span: 2, h: 'center' },
        { label: 'Tank in service', span: 2, h: 'center' }
      ], rows, { limit: 80 });
      note(sh, 'A date and age in orange: the last reading is more than ' + STALE_DAYS + ' days old, so the tank may have moved since. ' +
        'Parameters never measured on a tank are left out.');
      pair(sh, 'Tank notes', m.tanks.filter(x => x.note).map(x => x.name + ': ' + x.note).join('  ·  '), 'none');
    }

    if (m.parts.life) {
      bar(sh, ++n + '   BATH CHANGES AND EXPECTED LIFE');
      table(sh, [
        { label: 'Tank', span: 2 }, { label: 'Last renewal', span: 1, h: 'center' }, { label: 'Days since', span: 1, h: 'center' },
        { label: 'Last adjustment', span: 1, h: 'center' }, { label: 'Adjustment', span: 3 },
        { label: 'Usual interval', span: 1, h: 'center' }, { label: 'Next change due', span: 1, h: 'center' },
        { label: 'Days left', span: 1, h: 'center' }, { label: 'Iron at limit by', span: 1, h: 'center' }
      ], m.tanks.map(function (x) {
        const iv = x.interval;
        const left = !iv ? null : iv.remaining < 0
          ? Object.assign(status('crit'), { v: Math.abs(iv.remaining) + ' overdue' })
          : iv.remaining <= DUE_SOON ? Object.assign(status('warn'), { v: iv.remaining }) : { v: iv.remaining, h: 'center' };
        const fe = x.iron;
        return [
          { v: x.name, b: 1 },
          x.renewal ? x.renewal.date : null,
          x.renewal ? { v: x.renewal.days, h: 'center' } : null,
          x.adjust ? x.adjust.date : null,
          x.adjust ? x.adjust.text : { v: 'None recorded', color: C.muted },
          iv ? { v: 'Every ' + Math.round(iv.mean) + ' d', h: 'center' }
            : { v: x.intervalHave != null ? 'Not enough history' : '—', color: C.muted, h: 'center' },
          iv ? iv.due : null,
          left,
          !fe ? null : fe.atLimit ? Object.assign(status('crit'), { v: 'At limit now' }) : fe.date
        ];
      }), { limit: 20 });
      note(sh, 'Usual interval: the average number of days between the tank\'s past renewals (three or more needed); the next change is the last renewal plus that average — when the bath has usually been changed, not a measurement.');
      note(sh, 'Iron at limit by: when iron reaches the standard maximum if it keeps rising at its present rate since the last renewal (a straight line through the iron readings) — an estimate that moves with production.');
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

    const title = 'KGC Bath Status Report — ' + fmtDate(m.generated);
    return { blob: X.pack(sh, styles, { title: title, creator: m.preparedBy, sheetName: 'Bath Status', logo: logo }),
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
          '<div class="wk-chips col">' + SECTIONS.map(k =>
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
      const next = { tanksOff: {}, sectionsOff: {}, days: Number(wrap.querySelector('#tr-days').value),
        preparedBy: wrap.querySelector('#tr-by').value.trim(), preparedTitle: wrap.querySelector('#tr-title').value.trim() };
      wrap.querySelectorAll('[data-tr-tank]').forEach(el => { if (!el.checked) next.tanksOff[el.getAttribute('data-tr-tank')] = true; });
      wrap.querySelectorAll('[data-tr-part]').forEach(el => { if (!el.checked) next.sectionsOff[el.getAttribute('data-tr-part')] = true; });
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
