const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const context = {
    console,
    document: { getElementById: () => null, addEventListener() {} },
    localStorage: { getItem: () => null },
    database: { ref: () => ({ on() {} }) },
    tanks: [{ id: 10, ph: 4.5, fe: 0.5 }],
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['i18n.js', 'specs.js', 'actions.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
  }
  context.KGCTasks = {
    measurable: id => context.KGCSpecs.paramsFor(id),
    paramLabel: key => key,
  };
  return context;
}

function card(readings) {
  return {
    tankId: 10,
    before: { readings: { ph: 3, fe: 3 } },
    afters: readings == null ? {} : { sample: { at: '2026-10-08T10:00', readings } },
  };
}

test('one corrected parameter cannot establish success for two original breaches', () => {
  const c = setup();
  const result = c.KGCActions.suggest(card({ ph: 4.5 }));
  assert.equal(result.result, 'insufficient');
  assert.equal(result.why, c.t('ac.sg.missingTargets', { p: 'fe' }));
});

test('complete in-range re-measurements establish success', () => {
  assert.equal(setup().KGCActions.suggest(card({ ph: 4.5, fe: 0.5 })).result, 'achieved');
});

test('separate samples may complete the affected parameter set', () => {
  const record = card({ ph: 4.5 });
  record.afters.second = { at: '2026-10-08T11:00', readings: { fe: 0.5 } };
  assert.equal(setup().KGCActions.suggest(record).result, 'achieved');
});

test('no readings or unrelated readings cannot establish success', () => {
  const c = setup();
  assert.equal(c.KGCActions.suggest(card(null)).result, 'insufficient');
  assert.equal(c.KGCActions.suggest(card({ sg: 1.15 })).result, 'insufficient');
});

test('unassessable target readings cannot establish success', () => {
  for (const fe of [null, '', 'invalid', 0]) {
    assert.equal(setup().KGCActions.suggest(card({ ph: 4.5, fe })).result, 'insufficient');
  }
});

test('known breaches retain follow-up priority even with missing targets', () => {
  const c = setup();
  assert.equal(c.KGCActions.suggest(card({ ph: 3 })).result, 'followup');
  c.tanks[0].fe = 3;
  assert.equal(c.KGCActions.suggest(card({ ph: 4.5 })).result, 'followup');
});

test('both translations explain the missing target and substitute its name', () => {
  const c = setup();
  const key = 'ac.sg.missingTargets';
  const ar = c.I18N.tIn('ar', key, { p: 'Fe' });
  const en = c.I18N.tIn('en', key, { p: 'Fe' });
  assert.notEqual(ar, key);
  assert.notEqual(en, key);
  assert.notEqual(ar, en);
  for (const text of [ar, en]) {
    assert.ok(text.includes('Fe'));
    assert.ok(!text.includes('{p}'));
  }
});
