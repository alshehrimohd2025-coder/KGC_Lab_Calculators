'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../degreaser_core.js');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const close = (a,b) => assert.ok(Math.abs(a-b) < 1e-8, `${a} != ${b}`);
const fresh = overrides => core.makeup({ mode: 'fresh', volume: 28000, target: 10, ...overrides });
const adjust = overrides => core.makeup({ mode: 'add', volume: 28000, target: 10, current: 100*1600/28000, basisVerified: true, ...overrides });

test('supplier ratios are product per WATER, not 10–15 percent of final volume', () => {
  close(core.MIN_MAKEUP, 100*100/1100);
  close(core.MAX_MAKEUP, 100*150/1150);
  const low = fresh({ target: core.MIN_MAKEUP }), high = fresh({ target: core.MAX_MAKEUP });
  close(low.product, 2545.4545454545455);
  close(high.product, 3652.1739130434785);
  assert.equal(low.supplierRange, 'within'); assert.equal(high.supplierRange, 'within');
  close(low.product / low.water, 100/1000);
  close(high.product / high.water, 150/1000);
  assert.equal(fresh({ target: 8 }).supplierRange, 'low');
  assert.equal(fresh({ target: 15 }).supplierRange, 'high');
});

test('fresh fill returns exact requested final volume and never adds the full volume of water first', () => {
  const plan = fresh();
  assert.equal(plan.product, 2800); assert.equal(plan.water, 25200);
  close(plan.product + plan.water, 28000);
  close(plan.product / plan.finalVolume * 100, 10);
  assert.equal(plan.withdraw, 0);
});

test('adding concentrate accounts for rising volume and flags insufficient working space', () => {
  // Hypothetical known v/v reading; the UI never assumes the old charge is current.
  const plan = adjust({ capacity: 28000 });
  close(plan.product, 1333.3333333333333);
  close((1600 + plan.product) / plan.finalVolume * 100, 10);
  close(plan.finalVolume, 29333.333333333332);
  assert.equal(plan.overCapacity, true);
  assert.equal(plan.withdraw, 0); assert.equal(plan.water, 0);
});

test('fixed-volume replacement subtracts product lost in the withdrawn mixed bath', () => {
  const current = 100*1600/28000;
  const plan = adjust({ mode: 'replace', capacity: 28000 });
  close(plan.product, 1272.7272727272727);
  close(plan.withdraw, plan.product);
  close((1600 - plan.withdraw*current/100 + plan.product) / plan.finalVolume * 100, 10);
  assert.equal(plan.finalVolume, 28000); assert.equal(plan.overCapacity, false);
});

test('water addition and water replacement both conserve original product at the target', () => {
  const add = adjust({ current: 15 }), replace = adjust({ mode: 'replace', current: 15 });
  close(add.water, 14000); close(add.finalVolume, 42000);
  close(28000*0.15 / add.finalVolume * 100, 10);
  close(replace.water, replace.withdraw);
  close((28000-replace.withdraw)*0.15 / replace.finalVolume * 100, 10);
  assert.equal(add.product, 0); assert.equal(replace.product, 0);
});

test('known zero is accepted; matching targets need no addition; missing current reading is blocked', () => {
  const zero = adjust({ current: 0 });
  close(zero.product / zero.finalVolume * 100, 10);
  const same = adjust({ current: 10 });
  assert.equal(same.product + same.water + same.withdraw, 0);
  for (const current of ['', null, -1, 101, Infinity]) assert.equal(adjust({ current }).error, 'current');
  assert.equal(adjust({ basisVerified: false }).error, 'basis');
  assert.equal(fresh({ current: '', basisVerified: false }).error, undefined);
});

test('invalid quantities never produce a plan, while outside-range targets remain explicitly marked', () => {
  for (const volume of ['', 0, -1, Infinity]) assert.equal(fresh({ volume }).error, 'volume');
  for (const target of ['', 0, 100, -1, Infinity]) assert.equal(fresh({ target }).error, 'target');
  for (const capacity of [0, -1, 'abc']) assert.equal(fresh({ capacity }).error, 'capacity');
  assert.equal(fresh({ capacity: '' }).capacity, null);
  assert.equal(fresh({ capacity: 30000 }).overCapacity, false);
  assert.equal(fresh({ mode: 'other' }).error, 'mode');
});

