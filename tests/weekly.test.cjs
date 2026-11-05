'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const week = { kind: 'week', start: '2026-11-01' };
const salt = (date, kg, extra = {}) => ({ date, kg, ...extra });
const outage = { start: '2026-10-30', end: null, tankId: 9, kind: 'breakdown', title: 'Transfer pump failure',
  action: 'Rinsing bypassed pending replacement pump.', impact: 'pH change requires measurement.', impactBasis: 'expected' };

function load(data = {}, opts = {}) {
  const listeners = {}, errors = {}, writes = [], controls = {};
  const fields = {};
  for (const key of ['start', 'end', 'tankId', 'kind', 'title', 'action', 'impact', 'impactBasis']) {
    fields[key] = { value: '', getAttribute: () => key, addEventListener() {} };
  }
  const mount = { innerHTML: '', dataset: {}, contains: () => false, addEventListener() {},
    querySelectorAll: s => s === '[data-wk-event]' ? Object.values(fields) : [],
    querySelector(s) {
      return controls[s] || (controls[s] = { addEventListener(type, fn) { this[type] = fn; }, textContent: '' });
    } };
  let visible = false;
  const sandbox = { console, Blob, TextEncoder, Uint8Array, Uint32Array, DataView, ArrayBuffer,
    setTimeout() {}, clearTimeout() {}, navigator: {}, URL,
    IS_EDITOR: opts.edit !== false, IS_AUTHED: opts.edit !== false,
    localStorage: { getItem: () => 'en', setItem() {} },
    document: { activeElement: null, getElementById: id => visible && id === 'weekly-body' ? mount : null,
      addEventListener() {}, querySelectorAll: () => [] },
    tanks: [{ id: 9, name: 'Rinsing Tank 2', status: 'out_of_service' }, { id: 10, name: 'Flux Tank', status: 'in_service' }],
    tankLabel: x => x,
    database: { ref: p => ({ on: (ev, cb, err) => {
      (listeners[p] ||= []).push(cb); if (err) errors[p] = err;
    }, push: async r => { writes.push({ path: p, record: r }); }, update: async r => { writes.push({ path: p, record: r }); } }) }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['i18n.js', 'report.js', 'xlsx_kit.js', 'weekly_xlsx.js', 'weekly.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  }
  const emit = (p, value) => (listeners[p] || []).forEach(cb => cb({ val: () => value }));
  for (const p of Object.keys(listeners)) if (p !== opts.pending) emit(p, data[p] || {});
  return { api: sandbox.KGCWeekly, xlsx: sandbox.KGCWeeklyXlsx, sandbox, emit, errors, controls, fields, writes, mount,
    render() { visible = true; sandbox.KGCWeekly.render(); return mount.innerHTML; } };
}

test('dated salt additions are included without after readings, and totals match every detail', () => {
  const h = load({ flux_salt_additions: {
    a: salt('2026-11-01', 200, { ts: '2026-11-05T09:00:00Z', beBefore: '15', beAfter: '', note: 'Awaiting remeasurement' }),
    b: salt('2026-11-04', 100, { excludeFromModel: true }),
    c: salt('2026-10-31', 75), d: salt('2026-11-08', 50)
  } });
  const m = h.api.model(week);
  assert.equal(m.materials[0].q, 300);
  assert.equal(m.materialEntries.length, 2);
  assert.equal(m.materialEntries[0].date, '2026-11-01');
  assert.equal(m.materialEntries[0].after, null);
  assert.equal(m.materialEntries[0].before, 15);
  assert.equal(m.materialEntries[0].note, 'Awaiting remeasurement');
  assert.equal(h.api.model({ kind: 'day', start: '2026-11-04' }).materials[0].q, 100);
  assert.equal(h.api.model({ kind: 'month', start: '2026-10-01' }).materials[0].q, 75);
});

test('open outages cross week boundaries; closing preserves historical reports', () => {
  const h = load({ operational_events: { pump: outage } });
  assert.equal(h.api.model(week).operations[0].state, 'Ongoing');
  assert.equal(h.api.model({ kind: 'week', start: '2026-10-25' }).operations.length, 1);
  assert.equal(h.api.model({ kind: 'week', start: '2026-10-18' }).operations.length, 0);
  h.emit('operational_events', { pump: { ...outage, end: '2026-11-04' } });
  assert.equal(h.api.model(week).operations[0].state, 'Ended');
  assert.equal(h.api.model({ kind: 'week', start: '2026-10-25' }).operations[0].state, 'Ongoing');
  assert.equal(h.api.model({ kind: 'week', start: '2026-11-08' }).operations.length, 0);
  assert.match(h.api.model(week).operations[0].impactType, /not verified/);
});

test('current status is not backdated into an old report', () => {
  const h = load();
  assert.equal(h.api.model({ kind: 'week', start: '2020-01-05' }).currentOutages.length, 0);
  assert.equal(h.api.model({ kind: 'week', start: '2090-01-01' }).currentOutages.length, 1);
});

test('log/card priority avoids duplicate quantities but keeps distinct dates and units', () => {
  const h = load({ flux_salt_additions: { a: salt('2026-11-01', 200) } });
  h.sandbox.KGCActions = { list: () => [
    { tankId: 10, action: { at: '2026-11-01T10:00', material: 'flux_salt', actualQty: 200, actualUnit: 'kg' } },
    { tankId: 10, action: { at: '2026-11-02T10:00', material: 'flux_salt', actualQty: 100, actualUnit: 'kg' } },
    { tankId: 10, action: { at: '2026-11-02T10:00', material: 'water', actualQty: 400, actualUnit: 'L' } }
  ], aftersOf: () => [], materialText: () => '', stage: () => 'action', followups: () => [],
    compare: () => [], latestAfter: () => null };
  // No standard-covered tanks in this fixture: treatment cards still contribute materials.
  h.emit('report_settings', { tanksOff: { 10: true } });
  const m = h.api.model(week);
  assert.equal(m.materialEntries.length, 3);
  assert.equal(m.materials.find(x => x.unit === 'kg').q, 300);
  assert.equal(m.materials.find(x => x.unit === 'L').q, 400);
});

test('initial report is the current Sunday-to-Saturday week; page escapes free text', () => {
  const h = load({ operational_events: { pump: { ...outage, title: '<script>bad()</script>' } } });
  const html = h.render();
  const p = h.api.period();
  const start = new Date(p.start + 'T00:00:00');
  assert.equal(start.getDay(), 0);
  assert.ok(start <= new Date());
  assert.ok(new Date() - start < 7 * 86400000);
  h.api.setPeriod(week);
  assert.match(h.mount.innerHTML, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /Current week/);
});

test('export blocks missing or failed reads instead of issuing an empty report', async () => {
  const h = load({}, { pending: 'flux_salt_additions' });
  assert.match(h.render(), /id="wk-excel" disabled/);
  await assert.rejects(h.api.exportExcel(), /Loading report records/);
  h.errors.flux_salt_additions();
  await assert.rejects(h.api.exportExcel(), /could not be loaded/);
  h.emit('flux_salt_additions', {});
  assert.doesNotMatch(h.render(), /id="wk-excel" disabled/);
});

test('event form validates and saves dated events; read-only mode cannot write', async () => {
  const h = load(); h.render();
  const fill = data => Object.entries(data).forEach(([k, v]) => { h.fields[k].value = String(v ?? ''); });
  fill({ ...outage, end: '2026-10-29' });
  await h.controls['#wk-event-save'].click();
  assert.equal(h.writes.length, 0);
  fill({ ...outage, end: '' });
  await h.controls['#wk-event-save'].click();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].path, 'operational_events');
  assert.equal(h.writes[0].record.tankId, 9);
  assert.equal(h.writes[0].record.end, null);
  h.sandbox.IS_AUTHED = false;
  await h.controls['#wk-event-save'].click();
  assert.equal(h.writes.length, 1);
});

test('Excel and email include all additions and operating events without row truncation', async () => {
  const h = load({ flux_salt_additions: Object.fromEntries(Array.from({ length: 65 }, (_, i) =>
    ['s' + i, salt('2026-11-02', 10, { note: 'Addition number ' + i })])), operational_events: { pump: outage } });
  const m = h.api.model(week);
  const out = h.xlsx.build(m, null);
  const zip = Buffer.from(await out.blob.arrayBuffer());
  const text = zip.toString('utf8'); // writer uses STORED zip entries
  assert.match(text, /Addition number 64/);
  assert.match(text, /Transfer pump failure/);
  assert.match(text, /Expected — not verified by measurement/);
  assert.match(text, /Additions by execution date/);
  assert.doesNotMatch(text, /more rows not shown/);
  assert.match(h.xlsx.emailText(m), /Added:.*650/);
  assert.match(h.xlsx.emailText(m), /Transfer pump failure/);
  assert.ok(out.file.endsWith('.xlsx'));
});
