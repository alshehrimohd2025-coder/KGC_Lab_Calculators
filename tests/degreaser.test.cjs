'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../degreaser_core.js');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const segment = (initial, final) => ({ initial, final });
const tank = { id: 1, name: 'Degreasing Tank', fields: ['conc', 'sg', 'temp', 'time'], conc: 8, sg: 1.06,
  measured: { conc: '2026-10-20', sg: '2026-10-21' }, note: 'keep' };

test('supplier example and non-zero initial reading use delivered volume, not final reading', () => {
  const { preparation, ...result } = core.calculate([segment('0', '40')], '1');
  assert.deepEqual(result, { volume: 40, normality: 1, percent: 6.04 });
  assert.equal(preparation.correctionFactor, 1);
  assert.equal(core.calculate([segment(5, 45)], 1).percent, 6.04);
  // 50 mL water is already part of the method: no ×3 dilution correction.
  assert.notEqual(core.calculate([segment(0, 40)], 1).percent, 18.12);
});

test('9 mL bath + 41 mL water, titrating all 50 mL corrects only for the original 9 mL sample', () => {
  const options = { sampleVolume: 9, dilutionMode: 'water', dilutionVolume: 41, portion: 'whole' };
  const result = core.calculate([segment(0, 10)], 1, options);
  assert.equal(result.preparation.finalVolume, 50);
  assert.equal(result.preparation.effectiveSample, 9);
  assert.equal(result.preparation.aliquotFactor, 1);
  assert.ok(Math.abs(result.percent - 10 * 0.151 * 25 / 9) < 1e-8);
  const direct = core.calculate([segment(0, 10)], 1, { ...options, dilutionVolume: 0 });
  assert.equal(result.percent, direct.percent, 'water does not add analyte when all solution is titrated');
});

test('10 mL bath + 100 mL water, titrating 10 mL, uses 110 mL final volume and a factor of 27.5', () => {
  const options = { sampleVolume: 10, dilutionMode: 'water', dilutionVolume: 100, portion: 'aliquot', aliquotVolume: 10 };
  const result = core.calculate([segment(0, 2)], 0.98, options);
  assert.equal(result.preparation.finalVolume, 110);
  assert.equal(result.preparation.aliquotFactor, 11);
  assert.equal(result.preparation.sampleFactor, 2.5);
  assert.ok(Math.abs(result.preparation.correctionFactor - 27.5) < 1e-12);
  assert.equal(result.percent, 8.1389);
  const madeUpTo100 = core.calculate([segment(0, 2)], 0.98, { ...options, dilutionMode: 'final' });
  assert.equal(madeUpTo100.preparation.correctionFactor, 25);
  assert.equal(madeUpTo100.percent, 7.399);
});

test('titrating one fifth of a homogeneous dilution consumes one fifth the NaOH but returns the same bath concentration', () => {
  const options = { sampleVolume: 9, dilutionMode: 'final', dilutionVolume: 50 };
  const whole = core.calculate([segment(0, 20)], 1, { ...options, portion: 'whole' });
  const aliquot = core.calculate([segment(0, 4)], 1, { ...options, portion: 'aliquot', aliquotVolume: 10 });
  assert.equal(whole.percent, aliquot.percent);
});

test('invalid geometry cannot produce a concentration', () => {
  for (const value of ['', 0, -1, Infinity]) assert.equal(core.prepare({ sampleVolume: value }).error, 'sample');
  for (const options of [
    { dilutionVolume: '' }, { dilutionMode: 'water', dilutionVolume: -1 },
    { sampleVolume: 25, dilutionVolume: 24 }, { dilutionMode: 'other' }
  ]) assert.equal(core.calculate([segment(0, 10)], 1, options).error, 'dilution');
  for (const aliquotVolume of ['', 0, -1, 76]) assert.equal(core.prepare({ portion: 'aliquot', aliquotVolume }).error, 'aliquot');
  assert.equal(core.prepare({ portion: 'other' }).error, 'aliquot');
  assert.equal(core.prepare({ sampleVolume: 25, dilutionMode: 'water', dilutionVolume: 0 }).effectiveSample, 25);
});

