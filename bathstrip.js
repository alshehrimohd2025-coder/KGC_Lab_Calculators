/* ============================================================
   Bath ages — a strip under the tank cards
   ------------------------------------------------------------
   Each bath as a bar: how many days it has run against the average of its
   own past cycles, with the expected change date. It reads the replacement
   forecast (forecast.js), which is built from the plant's own logged
   replacements, so every figure here is a record, not a measurement.

   Depends on globals from index.html: t(), tankLabel(), and window.KGCForecast.
   ============================================================ */
(function () {
  'use strict';
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const COLOR = { good: 'var(--ink-3)', warn: 'var(--warn)', crit: 'var(--crit)' };

  function render() {
    const mount = document.getElementById('bath-strip');
    if (!mount) return;
    const F = window.KGCForecast;
    const list = F && F.all ? F.all() : [];
    if (!list.length) { mount.innerHTML = ''; return; }
    mount.innerHTML =
      '<h3 class="zb-h" style="margin:28px 2px 4px">' + esc(t('bs.title')) + '</h3>' +
      '<p class="lab-life-sub" style="margin:0 2px 10px">' + esc(t('bs.sub')) + '</p>' +
      '<div class="bs-list">' + list.map(function (x) {
        const f = x.f, c = COLOR[f.tier] || COLOR.good;
        const pct = Math.min(100, f.since / (f.mean || 1) * 100);
        const when = f.remaining < 0 ? t('bs.over', { n: Math.abs(f.remaining) }) : t('bs.in', { n: f.remaining });
        return '<div class="bs-row"><span class="bs-name">' + esc(tankLabel(x.tank.name)) + '</span>' +
          '<span class="bs-bar" dir="ltr" title="' + esc(t('bs.age', { n: f.since, m: Math.round(f.mean) })) + '">' +
            '<i style="width:' + pct.toFixed(0) + '%;background:' + c + '"></i>' +
            '<em style="left:' + Math.min(100, (f.mean - f.sd) / f.mean * 100).toFixed(0) + '%"></em></span>' +
          '<span class="bs-when" style="color:' + c + '">' + esc(when) + '<small>' + esc(f.due) + '</small></span></div>';
      }).join('') + '</div>';
  }

  database.ref('renewals').on('value', () => setTimeout(render, 0));
  database.ref('tanks_data').on('value', () => setTimeout(render, 0));
  if (window.I18N && I18N.onChange) I18N.onChange(render);
  document.addEventListener('DOMContentLoaded', () => setTimeout(render, 0));
})();
