/* Presentation layer only. It never reads or writes factory records. */
(function () {
  'use strict';
  const root = document.documentElement;
  const descriptions = {
    'page-tasks': 'tasks', 'page-tanks': 'tanks', 'page-timing': 'timing',
    'page-actions': 'actions', 'page-acid': 'acid', 'page-pickling': 'pickling',
    'page-flux': 'flux', 'page-lab': 'lab', 'page-kettle': 'kettle',
    'page-coating': 'coating', 'page-standards': 'standards', 'page-zinc': 'zinc',
    'page-zincbal': 'zincbal', 'page-weekly': 'weekly'
  };
  const editor = root.classList.contains('mode-edit');
  function update() {
    const active = document.querySelector('.topnav button[data-page].active');
    const page = active && active.dataset.page;
    const title = active && active.querySelector('[data-i18n]');
    const group = active && active.closest('.navgroup').querySelector('.navgroup-label');
    const heading = document.getElementById('experience-page-title');
    if (editor && heading && title) heading.textContent = title.textContent;
    document.getElementById('experience-page-group').textContent = editor && group ? group.textContent : t('experience.overview');
    document.getElementById('experience-role').textContent = t(editor ? 'experience.engineer' : 'experience.viewer');
    document.getElementById('experience-description').textContent = t('experience.desc.' + (editor ? descriptions[page] || 'tasks' : 'manager'));
    const date = document.getElementById('experience-date');
    const now = new Date();
    date.dateTime = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    date.textContent = now.toLocaleDateString(root.lang === 'en' ? 'en-GB' : 'ar-SA-u-ca-gregory-nu-latn', { weekday: 'short', day: 'numeric', month: 'short' });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
    document.querySelectorAll('.topnav [data-page]').forEach(el => {
      if (el.classList.contains('active')) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
    document.querySelectorAll('.navgroup-label').forEach(el => el.setAttribute('aria-expanded', String(!el.parentElement.classList.contains('folded'))));
    updateThemeLabel();
  }
  function isDark() {
    return root.dataset.theme === 'dark' || (!root.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function updateThemeLabel() {
    const button = document.getElementById('experience-theme');
    const label = t(isDark() ? 'experience.light' : 'experience.dark');
    button.setAttribute('aria-label', label);
    button.title = label;
  }
  document.getElementById('experience-theme').addEventListener('click', function () {
    root.dataset.theme = isDark() ? 'light' : 'dark';
    try { localStorage.setItem('kgc-appearance', root.dataset.theme); } catch (e) { /* unavailable storage */ }
    updateThemeLabel();
  });
  try {
    const theme = localStorage.getItem('kgc-appearance');
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  } catch (e) { /* retain system appearance */ }
  document.addEventListener('kgc:pagechange', update);
  document.addEventListener('click', function (e) {
    if (e.target.closest('.navgroup-label')) requestAnimationFrame(update);
  });
  // Keep the small-screen drawer usable with a keyboard as well as touch.
  document.addEventListener('keydown', function (e) {
    const nav = document.querySelector('.topnav.open');
    if (!nav || window.innerWidth >= 900) return;
    if (e.key === 'Escape') {
      toggleNav(); document.getElementById('navtoggle').focus();
    } else if (e.key === 'Tab') {
      const nodes = [...nav.querySelectorAll('button, [tabindex="0"]')].filter(el => el.getClientRects().length);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  // Bind the existing visual labels to their inputs without changing forms.
  document.querySelectorAll('.input-group, .field').forEach(function (group) {
    const label = group.querySelector('label');
    const input = group.querySelector('input[id], select[id], textarea[id]');
    if (label && input && !label.htmlFor) label.htmlFor = input.id;
  });
  if (window.I18N) I18N.onChange(update);
  document.addEventListener('DOMContentLoaded', update);
  update();
})();
