const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function loadI18n() {
  const nodes = [];
  const document = {
    documentElement: { lang: '', dir: '', classList: { toggle() {} } },
    querySelectorAll() { return nodes; },
    addEventListener() {}
  };
  const context = { window: {}, document, localStorage: { getItem() { return null; }, setItem() {} }, console };
  vm.runInNewContext(read('i18n.js'), context);
  return context.window.I18N;
}

test('the complete experience ships every new visible string in Arabic and English', () => {
  const i18n = loadI18n();
  const required = [
    'experience.skip', 'experience.navSub', 'experience.workspace', 'experience.managerTitle',
    'experience.overview', 'experience.nowNote', 'experience.comparison',
    'experience.comparisonNote', 'experience.production', 'experience.tanks', 'experience.engineer',
    'experience.viewer', 'experience.desc.manager', 'experience.desc.tasks', 'experience.desc.acid',
    'experience.desc.flux', 'experience.desc.zinc', 'experience.desc.weekly',
    'design.chart.productionDays', 'design.chart.controlBand', 'design.chart.missing',
    'design.chart.details', 'design.chart.period', 'design.chart.last14',
    'design.chart.last30', 'design.chart.all'
  ];
  for (const lang of ['ar', 'en']) {
    for (const key of required) assert.notEqual(i18n.tIn(lang, key), key, `${key} missing in ${lang}`);
  }
});

test('workspace structure remains addressable and stylesheet order avoids an unstyled first paint', () => {
  const html = read('index.html');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, []);
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /href="experience\.css(?:\?v=[^"]+)?"/);
  assert.match(head, /href="workspace-design\.css(?:\?v=[^"]+)?"/);
  assert.match(html, /<script src="experience\.js(?:\?v=[^"]+)?"><\/script>/);
  for (const page of ['tasks', 'tanks', 'timing', 'actions', 'acid', 'pickling', 'flux', 'lab', 'kettle', 'coating', 'standards', 'zinc', 'zincbal', 'weekly']) {
    assert.equal((html.match(new RegExp(`id="page-${page}"`, 'g')) || []).length, 1, `page-${page} mount changed`);
  }
  const managerOrder = ['id="mgr-alerts"', 'id="tanks-dashboard"', 'id="mgr-production"', 'id="manager-comparison"']
    .map(marker => html.indexOf(marker));
  assert.ok(managerOrder.every(position => position >= 0), 'manager decision sections exist');
  assert.deepEqual([...managerOrder].sort((a, b) => a - b), managerOrder, 'manager decision sections keep their intended order');
});

test('new presentation styles are structurally balanced', () => {
  for (const file of ['experience.css', 'workspace-design.css']) {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length, `${file} braces`);
  }
});