function load() {
  let html = '', elements = {};
  const listeners = [];
  const panels = { 'dg-titration-panel': { hidden: false }, 'dg-mix-panel': { hidden: true } };
  function tab(panel) {
    const handlers = {};
    return { dataset: { degreaserPanel: panel }, attrs: {}, addEventListener: (event,fn) => { handlers[event] = fn; },
      setAttribute(name,value) { this.attrs[name] = value; }, focus() { this.focused = true; },
      click() { handlers.click(); }, key(key) { handlers.keydown({key,preventDefault(){}}); } };
  }
  const tabs = [tab('dg-titration-panel'),tab('dg-mix-panel')];
  const mount = {
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value; elements = {};
      for (const match of value.matchAll(/<(?:input|select|p|div|strong|span|dd|label|button)\b([^>]*)>/g)) {
        const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1],m[2]]));
        if (!attrs.id && !attrs['data-mix-parts']) continue;
        const handlers = {};
        elements[attrs.id || 'preset-'+attrs['data-mix-parts']] = {
          value: attrs.value || '', checked: /\bchecked\b/.test(match[1]), hidden: /\bhidden\b/.test(match[1]),
          dataset: { mixParts: attrs['data-mix-parts'] }, style: {}, classList: {toggle(){}}, textContent: '',
          addEventListener: (event,fn) => { handlers[event] = fn; },
          input(value) { this.value = value; handlers.input.call(this); },
          change(value) { this.value = value; this.checked = value; handlers.change.call(this); },
          click() { handlers.click.call(this); }
        };
      }
    },
    querySelectorAll() { return Object.values(elements).filter(el => el.dataset.mixParts); }
  };
  const context = { window: { KGCDegreaserCore: core, I18N: true },
    document: { getElementById: id => id === 'degreaser-mix-body' ? mount : elements[id] || panels[id],
      querySelectorAll: () => tabs, documentElement: { dir: 'rtl' } },
    I18N: { onChange: fn => listeners.push(fn) }, t: key => key,
    get database() { throw new Error('Planning must never access Firebase'); }
  };
  vm.runInNewContext(read('degreaser_mix.js'), context);
  return { el: id => elements[id], tabs, panels, listeners, context };
}

test('planner starts with 28000 L fresh fill and presets recompute without accessing plant data', () => {
  const ui = load();
  assert.equal(ui.el('dm-product').textContent, '2,800 L');
  assert.equal(ui.el('dm-water').textContent, '25,200 L');
  ui.el('preset-100').click(); assert.equal(ui.el('dm-product').textContent, '2,545.5 L');
  ui.el('preset-150').click(); assert.equal(ui.el('dm-product').textContent, '3,652.2 L');
  ui.el('dm-target').input(''); assert.equal(ui.el('dm-product').textContent, '—');
});

test('adjustment needs a current v/v reading and reconfirmation whenever that reading changes', () => {
  const ui = load(); ui.el('dm-mode').change('add');
  assert.equal(ui.el('dm-product').textContent, '—');
  ui.el('dm-current').input(String(100*1600/28000));
  assert.equal(ui.el('dm-error').textContent, 'dm.error.basis');
  ui.el('dm-basis').change(true);
  assert.equal(ui.el('dm-product').textContent, '1,333.3 L');
  ui.el('dm-capacity').input('28000');
  assert.equal(ui.el('dm-capacity-warning').textContent, 'dm.overCapacity');
  ui.el('dm-current').input('6');
  assert.equal(ui.el('dm-basis').checked, false); assert.equal(ui.el('dm-product').textContent, '—');
  ui.el('dm-basis').change(true); ui.el('dm-mode').change('replace');
  assert.equal(ui.el('dm-result-volume').textContent, '28,000 L');
  assert.equal(ui.el('dm-capacity-warning').textContent, '');
});

test('tool tabs support keyboard switching, and language changes preserve quantities and selection', () => {
  const ui = load(); ui.el('dm-target').input('12'); ui.tabs[1].click();
  assert.equal(ui.panels['dg-titration-panel'].hidden, true);
  assert.equal(ui.panels['dg-mix-panel'].hidden, false);
  ui.listeners[0](); assert.equal(ui.el('dm-target').value, '12');
  assert.equal(ui.panels['dg-mix-panel'].hidden, false);
  ui.tabs[1].key('Home'); assert.equal(ui.panels['dg-titration-panel'].hidden, false);
  ui.tabs[0].key('ArrowLeft'); assert.equal(ui.panels['dg-mix-panel'].hidden, false);
});

test('all planning strings ship in Arabic and English and the planner loads after its core', () => {
  const context = { window: {}, document: { addEventListener() {}, querySelectorAll() { return []; } }, localStorage: { getItem() {} } };
  vm.runInNewContext(read('i18n.js'), context);
  const keys = [...new Set([...read('i18n.js').matchAll(/"(dm\.[^"]+)":/g)].map(m => m[1]))];
  assert.ok(keys.length > 45);
  for (const lang of ['ar','en']) for (const key of keys) assert.notEqual(context.window.I18N.tIn(lang,key), key);
  const html = read('index.html');
  assert.ok(html.indexOf('src="degreaser_core.js') < html.indexOf('src="degreaser_mix.js'));
  assert.equal((html.match(/id="degreaser-mix-body"/g)||[]).length,1);
});
