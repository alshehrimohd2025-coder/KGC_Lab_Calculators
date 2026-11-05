const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');

function setup(selected) {
  const window = { KGCWeeklyExportOptions: { get: () => selected } };
  const database = { ref: () => ({ on: () => {} }) };
  const context = vm.createContext({ window, database, TextEncoder, Uint8Array, Blob, Date, console });
  for (const name of ['report.js', 'xlsx_kit.js', 'weekly_xlsx.js']) vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context, { filename: name });
  return window.KGCWeeklyXlsx;
}
function model() {
  return {
    kind:'week', S:'2026-10-30', E:'2026-11-05', prevS:'2026-10-23', prevE:'2026-10-29', days:7,
    generated:'2026-11-05', generatedAt:'12:57', open:true, preparedBy:'', preparedTitle:'',
    production:{cur:{records:1,tonnes:100,zincKg:6000},prev:{records:0},partial:true},
    kpi:{tonnes:{cur:100,prev:null}, jigs:{cur:10,prev:null}, zincKg:{cur:6000,prev:null},
      zincPerT:{cur:60,prev:null}, drossExp:{cur:null,prev:null},tanksOut:{cur:1,prev:0,of:6}},
    dross:{basis:null,removed:0}, comments:{summary:'EXCLUSIVE SUMMARY'}, options:{unchanged:false,production:false},
    needs:[{priority:'high'}], outTanks:['TANK SECRET'], materials:[{name:'MATERIAL SECRET',q:2,unit:'kg'}],
    operations:[{tank:'EVENT SECRET',title:'breakdown',state:'Open',start:'2026-11-01'}],
    treatments:[{date:'2026-10-30',tank:'Flux solution',material:'Treatment',parameter:'pH',before:3,after:4,unit:'',source:'log',note:'TREATMENT SECRET'}],
    cards:[],quietCards:0,movement:[],still:[],openCards:0
  };
}
async function files(blob) {
  const data=Buffer.from(await blob.arrayBuffer()), result={};
  let p=0;
  while (p+30<=data.length && data.readUInt32LE(p)===0x04034b50) {
    assert.equal(data.readUInt16LE(p+8),0,'Expected stored ZIP member');
    const size=data.readUInt32LE(p+18), nameLength=data.readUInt16LE(p+26), extra=data.readUInt16LE(p+28);
    const name=data.subarray(p+30,p+30+nameLength).toString('utf8'), start=p+30+nameLength+extra;
    result[name]=data.subarray(start,start+size);
    p=start+size;
  }
  return result;
}
const none = () => ({summary:false,kpis:false,status:false,operations:false,changed:false,needs:false,consumption:false,notes:false,managerNote:''});

test('excluded sections and their details are absent from workbook and email', async () => {
  const api=setup(none()), m=model();
  const workbook=await files(api.build(m,null).blob), sheet=workbook['xl/worksheets/sheet1.xml'].toString(), mail=api.emailText(m);
  for (const marker of ['EXCLUSIVE SUMMARY','TANK SECRET','MATERIAL SECRET','EVENT SECRET','TREATMENT SECRET','ENGINEER NOTES']) {
    assert.ok(!sheet.includes(marker), marker+' leaked into workbook');
    assert.ok(!mail.includes(marker), marker+' leaked into email');
  }
});

test('specialist treatment readings appear without a false no-treatment message', async () => {
  const selected=none(); selected.changed=true;
  const api=setup(selected), workbook=await files(api.build(model(),null).blob), sheet=workbook['xl/worksheets/sheet1.xml'].toString();
  assert.match(sheet,/Treatment readings before and after/);
  assert.match(sheet,/TREATMENT SECRET/);
  assert.match(sheet,/>3<\/v>/);
  assert.match(sheet,/>4<\/v>/);
  assert.doesNotMatch(sheet,/No treatment card had an action/);
});

test('report note is literal escaped cell text and appears in email', async () => {
  const selected=none(); selected.managerNote='=1+1 <pump & test>';
  const api=setup(selected), m=model(), workbook=await files(api.build(m,null).blob), sheet=workbook['xl/worksheets/sheet1.xml'].toString();
  assert.match(sheet,/=1\+1 &lt;pump &amp; test&gt;/);
  assert.doesNotMatch(sheet,/<f>/);
  assert.match(api.emailText(m),/=1\+1 <pump & test>/);
});

test('a supplied logo is retained in the actual XLSX archive', async () => {
  const logo=new Uint8Array(24); logo[0]=0x89; logo[1]=0x50; logo[19]=100; logo[23]=20;
  const api=setup(none()), workbook=await files(api.build(model(),logo).blob);
  assert.ok(workbook['xl/media/image1.png']);
  assert.ok(workbook['xl/drawings/drawing1.xml']);
});
