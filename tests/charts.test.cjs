'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the production module through its normal Firebase callback and
// render entry points. No alternate chart renderer or production test hooks.
function load(records, extra = {}) {
  const subscriptions = {};
  const mounts = {};
  for (const [id, context] of [['zn-body', 'editor'], ['mgr-production', 'manager']]) {
    const handlers = {};
    const select = {
      value: context === 'editor' ? '30' : '14', focused: false,
      getAttribute: () => context,
      addEventListener: (name, callback) => { handlers[name] = callback; },
      focus() { this.focused = true; },
      change(value) { this.value = String(value); handlers.change(); }
    };
    mounts[id] = {
      innerHTML: '', select,
      querySelectorAll: selector => selector === '[data-chart-range]' ? [select] :
        selector === '.chart-wrap' ? (extra.wraps || []) : [],
      querySelector: () => select
    };
  }
  const sandbox = {
    console, Intl, Date, Set, setInterval: () => {},
    window: {},
    t: (key, values) => key + (values ? JSON.stringify(values) : ''),
    document: { getElementById: id => mounts[id] || null, addEventListener() {} },
    database: { ref: location => ({ on: (event, callback) => { subscriptions[location] = callback; } }) }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../zinc.js'), 'utf8'), sandbox);
  subscriptions.zinc_daily({ val: () => Object.fromEntries(records.map(record => [record.date, record])) });
  return { editor: mounts['zn-body'], manager: mounts['mgr-production'], api: sandbox.window.KGCZinc };
}
const day = (date, pct = 7, kg = 60000) => ({ date, totalTon: kg, dayTon: kg / 2, nightTon: kg / 2,
  totalPct: pct, dayPct: pct, nightPct: pct, dayJigs: 30, nightJigs: 30 });
const svg = (html, kind) => html.match(new RegExp('<div class="chart-wrap ' + kind + '-chart">[\\s\\S]*?</svg>'))?.[0] || '';
const count = (html, pattern) => (html.match(pattern) || []).length;

test('both screens render separate charts, correctly convert kg to tonnes and label the period', () => {
  const result = load([day('2026-09-29', 7, 62000), day('2026-10-01', 8, 80000)]);
  for (const mount of [result.manager, result.editor]) {
    assert.match(mount.innerHTML, /2026-09-29 — 2026-10-01/);
    assert.match(svg(mount.innerHTML, 'production'), /80 mgr\.ton/);
    assert.doesNotMatch(svg(mount.innerHTML, 'production'), />62000</);
    assert.match(svg(mount.innerHTML, 'zinc'), /8\.00%/);
    assert.doesNotMatch(svg(mount.innerHTML, 'zinc'), /ton-line|ton-dot/);
    assert.match(mount.innerHTML, /design\.chart\.productionDays/);
    assert.match(mount.innerHTML, /<details class="chart-data">/);
  }
});

test('missing and zero percentages leave line gaps and expose missing status instead of zero readings', () => {
  const result = load([day('2026-10-01', 7), day('2026-10-02', null), day('2026-10-03', 8),
    day('2026-10-04', 0), day('2026-10-05', 9)]);
  const chart = svg(result.manager.innerHTML, 'zinc');
  const line = chart.match(/class="series zinc-series" d="([^"]*)"/)[1];
  assert.equal(count(line, /M/g), 3);
  assert.equal(count(line, /L/g), 0);
  assert.equal(count(chart, /data-missing="true"/g), 2);
  assert.equal(count(chart, /class="pt-dot"/g), 3);
  assert.doesNotMatch(chart, /NaN|Infinity/);
  assert.match(chart, /design\.chart\.missing/);
  assert.doesNotMatch(chart, /0\.00%/);
});

