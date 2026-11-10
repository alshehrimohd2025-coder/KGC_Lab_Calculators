/* Manager facing flux treatment and post-treatment zinc summary. */
(function () {
  'use strict';
  const root = document.documentElement;
  const panel = document.getElementById('manager-flux-treatment');
  const body = document.getElementById('manager-flux-summary-body');
  const toggle = document.getElementById('manager-flux-toggle');
  if (!panel || !body || !toggle || typeof database === 'undefined' || !window.KGCWeekly) return;
  const settingRef = database.ref('report_settings/managerFluxSummaryVisible');
  let visible = true;
  let readDone = false;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const lang = () => root.lang === 'en';
  const tr = (ar, en) => lang() ? en : ar;
  const num = n => n == null || !isFinite(Number(n)) ? '—' : new Intl.NumberFormat(lang() ? 'en' : 'ar-SA-u-nu-latn', {maximumFractionDigits:1}).format(Number(n));
  const iso = d => d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  const parse = s => { const a=String(s||'').slice(0,10).split('-').map(Number); return a.length===3 ? new Date(a[0],a[1]-1,a[2],12) : null; };
  const weekStart = d => { const x=new Date(d); x.setHours(12,0,0,0); x.setDate(x.getDate()-x.getDay()); return x; };
  const plusDays = (d,n) => { const x=new Date(d); x.setDate(x.getDate()+n); return x; };
  const weekLabel = (start) => iso(start)+' – '+iso(plusDays(start,6));
  const short = a => (a||[]).filter(Boolean).join(' · ');
  const periods = () => {
    const now = new Date(), base=weekStart(now);
    return Array.from({length:5},(_,i)=>({kind:'week',start:iso(plusDays(base,(i-4)*7))}));
  };
  function render() {
    const editor = root.classList.contains('mode-edit');
    const canEdit = editor && root.classList.contains('authed');
    toggle.checked = visible;
    toggle.disabled = !canEdit;
    panel.style.display = (visible || editor) ? '' : 'none';
    if (!visible) {
      body.innerHTML = tr('<p class="manager-flux-muted">الملخص مخفي عن صفحة المدير. فعّل الخيار أعلاه لإظهاره.</p>',
        '<p class="manager-flux-muted">This summary is hidden from the manager page. Turn it on above to show it.</p>');
      return;
    }
    const W = window.KGCWeekly;
    if (!W || typeof W.model !== 'function') {
      body.innerHTML = '<p class="manager-flux-muted">'+esc(tr('جارٍ تحميل السجلات…','Loading records…'))+'</p>'; return;
    }
    let ms;
    try { ms=periods().map(p=>({p:p,m:W.model(p)})); }
    catch (_) { body.innerHTML='<p class="manager-flux-muted">'+esc(tr('تعذر تحميل السجلات حالياً.','Records are not available yet.'))+'</p>'; return; }
    const buckets = new Map();
    const bucket = d => buckets.get(d) || (buckets.set(d,{actions:[],adds:[],readings:[],issues:[]}),buckets.get(d));
    ms.forEach(({p,m},i)=>{
      (m.treatments||[]).forEach(x=>bucket(x.date).readings.push(esc(x.parameter)+' <bdi dir="ltr">'+esc(num(x.before))+' → '+esc(num(x.after))+(x.unit?' '+esc(x.unit):'')+'</bdi>'+(x.note?' <small>'+esc(x.note)+'</small>':'')));
      (m.materialEntries||[]).filter(x=>Number(x.tankId)===10).forEach(x=>bucket(x.date).adds.push(esc(x.name||x.mat||tr('إضافة','Addition'))+': '+esc(num(x.q))+' '+esc(x.unit||'kg')));
      (m.operations||[]).filter(e=>Number(e.tankId)===10||/flux|فلكس|rinse|شطف|pump|مضخ/i.test([e.title,e.action,e.impact].join(' '))).forEach(e=>{
        const date=e.start||e.date; if(!date) return;
        const b=bucket(date), line=short([e.title,e.kindText,e.action]);
        if(line) b.actions.push(esc(line));
        if(e.impact||/breakdown|failure|عطل|مشكلة|broken|pump|مضخ/i.test([e.title,e.kindText,e.action].join(' '))) b.issues.push(esc(short([e.impact,e.title,e.action])));
      });
    });
    const dates=[...buckets.keys()].sort();
    if(!dates.length){
      body.innerHTML='<p class="manager-flux-muted">'+esc(tr('لا توجد معالجات أو إضافات فلكس مسجلة خلال آخر خمسة أسابيع.','No flux treatments or additions are recorded in the last five weeks.'))+'</p>'; return;
    }
    const rows=dates.map(date=>{
      const b=buckets.get(date), d=parse(date);
      const idx=ms.findIndex(x=>{const s=parse(x.p.start); return s&&d>=s&&d<=plusDays(s,6);});
      const after=idx>=0&&idx+1<ms.length?ms[idx+1].m.production.cur:null;
      const rate=after&&after.zincPerT!=null?after.zincPerT:null;
      const pct=rate==null?null:rate/10;
      const post=rate==null?tr('لا تتوفر فترة لاحقة مسجلة بعد','No later recorded period yet'):(num(pct)+'% · '+num(rate)+' kg/t');
      return '<tr><td dir="ltr">'+esc(date)+'</td><td>'+ (b.actions.join('<br>')||'—') +
        (b.adds.length?'<br><small>'+b.adds.join('<br>')+'</small>':'')+'</td><td>'+(b.readings.join('<br>')||'—')+
        '</td><td>'+(b.issues.join('<br>')||'—')+'</td><td><b>'+esc(post)+'</b>'+
        (rate==null?'':'<br><small>'+esc(weekLabel(parse(ms[idx+1].p.start)))+'</small>')+'</td></tr>';
    }).join('');
    body.innerHTML='<p class="manager-flux-muted">'+esc(tr('آخر خمسة أسابيع. استهلاك الزنك المعروض هو للأسبوع التالي لتاريخ الإجراء، كنسبة وكمية لكل طن.','Last five weeks. Zinc use shown is for the week after each action, as both a percentage and kg per tonne.'))+'</p>'+
      '<div class="manager-flux-table-wrap"><table class="manager-flux-table"><thead><tr>'+
      ['التاريخ','الإجراء والإضافات','القراءات قبل ← بعد','المشكلة المسجلة','استهلاك الزنك بعد الإجراء'].map(x=>'<th>'+esc(tr(x,({'التاريخ':'Date','الإجراء والإضافات':'Action and additions','القراءات قبل ← بعد':'Readings before → after','المشكلة المسجلة':'Recorded issue','استهلاك الزنك بعد الإجراء':'Zinc use after action'}[x]||x)))+'</th>').join('')+
      '</tr></thead><tbody>'+rows+'</tbody></table></div>';
  }
  const style=document.createElement('style');
  style.textContent='.manager-flux-settings-row{display:flex;justify-content:flex-start;margin:0 0 16px}.manager-flux-panel{margin:28px 0;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:20px;box-shadow:var(--e1)}.manager-flux-setting{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink-2);cursor:pointer}.manager-flux-setting input{width:18px;height:18px;accent-color:var(--accent)}:root:not(.mode-edit) .manager-flux-setting,:root.mode-edit:not(.authed) .manager-flux-setting{display:none}.manager-flux-muted{font-size:13px;color:var(--ink-3);margin:6px 0 14px}.manager-flux-table-wrap{overflow:auto}.manager-flux-table{width:100%;border-collapse:collapse;font-size:13px;min-width:760px}.manager-flux-table th,.manager-flux-table td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;text-align:right}.manager-flux-table th{color:var(--ink-2);background:var(--recess);font-weight:600}.manager-flux-table td small{display:inline-block;color:var(--ink-3);margin-top:4px}';
  document.head.appendChild(style);
  toggle.addEventListener('change',function(){
    if(!root.classList.contains('mode-edit')||!root.classList.contains('authed')){toggle.checked=visible;return;}
    settingRef.set(!!toggle.checked).then(()=>{visible=!!toggle.checked;render();}).catch(()=>{toggle.checked=visible;});
  });
  settingRef.on('value',s=>{visible=s.val()!==false;readDone=true;render();});
  ['flux_treatments','peroxide_treatments','flux_salt_additions','operational_events','zinc_daily','production/batches','actions','readings_log'].forEach(path=>
    database.ref(path).on('value',()=>setTimeout(render,120),()=>{}));
  if(window.I18N) I18N.onChange(render);
  setTimeout(render,0);
})();