test('refills add each delivered volume and standardized normality scales equivalents', () => {
  assert.equal(core.calculate([segment(0, 50), segment(2, 22)], 1).percent, 10.57);
  assert.equal(core.calculate([segment(0, 40)], 0.98).percent, 5.9192);
  assert.equal(core.calculate([segment(0, 40)], 0.1).percent, 0.604);
});

test('blank, nonfinite, negative and reversed readings never become a zero or a saved result', () => {
  for (const value of ['', ' ', null, undefined, 'abc', Infinity]) {
    assert.equal(core.calculate([segment(0, value)], 1).error, 'reading');
  }
  assert.equal(core.calculate([], 1).error, 'reading');
  assert.equal(core.calculate([segment(-1, 10)], 1).error, 'negative');
  assert.equal(core.calculate([segment(10, 9)], 1).error, 'order');
  assert.equal(core.calculate([segment(0, 20), segment(0, '')], 1).error, 'reading');
  for (const n of ['', 0, -1, Infinity]) assert.equal(core.calculate([segment(0, 10)], n).error, 'normality');
  assert.equal(core.calculate([segment(0, 1000)], 1).error, 'range');
  assert.equal(core.calculate([segment(0, 0)], 1).percent, 0, 'an actual zero remains distinct from blank');
});

test('atomic patch targets existing id, preserves schema, and uses Riyadh date at UTC midnight boundary', () => {
  const remote = { 0: { id: 12, name: 'Zinc Tank' }, 11: structuredClone(tank) };
  const before = structuredClone(remote);
  const updates = core.readingUpdates(remote, 6.04, new Date('2026-10-27T22:30:00Z'));
  assert.deepEqual(Object.keys(updates).sort(), [
    'tanks_data/11/conc', 'tanks_data/11/measured/conc',
    'readings_log/1_2026-10-28/tankId', 'readings_log/1_2026-10-28/date',
    'readings_log/1_2026-10-28/ts', 'readings_log/1_2026-10-28/conc'
  ].sort());
  assert.equal(updates['tanks_data/11/conc'], 6.04);
  assert.equal(updates['tanks_data/11/measured/conc'], '2026-10-28');
  assert.deepEqual(remote, before);
  for (const data of [null, [], { 0: { ...tank, name: 'Other Tank' } }, { 0: tank, 1: tank }]) {
    assert.throws(() => core.readingUpdates(data, 6, new Date()), /tank/);
  }
  assert.throws(() => core.readingUpdates(remote, NaN, new Date()), /tank/);
});