test('a single production day stays visible and all-missing percentages do not invent a line', () => {
  const result = load([day('2026-10-07', undefined)]);
  // Explicit missing value is needed because day() has a fixture default.
  const missing = load([{ ...day('2026-10-07'), totalPct: undefined, dayPct: undefined, nightPct: undefined }]);
  assert.equal(count(svg(result.editor.innerHTML, 'production'), /class="bar"/g), 1);
  assert.match(svg(missing.editor.innerHTML, 'zinc'), /class="series zinc-series" d=""/);
  assert.doesNotMatch(svg(missing.editor.innerHTML, 'zinc'), /NaN|Infinity/);
  assert.match(missing.editor.innerHTML, /class="chart-headline" dir="ltr">—/);
});

test('calendar boundaries are legible, off-days stay out, and range selection changes only chart view', () => {
  const records = Array.from({ length: 35 }, (_, i) => day(new Date(Date.UTC(2026, 8, i + 1)).toISOString().slice(0, 10)));
  records.push({ ...day('2026-10-09'), totalTon: 0, dross: 1500 });
  const result = load(records);
  assert.equal(count(svg(result.manager.innerHTML, 'production'), /class="bar"/g), 14);
  assert.equal(count(svg(result.editor.innerHTML, 'production'), /class="bar"/g), 30);
  assert.equal(Object.keys(result.api._days()).length, 36);
  result.manager.select.change(30);
  assert.equal(count(svg(result.manager.innerHTML, 'production'), /class="bar"/g), 30);
  assert.equal(result.manager.select.focused, true);
  result.manager.select.change(0);
  assert.equal(count(svg(result.manager.innerHTML, 'production'), /class="bar"/g), 35);
  assert.equal(Object.keys(result.api._days()).length, 36);
  assert.doesNotMatch(svg(result.manager.innerHTML, 'production'), /2026-10-09/);
  assert.equal(count(svg(result.manager.innerHTML, 'production'), /class="axis-label chart-date"/g), 6);
});

test('large percent outliers stay within the plot and yield a bounded tick count', () => {
  const result = load([day('2026-10-01', 8), day('2026-10-02', 9999)]);
  const chart = svg(result.manager.innerHTML, 'zinc');
  assert.doesNotMatch(chart, /NaN|Infinity/);
  assert.ok(count(chart, /class="grid"/g) <= 6);
  const line = chart.match(/class="series zinc-series" d="([^"]*)"/)[1];
  const coords = [...line.matchAll(/[ML]([\d.]+) ([\d.]+)/g)];
  for (const coordinate of coords) assert.ok(Number(coordinate[2]) >= 20 && Number(coordinate[2]) <= 240);
});

test('point details are focusable, escape-safe, and expose exact readings and units', () => {
  const result = load([day('2026-10-01', 7.1234)]);
  const chart = svg(result.manager.innerHTML, 'zinc');
  assert.match(chart, /tabindex="0" role="img" aria-label="2026-10-01/);
  assert.match(chart, /7\.12%/);
  assert.match(chart, /data-tip="&lt;b&gt;/);
  assert.match(chart, /<title>zn\.legend\.pct<\/title>/);
});

test('tooltip supports focus, blur, touch click and Escape without saving anything', () => {
  const events = {}, classes = new Set();
  const tip = { innerHTML: '', style: {}, offsetWidth: 180, offsetHeight: 60,
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) } };
  const point = { getAttribute: () => '<b>2026-10-01</b>',
    getBoundingClientRect: () => ({ left: 40, top: 100, width: 8 }),
    querySelector: () => null,
    addEventListener: (name, callback) => { events[name] = callback; } };
  const wrap = { querySelector: () => tip, querySelectorAll: () => [point],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 500 }), addEventListener() {} };
  load([day('2026-10-01')], { wraps: [wrap] });
  events.focus();
  assert.equal(classes.has('on'), true);
  assert.equal(tip.innerHTML, '<b>2026-10-01</b>');
  events.keydown({ key: 'Escape' });
  assert.equal(classes.has('on'), false);
  events.click();
  assert.equal(classes.has('on'), true);
  events.blur();
  assert.equal(classes.has('on'), false);
});
