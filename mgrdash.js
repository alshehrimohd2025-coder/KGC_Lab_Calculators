/* ============================================================
   Manager's summary — measured figures only
   ------------------------------------------------------------
   Everything here is weighed or read off the kettle, never inferred from
   handwritten thickness readings:
     - zinc consumption this month against last (level drop x 555 kg/cm,
       a factor that weighed ingots confirm to 0.3% over 52 days)
     - production tonnage (weighed)
     - zinc added (weighed ingots)
     - dross removed per tonne (weighed)
   Estimates built on the jig sheets (avoidable zinc, reactive steel,
   re-pass) stay on the engineer's zinc-balance page with their confidence
   beside them, and do not appear here.

   Depends on globals from index.html: database, t(), and window.KGCZinc.
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') return;

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const fmt = (v, d) => Number(v).toLocaleString(undefined, { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 });

  /* Each card compares the same figure over three windows, stacked so the
     difference reads straight down: this month so far, last month in full,
     and the last 30 calendar days (which always has a month's worth of days,
     so it stays comparable in the first week of a month). Stop days with no
     tonnage still count for zinc added and dross, not for per-tonne rates. */
  function windows() {
    const Z = window.KGCZinc;
    const days = Object.values((Z && Z._days && Z._days()) || {}).filter(d => d && d.date)
      .sort((a, b) => a.date < b.date ? -1 : 1);
    if (!days.length) return null;
    const last = days[days.length - 1].date;
    const cur = last.slice(0, 7);
    const pd = new Date(cur + '-01T00:00:00'); pd.setMonth(pd.getMonth() - 1);
    const prev = pd.getFullYear() + '-' + String(pd.getMonth() + 1).padStart(2, '0');
    const c30 = new Date(last + 'T00:00:00'); c30.setDate(c30.getDate() - 29);
    const from30 = c30.toISOString().slice(0, 10);
    const agg = pick => {
      const r = { kg: 0, zn: 0, rel: 0, dross: 0, days: 0, first: '', last: '', daily: [], drossDays: [], stopDays: [] };
      days.filter(pick).forEach(function (d) {
        const kg = num(d.dayTon) + num(d.nightTon);
        const zn = num(d.dayPct) / 100 * num(d.dayTon) + num(d.nightPct) / 100 * num(d.nightTon);
        r.rel += num(d.release); r.dross += num(d.dross);
        if (num(d.dross) > 0) r.drossDays.push({ date: d.date, kg: num(d.dross), rel: num(d.release) });
        if (!(num(d.dayTon) + num(d.nightTon) > 0) && num(d.release) > 0) r.stopDays.push({ date: d.date, rel: num(d.release) });
        if (kg > 0 && zn > 0) {
          r.kg += kg; r.zn += zn; r.days++;
          if (!r.first) r.first = d.date; r.last = d.date;
          r.daily.push({ date: d.date, v: zn / kg * 1000 });
        }
      });
      r.cons = r.kg ? r.zn / r.kg * 1000 : null;
      r.perDay = r.days ? r.kg / r.days / 1000 : null;
      r.relT = r.kg ? r.rel / r.kg * 1000 : null;
      r.drossT = r.kg ? r.dross / r.kg * 1000 : null;
      return r;
    };
    return { cur: cur, prev: prev, last: last,
             C: agg(d => d.date.slice(0, 7) === cur),
             P: agg(d => d.date.slice(0, 7) === prev),
             R: agg(d => d.date >= from30 && d.date <= last) };
  }

  const monthName = ym => {
    try {
      const en = document.documentElement.classList.contains('lang-en');
      return new Date(ym + '-01T00:00:00').toLocaleDateString(en ? 'en-GB' : 'ar-SA-u-ca-gregory-nu-latn', { month: 'long' });
    } catch (e) { return ym; }
  };

  /* A verdict on a month that has barely started is unfair to it -- two
     days against a full month, or a single drossing day. The arrow appears
     once the month has this many production days; before that the card
     says it is too early. */
  const MIN_DAYS = 7;

  /* last month | this month, side by side, one line of difference beneath */
  function card(title, unit, digits, W, key, lowerIsBetter, why, total) {
    const v = r => r && r.kg && r[key] != null ? r[key] : null;
    const cv = v(W.C), pv = v(W.P);
    // total: optional (period) => text with the period's absolute quantity
    const col = (lbl, val, days, now, r) => '<div class="mg-col' + (now ? ' now' : '') + '"><span class="mg-col-k">' + esc(lbl) + '</span>' +
      '<span class="mg-col-v">' + (val != null ? fmt(val, digits) : '—') + '<small>' + esc(unit) + '</small></span>' +
      (total ? '<span class="mg-col-tot">' + total(r) + '</span>' : '') +
      '<span class="mg-col-d">' + esc(t('mg.days', { n: days })) + '</span></div>';
    let verdict;
    if (cv == null || pv == null) verdict = '';
    else if (W.C.days < MIN_DAYS) verdict = '<span class="mg-verdict mg-flat">' + esc(t('mg.early', { n: W.C.days, m: MIN_DAYS })) + '</span>';
    else {
      const d = cv - pv, pct = pv ? d / pv * 100 : 0;
      const bad = lowerIsBetter ? d > 0 : d < 0;
      verdict = Math.abs(pct) < 1.5
        ? '<span class="mg-verdict mg-flat">' + esc(t('mg.same')) + '</span>'
        : '<span class="mg-verdict mg-' + (bad ? 'up' : 'down') + '">' + (d > 0 ? '▲ ' : '▼ ') + fmt(Math.abs(d), digits) + ' ' +
          esc(unit) + ' (' + (d > 0 ? '+' : '−') + Math.abs(pct).toFixed(0) + '%)</span>';
    }
    return '<div class="mg-card"><span class="mg-k">' + esc(title) + '</span>' +
      '<div class="mg-pair">' + col(monthName(W.prev), pv, W.P.days, false, W.P) + col(monthName(W.cur), cv, W.C.days, true, W.C) + '</div>' +
      verdict + (why && W.C.days < MIN_DAYS ? '<p class="mg-why">' + esc(why) + '</p>' : '') + '</div>';
  }

  /* Why an early-month figure looks high, from the month's own records:
     a drossing or a refill on a stop day lands in full on the few tonnes
     produced so far. */
  function reasons(W) {
    const C = W.C, tns = fmt(C.kg / 1000);
    const day = ds => ds.map(x => Number(x.date.slice(8))).join(t('mg.and'));
    const out = {};
    if (C.drossDays.length) {
      out.dross = t('mg.why.dross', { kg: fmt(C.drossDays.reduce((a, x) => a + x.kg, 0)), d: day(C.drossDays), t: tns, n: C.days });
    }
    if (C.stopDays.length) {
      out.added = t('mg.why.added', { kg: fmt(C.stopDays.reduce((a, x) => a + x.rel, 0)), d: day(C.stopDays), t: tns });
    }
    out.cons = t('mg.why.early', { n: C.days });
    out.prod = C.stopDays.length ? t('mg.why.prod', { d: day(C.stopDays) }) : t('mg.why.early', { n: C.days });
    return out;
  }

  /* ---------------- what the manager sees ----------------
     Every block can be switched off from the engineer's page; the choice is
     stored at mgr_settings/show and applies on the manager's screen at once.
     The engineer still sees hidden blocks, dimmed and labelled, so the page
     can be checked without switching views. */
  const BLOCKS = ['status', 'fresh', 'cons', 'prod', 'added', 'dross'];
  let show = {}, readings = {};
  const isOn = k => show[k] !== false;
  const editor = () => typeof IS_EDITOR !== 'undefined' && IS_EDITOR;
  const canSave = () => editor() && typeof IS_AUTHED !== 'undefined' && IS_AUTHED;
  // hidden from the manager: not drawn at all; for the engineer: drawn, dimmed
  const wrap = (k, html) => !html ? '' : isOn(k) ? html : editor()
    ? '<div class="mg-off" data-off-label="' + esc(t('mg.hiddenTag')) + '">' + html + '</div>' : '';

  /* one sentence: what needs attention right now */
  function statusLine(W) {
    const H = window.KGCHints, F = window.KGCForecast;
    const parts = [];
    if (H && typeof tanks !== 'undefined') {
      const bad = tanks.slice().sort((a, b) => a.id - b.id)
        .map(tk => ({ tk: tk, d: H.diagnose(tk) })).filter(x => x.d && (x.d.tier === 'warn' || x.d.tier === 'crit'));
      const crit = bad.some(x => x.d.tier === 'crit');
      parts.push(bad.length
        ? '<span class="st-' + (crit ? 'crit' : 'warn') + '">' + esc(t('mg.st.need', { n: bad.length })) + '</span> ' +
          esc(bad.map(x => tankLabel(x.tk.name)).join('، '))
        : '<span class="st-good">' + esc(t('mg.st.allOk')) + '</span>');
    }
    const next = F && F.all ? F.all()[0] : null;
    if (next) {
      parts.push(esc(next.f.remaining < 0
        ? t('mg.st.overdue', { tank: tankLabel(next.tank.name), n: Math.abs(next.f.remaining) })
        : t('mg.st.next', { tank: tankLabel(next.tank.name), n: next.f.remaining })));
    }
    if (W && W.C.kg && W.P.kg) {
      if (W.C.days < MIN_DAYS) parts.push(esc(t('mg.st.consEarly')));
      else {
        const pct = (W.C.cons - W.P.cons) / W.P.cons * 100;
        parts.push(Math.abs(pct) < 1.5 ? esc(t('mg.st.consSame'))
          : '<span class="st-' + (pct > 0 ? 'warn' : 'good') + '">' + esc(t(pct > 0 ? 'mg.st.consUp' : 'mg.st.consDown', { p: Math.abs(pct).toFixed(0) })) + '</span>');
      }
    }
    return parts.length ? '<div class="mg-status">' + parts.join('<i>·</i>') + '</div>' : '';
  }

  /* how old the figures are, so a stale page is never read as today */
  function freshLine(W) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const age = d => d ? Math.round((today - new Date(d + 'T00:00:00')) / 86400000) : null;
    let lastRead = '';
    Object.values(readings || {}).forEach(r => { if (r && r.date && r.date > lastRead) lastRead = r.date; });
    const item = (label, d, warnAfter) => {
      if (!d) return '';
      const a = age(d);
      const txt = a <= 0 ? t('mg.fr.today') : a === 1 ? t('mg.fr.yesterday') : t('mg.fr.ago', { n: a });
      return '<span' + (a > warnAfter ? ' class="st-warn"' : '') + '>' + esc(label) + ': <b dir="ltr">' + esc(d) + '</b> (' + esc(txt) + ')</span>';
    };
    const html = [item(t('mg.fr.report'), W && W.last, 2), item(t('mg.fr.readings'), lastRead, 3)].filter(Boolean).join('<i>·</i>');
    return html ? '<div class="mg-fresh">' + html + '</div>' : '';
  }

  function settingsHTML() {
    if (!editor()) return '';
    return '<details class="mg-set"><summary>' + esc(t('mg.set.title')) + '</summary>' +
      '<p>' + esc(t('mg.set.sub')) + '</p><div class="mg-set-list">' +
      BLOCKS.map(k => '<label><input type="checkbox" data-mg-show="' + k + '"' + (isOn(k) ? ' checked' : '') +
        (canSave() ? '' : ' disabled') + '> ' + esc(t('mg.set.' + k)) + '</label>').join('') +
      '</div><span class="mg-set-msg"></span></details>';
  }

  function render() {
    const mount = document.getElementById('mgr-kpis');
    if (!mount) return;
    const W = windows();
    const openSet = !!(mount.querySelector('.mg-set') && mount.querySelector('.mg-set').open);
    if (!W) { mount.innerHTML = settingsHTML(); return; }
    const why = reasons(W);
    const cards = [
      wrap('cons', card(t('mg.cons'), 'kg/t', 1, W, 'cons', true, why.cons)),
      wrap('prod', card(t('mg.prod'), 't', 1, W, 'perDay', false, why.prod)),
      wrap('added', card(t('mg.added'), 'kg/t', 1, W, 'relT', true, why.added || why.cons)),
      wrap('dross', card(t('mg.dross'), 'kg/t', 1, W, 'drossT', true, why.dross || why.cons, function (r) {
        // the weighed total behind the rate, and how many times it was taken out
        return '<b>' + fmt(r.dross) + '</b> ' + esc(t('mg.kgTotal')) +
          (r.drossDays.length ? '<small>' + esc(t('mg.drossTimes', { n: r.drossDays.length, d: r.drossDays.map(x => Number(x.date.slice(8))).join('، ') })) + '</small>' : '');
      }))
    ].join('');
    mount.innerHTML = settingsHTML() +
      wrap('status', statusLine(W)) + wrap('fresh', freshLine(W)) +
      (cards ? '<div class="mg-grid">' + cards + '</div><p class="mg-foot">' + esc(t('mg.foot')) + '</p>' : '');
    if (openSet && mount.querySelector('.mg-set')) mount.querySelector('.mg-set').open = true;
    mount.querySelectorAll('[data-mg-show]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        if (!canSave()) return;
        const msg = mount.querySelector('.mg-set-msg');
        database.ref('mgr_settings/show/' + cb.getAttribute('data-mg-show')).set(cb.checked)
          .then(() => { if (msg) msg.textContent = t('mg.set.saved'); })
          .catch(e => { if (msg) msg.textContent = e.message; cb.checked = !cb.checked; });
      });
    });
  }

  database.ref('zinc_daily').on('value', () => setTimeout(render, 0));
  database.ref('mgr_settings/show').on('value', s => { show = s.val() || {}; render(); });
  database.ref('readings_log').on('value', s => { readings = s.val() || {}; render(); });
  database.ref('tanks_data').on('value', () => setTimeout(render, 0));
  database.ref('renewals').on('value', () => setTimeout(render, 0));
  if (window.I18N && I18N.onChange) I18N.onChange(render);
  window.KGCMgr = { render: render };
})();