// Minimal DOM for the actual UI module; no alternate calculator or save path.
function loadUI(options = {}) {
  let elements = {}, html = '', subscription, cancelRead;
  const writes = [], languageListeners = [];
  let resolveRead, rejectWrite = options.rejectWrite;
  const attrs = source => Object.fromEntries([...source.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
  const document = {
    getElementById: id => id === 'degreaser-body' ? mount : elements[id] || null
  };
  const mount = {
    get innerHTML() { return html; },
    set innerHTML(next) {
      html = next; elements = {};
      for (const m of next.matchAll(/<(?:input|select|button|output|p|div|dd|strong|span|label)\b([^>]*)>/g)) {
        const a = attrs(m[1]);
        if (!a.id && !('data-remove' in a)) continue;
        const handlers = {};
        const el = { id: a.id, value: a.value || '', checked: /\bchecked\b/.test(m[1]), disabled: /\bdisabled\b/.test(m[1]),
          dataset: { segment: a['data-segment'], field: a['data-field'], remove: a['data-remove'] }, textContent: '',
          classList: { toggle() {} }, addEventListener(event, fn) { handlers[event] = fn; }, focus() {},
          input(value) { this.value = String(value); return handlers.input.call(this); },
          change(value) { this.checked = value; this.value = String(value); return handlers.change.call(this); },
          click() { return handlers.click.call(this); }
        };
        elements[a.id || 'remove-' + a['data-remove']] = el;
      }
    },
    querySelectorAll(selector) {
      return Object.values(elements).filter(el => selector === '[data-segment]' ? el.dataset.segment !== undefined : el.dataset.remove !== undefined);
    }
  };
  const context = {
    console: { error() {} }, Date, Intl, Number,
    window: { KGCDegreaserCore: core, I18N: true }, document,
    I18N: { onChange(fn) { languageListeners.push(fn); } },
    t: key => key, IS_EDITOR: options.editor !== false, IS_AUTHED: options.authed !== false,
    database: { ref(location) { return {
      on(event, fn, fail) { subscription = fn; cancelRead = fail; },
      once() { return options.delayedRead ? new Promise(resolve => { resolveRead = resolve; }) : Promise.resolve({ val: () => ({ 4: structuredClone(tank) }) }); },
      async update(updates) { writes.push(updates); if (rejectWrite) throw new Error('PERMISSION_DENIED'); }
    }; } }
  };
  vm.runInNewContext(read('degreaser.js'), context);
  if (!options.noTank) subscription({ val: () => ({ 4: structuredClone(tank) }) });
  return { context, el: id => elements[id], writes, mount, languageListeners,
    failRead: () => cancelRead(), finishRead: () => resolveRead({ val: () => ({ 4: structuredClone(tank) }) }),
    ready() { elements['dg-final-0'].input(40); elements['dg-verified'].change(true); elements['dg-indicator'].change('phenolphthalein'); }
  };
}

test('preview never writes and unstandardized NaOH cannot be saved even by direct event invocation', async () => {
  const ui = loadUI();
  ui.el('dg-final-0').input(40);
  ui.el('dg-indicator').change('phenolphthalein');
  assert.equal(ui.el('dg-percent').textContent, '6.040');
  assert.equal(ui.el('dg-save').disabled, true);
  await ui.el('dg-save').click();
  assert.equal(ui.writes.length, 0);
  assert.equal(ui.el('dg-confidence').textContent, 'dg.estimate');
});

test('unknown or different indicator blocks concentration and save even after normality confirmation', async () => {
  const ui = loadUI();
  ui.el('dg-final-0').input(40); ui.el('dg-verified').change(true);
  assert.equal(ui.el('dg-percent').textContent, '—');
  assert.equal(ui.el('dg-confidence').textContent, 'dg.indicatorBlocked');
  await ui.el('dg-save').click(); assert.equal(ui.writes.length, 0);
  ui.el('dg-indicator').change('phenolphthalein'); assert.equal(ui.el('dg-percent').textContent, '6.040');
  ui.el('dg-indicator').change('unknown');
  await ui.el('dg-save').click(); assert.equal(ui.writes.length, 0);
});

test('UI supports water vs final volume and titrating either all solution or an aliquot', async () => {
  const ui = loadUI(); ui.ready();
  ui.el('dg-nine').click();
  assert.equal(ui.el('dg-sample').value, '9');
  assert.equal(ui.el('dg-dilution-volume').value, '50');
  assert.equal(ui.el('dg-percent').textContent, '16.778');
  ui.el('dg-dilution-mode').change('water');
  assert.equal(ui.el('dg-dilution-volume').value, '41');
  assert.equal(ui.el('dg-percent').textContent, '16.778');
  ui.el('dg-sample').input(10); ui.el('dg-dilution-volume').input(100);
  ui.el('dg-portion').change('aliquot'); ui.el('dg-aliquot').input(10);
  ui.el('dg-final-0').input(2); ui.el('dg-normality').input(0.98);
  assert.equal(ui.el('dg-final-volume').textContent, '110 mL');
  assert.equal(ui.el('dg-aliquot-factor').textContent, '11 ×');
  assert.equal(ui.el('dg-correction-factor').textContent, '27.5 ×');
  assert.equal(ui.el('dg-percent').textContent, '8.139');
  ui.el('dg-verified').change(true); await ui.el('dg-save').click();
  assert.equal(ui.writes[0]['tanks_data/4/conc'], 8.1389);
  ui.el('dg-aliquot').input(111);
  assert.equal(ui.el('dg-percent').textContent, '—');
  await ui.el('dg-save').click(); assert.equal(ui.writes.length, 1);
  ui.el('dg-supplier').click();
  assert.equal(ui.el('dg-sample').value, '25');
  assert.equal(ui.el('dg-dilution-volume').value, '75');
});

test('editor save uses one atomic field-level update and reports success only after acknowledgment', async () => {
  const ui = loadUI(); ui.ready();
  assert.equal(ui.el('dg-save').disabled, false);
  await ui.el('dg-save').click();
  assert.equal(ui.writes.length, 1);
  assert.equal(ui.writes[0]['tanks_data/4/conc'], 6.04);
  assert.equal(ui.el('dg-message').textContent, 'dg.saved');
  assert.equal(Object.keys(ui.writes[0]).length, 6);
});

test('manager, revoked editor and unavailable bath cannot write', async () => {
  for (const opts of [{ editor: false }, { authed: false }, { noTank: true }]) {
    const ui = loadUI(opts); ui.ready(); await ui.el('dg-save').click();
    assert.equal(ui.writes.length, 0);
  }
  const ui = loadUI({ delayedRead: true }); ui.ready();
  const pending = ui.el('dg-save').click();
  ui.context.IS_AUTHED = false;
  ui.finishRead(); await pending;
  assert.equal(ui.writes.length, 0);
  assert.equal(ui.el('dg-message').textContent, 'dg.saveFailed');
});

test('invalid and incomplete refill rows clear previous result and block save', async () => {
  const ui = loadUI(); ui.ready();
  ui.el('dg-add').click();
  assert.equal(ui.el('dg-percent').textContent, '—');
  await ui.el('dg-save').click();
  assert.equal(ui.writes.length, 0);
  ui.el('dg-final-1').input(10);
  assert.equal(ui.el('dg-percent').textContent, '7.550');
  ui.el('dg-initial-1').input(20);
  assert.equal(ui.el('dg-error').textContent, 'dg.error.order');
  assert.equal(ui.el('dg-save').disabled, true);
});

test('normality edits invalidate confirmation and Firebase failures never show success', async () => {
  const ui = loadUI({ rejectWrite: true }); ui.ready();
  ui.el('dg-normality').input(0.98);
  assert.equal(ui.el('dg-verified').checked, false);
  assert.equal(ui.el('dg-percent').textContent, '5.919');
  await ui.el('dg-save').click(); assert.equal(ui.writes.length, 0);
  ui.el('dg-verified').change(true);
  await ui.el('dg-save').click();
  assert.equal(ui.el('dg-message').textContent, 'dg.saveFailed');
  assert.equal(ui.el('dg-save').disabled, false);
  ui.failRead(); assert.equal(ui.el('dg-save').disabled, true);
});

test('language changes retain readings, refills and verification, and all keys exist in both dictionaries', () => {
  const ui = loadUI(); ui.ready();
  ui.el('dg-add').click(); ui.el('dg-final-1').input(10);
  ui.languageListeners[0]();
  assert.equal(ui.el('dg-final-0').value, '40');
  assert.equal(ui.el('dg-final-1').value, '10');
  assert.equal(ui.el('dg-verified').checked, true);
  const sandbox = { window: {}, console, localStorage: { getItem() {} },
    document: { addEventListener() {}, querySelectorAll() { return []; } } };
  vm.runInNewContext(read('i18n.js'), sandbox);
  const keys = [...new Set([...read('i18n.js').matchAll(/"(dg\.[^"]+)":/g)].map(m => m[1]))];
  assert.ok(keys.length > 35);
  for (const lang of ['ar', 'en']) for (const key of keys) assert.notEqual(sandbox.window.I18N.tIn(lang, key), key, lang + ': ' + key);
  assert.match(read('index.html'), /id="degreaser-body"/);
  assert.ok(read('index.html').indexOf('src="degreaser_core.js') < read('index.html').indexOf('src="degreaser.js'));
});
