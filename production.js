/* ============================================================
   Production Time Tracker — KGC galvanizing line
   ------------------------------------------------------------
   Records EVERY timestamp as its own segment so the historical
   data can later answer: actual vs expected time, waiting,
   downtime, crane cost, per-tank averages and bottlenecks.

   Depends on globals defined in index.html:
     database   (firebase realtime db)
     IS_EDITOR  (write access flag)
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[production] Firebase database is not available.');
    return;
  }

  /* ---------------- configuration ---------------- */

  // Stages are data-driven: adding another rinsing tank later is a config
  // change (or a Firebase edit), not a rewrite.
  const DEFAULT_STAGES = [
    { key: 'loading',         name: 'التحميل',             type: 'simple' },
    { key: 'crane_attach',    name: 'التركيب على الرافعة',  type: 'simple' },
    { key: 'crane_wait',      name: 'انتظار الرافعة',       type: 'simple' },
    { key: 'crane_move',      name: 'حركة الرافعة',         type: 'simple' },
    { key: 'degreasing',      name: 'الديجريسنج',           type: 'tank' },
    { key: 'rinse_pre_acid',  name: 'رينسينج قبل الحمض',    type: 'tank' },
    { key: 'acid',            name: 'الحمض',                type: 'tank', tankGroup: 'acid' },
    { key: 'rinse_post_acid', name: 'رينسينج بعد الحمض',    type: 'tank', tankGroup: 'rinse' },
    { key: 'flux',            name: 'الفلكس',               type: 'tank' },
    { key: 'drying',          name: 'الدراينج',             type: 'simple' },
    { key: 'wait_zinc',       name: 'انتظار الفرن',         type: 'simple' },
    { key: 'zinc',            name: 'فرن الزنك',            type: 'tank' },
    { key: 'cooling',         name: 'التبريد',              type: 'simple' },
    { key: 'inspection',      name: 'فحص الجودة',           type: 'simple' }
  ];

  const DEFAULT_TANK_GROUPS = {
    acid: [
      { v: 'acid_1', n: 'حمض 1' },
      { v: 'acid_2', n: 'حمض 2' },
      { v: 'acid_3', n: 'حمض 3' },
      { v: 'acid_4', n: 'حمض 4' }
    ],
    rinse: [
      { v: 'rinse_1', n: 'رينسينج 1' },
      { v: 'rinse_2', n: 'رينسينج 2' }
    ]
  };
  const STRIPPING_TANK = { v: 'stripping', n: 'ستريبنج أسيد (إعادة معالجة)' };

  const WAIT_REASONS = ['الرافعة مشغولة', 'تأخير المشغّل', 'الحوض مشغول', 'عطل معدات', 'تأخير إنتاج', 'صيانة', 'أخرى'];
  const DOWN_REASONS = ['عطل رافعة', 'عطل معدات', 'مشكلة حوض', 'مشكلة مشغّل', 'صيانة', 'مشكلة منتج', 'أخرى'];
  const ISSUE_TYPES  = ['جودة السطح', 'صدأ', 'زنك زائد', 'طلاء ضعيف', 'عملية كيميائية', 'مناولة', 'أخرى'];
  const REWORK_REASONS = ['طلاء ضعيف', 'زنك زائد', 'تلوث السطح', 'أكسدة', 'أخرى'];

  // Managers currently see the tanks dashboard only. Flip this to true to also
  // expose the read-only production analytics to the view-only link.
  const SHOW_ANALYTICS_TO_VIEWERS = false;

  let STAGES = DEFAULT_STAGES.slice();
  let TANK_GROUPS = JSON.parse(JSON.stringify(DEFAULT_TANK_GROUPS));

  /* ---------------- state ---------------- */

  let batches = {};          // id -> batch
  let mounted = false;
  const root = document.getElementById('page-timing');
  const dbRef = database.ref('production');

  /* ---------------- small helpers ---------------- */

  const pad = n => (n < 10 ? '0' : '') + n;
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function clock(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function dateStr(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  // 01:12:32
  function hms(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return '00:00:00';
    const t = Math.floor(ms / 1000);
    return pad(Math.floor(t / 3600)) + ':' + pad(Math.floor(t / 60) % 60) + ':' + pad(t % 60);
  }
  // 1س 12د  /  8د 25ث
  function dur(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return '—';
    const t = Math.round(ms / 1000);
    const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    if (h) return h + 'س ' + m + 'د';
    if (m) return m + 'د ' + s + 'ث';
    return s + 'ث';
  }
  const mins = ms => (ms == null || !isFinite(ms)) ? '' : (ms / 60000).toFixed(1);
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  function tankName(v) {
    if (!v) return '';
    if (v === STRIPPING_TANK.v) return STRIPPING_TANK.n;
    for (const g of Object.keys(TANK_GROUPS)) {
      const hit = (TANK_GROUPS[g] || []).find(t => t.v === v);
      if (hit) return hit.n;
    }
    return v;
  }
  const stageAt = i => STAGES[i] || null;
  const stageIndexOf = key => STAGES.findIndex(s => s.key === key);

  const KIND_LABEL = {
    stage: '', immersion: 'غمر', draining: 'تقطير',
    wait: 'انتظار', downtime: 'توقف', rework: 'إعادة معالجة'
  };

  /* ---------------- segment helpers ---------------- */

  const segs = b => Array.isArray(b.segments) ? b.segments : [];
  const openSeg = b => segs(b).find(s => !s.endTs) || null;
  const segLen = s => (s.endTs || Date.now()) - s.startTs;

  function pushSeg(b, seg) {
    if (!Array.isArray(b.segments)) b.segments = [];
    seg.seq = b.segments.length;
    b.segments.push(seg);
  }
  function closeOpen(b, ts) {
    const s = openSeg(b);
    if (s) s.endTs = ts;
    return s;
  }

  /** Open whichever segment kind the given stage starts with. */
  function openStage(b, idx, ts, tank) {
    const st = stageAt(idx);
    if (!st) return;
    b.stageIdx = idx;
    pushSeg(b, {
      kind: st.type === 'tank' ? 'immersion' : 'stage',
      stageKey: st.key,
      stageName: st.name,
      tank: tank || null,
      startTs: ts,
      endTs: null,
      reason: null
    });
  }

  /* ---------------- persistence ---------------- */

  /* Firebase rejects `undefined` outright, and it strips `null` keys on read —
     so a value that round-tripped comes back undefined. Normalise before every
     write, and never let a failed write block the UI. */
  function clean(v) {
    if (v === undefined) return null;
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') {
      const o = {};
      Object.keys(v).forEach(k => { o[k] = clean(v[k]); });
      return o;
    }
    return v;
  }

  function save(b) {
    if (!IS_EDITOR) return;
    b.updatedTs = Date.now();
    try {
      dbRef.child('batches/' + b.id).set(clean(b))
        .catch(e => console.error('[production] save failed', e));
    } catch (e) {
      console.error('[production] save threw', e);
    }
  }

  dbRef.child('config/stages').on('value', snap => {
    const v = snap.val();
    if (Array.isArray(v) && v.length) STAGES = v;
    render();
  });
  dbRef.child('config/tankGroups').on('value', snap => {
    const v = snap.val();
    if (v && typeof v === 'object') TANK_GROUPS = v;
    render();
  });
  dbRef.child('batches').on('value', snap => {
    batches = snap.val() || {};
    render();
  });

  const allBatches = () => Object.values(batches)
    .filter(b => b && b.id)
    .sort((a, b) => (b.startTs || 0) - (a.startTs || 0));
  const activeBatches = () => allBatches().filter(b => b.status === 'active').reverse();
  const doneBatches = () => allBatches().filter(b => b.status === 'done');

  /* ---------------- analytics ---------------- */

  /** Totals for one batch, split the way the spec asks for. */
  function totals(b) {
    const t = {
      cycle: (b.endTs || Date.now()) - b.startTs,
      processing: 0,   // simple stages + immersion
      draining: 0,
      waiting: 0,
      downtime: 0,
      craneWait: 0,
      craneMove: 0,
      byStage: {},     // stageKey -> ms (immersion only for tanks)
      byTank: {},      // tank -> ms immersion
      drainByTank: {}
    };
    segs(b).forEach(s => {
      const d = segLen(s);
      if (s.kind === 'wait') { t.waiting += d; return; }
      if (s.kind === 'downtime') { t.downtime += d; return; }
      if (s.kind === 'rework') return;
      if (s.kind === 'draining') {
        t.draining += d;
        if (s.tank) t.drainByTank[s.tank] = (t.drainByTank[s.tank] || 0) + d;
        return;
      }
      // stage | immersion
      t.processing += d;
      t.byStage[s.stageKey] = (t.byStage[s.stageKey] || 0) + d;
      if (s.kind === 'immersion' && s.tank) t.byTank[s.tank] = (t.byTank[s.tank] || 0) + d;
      if (s.stageKey === 'crane_wait') t.craneWait += d;
      if (s.stageKey === 'crane_move') t.craneMove += d;
    });
    return t;
  }

  /**
   * Expected cycle time from history.
   * Prefers same-product batches; scales by weight when the sample carries
   * weights, because a small and a large batch are not comparable.
   */
  function expectedCycle(product, weight) {
    const done = doneBatches().filter(b => b.endTs);
    const same = done.filter(b => (b.product || '') === (product || ''));
    const pool = same.length >= 2 ? same : done;
    if (pool.length < 2) return null;

    const cycles = pool.map(b => b.endTs - b.startTs);
    const flat = avg(cycles);

    const weighted = pool.filter(b => Number(b.weight) > 0);
    if (weight > 0 && weighted.length >= 2) {
      const perKg = avg(weighted.map(b => (b.endTs - b.startTs) / Number(b.weight)));
      // Blend so one odd batch cannot dominate the estimate.
      return { ms: (flat + perKg * weight) / 2, n: pool.length, scoped: same.length >= 2 };
    }
    return { ms: flat, n: pool.length, scoped: same.length >= 2 };
  }

  function analytics() {
    const done = doneBatches().filter(b => b.endTs);
    const rows = done.map(b => ({ b, t: totals(b) }));

    const a = {
      count: done.length,
      weight: done.reduce((s, b) => s + (Number(b.weight) || 0), 0),
      pieces: done.reduce((s, b) => s + (Number(b.pieces) || 0), 0),
      cycle: avg(rows.map(r => r.t.cycle)),
      processing: avg(rows.map(r => r.t.processing)),
      draining: avg(rows.map(r => r.t.draining)),
      waiting: avg(rows.map(r => r.t.waiting)),
      downtime: avg(rows.map(r => r.t.downtime)),
      craneWait: avg(rows.map(r => r.t.craneWait)),
      craneMove: avg(rows.map(r => r.t.craneMove)),
      stage: {}, tank: {}, drainTank: {}, product: {},
      waitReason: {}, downReason: {}, issueType: {},
      waitByStage: {},
      issues: done.filter(b => b.issue && b.issue.level && b.issue.level !== 'none').length,
      reworks: done.reduce((s, b) => s + ((b.reworks || []).length), 0),
      issueCycle: null
    };

    const bucket = (obj, k, v) => { (obj[k] = obj[k] || []).push(v); };

    rows.forEach(({ b, t }) => {
      Object.keys(t.byStage).forEach(k => bucket(a.stage, k, t.byStage[k]));
      Object.keys(t.byTank).forEach(k => bucket(a.tank, k, t.byTank[k]));
      Object.keys(t.drainByTank).forEach(k => bucket(a.drainTank, k, t.drainByTank[k]));
      bucket(a.product, b.product || '—', t.cycle);

      segs(b).forEach(s => {
        if (s.kind === 'wait') {
          a.waitReason[s.reason || 'غير محدد'] = (a.waitReason[s.reason || 'غير محدد'] || 0) + segLen(s);
          const k = s.stageName || s.stageKey || '—';
          a.waitByStage[k] = (a.waitByStage[k] || 0) + segLen(s);
        }
        if (s.kind === 'downtime') {
          a.downReason[s.reason || 'غير محدد'] = (a.downReason[s.reason || 'غير محدد'] || 0) + segLen(s);
        }
      });
      if (b.issue && b.issue.type) a.issueType[b.issue.type] = (a.issueType[b.issue.type] || 0) + 1;
    });

    const problem = rows.filter(r => r.b.issue && r.b.issue.level && r.b.issue.level !== 'none');
    a.issueCycle = avg(problem.map(r => r.t.cycle));

    // collapse buckets to averages
    ['stage', 'tank', 'drainTank', 'product'].forEach(g => {
      Object.keys(a[g]).forEach(k => { a[g][k] = { avg: avg(a[g][k]), n: a[g][k].length }; });
    });

    const topBy = (obj, pick) => {
      const keys = Object.keys(obj);
      if (!keys.length) return null;
      return keys.reduce((best, k) => (pick(obj[k]) > pick(obj[best]) ? k : best), keys[0]);
    };
    a.topStage = topBy(a.stage, v => v.avg);
    a.topTank = topBy(a.tank, v => v.avg);
    a.topWaitStage = topBy(a.waitByStage, v => v);
    a.topDownReason = topBy(a.downReason, v => v);
    a.topIssue = topBy(a.issueType, v => v);

    // hours of real production time, for rate figures
    const totalHours = rows.reduce((s, r) => s + r.t.cycle, 0) / 3600000;
    a.kgPerHour = totalHours > 0 ? a.weight / totalHours : null;
    a.piecesPerHour = totalHours > 0 ? a.pieces / totalHours : null;
    return a;
  }

  /* ================= actions ================= */

  function newBatchNumber() {
    const nums = allBatches().map(b => parseInt(b.batchNumber, 10)).filter(n => isFinite(n));
    return String(nums.length ? Math.max.apply(null, nums) + 1 : 1001);
  }

  function createBatch(meta) {
    const now = Date.now();
    const b = {
      id: 'b_' + now + '_' + Math.random().toString(36).slice(2, 7),
      batchNumber: meta.batchNumber || newBatchNumber(),
      product: meta.product || '',
      pieces: Number(meta.pieces) || 0,
      weight: Number(meta.weight) || 0,
      workOrder: meta.workOrder || '',
      notes: meta.notes || '',
      startTs: now,          // stamped by the system, never typed
      endTs: null,
      status: 'active',
      stageIdx: 0,
      segments: [],
      reworks: [],
      audit: [],
      issue: { level: 'none', type: '', description: '' }
    };
    openStage(b, 0, now);
    batches[b.id] = b;
    save(b);
    render();
  }

  /** Tank stage: lift out of the liquid — ends immersion, starts draining. */
  function liftOut(id) {
    const b = batches[id]; if (!b || !IS_EDITOR) return;
    const cur = openSeg(b);
    if (!cur || cur.kind !== 'immersion') return;
    const now = Date.now();
    cur.endTs = now;
    pushSeg(b, {
      kind: 'draining', stageKey: cur.stageKey, stageName: cur.stageName,
      tank: cur.tank || null, startTs: now, endTs: null, reason: null
    });
    save(b); render();
  }

  /** Close the current segment and open the next stage (or finish). */
  function next(id) {
    const b = batches[id]; if (!b || !IS_EDITOR) return;
    const cur = openSeg(b);
    if (!cur) return;
    if (cur.kind === 'immersion') return;                 // must lift out first
    if (cur.kind === 'downtime') return;                  // must resume first

    const nextIdx = b.stageIdx + 1;
    const st = stageAt(nextIdx);

    if (!st) { finishBatch(id); return; }

    // A tank stage may need its tank chosen before it starts.
    if (st.type === 'tank' && st.tankGroup) {
      askTank(st, b.reworkActive, tank => {
        const now = Date.now();
        closeOpen(b, now);
        openStage(b, nextIdx, now, tank);
        afterAdvance(b);
      });
      return;
    }
    const now = Date.now();
    closeOpen(b, now);
    openStage(b, nextIdx, now);
    afterAdvance(b);
  }

  /** Close an open rework once the batch returns to where it left off. */
  function afterAdvance(b) {
    if (b.reworkActive) {
      const rw = (b.reworks || []).find(r => !r.endTs);
      if (rw && b.stageIdx >= rw.fromStageIdx) {
        rw.endTs = Date.now();
        b.reworkActive = false;
        const seg = segs(b).find(s => s.kind === 'rework' && !s.endTs);
        if (seg) seg.endTs = rw.endTs;
      }
    }
    save(b); render();
  }

  /** Stage is done but the batch has not moved on yet — log the gap. */
  function startWait(id) {
    const b = batches[id]; if (!b || !IS_EDITOR) return;
    const cur = openSeg(b);
    if (!cur || cur.kind === 'wait' || cur.kind === 'downtime' || cur.kind === 'immersion') return;
    askReason('سبب الانتظار', WAIT_REASONS, reason => {
      const now = Date.now();
      closeOpen(b, now);
      pushSeg(b, {
        kind: 'wait', stageKey: cur.stageKey, stageName: cur.stageName,
        tank: null, startTs: now, endTs: null, reason: reason
      });
      save(b); render();
    });
  }

  function pause(id) {
    const b = batches[id]; if (!b || !IS_EDITOR) return;
    const cur = openSeg(b);
    if (!cur || cur.kind === 'downtime') return;
    askReason('سبب التوقف', DOWN_REASONS, reason => {
      const now = Date.now();
      // remember what to reopen on resume so stage totals stay correct
      b.resumeTo = { kind: cur.kind, stageKey: cur.stageKey, stageName: cur.stageName, tank: cur.tank || null, reason: cur.reason || null };
      closeOpen(b, now);
      pushSeg(b, {
        kind: 'downtime', stageKey: cur.stageKey, stageName: cur.stageName,
        tank: null, startTs: now, endTs: null, reason: reason
      });
      save(b); render();
    });
  }

  function resume(id) {
    const b = batches[id]; if (!b || !IS_EDITOR) return;
    const cur = openSeg(b);
    if (!cur || cur.kind !== 'downtime') return;
    const now = Date.now();
    cur.endTs = now;
    const r = b.resumeTo || { kind: 'stage', stageKey: cur.stageKey, stageName: cur.stageName, tank: null, reason: null };
    pushSeg(b, {
      kind: r.kind, stageKey: r.stageKey, stageName: r.stageName,
      tank: r.tank || null, startTs: now, endTs: null, reason: r.reason || null
    });
    b.resumeTo = null;
    save(b); render();
  }

  /** Undo an accidental NEXT: drop the open segment and reopen the previous. */
  function undo(id) {
    const b = batches[id]; if (!b || !IS_EDITOR) return;
    const list = segs(b);
    if (list.length < 2) return;
    if (!confirm('التراجع عن آخر خطوة؟ سيُعاد فتح المرحلة السابقة.')) return;
    const open = openSeg(b);
    if (open) list.splice(list.indexOf(open), 1);
    const prev = list[list.length - 1];
    if (!prev) return;
    prev.endTs = null;
    const idx = stageIndexOf(prev.stageKey);
    if (idx >= 0) b.stageIdx = idx;
    b.segments = list.map((s, i) => (s.seq = i, s));
    save(b); render();
  }

  function startRework(id) {
    const b = batches[id]; if (!b || !IS_EDITOR) return;
    askRework(b, (reason, targetKey) => {
      const now = Date.now();
      const targetIdx = stageIndexOf(targetKey);
      if (targetIdx < 0) return;
      if (!Array.isArray(b.reworks)) b.reworks = [];
      b.reworks.push({ reason, returnStage: targetKey, returnStageName: (stageAt(targetIdx) || {}).name, startTs: now, endTs: null, fromStageIdx: b.stageIdx });
      b.reworkActive = true;
      closeOpen(b, now);
      pushSeg(b, {
        kind: 'rework', stageKey: 'rework', stageName: 'إعادة معالجة',
        tank: null, startTs: now, endTs: null, reason: reason
      });
      // the rework marker is a point in the timeline; processing continues below it
      const marker = openSeg(b);
      if (marker) marker.endTs = now;
      const st = stageAt(targetIdx);
      if (st && st.type === 'tank' && st.tankGroup) {
        askTank(st, true, tank => { openStage(b, targetIdx, now, tank); save(b); render(); });
      } else {
        openStage(b, targetIdx, now);
        save(b); render();
      }
    });
  }

  function finishBatch(id) {
    const b = batches[id]; if (!b || !IS_EDITOR) return;
    askIssue(issue => {
      const now = Date.now();
      closeOpen(b, now);
      b.issue = issue;
      b.endTs = now;
      b.status = 'done';
      save(b); render();
    });
  }

  function deleteBatch(id) {
    const b = batches[id]; if (!b || !IS_EDITOR) return;
    if (!confirm('حذف الدفعة ' + b.batchNumber + ' نهائياً؟ لا يمكن التراجع.')) return;
    dbRef.child('batches/' + id).remove();
    delete batches[id];
    render();
  }

  /* ================= dialogs ================= */

  function modal(html, cls) {
    const wrap = document.createElement('div');
    wrap.className = 'pt-overlay';
    wrap.innerHTML = '<div class="pt-modal ' + (cls || '') + '">' + html + '</div>';
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    document.body.appendChild(wrap);
    function close() { wrap.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    wrap.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
    return { el: wrap, close };
  }

  const headHtml = title =>
    '<div class="pt-modal-head"><h3>' + esc(title) + '</h3><button class="pt-x" data-close aria-label="إغلاق">&times;</button></div>';

  function askReason(title, list, cb) {
    const m = modal(
      headHtml(title) +
      '<div class="pt-modal-body"><div class="pt-reasons">' +
      list.map((r, i) => '<button class="pt-reason" data-i="' + i + '">' + esc(r) + '</button>').join('') +
      '</div></div>'
    );
    m.el.querySelectorAll('.pt-reason').forEach(btn => {
      btn.addEventListener('click', () => { m.close(); cb(list[Number(btn.dataset.i)]); });
    });
  }

  function askTank(stage, allowStripping, cb) {
    let opts = (TANK_GROUPS[stage.tankGroup] || []).slice();
    if (allowStripping && stage.tankGroup === 'acid') opts.push(STRIPPING_TANK);
    if (!opts.length) { cb(null); return; }
    const m = modal(
      headHtml('اختر حوض ' + stage.name) +
      '<div class="pt-modal-body"><div class="pt-reasons">' +
      opts.map((t, i) => '<button class="pt-reason" data-i="' + i + '">' + esc(t.n) + '</button>').join('') +
      '</div></div>'
    );
    m.el.querySelectorAll('.pt-reason').forEach(btn => {
      btn.addEventListener('click', () => { m.close(); cb(opts[Number(btn.dataset.i)].v); });
    });
  }

  function askIssue(cb) {
    const m = modal(
      headHtml('إنهاء الدفعة — هل فيها مشاكل؟') +
      '<div class="pt-modal-body"><div class="pt-form">' +
      '<div class="pt-field"><label>مستوى المشكلة</label><select id="iss-level">' +
      '<option value="none">لا توجد مشاكل</option><option value="minor">مشكلة بسيطة</option><option value="major">مشكلة كبيرة</option>' +
      '</select></div>' +
      '<div class="pt-field"><label>نوع المشكلة</label><select id="iss-type"><option value="">—</option>' +
      ISSUE_TYPES.map(t => '<option>' + esc(t) + '</option>').join('') + '</select></div>' +
      '<div class="pt-field full"><label>وصف المشكلة</label><textarea id="iss-desc" placeholder="اختياري"></textarea></div>' +
      '</div></div>' +
      '<div class="pt-modal-foot"><button class="btn" id="iss-ok">إنهاء الدفعة</button>' +
      '<button class="btn ghost" data-close>إلغاء</button></div>'
    );
    m.el.querySelector('#iss-ok').addEventListener('click', () => {
      const issue = {
        level: m.el.querySelector('#iss-level').value,
        type: m.el.querySelector('#iss-type').value,
        description: m.el.querySelector('#iss-desc').value.trim()
      };
      m.close(); cb(issue);
    });
  }

  function askRework(b, cb) {
    const m = modal(
      headHtml('إعادة معالجة — الدفعة ' + b.batchNumber) +
      '<div class="pt-modal-body"><div class="pt-form">' +
      '<div class="pt-field"><label>السبب</label><select id="rw-reason">' +
      REWORK_REASONS.map(r => '<option>' + esc(r) + '</option>').join('') + '</select></div>' +
      '<div class="pt-field"><label>تعود إلى مرحلة</label><select id="rw-stage">' +
      STAGES.map(s => '<option value="' + esc(s.key) + '">' + esc(s.name) + '</option>').join('') + '</select></div>' +
      '<p class="pt-hint full">سيُسجَّل وقت بداية إعادة المعالجة الآن، ووقت نهايتها تلقائياً عند رجوع الدفعة للمرحلة التي كانت فيها. حوض الستريبنج أسيد يصبح متاحاً أثناء إعادة المعالجة.</p>' +
      '</div></div>' +
      '<div class="pt-modal-foot"><button class="btn" id="rw-ok">بدء إعادة المعالجة</button>' +
      '<button class="btn ghost" data-close>إلغاء</button></div>'
    );
    m.el.querySelector('#rw-ok').addEventListener('click', () => {
      const reason = m.el.querySelector('#rw-reason').value;
      const stage = m.el.querySelector('#rw-stage').value;
      m.close(); cb(reason, stage);
    });
  }

  function openNewBatch() {
    if (!IS_EDITOR) return;
    const m = modal(
      headHtml('دفعة جديدة') +
      '<div class="pt-modal-body"><div class="pt-form">' +
      '<div class="pt-field"><label>رقم الدفعة</label><input id="nb-num" value="' + esc(newBatchNumber()) + '"></div>' +
      '<div class="pt-field"><label>اسم / نوع المنتج</label><input id="nb-prod" placeholder="مثال: Product A"></div>' +
      '<div class="pt-field"><label>عدد القطع</label><input id="nb-pcs" type="number" step="1" min="0" placeholder="0"></div>' +
      '<div class="pt-field"><label>الوزن الكلي (كجم)</label><input id="nb-wt" type="number" step="0.1" min="0" placeholder="0"></div>' +
      '<div class="pt-field"><label>رقم أمر التشغيل</label><input id="nb-wo" placeholder="اختياري"></div>' +
      '<div class="pt-field full"><label>ملاحظات</label><textarea id="nb-notes" placeholder="اختياري"></textarea></div>' +
      '<p class="pt-hint full">وقت البداية يُسجَّل تلقائياً لحظة الضغط على «بدء الدفعة» — لا يُدخل يدوياً.</p>' +
      '</div></div>' +
      '<div class="pt-modal-foot"><button class="btn" id="nb-ok">بدء الدفعة</button>' +
      '<button class="btn ghost" data-close>إلغاء</button></div>'
    );
    const start = () => {
      createBatch({
        batchNumber: m.el.querySelector('#nb-num').value.trim(),
        product: m.el.querySelector('#nb-prod').value.trim(),
        pieces: m.el.querySelector('#nb-pcs').value,
        weight: m.el.querySelector('#nb-wt').value,
        workOrder: m.el.querySelector('#nb-wo').value.trim(),
        notes: m.el.querySelector('#nb-notes').value.trim()
      });
      m.close();
    };
    m.el.querySelector('#nb-ok').addEventListener('click', start);
    m.el.querySelector('#nb-prod').focus();
  }

  /* ---------- batch details + segment editing ---------- */

  function openDetails(id) {
    const b = batches[id]; if (!b) return;
    const t = totals(b);
    const exp = expectedCycle(b.product, Number(b.weight) || 0);

    const rows = segs(b).map((s, i) => {
      const kindTag = s.kind !== 'stage'
        ? '<span class="pt-kind k-' + s.kind + '">' + esc(KIND_LABEL[s.kind] || s.kind) + '</span>' : '';
      const editTag = s.edited ? '<span class="pt-kind k-edited">معدّل</span>' : '';
      const sub = [
        s.tank ? tankName(s.tank) : '',
        s.reason ? 'السبب: ' + s.reason : ''
      ].filter(Boolean).join(' · ');
      return '<div class="pt-tl-row"' + (IS_EDITOR ? ' data-edit="' + i + '" style="cursor:pointer"' : '') + '>' +
        '<div><div class="pt-tl-name">' + esc(s.stageName || s.stageKey) + kindTag + editTag + '</div>' +
        (sub ? '<div class="pt-tl-sub">' + esc(sub) + '</div>' : '') + '</div>' +
        '<div class="pt-tl-time">' + clock(s.startTs) + ' → ' + (s.endTs ? clock(s.endTs) : '…') + '</div>' +
        '<div class="pt-tl-dur">' + dur(segLen(s)) + '</div>' +
        '</div>';
    }).join('');

    const stat = (k, v, hot) =>
      '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';

    const issue = b.issue || { level: 'none' };
    const issuePill = issue.level === 'none' || !issue.level
      ? '<span class="pt-pill pill-ok">بدون مشاكل</span>'
      : '<span class="pt-pill ' + (issue.level === 'major' ? 'pill-bad' : 'pill-warn') + '">' +
        (issue.level === 'major' ? 'مشكلة كبيرة' : 'مشكلة بسيطة') + (issue.type ? ' — ' + esc(issue.type) : '') + '</span>';

    const reworkHtml = (b.reworks || []).length
      ? '<p class="pt-subtitle">إعادة المعالجة</p>' + (b.reworks || []).map(r =>
          '<div class="pt-tl-row"><div><div class="pt-tl-name">' + esc(r.reason || '') + '</div>' +
          '<div class="pt-tl-sub">رجعت إلى: ' + esc(r.returnStageName || r.returnStage || '') + '</div></div>' +
          '<div class="pt-tl-time">' + clock(r.startTs) + ' → ' + (r.endTs ? clock(r.endTs) : '…') + '</div>' +
          '<div class="pt-tl-dur">' + (r.endTs ? dur(r.endTs - r.startTs) : '—') + '</div></div>').join('')
      : '';

    const auditHtml = (b.audit || []).length
      ? '<p class="pt-subtitle">سجل التعديلات</p>' + (b.audit || []).map(a =>
          '<div class="pt-tl-row"><div><div class="pt-tl-name">' + esc(a.field) + '</div>' +
          '<div class="pt-tl-sub">' + esc(a.reason || '') + '</div></div>' +
          '<div class="pt-tl-time">' + esc(a.from) + ' → ' + esc(a.to) + '</div>' +
          '<div class="pt-tl-dur">' + clock(a.ts) + '</div></div>').join('')
      : '';

    const m = modal(
      headHtml('الدفعة ' + b.batchNumber + ' — ' + (b.product || 'بدون منتج')) +
      '<div class="pt-modal-body">' +
        '<div class="pt-bar">' + issuePill +
          '<span class="pt-tl-sub">' + esc(b.pieces || 0) + ' قطعة · ' + esc(b.weight || 0) + ' كجم' +
          (b.workOrder ? ' · أمر ' + esc(b.workOrder) : '') + '</span>' +
          '<span class="spacer"></span>' +
          '<span class="pt-tl-time">' + dateStr(b.startTs) + '</span>' +
        '</div>' +
        '<div class="pt-stats">' +
          stat('الزمن الفعلي', hms(t.cycle)) +
          stat('الزمن المتوقع', exp ? hms(exp.ms) : '—') +
          stat('زمن المعالجة', hms(t.processing)) +
          stat('التقطير', hms(t.draining)) +
          stat('الانتظار', hms(t.waiting), t.waiting >= 60000) +
          stat('التوقف', hms(t.downtime), t.downtime >= 60000) +
        '</div>' +
        '<p class="pt-subtitle">الخط الزمني</p>' +
        '<div class="pt-timeline">' + rows + '</div>' +
        reworkHtml + auditHtml +
        (IS_EDITOR ? '<p class="pt-hint" style="margin-top:14px">اضغط على أي صف في الخط الزمني لتعديل وقته — يُحفظ الوقت الأصلي وسبب التعديل.</p>' : '') +
      '</div>' +
      '<div class="pt-modal-foot">' +
        '<button class="btn ghost" data-close>إغلاق</button>' +
        (IS_EDITOR && b.status === 'done' ? '<button class="btn danger" id="del-batch">حذف الدفعة</button>' : '') +
      '</div>',
      'wide'
    );

    if (IS_EDITOR) {
      m.el.querySelectorAll('[data-edit]').forEach(row => {
        row.addEventListener('click', () => { m.close(); editSegment(id, Number(row.dataset.edit)); });
      });
      const del = m.el.querySelector('#del-batch');
      if (del) del.addEventListener('click', () => { m.close(); deleteBatch(id); });
    }
  }

  function toLocalInput(ts) {
    if (!ts) return '';
    const d = new Date(ts - d0offset(ts));
    return d.toISOString().slice(0, 19);
  }
  function d0offset(ts) { return new Date(ts).getTimezoneOffset() * 60000; }
  function fromLocalInput(v) {
    if (!v) return null;
    const ms = new Date(v).getTime();
    return isFinite(ms) ? ms : null;
  }

  function editSegment(id, i) {
    const b = batches[id]; if (!b || !IS_EDITOR) return;
    const s = segs(b)[i]; if (!s) return;

    const m = modal(
      headHtml('تعديل: ' + (s.stageName || s.stageKey)) +
      '<div class="pt-modal-body"><div class="pt-form">' +
      '<div class="pt-field"><label>وقت البداية</label><input id="ed-start" type="datetime-local" step="1" value="' + toLocalInput(s.startTs) + '"></div>' +
      '<div class="pt-field"><label>وقت النهاية</label><input id="ed-end" type="datetime-local" step="1" value="' + toLocalInput(s.endTs) + '"></div>' +
      (s.tank ? '<div class="pt-field"><label>الحوض</label><input id="ed-tank" value="' + esc(tankName(s.tank)) + '" disabled></div>' : '') +
      (s.kind === 'wait' ? '<div class="pt-field"><label>سبب الانتظار</label><select id="ed-reason">' +
        WAIT_REASONS.map(r => '<option' + (r === s.reason ? ' selected' : '') + '>' + esc(r) + '</option>').join('') + '</select></div>' : '') +
      (s.kind === 'downtime' ? '<div class="pt-field"><label>سبب التوقف</label><select id="ed-reason">' +
        DOWN_REASONS.map(r => '<option' + (r === s.reason ? ' selected' : '') + '>' + esc(r) + '</option>').join('') + '</select></div>' : '') +
      '<div class="pt-field full"><label>سبب التعديل (إلزامي)</label><input id="ed-why" placeholder="مثال: نُسي الضغط على التالي"></div>' +
      '<p class="pt-hint full">لن تُحذف القيم الأصلية — تُحفظ في سجل التعديلات مع الوقت والسبب.</p>' +
      '</div></div>' +
      '<div class="pt-modal-foot"><button class="btn" id="ed-ok">حفظ التعديل</button>' +
      '<button class="btn ghost" data-close>إلغاء</button></div>'
    );

    m.el.querySelector('#ed-ok').addEventListener('click', () => {
      const why = m.el.querySelector('#ed-why').value.trim();
      if (!why) { alert('اكتب سبب التعديل أولاً.'); return; }
      const ns = fromLocalInput(m.el.querySelector('#ed-start').value);
      const ne = fromLocalInput(m.el.querySelector('#ed-end').value);
      if (ns && ne && ne < ns) { alert('وقت النهاية قبل وقت البداية.'); return; }

      if (!Array.isArray(b.audit)) b.audit = [];
      const log = (field, from, to) => {
        if (from === to) return;
        b.audit.push({ ts: Date.now(), field: (s.stageName || s.stageKey) + ' — ' + field, from: from, to: to, reason: why, by: 'editor' });
      };
      if (ns && ns !== s.startTs) { log('البداية', clock(s.startTs), clock(ns)); if (s.originalStartTs == null) s.originalStartTs = s.startTs; s.startTs = ns; s.edited = true; }
      if (ne !== s.endTs && (ne || s.endTs)) { log('النهاية', clock(s.endTs), clock(ne)); if (s.originalEndTs == null) s.originalEndTs = s.endTs || null; s.endTs = ne; s.edited = true; }
      const rsel = m.el.querySelector('#ed-reason');
      if (rsel && rsel.value !== s.reason) { log('السبب', s.reason || '—', rsel.value); s.reason = rsel.value; s.edited = true; }

      save(b); m.close(); render(); openDetails(id);
    });
  }

  /* ================= export ================= */

  function exportCsv() {
    const rows = [];
    rows.push(['رقم الدفعة', 'المنتج', 'القطع', 'الوزن كجم', 'أمر التشغيل', 'التاريخ', 'البداية', 'النهاية',
               'الزمن الكلي د', 'المعالجة د', 'التقطير د', 'الانتظار د', 'التوقف د', 'مشكلة', 'نوع المشكلة',
               'المرحلة', 'النوع', 'الحوض', 'بداية المرحلة', 'نهاية المرحلة', 'المدة د', 'السبب']);

    allBatches().forEach(b => {
      const t = totals(b);
      const base = [
        b.batchNumber, b.product, b.pieces, b.weight, b.workOrder, dateStr(b.startTs),
        clock(b.startTs), b.endTs ? clock(b.endTs) : '',
        mins(t.cycle), mins(t.processing), mins(t.draining), mins(t.waiting), mins(t.downtime),
        (b.issue && b.issue.level && b.issue.level !== 'none') ? 'نعم' : 'لا',
        (b.issue && b.issue.type) || ''
      ];
      const list = segs(b);
      if (!list.length) { rows.push(base.concat(['', '', '', '', '', '', ''])); return; }
      list.forEach(s => {
        rows.push(base.concat([
          s.stageName || s.stageKey,
          KIND_LABEL[s.kind] || 'مرحلة',
          tankName(s.tank),
          clock(s.startTs),
          s.endTs ? clock(s.endTs) : '',
          mins(segLen(s)),
          s.reason || ''
        ]));
      });
    });

    const csv = rows.map(r => r.map(c => {
      const v = c == null ? '' : String(c);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(',')).join('\r\n');

    // BOM so Excel reads the Arabic correctly
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'KGC_production_' + dateStr(Date.now()) + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ================= rendering ================= */

  function batchCard(b) {
    const cur = openSeg(b);
    const st = stageAt(b.stageIdx);
    const kind = cur ? cur.kind : 'stage';
    const t = totals(b);
    const exp = expectedCycle(b.product, Number(b.weight) || 0);

    const cls = kind === 'downtime' ? 'is-paused' : kind === 'wait' ? 'is-waiting' : b.reworkActive ? 'is-rework' : '';
    const phaseLabel = kind === 'downtime' ? 'متوقفة' : kind === 'wait' ? 'انتظار' :
                       kind === 'immersion' ? 'غمر' : kind === 'draining' ? 'تقطير' : 'قيد التشغيل';

    const stageTitle = kind === 'wait' ? 'انتظار بعد ' + (cur.stageName || '')
                     : kind === 'downtime' ? 'توقف أثناء ' + (cur.stageName || '')
                     : (st ? st.name : '—') + (cur && cur.tank ? ' — ' + tankName(cur.tank) : '');

    const rail = STAGES.map((s, i) =>
      '<span class="' + (i < b.stageIdx ? 'done' : i === b.stageIdx ? 'now' : '') + '"></span>').join('');

    let actions = '';
    if (IS_EDITOR) {
      if (kind === 'downtime') {
        actions = '<button class="btn wide" data-act="resume" data-id="' + b.id + '">استئناف</button>';
      } else if (kind === 'immersion') {
        actions =
          '<button class="btn wide" data-act="lift" data-id="' + b.id + '">رفع من الحوض</button>' +
          '<button class="btn ghost" data-act="pause" data-id="' + b.id + '">توقف</button>' +
          '<button class="btn ghost" data-act="undo" data-id="' + b.id + '">تراجع</button>';
      } else {
        const last = b.stageIdx >= STAGES.length - 1 && kind !== 'wait';
        actions =
          '<button class="btn wide" data-act="next" data-id="' + b.id + '">' + (last ? 'إنهاء الدفعة' : 'التالي') + '</button>' +
          (kind === 'wait' ? '' : '<button class="btn ghost" data-act="wait" data-id="' + b.id + '">انتظار</button>') +
          '<button class="btn ghost" data-act="pause" data-id="' + b.id + '">توقف</button>' +
          '<button class="btn ghost" data-act="undo" data-id="' + b.id + '">تراجع</button>';
      }
      actions += '<button class="btn ghost" data-act="rework" data-id="' + b.id + '">إعادة معالجة</button>';
    }

    return '<div class="pt-batch ' + cls + '" data-batch="' + b.id + '">' +
      '<div class="pt-batch-head">' +
        '<div><div class="pt-batch-id">دفعة ' + esc(b.batchNumber) + '</div>' +
        '<div class="pt-batch-meta">' + esc(b.product || 'بدون منتج') +
        (b.weight ? ' · ' + esc(b.weight) + ' كجم' : '') +
        (b.pieces ? ' · ' + esc(b.pieces) + ' قطعة' : '') + '</div></div>' +
        '<span class="pt-phase-tag">' + phaseLabel + '</span>' +
      '</div>' +
      '<div class="pt-stage-now">' +
        '<div class="pt-stage-label">المرحلة الحالية</div>' +
        '<div class="pt-stage-name">' + esc(stageTitle) + '</div>' +
        '<div class="pt-elapsed" data-live="stage" data-since="' + (cur ? cur.startTs : b.startTs) + '">' +
          hms(cur ? segLen(cur) : 0) + '</div>' +
        '<div class="pt-elapsed-sub">إجمالي الدفعة <span data-live="total" data-since="' + b.startTs + '">' + hms(t.cycle) + '</span></div>' +
        (exp ? '<div class="pt-expected"><span>المتوقع <b>' + hms(exp.ms) + '</b></span>' +
               '<span>من <b>' + exp.n + '</b> دفعة سابقة</span></div>' : '') +
      '</div>' +
      '<div class="pt-rail">' + rail + '</div>' +
      (actions ? '<div class="pt-actions">' + actions + '</div>' : '') +
    '</div>';
  }

  function historyTable() {
    const f = {
      q: (document.getElementById('pt-f-q') || {}).value || '',
      from: (document.getElementById('pt-f-from') || {}).value || '',
      to: (document.getElementById('pt-f-to') || {}).value || '',
      product: (document.getElementById('pt-f-prod') || {}).value || '',
      tank: (document.getElementById('pt-f-tank') || {}).value || '',
      issue: (document.getElementById('pt-f-issue') || {}).value || ''
    };
    const q = f.q.trim().toLowerCase();

    let list = doneBatches().filter(b => {
      if (q && !((b.batchNumber || '') + ' ' + (b.product || '') + ' ' + (b.workOrder || '')).toLowerCase().includes(q)) return false;
      if (f.product && (b.product || '') !== f.product) return false;
      if (f.from && dateStr(b.startTs) < f.from) return false;
      if (f.to && dateStr(b.startTs) > f.to) return false;
      if (f.tank && !segs(b).some(s => s.tank === f.tank)) return false;
      const has = b.issue && b.issue.level && b.issue.level !== 'none';
      if (f.issue === 'yes' && !has) return false;
      if (f.issue === 'no' && has) return false;
      return true;
    });

    if (!list.length) return '<div class="pt-empty">لا توجد دفعات مطابقة</div>';

    const rows = list.map(b => {
      const t = totals(b);
      const has = b.issue && b.issue.level && b.issue.level !== 'none';
      return '<tr class="pt-row-link" data-open="' + b.id + '">' +
        '<td class="name">' + esc(b.batchNumber) + '</td>' +
        '<td class="name">' + esc(b.product || '—') + '</td>' +
        '<td class="num">' + esc(b.weight || 0) + '</td>' +
        '<td class="num">' + dateStr(b.startTs) + '</td>' +
        '<td class="num">' + clock(b.startTs) + '</td>' +
        '<td class="num">' + clock(b.endTs) + '</td>' +
        '<td class="num">' + dur(t.cycle) + '</td>' +
        '<td class="num">' + dur(t.waiting) + '</td>' +
        '<td>' + (has
          ? '<span class="pt-pill ' + (b.issue.level === 'major' ? 'pill-bad' : 'pill-warn') + '">' + esc(b.issue.type || 'مشكلة') + '</span>'
          : '<span class="pt-pill pill-ok">سليمة</span>') + '</td>' +
      '</tr>';
    }).join('');

    return '<div class="tablewrap"><table><thead><tr>' +
      '<th>الدفعة</th><th>المنتج</th><th>الوزن</th><th>التاريخ</th><th>البداية</th><th>النهاية</th>' +
      '<th>الزمن الكلي</th><th>الانتظار</th><th>الحالة</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function analyticsHtml() {
    const a = analytics();
    if (!a.count) return '<div class="pt-empty">لا توجد دفعات مكتملة بعد — الإحصائيات تظهر بعد إنهاء أول دفعة</div>';

    const stat = (k, v, unit, hot) =>
      '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span>' +
      '<span class="v">' + v + (unit ? '<small>' + unit + '</small>' : '') + '</span></div>';
    const n = v => v == null ? '—' : v;

    const stageRows = Object.keys(a.stage)
      .map(k => ({ k, v: a.stage[k] }))
      .sort((x, y) => y.v.avg - x.v.avg)
      .map(r => {
        const st = STAGES.find(s => s.key === r.k);
        return '<div class="pt-tl-row"><div class="pt-tl-name">' + esc(st ? st.name : r.k) + '</div>' +
          '<div class="pt-tl-time">' + r.v.n + ' دفعة</div>' +
          '<div class="pt-tl-dur">' + dur(r.v.avg) + '</div></div>';
      }).join('');

    const tankRows = Object.keys(a.tank).map(k =>
      '<div class="pt-tl-row"><div class="pt-tl-name">' + esc(tankName(k)) + '</div>' +
      '<div class="pt-tl-time">غمر · ' + a.tank[k].n + ' دفعة' +
      (a.drainTank[k] ? ' · تقطير ' + dur(a.drainTank[k].avg) : '') + '</div>' +
      '<div class="pt-tl-dur">' + dur(a.tank[k].avg) + '</div></div>').join('');

    const prodRows = Object.keys(a.product).map(k =>
      '<div class="pt-tl-row"><div class="pt-tl-name">' + esc(k) + '</div>' +
      '<div class="pt-tl-time">' + a.product[k].n + ' دفعة</div>' +
      '<div class="pt-tl-dur">' + dur(a.product[k].avg) + '</div></div>').join('');

    return '' +
      '<p class="pt-subtitle">الإنتاج</p><div class="pt-stats">' +
        stat('عدد الدفعات', a.count) +
        stat('إجمالي الوزن', Math.round(a.weight), 'كجم') +
        stat('متوسط زمن الدورة', hms(a.cycle)) +
        stat('متوسط المعالجة', hms(a.processing)) +
        stat('متوسط الانتظار', hms(a.waiting), '', a.waiting >= 60000) +
        stat('متوسط التوقف', hms(a.downtime), '', a.downtime >= 60000) +
        stat('الإنتاجية', a.kgPerHour ? a.kgPerHour.toFixed(0) : '—', 'كجم/س') +
        stat('الإنتاجية', a.piecesPerHour ? a.piecesPerHour.toFixed(1) : '—', 'قطعة/س') +
      '</div>' +
      '<p class="pt-subtitle">الاختناقات</p><div class="pt-stats">' +
        stat('أطول مرحلة', esc(n(a.topStage ? (STAGES.find(s => s.key === a.topStage) || {}).name || a.topStage : '—'))) +
        stat('أكثر مرحلة انتظاراً', esc(n(a.topWaitStage))) +
        stat('أطول حوض', esc(n(a.topTank ? tankName(a.topTank) : '—'))) +
        stat('أكثر سبب توقف', esc(n(a.topDownReason))) +
        stat('متوسط انتظار الرافعة', hms(a.craneWait)) +
        stat('متوسط حركة الرافعة', hms(a.craneMove)) +
      '</div>' +
      '<p class="pt-subtitle">الجودة</p><div class="pt-stats">' +
        stat('دفعات بها مشاكل', a.issues, '', a.issues > 0) +
        stat('نسبة السليمة', a.count ? Math.round((a.count - a.issues) / a.count * 100) : 0, '%') +
        stat('أكثر مشكلة تكراراً', esc(n(a.topIssue))) +
        stat('عمليات إعادة المعالجة', a.reworks, '', a.reworks > 0) +
        stat('متوسط زمن الدفعات المعيبة', a.issueCycle ? hms(a.issueCycle) : '—') +
      '</div>' +
      (stageRows ? '<p class="pt-subtitle">متوسط كل مرحلة</p><div class="pt-timeline">' + stageRows + '</div>' : '') +
      (tankRows ? '<p class="pt-subtitle">متوسط كل حوض</p><div class="pt-timeline">' + tankRows + '</div>' : '') +
      (prodRows ? '<p class="pt-subtitle">متوسط كل منتج</p><div class="pt-timeline">' + prodRows + '</div>' : '');
  }

  function render() {
    if (!root) return;
    if (!IS_EDITOR && !SHOW_ANALYTICS_TO_VIEWERS) { root.innerHTML = ''; return; }

    const act = activeBatches();
    const products = Array.from(new Set(doneBatches().map(b => b.product).filter(Boolean)));
    const tanks = Array.from(new Set(allBatches().flatMap(b => segs(b).map(s => s.tank)).filter(Boolean)));

    // preserve filter values across re-renders
    const keep = {};
    ['pt-f-q', 'pt-f-from', 'pt-f-to', 'pt-f-prod', 'pt-f-tank', 'pt-f-issue'].forEach(id => {
      const el = document.getElementById(id); if (el) keep[id] = el.value;
    });

    root.innerHTML =
      '<section class="pt-section">' +
        '<div class="sechead"><span class="secnum">١</span><h2 class="sectitle">الدفعات الجارية</h2></div>' +
        '<p class="secsub">كل دفعة لها مؤقّت مستقل. كل ضغطة تُسجَّل بوقتها الفعلي وتُحفظ فوراً.</p>' +
        '<div class="pt-bar">' +
          (IS_EDITOR ? '<button class="btn" id="pt-new">دفعة جديدة</button>' : '') +
          '<span class="spacer"></span>' +
          '<button class="btn ghost" id="pt-export">تصدير الكل (Excel)</button>' +
        '</div>' +
        (act.length
          ? '<div class="pt-active-grid">' + act.map(batchCard).join('') + '</div>'
          : '<div class="pt-empty">لا توجد دفعات جارية — اضغط «دفعة جديدة» للبدء</div>') +
      '</section>' +

      '<section class="pt-section">' +
        '<div class="sechead"><span class="secnum">٢</span><h2 class="sectitle">لوحة التحليل</h2></div>' +
        '<p class="secsub">تُحسب تلقائياً من كل دفعة مكتملة — الزمن الفعلي مقابل المتوقع، والوقت الضائع، والاختناقات.</p>' +
        analyticsHtml() +
      '</section>' +

      '<section class="pt-section">' +
        '<div class="sechead"><span class="secnum">٣</span><h2 class="sectitle">سجل الإنتاج</h2></div>' +
        '<p class="secsub">اضغط على أي دفعة لعرض خطها الزمني الكامل ثانية بثانية.</p>' +
        '<div class="pt-filters">' +
          '<input id="pt-f-q" placeholder="بحث: رقم دفعة / منتج / أمر تشغيل">' +
          '<input id="pt-f-from" type="date" title="من تاريخ">' +
          '<input id="pt-f-to" type="date" title="إلى تاريخ">' +
          '<select id="pt-f-prod"><option value="">كل المنتجات</option>' +
            products.map(p => '<option>' + esc(p) + '</option>').join('') + '</select>' +
          '<select id="pt-f-tank"><option value="">كل الأحواض</option>' +
            tanks.map(t => '<option value="' + esc(t) + '">' + esc(tankName(t)) + '</option>').join('') + '</select>' +
          '<select id="pt-f-issue"><option value="">الكل</option><option value="no">سليمة فقط</option><option value="yes">بها مشاكل</option></select>' +
        '</div>' +
        '<div id="pt-history"></div>' +
      '</section>';

    Object.keys(keep).forEach(id => { const el = document.getElementById(id); if (el) el.value = keep[id]; });
    document.getElementById('pt-history').innerHTML = historyTable();
    wire();
    mounted = true;
  }

  function wire() {
    const nb = document.getElementById('pt-new');
    if (nb) nb.addEventListener('click', openNewBatch);
    const ex = document.getElementById('pt-export');
    if (ex) ex.addEventListener('click', exportCsv);

    root.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        switch (btn.dataset.act) {
          case 'next': next(id); break;
          case 'lift': liftOut(id); break;
          case 'wait': startWait(id); break;
          case 'pause': pause(id); break;
          case 'resume': resume(id); break;
          case 'undo': undo(id); break;
          case 'rework': startRework(id); break;
        }
      });
    });

    root.querySelectorAll('.pt-batch-head').forEach(h => {
      h.style.cursor = 'pointer';
      h.addEventListener('click', () => openDetails(h.closest('[data-batch]').dataset.batch));
    });

    ['pt-f-q', 'pt-f-from', 'pt-f-to', 'pt-f-prod', 'pt-f-tank', 'pt-f-issue'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => {
        document.getElementById('pt-history').innerHTML = historyTable();
        wireHistory();
      });
    });
    wireHistory();
  }

  function wireHistory() {
    root.querySelectorAll('[data-open]').forEach(tr => {
      tr.addEventListener('click', () => openDetails(tr.dataset.open));
    });
  }

  /* live timers — update only the numbers so inputs keep focus */
  setInterval(() => {
    if (!mounted || !root) return;
    root.querySelectorAll('[data-live]').forEach(el => {
      const since = Number(el.dataset.since);
      if (!since) return;
      el.textContent = hms(Date.now() - since);
    });
  }, 1000);

  // expose a couple of helpers for the daily export script / console use
  window.KGCProduction = {
    exportCsv: exportCsv, analytics: analytics, totals: totals,
    _batches: () => batches, _stages: () => STAGES
  };
})();
