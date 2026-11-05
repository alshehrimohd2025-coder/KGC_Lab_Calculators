'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(data) {
  const listeners = {};
  const sandbox = {
    console, setTimeout() {}, clearTimeout() {},
    document: { getElementById: () => null, addEventListener() {} },
    t: key => key, tanks: [{ id: 10, name: 'Flux Tank', status: 'in_service' }], tankLabel: s => s,
    database: { ref: key => ({ on: (event, callback) => { listeners[key] = callback; } }) }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'weekly.js'), 'utf8'), sandbox);
  Object.entries(listeners).forEach(([key, cb]) => cb({ val: () => data[key] || {} }));
  return sandbox;
}
const week = { kind: 'week', start: '2026-10-30' };

test('specialist treatment rows retain dates and measurements including zero and blanks', () => {
  const h = load({
    flux_treatments: {
      one: { date: '2026-10-30', phBefore: 0, phAfter: 4.7, beBefore: '', beAfter: 12, note: 'first' },
      two: { date: '2026-10-30', phBefore: 4.7, phAfter: 5.1, note: 'second' },
      uncertain: { date: '2026-10-31', liters: 100, beBefore: 0, beAfter: 0, note: 'note' },
      old: { date: '2026-10-29', phBefore: 2, phAfter: 3 },
      later: { date: '2026-11-06', phBefore: 2, phAfter: 3 }
    },
    peroxide_treatments: { a: { date: '2026-11-05', feBefore: 2.3, feAfter: 0.4, note: 'iron' } },
    flux_salt_additions: { a: { date: '2026-11-01', beBefore: 0, beAfter: null } }
  });
  const model = h.KGCWeekly.model(week);
  const rows = model.treatments;
  assert.equal(rows.length, 6);
  assert.equal(rows[0].date, '2026-10-30');
  assert.equal(rows[0].tank, 'wk.flux.solution');
  assert.equal(rows[0].parameter, 'ph');
  assert.equal(rows[0].before, 0);
  assert.equal(rows[1].before, null);
  assert.equal(rows[1].after, 12);
  assert.equal(rows[2].note, 'second');
  assert.equal(rows[3].before, null);
  assert.equal(rows[3].after, null);
  assert.match(rows[3].note, /wk.baume.zeroPair/);
  assert.equal(model.materialEntries[0].before, null);
  assert.equal(model.materialEntries[0].after, null);
  assert.match(model.materialEntries[0].note, /wk.baume.zeroPair/);
  assert.equal(rows[4].before, 0);
  assert.equal(rows[4].after, null);
  assert.equal(rows[5].parameter, 'fe');
  assert.equal(rows[5].unit, 'g/L');
  assert.equal(rows[5].after, 0.4);
});

test('excluded flux tank is omitted and duplicate same-day records remain distinct', () => {
  const records = { a: { date: '2026-10-30', phBefore: 4, phAfter: 5 }, b: { date: '2026-10-30', phBefore: 4, phAfter: 5 } };
  assert.equal(load({ flux_treatments: records }).KGCWeekly.model(week).treatments.length, 2);
  assert.equal(load({ flux_treatments: records, report_settings: { tanksOff: { 10: true } } }).KGCWeekly.model(week).treatments.length, 0);
});

test('historical reports do not use follow-ups dated after the reporting period', () => {
  const h = load({});
  const c = { tankId: 10, before: { readings: { ph: 4 } }, action: { at: '2026-10-30T10:00', material: 'ammonia' },
    afters: [{ at: '2026-11-01T10:00', readings: { ph: 5 } }, { at: '2026-11-08T10:00', readings: { ph: 7 } }] };
  h.KGCActions = { list: () => [c], aftersOf: card => card.afters, materialText: () => 'Ammonia', stage: () => 'done' };
  const rows = h.KGCWeekly.model(week).cards;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].before, 4);
  assert.equal(rows[0].after, 5);
});
