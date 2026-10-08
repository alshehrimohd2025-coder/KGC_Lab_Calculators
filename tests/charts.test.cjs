const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../zinc.js'), 'utf8');
const context = { window: {}, database: { ref: () => ({ on() {} }) }, document: { addEventListener() {} }, setInterval() {}, t: key => key, console };
// Exercise the actual renderers without a Firebase connection or production API additions.
vm.runInNewContext(source.replace('window.KGCZinc = {', 'window.chartTest = { chart, tonnageChart }; window.KGCZinc = {'), context);
const { chart, tonnageChart } = context.window.chartTest;
const day = (date, totalPct, totalTon = 60000) => ({ date, totalPct, totalTon, dayTon: 30000, nightTon: 30000 });
test('empty and single-day charts produce no invalid coordinates', () => {
  for (const render of [chart, tonnageChart]) {
    assert.equal(render([]), '');
    assert.doesNotMatch(render([day('2026-10-01', 7.5)]), /NaN|Infinity/);
  }
});
test('missing consumption creates a gap, not a zero point or a connecting line', () => {
  const html = chart([day('2026-10-01', 7), day('2026-10-02', null), day('2026-10-03', 8)]);
  assert.equal((html.match(/class="pt-dot"/g) || []).length, 2);
  const line = html.match(/class="series" d="([^"]*)"/)[1];
  assert.equal((line.match(/M/g) || []).length, 2);
  assert.doesNotMatch(line, /L/);
});
test('production converts stored kg to labelled tonnes', () => {
  const html = tonnageChart([day('2026-10-01', 7.5, 62000)]);
  assert.match(html, /text-anchor="middle">62<\/text>/);
  assert.doesNotMatch(html, />62000<\/text>/);
});
test('consumption plot keeps the plant limits and has no second production axis', () => {
  const html = chart([day('2026-10-01', 10)]);
  assert.match(html, />9%<\/text>/);
  assert.match(html, />4%<\/text>/);
  assert.doesNotMatch(html, /class="ton-line"/);
});
