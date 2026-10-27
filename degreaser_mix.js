/* Volume planning only. Does not read or write Firebase, and never treats
   the historical charge or a titration % of unspecified basis as current v/v. */
(function () {
  'use strict';
  const core = window.KGCDegreaserCore, mount = document.getElementById('degreaser-mix-body');
  if (!core || !mount) return;
  let state = { mode: 'fresh', volume: '28000', target: '10', current: '', capacity: '', basisVerified: false };
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tr = key => esc(t('dm.' + key));
  const fmt = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 1 });
  function render() {
    mount.innerHTML = `<div class="dg-card dm-card">
      <div class="dg-heading"><div><p class="dg-eyebrow">${tr('eyebrow')}</p><h3>${tr('title')}</h3></div><span class="dg-method">${tr('rangeBadge')}</span></div>
      <div class="dm-source"><p>${tr('sourceRecipe')}</p><p class="dg-help">${tr('sourceBasis')}</p></div>
      <div class="dg-workspace"><div class="dg-inputs">
        <label for="dm-mode">${tr('mode')}</label><select id="dm-mode"><option value="fresh" ${state.mode === 'fresh' ? 'selected' : ''}>${tr('modeFresh')}</option><option value="add" ${state.mode === 'add' ? 'selected' : ''}>${tr('modeAdd')}</option><option value="replace" ${state.mode === 'replace' ? 'selected' : ''}>${tr('modeReplace')}</option></select>
        <div class="dm-field"><label for="dm-volume" id="dm-volume-label">${tr(state.mode === 'fresh' ? 'finalVolume' : 'currentVolume')}</label><input id="dm-volume" type="number" min="0" step="any" inputmode="decimal" value="${esc(state.volume)}" aria-describedby="dm-error"></div>
        <div class="dm-field"><label for="dm-target">${tr('target')}</label><input id="dm-target" type="number" min="0" max="100" step="any" inputmode="decimal" value="${esc(state.target)}" aria-describedby="dm-error"></div>
        <div class="dm-presets">${[['minParts','presetLow'],['midParts','presetMid'],['maxParts','presetHigh']].map(([key,label]) => `<button class="btn mini" type="button" data-mix-parts="${core.RECIPE[key]}">${tr(label)}<strong dir="ltr">${core.percentFromParts(core.RECIPE[key]).toFixed(2)}%</strong></button>`).join('')}</div>
        <div id="dm-current-fields" ${state.mode === 'fresh' ? 'hidden' : ''}>
          <label for="dm-current">${tr('current')}</label><input id="dm-current" type="number" min="0" max="100" step="any" inputmode="decimal" value="${esc(state.current)}" aria-describedby="dm-current-help dm-error">
          <p id="dm-current-help" class="dg-help">${tr('currentHelp')}</p>
          <label class="dg-check"><input id="dm-basis" type="checkbox" ${state.basisVerified ? 'checked' : ''}><span>${tr('basisConfirm')}</span></label>
        </div>
        <div class="dm-field"><label for="dm-capacity">${tr('capacity')}</label><input id="dm-capacity" type="number" min="0" step="any" inputmode="decimal" value="${esc(state.capacity)}" aria-describedby="dm-capacity-help dm-error"><p id="dm-capacity-help" class="dg-help">${tr('capacityHelp')}</p></div>
        <p class="dg-help">${tr('initialCharge')}</p>
      </div><div class="dg-output">
        <p id="dm-plan-title" class="dg-eyebrow"></p><div class="dm-amounts"><div><span>${tr('product')}</span><strong id="dm-product" dir="ltr">—</strong></div><div><span>${tr('water')}</span><strong id="dm-water" dir="ltr">—</strong></div></div>
        <div class="dm-bar" id="dm-bar" aria-hidden="true"><span id="dm-product-bar"></span></div>
        <p id="dm-result-note" class="dg-help"></p>
        <p id="dm-error" class="dg-error" role="status"></p>
        <p id="dm-capacity-warning" class="dg-error" role="status"></p>
        <dl class="dg-metrics"><div><dt>${tr('resultVolume')}</dt><dd id="dm-result-volume" dir="ltr">—</dd></div><div><dt>${tr('withdraw')}</dt><dd id="dm-withdraw" dir="ltr">—</dd></div><div><dt>${tr('equivalentRecipe')}</dt><dd id="dm-ratio" dir="ltr">—</dd></div></dl>
        <p id="dm-range" class="dm-range"></p><p id="dm-reference" class="dg-help"></p>
        <p id="dm-formula" class="dg-equation" dir="ltr"></p>
        <p class="dg-help dm-planning">${tr('planningOnly')}</p>
      </div></div>
      <details class="dg-protocol"><summary>${tr('methodTitle')}</summary><p>${tr('methodFresh')}</p><p>${tr('methodAdd')}</p><p>${tr('methodReplace')}</p><p class="dg-help">${tr('methodAssumptions')}</p><p class="dg-help">${tr('source')}</p></details>
    </div>`;
    for (const [id,key] of [['dm-volume','volume'],['dm-target','target'],['dm-current','current'],['dm-capacity','capacity']]) {
      document.getElementById(id).addEventListener('input', function () {
        state[key] = this.value;
        if (key === 'current') { state.basisVerified = false; document.getElementById('dm-basis').checked = false; }
        update();
      });
    }
    document.getElementById('dm-mode').addEventListener('change', function () {
      state.mode = this.value;
      document.getElementById('dm-current-fields').hidden = this.value === 'fresh';
      document.getElementById('dm-volume-label').textContent = t(this.value === 'fresh' ? 'dm.finalVolume' : 'dm.currentVolume');
      update();
    });
    document.getElementById('dm-basis').addEventListener('change', function () { state.basisVerified = this.checked; update(); });
    mount.querySelectorAll('[data-mix-parts]').forEach(button => button.addEventListener('click', function () {
      state.target = String(core.percentFromParts(Number(button.dataset.mixParts)));
      document.getElementById('dm-target').value = state.target;
      update();
    }));
    update();
  }
  function update() {
    const plan = core.makeup(state), valid = !plan.error;
    const set = (id, value) => { document.getElementById(id).textContent = value; };
    set('dm-product', valid ? fmt(plan.product) + ' L' : '—');
    set('dm-water', valid ? fmt(plan.water) + ' L' : '—');
    set('dm-plan-title', t('dm.' + (state.mode === 'fresh' ? 'planFresh' : state.mode === 'replace' ? 'planReplace' : 'planAdd')));
    set('dm-result-volume', valid ? fmt(plan.finalVolume) + ' L' : '—');
    set('dm-withdraw', valid ? fmt(plan.withdraw) + ' L' : '—');
    set('dm-ratio', valid ? fmt(plan.productPer1000Water) + ' / 1,000' : '—');
    set('dm-error', valid ? '' : t('dm.error.' + plan.error));
    set('dm-capacity-warning', !valid ? '' : plan.overCapacity ? t('dm.overCapacity', { excess: fmt(plan.finalVolume - plan.capacity) }) : plan.capacity == null && state.mode === 'add' ? t('dm.capacityUnknown') : '');
    set('dm-range', valid ? t('dm.range.' + plan.supplierRange) : '');
    document.getElementById('dm-range').classList.toggle('dm-outside', valid && plan.supplierRange !== 'within');
    set('dm-reference', valid ? t('dm.reference', { min: fmt(plan.referenceMinProduct), max: fmt(plan.referenceMaxProduct), volume: fmt(plan.volume) }) : '');
    set('dm-result-note', valid ? t('dm.' + (state.mode === 'fresh' ? 'freshNote' : state.mode === 'replace' ? 'replaceNote' : 'addNote')) : '');
    const bar = document.getElementById('dm-bar'); bar.hidden = !valid || state.mode !== 'fresh';
    document.getElementById('dm-product-bar').style.width = valid ? plan.target + '%' : '0%';
    set('dm-formula', !valid ? '' : state.mode === 'fresh' ? fmt(plan.volume) + ' × ' + fmt(plan.target) + ' / 100 = ' + fmt(plan.product) + ' L' : '');
  }
  // Both tools live inside the original Lab page. No new app route or login.
  const tabs = document.querySelectorAll('[data-degreaser-panel]');
  function selectTab(button, focus) {
    tabs.forEach(tab => {
      const selected = tab === button;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.dataset.degreaserPanel).hidden = !selected;
    });
    if (focus) button.focus();
  }
  tabs.forEach((button,index) => {
    button.addEventListener('click', () => selectTab(button, false));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const rtl = document.documentElement.dir === 'rtl';
      const direction = (event.key === 'ArrowRight' ? 1 : -1) * (rtl ? -1 : 1);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + direction + tabs.length) % tabs.length;
      selectTab(tabs[next], true);
    });
  });
  render();
  if (window.I18N) I18N.onChange(render);
})();
