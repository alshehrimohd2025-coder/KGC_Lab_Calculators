/* ============================================================
   Auto-update — open pages pick up a new release by themselves
   ------------------------------------------------------------
   GitHub Pages lets browsers keep each file for 10 minutes, so a change
   could stay unseen on a page left open on a screen. This checks
   version.txt (never cached) every 3 minutes and whenever the tab comes
   back into view; when it differs from the version this page was built
   with, the page reloads -- but never while someone is typing into a
   field, so an unsaved entry is not lost. stamp_version.py writes both.
   ============================================================ */
(function () {
  'use strict';
  const meta = document.querySelector('meta[name="app-version"]');
  const mine = meta ? meta.getAttribute('content') : null;
  if (!mine) return;
  let pending = false;

  const busy = () => {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
  };
  /* one reload per new version per 10 minutes: if the browser still hands
     back the old page from its cache, wait for the cache to expire rather
     than reloading in a loop */
  function allowed(v) {
    try {
      const last = JSON.parse(sessionStorage.getItem('kgc-reload-for') || 'null');
      if (last && last.v === v && Date.now() - last.at < 10 * 60 * 1000) return false;
      sessionStorage.setItem('kgc-reload-for', JSON.stringify({ v: v, at: Date.now() }));
    } catch (e) {}
    return true;
  }
  let target = null;
  function reloadWhenIdle(v) {
    if (!allowed(v)) return;
    target = v;
    if (!busy()) { location.reload(); return; }
    pending = true;
  }
  document.addEventListener('focusout', () => { if (pending) setTimeout(() => { if (!busy()) location.reload(); }, 800); });

  function check() {
    fetch('version.txt?t=' + Date.now(), { cache: 'no-store' })
      .then(r => r.ok ? r.text() : null)
      .then(v => { v = (v || '').trim(); if (v && v !== mine) reloadWhenIdle(v); })
      .catch(() => {});
  }
  setInterval(check, 3 * 60 * 1000);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  setTimeout(check, 5000);
})();
