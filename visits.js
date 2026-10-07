/* ============================================================
   Manager page visits — did anyone open the dashboard?
   ------------------------------------------------------------
   Each time the manager's link (no ?edit) is opened, one record is
   appended at visits/<YYYY-MM-DD>/<pushId>: the time, phone or computer,
   and the page language. Nothing identifies a person; the link is shared,
   so a visit means "the manager's page was opened", not by whom.
   Counted once per browser tab, and never for the editor's own account.

   The write needs a rule allowing anonymous appends under visits/ (see
   database.rules.json); until it is published, the write fails silently
   and the engineer's panel says so.

   Depends on globals from index.html: database, IS_EDITOR, IS_AUTHED,
   EDITOR_EMAIL, t().
   ============================================================ */
(function () {
  'use strict';
  if (typeof database === 'undefined') return;

  const pad = n => (n < 10 ? '0' : '') + n;
  const dayKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

  /* ---------- record (manager view only) ---------- */
  function record() {
    try {
      if (typeof IS_EDITOR !== 'undefined' && IS_EDITOR) return;
      if (sessionStorage.getItem('kgc-visit')) return;
      const u = firebase.auth && firebase.auth().currentUser;
      if (u && (u.email || '').toLowerCase() === String(EDITOR_EMAIL).toLowerCase()) return;   // the engineer checking
      const now = new Date();
      database.ref('visits/' + dayKey(now)).push({
        ts: now.getTime(),
        dev: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'phone' : 'computer',
        lang: document.documentElement.classList.contains('lang-en') ? 'en' : 'ar'
      }).then(() => { try { sessionStorage.setItem('kgc-visit', '1'); } catch (e) {} })
        .catch(() => {});                                // rule not published yet: say nothing to the viewer
    } catch (e) {}
  }
  // wait for the auth state so the editor's own visits are never counted
  if (firebase.auth) {
    let done = false;
    firebase.auth().onAuthStateChanged(function () { if (!done) { done = true; setTimeout(record, 1500); } });
  } else setTimeout(record, 1500);

  /* ---------- report (engineer's page) ---------- */
  let visits = {};
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function render() {
    const mount = document.getElementById('visits-panel');
    if (!mount) return;
    if (typeof IS_EDITOR === 'undefined' || !IS_EDITOR) { mount.innerHTML = ''; return; }
    const list = [];
    Object.keys(visits || {}).forEach(d => Object.values(visits[d] || {}).forEach(v => { if (v && v.ts) list.push(v); }));
    list.sort((a, b) => b.ts - a.ts);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const since = days => list.filter(v => v.ts >= today.getTime() - (days - 1) * 86400000).length;
    const when = ts => {
      const d = new Date(ts), dd = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
      const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
      return (dd === 0 ? t('vs.today') : dd === 1 ? t('vs.yesterday') : dayKey(d)) + ' ' + hm;
    };
    // a 14-day strip, one cell per day, darker for more opens
    const cells = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000), k = dayKey(d);
      const n = Object.keys((visits || {})[k] || {}).length;
      cells.push('<i class="vs-c' + (n ? ' on' : '') + '" style="' + (n ? 'opacity:' + Math.min(1, .35 + n * .2) : '') + '" title="' + k + ': ' + n + '"></i>');
    }
    mount.innerHTML = '<div class="vs">' +
      '<b class="vs-t">' + esc(t('vs.title')) + '</b>' +
      (list.length
        ? '<span>' + esc(t('vs.last', { w: when(list[0].ts), dev: t('vs.dev.' + list[0].dev) })) + '</span>' +
          '<span>' + esc(t('vs.counts', { a: since(7), b: since(30) })) + '</span>' +
          '<span class="vs-strip" dir="ltr">' + cells.join('') + '</span>'
        : '<span class="vs-none">' + esc(t('vs.none')) + '</span>') +
      '</div>';
  }

  database.ref('visits').limitToLast(31).on('value', s => { visits = s.val() || {}; render(); }, () => render());
  if (window.I18N && I18N.onChange) I18N.onChange(render);
  document.addEventListener('DOMContentLoaded', render);
  window.KGCVisits = { render: render };
})();
