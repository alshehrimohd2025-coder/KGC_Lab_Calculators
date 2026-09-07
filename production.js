/* ============================================================
   Production Time Tracker — KGC galvanizing line
   ------------------------------------------------------------
   Records EVERY timestamp as its own segment so the historical
   data can later answer: actual vs expected time, waiting,
   downtime, crane cost, per-tank averages and bottlenecks.

   Depends on globals defined in index.html:
     database   (firebase realtime db)
     IS_EDITOR  (editor UI flag, from the ?edit= link)
     IS_AUTHED  (Firebase Auth confirmed the editor's password)
   Every write also requires IS_AUTHED — IS_EDITOR alone only shows the UI.
   ============================================================ */
(function () {
  'use strict';

  if (typeof database === 'undefined') {
    console.error('[production] Firebase database is not available.');
    return;
  }

  /* ---------------- configuration ---------------- */

  // Stages are data-driven: adding another rinsing tank later is a config
  // change (or a Firebase edit), not a rewrite. Names come from i18n by key.
  const DEFAULT_STAGES = [
    { key: 'loading',         type: 'simple' },
    { key: 'crane_attach',    type: 'simple' },
    { key: 'crane_wait',      type: 'simple' },
    { key: 'crane_move',      type: 'simple' },
    { key: 'degreasing',      type: 'tank' },
    { key: 'rinse_pre_acid',  type: 'tank' },
    { key: 'acid',            type: 'tank', tankGroup: 'acid' },
    { key: 'rinse_post_acid', type: 'tank', tankGroup: 'rinse' },
    { key: 'flux',            type: 'tank' },
    { key: 'drying',          type: 'simple' },
    { key: 'wait_zinc',       type: 'simple' },
    { key: 'zinc',            type: 'tank' },
    { key: 'cooling',         type: 'simple' },
    { key: 'inspection',      type: 'simple' }
  ];

  const DEFAULT_TANK_GROUPS = {
    acid:  [{ v: 'acid_1' }, { v: 'acid_2' }, { v: 'acid_3' }, { v: 'acid_4' }],
    rinse: [{ v: 'rinse_1' }, { v: 'rinse_2' }]
  };
  const STRIPPING_TANK = { v: 'stripping' };

  /* Reasons are stored as keys, never as display text, so a log written in
     Arabic still reads correctly when the site is switched to English. */
  const WAIT_REASONS = ['r.wait.crane', 'r.wait.operator', 'r.wait.tank', 'r.wait.equip', 'r.wait.prod', 'r.wait.maint', 'r.wait.other'];
  const DOWN_REASONS = ['r.down.crane', 'r.down.equip', 'r.down.tank', 'r.down.operator', 'r.down.maint', 'r.down.product', 'r.down.other'];
  const ISSUE_TYPES  = ['r.iss.surface', 'r.iss.rust', 'r.iss.excesszinc', 'r.iss.coating', 'r.iss.chem', 'r.iss.handling', 'r.iss.other'];
  const REWORK_REASONS = ['r.rw.coating', 'r.rw.excesszinc', 'r.rw.contam', 'r.rw.oxid', 'r.rw.other'];

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
  // 1س 12د  /  1h 12m
  function dur(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return '—';
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, sec = total % 60;
    if (h) return h + t('u.h') + ' ' + m + t('u.m');
    if (m) return m + t('u.m') + ' ' + sec + t('u.s');
    return sec + t('u.s');
  }
  const mins = ms => (ms == null || !isFinite(ms)) ? '' : (ms / 60000).toFixed(1);
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  /* Every label below resolves through i18n by key, and falls back to whatever
     was stored if the key is unknown — so older records still read correctly. */
  function tr(key, fallback) {
    const out = t(key);
    return out === key ? (fallback != null ? fallback : key) : out;
  }
  const tankName = v => (!v ? '' : tr('pt.ptank.' + v, v));
  const stageName = (key, fallback) => tr('pt.stage.' + key, fallback);
  const reasonName = r => (!r ? '' : tr(r, r));
  const kindLabel = k => (k === 'stage' ? '' : tr('pt.kind.' + k, k));

  const stageAt = i => STAGES[i] || null;
  const stageIndexOf = key => STAGES.findIndex(s => s.key === key);

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
      stageName: stageName(st.key),
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
    if (!IS_EDITOR || !IS_AUTHED) return;
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
    const tt = {
      cycle: (b.endTs || Date.now()) - b.startTs,
      net: 0,          // cycle minus downtime — the clock a full stop freezes
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
      if (s.kind === 'wait') { tt.waiting += d; return; }
      if (s.kind === 'downtime') { tt.downtime += d; return; }
      if (s.kind === 'rework') return;
      if (s.kind === 'draining') {
        tt.draining += d;
        if (s.tank) tt.drainByTank[s.tank] = (tt.drainByTank[s.tank] || 0) + d;
        return;
      }
      // stage | immersion
      tt.processing += d;
      tt.byStage[s.stageKey] = (tt.byStage[s.stageKey] || 0) + d;
      if (s.kind === 'immersion' && s.tank) tt.byTank[s.tank] = (tt.byTank[s.tank] || 0) + d;
      if (s.stageKey === 'crane_wait') tt.craneWait += d;
      if (s.stageKey === 'crane_move') tt.craneMove += d;
    });
    tt.net = Math.max(0, tt.cycle - tt.downtime);
    return tt;
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

    rows.forEach(({ b, t: tt }) => {
      Object.keys(tt.byStage).forEach(k => bucket(a.stage, k, tt.byStage[k]));
      Object.keys(tt.byTank).forEach(k => bucket(a.tank, k, tt.byTank[k]));
      Object.keys(tt.drainByTank).forEach(k => bucket(a.drainTank, k, tt.drainByTank[k]));
      bucket(a.product, b.product || '—', tt.cycle);

      segs(b).forEach(s => {
        if (s.kind === 'wait') {
          a.waitReason[s.reason || '?'] = (a.waitReason[s.reason || '?'] || 0) + segLen(s);
          const k = s.stageKey || '—';
          a.waitByStage[k] = (a.waitByStage[k] || 0) + segLen(s);
        }
        if (s.kind === 'downtime') {
          a.downReason[s.reason || '?'] = (a.downReason[s.reason || '?'] || 0) + segLen(s);
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
    const b = batches[id]; if (!b || !IS_EDITOR || !IS_AUTHED) return;
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

  /** Close the current segment and move to whichever stage the operator picks.
      The line does not always run strictly in order — a batch may skip a rinse
      or go back for another dip — so the stage is chosen, not assumed. */
  function next(id) {
    const b = batches[id]; if (!b || !IS_EDITOR || !IS_AUTHED) return;
    const cur = openSeg(b);
    if (!cur) return;
    if (cur.kind === 'immersion') return;                 // must lift out first
    if (cur.kind === 'downtime') return;                  // must resume first

    askStage(b, choice => {
      if (choice === 'finish') { finishBatch(id); return; }
      const idx = Number(choice);
      const st = stageAt(idx);
      if (!st) return;

      // A tank stage may need its tank chosen before it starts.
      if (st.type === 'tank' && st.tankGroup) {
        askTank(st, b.reworkActive, tank => {
          const now = Date.now();
          closeOpen(b, now);
          openStage(b, idx, now, tank);
          afterAdvance(b);
        });
        return;
      }
      const now = Date.now();
      closeOpen(b, now);
      openStage(b, idx, now);
      afterAdvance(b);
    });
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
    const b = batches[id]; if (!b || !IS_EDITOR || !IS_AUTHED) return;
    const cur = openSeg(b);
    if (!cur || cur.kind === 'wait' || cur.kind === 'downtime' || cur.kind === 'immersion') return;
    askReason(t('pt.waitReason'), WAIT_REASONS, reason => {
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
    const b = batches[id]; if (!b || !IS_EDITOR || !IS_AUTHED) return;
    const cur = openSeg(b);
    if (!cur || cur.kind === 'downtime') return;
    askReason(t('pt.downReason'), DOWN_REASONS, reason => {
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
    const b = batches[id]; if (!b || !IS_EDITOR || !IS_AUTHED) return;
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
    const b = batches[id]; if (!b || !IS_EDITOR || !IS_AUTHED) return;
    const list = segs(b);
    if (list.length < 2) return;
    if (!confirm(t('pt.confirmUndo'))) return;
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
    const b = batches[id]; if (!b || !IS_EDITOR || !IS_AUTHED) return;
    askRework(b, (reason, targetKey) => {
      const now = Date.now();
      const targetIdx = stageIndexOf(targetKey);
      if (targetIdx < 0) return;
      if (!Array.isArray(b.reworks)) b.reworks = [];
      b.reworks.push({ reason, returnStage: targetKey, returnStageName: (stageAt(targetIdx) || {}).name, startTs: now, endTs: null, fromStageIdx: b.stageIdx });
      b.reworkActive = true;
      closeOpen(b, now);
      pushSeg(b, {
        kind: 'rework', stageKey: 'rework', stageName: t('pt.rework.section'),
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
    const b = batches[id]; if (!b || !IS_EDITOR || !IS_AUTHED) return;
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
    const b = batches[id]; if (!b || !IS_EDITOR || !IS_AUTHED) return;
    if (!confirm(t('pt.confirmDelete', { n: b.batchNumber }))) return;
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
    '<div class="pt-modal-head"><h3>' + esc(title) + '</h3><button class="pt-x" data-close aria-label="' + esc(t('pt.closeAria')) + '">&times;</button></div>';

  function askReason(title, list, cb) {
    const m = modal(
      headHtml(title) +
      '<div class="pt-modal-body"><div class="pt-reasons">' +
      list.map((r, i) => '<button class="pt-reason" data-i="' + i + '">' + esc(reasonName(r)) + '</button>').join('') +
      '</div></div>'
    );
    m.el.querySelectorAll('.pt-reason').forEach(btn => {
      btn.addEventListener('click', () => { m.close(); cb(list[Number(btn.dataset.i)]); });
    });
  }

  /* Every stage is offered, with its position marked, so the operator can jump
     forward, repeat the current stage, or step back for a re-dip. */
  function askStage(b, cb) {
    const rows = STAGES.map(function (s, i) {
      const state = i < b.stageIdx ? 'done' : i === b.stageIdx ? 'now' : 'todo';
      const hint = state === 'done' ? t('pt.stageDone') : state === 'now' ? t('pt.stageNow') : '';
      return '<button class="pt-stage-opt is-' + state + '" data-i="' + i + '">' +
          '<span class="n">' + (i + 1) + '</span>' +
          '<span class="s">' + esc(stageName(s.key)) + '</span>' +
          (hint ? '<span class="h">' + esc(hint) + '</span>' : '') +
        '</button>';
    }).join('');

    const m = modal(
      headHtml(t('pt.selectStage')) +
      '<div class="pt-modal-body"><div class="pt-stage-list">' + rows + '</div></div>' +
      '<div class="pt-modal-foot">' +
        '<button class="btn" id="pt-stage-finish">' + esc(t('pt.btn.finish')) + '</button>' +
        '<button class="btn ghost" data-close>' + esc(t('pt.cancel')) + '</button>' +
      '</div>'
    );
    m.el.querySelectorAll('.pt-stage-opt').forEach(btn => {
      btn.addEventListener('click', () => { m.close(); cb(Number(btn.dataset.i)); });
    });
    m.el.querySelector('#pt-stage-finish').addEventListener('click', () => { m.close(); cb('finish'); });
  }

  function askTank(stage, allowStripping, cb) {
    let opts = (TANK_GROUPS[stage.tankGroup] || []).slice();
    if (allowStripping && stage.tankGroup === 'acid') opts.push(STRIPPING_TANK);
    if (!opts.length) { cb(null); return; }
    const m = modal(
      headHtml(t('pt.selectTank', { stage: stageName(stage.key) })) +
      '<div class="pt-modal-body"><div class="pt-reasons">' +
      opts.map((o, i) => '<button class="pt-reason" data-i="' + i + '">' + esc(tankName(o.v)) + '</button>').join('') +
      '</div></div>'
    );
    m.el.querySelectorAll('.pt-reason').forEach(btn => {
      btn.addEventListener('click', () => { m.close(); cb(opts[Number(btn.dataset.i)].v); });
    });
  }

  function askIssue(cb) {
    const m = modal(
      headHtml(t('pt.issue.title')) +
      '<div class="pt-modal-body"><div class="pt-form">' +
      '<div class="pt-field"><label>' + esc(t('pt.issue.level')) + '</label><select id="iss-level">' +
      '<option value="none">' + esc(t('pt.issue.none')) + '</option><option value="minor">' + esc(t('pt.issue.minor')) + '</option><option value="major">' + esc(t('pt.issue.major')) + '</option>' +
      '</select></div>' +
      '<div class="pt-field"><label>' + esc(t('pt.issue.type')) + '</label><select id="iss-type"><option value="">—</option>' +
      ISSUE_TYPES.map(k => '<option value="' + esc(k) + '">' + esc(reasonName(k)) + '</option>').join('') + '</select></div>' +
      '<div class="pt-field full"><label>' + esc(t('pt.issue.desc')) + '</label><textarea id="iss-desc" placeholder="' + esc(t('pt.f.optional')) + '"></textarea></div>' +
      '</div></div>' +
      '<div class="pt-modal-foot"><button class="btn" id="iss-ok">' + esc(t('pt.btn.finish')) + '</button>' +
      '<button class="btn ghost" data-close>' + esc(t('pt.cancel')) + '</button></div>'
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
      headHtml(t('pt.rework.title', { n: b.batchNumber })) +
      '<div class="pt-modal-body"><div class="pt-form">' +
      '<div class="pt-field"><label>' + esc(t('pt.rework.reason')) + '</label><select id="rw-reason">' +
      REWORK_REASONS.map(k => '<option value="' + esc(k) + '">' + esc(reasonName(k)) + '</option>').join('') + '</select></div>' +
      '<div class="pt-field"><label>' + esc(t('pt.rework.returnTo')) + '</label><select id="rw-stage">' +
      STAGES.map(x => '<option value="' + esc(x.key) + '">' + esc(stageName(x.key)) + '</option>').join('') + '</select></div>' +
      '<p class="pt-hint full">' + esc(t('pt.rework.hint')) + '</p>' +
      '</div></div>' +
      '<div class="pt-modal-foot"><button class="btn" id="rw-ok">' + esc(t('pt.rework.start')) + '</button>' +
      '<button class="btn ghost" data-close>' + esc(t('pt.cancel')) + '</button></div>'
    );
    m.el.querySelector('#rw-ok').addEventListener('click', () => {
      const reason = m.el.querySelector('#rw-reason').value;
      const stage = m.el.querySelector('#rw-stage').value;
      m.close(); cb(reason, stage);
    });
  }

  function openNewBatch() {
    if (!IS_EDITOR || !IS_AUTHED) return;
    const m = modal(
      headHtml(t('pt.newbatch')) +
      '<div class="pt-modal-body"><div class="pt-form">' +
      '<div class="pt-field"><label>' + esc(t('pt.f.batchNumber')) + '</label><input id="nb-num" value="' + esc(newBatchNumber()) + '"></div>' +
      '<div class="pt-field"><label>' + esc(t('pt.f.product')) + '</label><input id="nb-prod" placeholder="Product A"></div>' +
      '<div class="pt-field"><label>' + esc(t('pt.f.pieces')) + '</label><input id="nb-pcs" type="number" step="1" min="0" placeholder="0"></div>' +
      '<div class="pt-field"><label>' + esc(t('pt.f.weight')) + '</label><input id="nb-wt" type="number" step="0.1" min="0" placeholder="0"></div>' +
      '<div class="pt-field"><label>' + esc(t('pt.f.workOrder')) + '</label><input id="nb-wo" placeholder="' + esc(t('pt.f.optional')) + '"></div>' +
      '<div class="pt-field full"><label>' + esc(t('pt.f.notes')) + '</label><textarea id="nb-notes" placeholder="' + esc(t('pt.f.optional')) + '"></textarea></div>' +
      '<p class="pt-hint full">' + esc(t('pt.f.autoStart')) + '</p>' +
      '</div></div>' +
      '<div class="pt-modal-foot"><button class="btn" id="nb-ok">' + esc(t('pt.f.start')) + '</button>' +
      '<button class="btn ghost" data-close>' + esc(t('pt.cancel')) + '</button></div>'
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
    const tt = totals(b);
    const exp = expectedCycle(b.product, Number(b.weight) || 0);

    const rows = segs(b).map((s, i) => {
      const kindTag = s.kind !== 'stage'
        ? '<span class="pt-kind k-' + s.kind + '">' + esc(kindLabel(s.kind)) + '</span>' : '';
      const editTag = s.edited ? '<span class="pt-kind k-edited">' + esc(t('pt.edited')) + '</span>' : '';
      const sub = [
        s.tank ? tankName(s.tank) : '',
        s.reason ? t('pt.reasonIs', { r: reasonName(s.reason) }) : ''
      ].filter(Boolean).join(' · ');
      return '<div class="pt-tl-row"' + (IS_EDITOR ? ' data-edit="' + i + '" style="cursor:pointer"' : '') + '>' +
        '<div><div class="pt-tl-name">' + esc(stageName(s.stageKey, s.stageName)) + kindTag + editTag + '</div>' +
        (sub ? '<div class="pt-tl-sub">' + esc(sub) + '</div>' : '') + '</div>' +
        '<div class="pt-tl-time">' + clock(s.startTs) + ' → ' + (s.endTs ? clock(s.endTs) : '…') + '</div>' +
        '<div class="pt-tl-dur">' + dur(segLen(s)) + '</div>' +
        '</div>';
    }).join('');

    const stat = (k, v, hot) =>
      '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';

    const issue = b.issue || { level: 'none' };
    const issuePill = issue.level === 'none' || !issue.level
      ? '<span class="pt-pill pill-ok">' + esc(t('pt.noIssues')) + '</span>'
      : '<span class="pt-pill ' + (issue.level === 'major' ? 'pill-bad' : 'pill-warn') + '">' +
        esc(issue.level === 'major' ? t('pt.issue.major') : t('pt.issue.minor')) + (issue.type ? ' — ' + esc(reasonName(issue.type)) : '') + '</span>';

    const reworkHtml = (b.reworks || []).length
      ? '<p class="pt-subtitle">' + esc(t('pt.rework.section')) + '</p>' + (b.reworks || []).map(r =>
          '<div class="pt-tl-row"><div><div class="pt-tl-name">' + esc(reasonName(r.reason)) + '</div>' +
          '<div class="pt-tl-sub">' + esc(t('pt.rework.returned', { stage: stageName(r.returnStage, r.returnStageName) })) + '</div></div>' +
          '<div class="pt-tl-time">' + clock(r.startTs) + ' → ' + (r.endTs ? clock(r.endTs) : '…') + '</div>' +
          '<div class="pt-tl-dur">' + (r.endTs ? dur(r.endTs - r.startTs) : '—') + '</div></div>').join('')
      : '';

    const auditHtml = (b.audit || []).length
      ? '<p class="pt-subtitle">' + esc(t('pt.details.audit')) + '</p>' + (b.audit || []).map(a =>
          '<div class="pt-tl-row"><div><div class="pt-tl-name">' + esc(a.field) + '</div>' +
          '<div class="pt-tl-sub">' + esc(a.reason || '') + '</div></div>' +
          '<div class="pt-tl-time">' + esc(a.from) + ' → ' + esc(a.to) + '</div>' +
          '<div class="pt-tl-dur">' + clock(a.ts) + '</div></div>').join('')
      : '';

    const m = modal(
      headHtml(t('pt.batch') + ' ' + b.batchNumber + ' — ' + (b.product || t('pt.noProduct'))) +
      '<div class="pt-modal-body">' +
        '<div class="pt-bar">' + issuePill +
          '<span class="pt-tl-sub">' + esc(b.pieces || 0) + ' ' + esc(t('pt.pieces')) + ' · ' + esc(b.weight || 0) + ' ' + esc(t('pt.kg')) +
          (b.workOrder ? ' · ' + esc(b.workOrder) : '') + '</span>' +
          '<span class="spacer"></span>' +
          '<span class="pt-tl-time">' + dateStr(b.startTs) + '</span>' +
        '</div>' +
        '<div class="pt-stats">' +
          stat(t('pt.stat.actual'), hms(tt.cycle)) +
          stat(t('pt.stat.expected'), exp ? hms(exp.ms) : '—') +
          stat(t('pt.stat.processing'), hms(tt.processing)) +
          stat(t('pt.stat.draining'), hms(tt.draining)) +
          stat(t('pt.stat.waiting'), hms(tt.waiting), tt.waiting >= 60000) +
          stat(t('pt.stat.downtime'), hms(tt.downtime), tt.downtime >= 60000) +
        '</div>' +
        '<p class="pt-subtitle">' + esc(t('pt.details.timeline')) + '</p>' +
        '<div class="pt-timeline">' + rows + '</div>' +
        reworkHtml + auditHtml +
        (IS_EDITOR ? '<p class="pt-hint" style="margin-top:14px">' + esc(t('pt.details.editHint')) + '</p>' : '') +
      '</div>' +
      '<div class="pt-modal-foot">' +
        '<button class="btn ghost" data-close>' + esc(t('pt.close')) + '</button>' +
        (IS_EDITOR && b.status === 'done' ? '<button class="btn danger" id="del-batch">' + esc(t('pt.details.delete')) + '</button>' : '') +
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
    const b = batches[id]; if (!b || !IS_EDITOR || !IS_AUTHED) return;
    const s = segs(b)[i]; if (!s) return;

    const m = modal(
      headHtml(t('pt.edit.title', { stage: stageName(s.stageKey, s.stageName) })) +
      '<div class="pt-modal-body"><div class="pt-form">' +
      '<div class="pt-field"><label>' + esc(t('pt.edit.start')) + '</label><input id="ed-start" type="datetime-local" step="1" value="' + toLocalInput(s.startTs) + '"></div>' +
      '<div class="pt-field"><label>' + esc(t('pt.edit.end')) + '</label><input id="ed-end" type="datetime-local" step="1" value="' + toLocalInput(s.endTs) + '"></div>' +
      (s.tank ? '<div class="pt-field"><label>' + esc(t('pt.edit.tank')) + '</label><input id="ed-tank" value="' + esc(tankName(s.tank)) + '" disabled></div>' : '') +
      (s.kind === 'wait' ? '<div class="pt-field"><label>' + esc(t('pt.waitReason')) + '</label><select id="ed-reason">' +
        WAIT_REASONS.map(r => '<option value="' + esc(r) + '"' + (r === s.reason ? ' selected' : '') + '>' + esc(reasonName(r)) + '</option>').join('') + '</select></div>' : '') +
      (s.kind === 'downtime' ? '<div class="pt-field"><label>' + esc(t('pt.downReason')) + '</label><select id="ed-reason">' +
        DOWN_REASONS.map(r => '<option value="' + esc(r) + '"' + (r === s.reason ? ' selected' : '') + '>' + esc(reasonName(r)) + '</option>').join('') + '</select></div>' : '') +
      '<div class="pt-field full"><label>' + esc(t('pt.edit.why')) + '</label><input id="ed-why" placeholder="' + esc(t('pt.edit.whyPh')) + '"></div>' +
      '<p class="pt-hint full">' + esc(t('pt.edit.hint')) + '</p>' +
      '</div></div>' +
      '<div class="pt-modal-foot"><button class="btn" id="ed-ok">' + esc(t('pt.edit.save')) + '</button>' +
      '<button class="btn ghost" data-close>' + esc(t('pt.cancel')) + '</button></div>'
    );

    m.el.querySelector('#ed-ok').addEventListener('click', () => {
      const why = m.el.querySelector('#ed-why').value.trim();
      if (!why) { alert(t('pt.edit.needWhy')); return; }
      const ns = fromLocalInput(m.el.querySelector('#ed-start').value);
      const ne = fromLocalInput(m.el.querySelector('#ed-end').value);
      if (ns && ne && ne < ns) { alert(t('pt.edit.badRange')); return; }

      if (!Array.isArray(b.audit)) b.audit = [];
      const log = (field, from, to) => {
        if (from === to) return;
        b.audit.push({ ts: Date.now(), field: stageName(s.stageKey, s.stageName) + ' — ' + field, from: from, to: to, reason: why, by: 'editor' });
      };
      if (ns && ns !== s.startTs) { log(t('pt.edit.fStart'), clock(s.startTs), clock(ns)); if (s.originalStartTs == null) s.originalStartTs = s.startTs; s.startTs = ns; s.edited = true; }
      if (ne !== s.endTs && (ne || s.endTs)) { log(t('pt.edit.fEnd'), clock(s.endTs), clock(ne)); if (s.originalEndTs == null) s.originalEndTs = s.endTs || null; s.endTs = ne; s.edited = true; }
      const rsel = m.el.querySelector('#ed-reason');
      if (rsel && rsel.value !== s.reason) { log(t('pt.edit.fReason'), reasonName(s.reason) || '—', reasonName(rsel.value)); s.reason = rsel.value; s.edited = true; }

      save(b); m.close(); render(); openDetails(id);
    });
  }

  /* ================= export ================= */

  function exportCsv() {
    const rows = [];
    rows.push([t('pt.f.batchNumber'), t('pt.h.product'), t('pt.pieces'), t('pt.h.weight'), t('pt.f.workOrder'),
               t('pt.h.date'), t('pt.h.start'), t('pt.h.end'),
               t('pt.h.total'), t('pt.stat.processing'), t('pt.stat.draining'), t('pt.stat.waiting'), t('pt.stat.downtime'),
               t('pt.issueShort'), t('pt.issue.type'),
               t('pt.kind.stage'), t('pt.h.status'), t('pt.edit.tank'),
               t('pt.h.start'), t('pt.h.end'), t('pt.h.total'), t('pt.rework.reason')]);

    allBatches().forEach(b => {
      const tt = totals(b);
      const base = [
        b.batchNumber, b.product, b.pieces, b.weight, b.workOrder, dateStr(b.startTs),
        clock(b.startTs), b.endTs ? clock(b.endTs) : '',
        mins(tt.cycle), mins(tt.processing), mins(tt.draining), mins(tt.waiting), mins(tt.downtime),
        (b.issue && b.issue.level && b.issue.level !== 'none') ? '1' : '0',
        (b.issue && b.issue.type) || ''
      ];
      const list = segs(b);
      if (!list.length) { rows.push(base.concat(['', '', '', '', '', '', ''])); return; }
      list.forEach(s => {
        rows.push(base.concat([
          stageName(s.stageKey, s.stageName),
          kindLabel(s.kind) || t('pt.kind.stage'),
          tankName(s.tank),
          clock(s.startTs),
          s.endTs ? clock(s.endTs) : '',
          mins(segLen(s)),
          reasonName(s.reason)
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
    const tt = totals(b);
    const exp = expectedCycle(b.product, Number(b.weight) || 0);

    const cls = kind === 'downtime' ? 'is-paused' : kind === 'wait' ? 'is-waiting' : b.reworkActive ? 'is-rework' : '';
    const phaseLabel = kind === 'downtime' ? t('pt.phase.paused') : kind === 'wait' ? t('pt.phase.waiting') :
                       kind === 'immersion' ? t('pt.phase.immersion') : kind === 'draining' ? t('pt.phase.draining') : t('pt.phase.running');

    const curStage = cur ? stageName(cur.stageKey, cur.stageName) : '';
    const stageTitle = kind === 'wait' ? t('pt.waitAfter', { stage: curStage })
                     : kind === 'downtime' ? t('pt.downDuring', { stage: curStage })
                     : (st ? stageName(st.key) : '—') + (cur && cur.tank ? ' — ' + tankName(cur.tank) : '');

    const rail = STAGES.map((s, i) =>
      '<span class="' + (i < b.stageIdx ? 'done' : i === b.stageIdx ? 'now' : '') + '"></span>').join('');

    let actions = '';
    if (IS_EDITOR) {
      if (kind === 'downtime') {
        actions = '<button class="btn wide" data-act="resume" data-id="' + b.id + '">' + esc(t('pt.btn.resume')) + '</button>';
      } else if (kind === 'immersion') {
        actions =
          '<button class="btn wide" data-act="lift" data-id="' + b.id + '">' + esc(t('pt.btn.lift')) + '</button>' +
          '<button class="btn ghost" data-act="pause" data-id="' + b.id + '">' + esc(t('pt.btn.pause')) + '</button>' +
          '<button class="btn ghost" data-act="undo" data-id="' + b.id + '">' + esc(t('pt.btn.undo')) + '</button>';
      } else {
        const last = b.stageIdx >= STAGES.length - 1 && kind !== 'wait';
        actions =
          '<button class="btn wide" data-act="next" data-id="' + b.id + '">' + (last ? t('pt.btn.finish') : t('pt.btn.next')) + '</button>' +
          (kind === 'wait' ? '' : '<button class="btn ghost" data-act="wait" data-id="' + b.id + '">' + esc(t('pt.btn.wait')) + '</button>') +
          '<button class="btn ghost" data-act="pause" data-id="' + b.id + '">' + esc(t('pt.btn.pause')) + '</button>' +
          '<button class="btn ghost" data-act="undo" data-id="' + b.id + '">' + esc(t('pt.btn.undo')) + '</button>';
      }
      actions += '<button class="btn ghost" data-act="rework" data-id="' + b.id + '">' + esc(t('pt.btn.rework')) + '</button>' +
        '<button class="btn ghost danger" data-act="delete" data-id="' + b.id + '">' + esc(t('pt.btn.delete')) + '</button>';
    }

    return '<div class="pt-batch ' + cls + '" data-batch="' + b.id + '">' +
      '<div class="pt-batch-head">' +
        '<div><div class="pt-batch-id">' + esc(t('pt.batch')) + ' ' + esc(b.batchNumber) + '</div>' +
        '<div class="pt-batch-meta">' + esc(b.product || t('pt.noProduct')) +
        (b.weight ? ' · ' + esc(b.weight) + ' ' + esc(t('pt.kg')) : '') +
        (b.pieces ? ' · ' + esc(b.pieces) + ' ' + esc(t('pt.pieces')) : '') + '</div></div>' +
        '<span class="pt-phase-tag">' + phaseLabel + '</span>' +
      '</div>' +
      '<div class="pt-stage-now">' +
        '<div class="pt-stage-label">' + esc(t('pt.currentStage')) + '</div>' +
        '<div class="pt-stage-name">' + esc(stageTitle) + '</div>' +
        '<div class="pt-elapsed" data-live="stage" data-since="' + (cur ? cur.startTs : b.startTs) + '">' +
          hms(cur ? segLen(cur) : 0) + '</div>' +
        '<div class="pt-elapsed-sub">' + esc(t('pt.batchTotal')) + ' <span data-live="total" data-since="' + b.startTs +
          '" data-offset="' + tt.downtime + '"' + (kind === 'downtime' ? ' data-frozen="1"' : '') + '>' + hms(tt.net) + '</span>' +
          (tt.downtime ? ' <small class="pt-stopped">' + esc(t('pt.stoppedFor', { d: hms(tt.downtime) })) + '</small>' : '') + '</div>' +
        (exp ? '<div class="pt-expected"><span>' + esc(t('pt.expected')) + ' <b>' + hms(exp.ms) + '</b></span>' +
               '<span>' + esc(t('pt.fromNBatches', { n: exp.n })) + '</span></div>' : '') +
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

    if (!list.length) return '<div class="pt-empty">' + esc(t('pt.noMatch')) + '</div>';

    const rows = list.map(b => {
      const tt = totals(b);
      const has = b.issue && b.issue.level && b.issue.level !== 'none';
      return '<tr class="pt-row-link" data-open="' + b.id + '">' +
        '<td class="name">' + esc(b.batchNumber) + '</td>' +
        '<td class="name">' + esc(b.product || '—') + '</td>' +
        '<td class="num">' + esc(b.weight || 0) + '</td>' +
        '<td class="num">' + dateStr(b.startTs) + '</td>' +
        '<td class="num">' + clock(b.startTs) + '</td>' +
        '<td class="num">' + clock(b.endTs) + '</td>' +
        '<td class="num">' + dur(tt.cycle) + '</td>' +
        '<td class="num">' + dur(tt.waiting) + '</td>' +
        '<td>' + (has
          ? '<span class="pt-pill ' + (b.issue.level === 'major' ? 'pill-bad' : 'pill-warn') + '">' + esc(reasonName(b.issue.type) || t('pt.issueShort')) + '</span>'
          : '<span class="pt-pill pill-ok">' + esc(t('pt.clean')) + '</span>') + '</td>' +
      '</tr>';
    }).join('');

    return '<div class="tablewrap"><table><thead><tr>' +
      ['pt.h.batch','pt.h.product','pt.h.weight','pt.h.date','pt.h.start','pt.h.end','pt.h.total','pt.h.waiting','pt.h.status']
        .map(k => '<th>' + esc(t(k)) + '</th>').join('') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function analyticsHtml() {
    const a = analytics();
    if (!a.count) return '<div class="pt-empty">' + esc(t('pt.noAnalytics')) + '</div>';

    const stat = (k, v, unit, hot) =>
      '<div class="pt-stat' + (hot ? ' hot' : '') + '"><span class="k">' + esc(k) + '</span>' +
      '<span class="v">' + v + (unit ? '<small>' + unit + '</small>' : '') + '</span></div>';
    const n = v => v == null ? '—' : v;

    const stageRows = Object.keys(a.stage)
      .map(k => ({ k, v: a.stage[k] }))
      .sort((x, y) => y.v.avg - x.v.avg)
      .map(r => {
        const st = STAGES.find(s => s.key === r.k);
        return '<div class="pt-tl-row"><div class="pt-tl-name">' + esc(stageName(r.k)) + '</div>' +
          '<div class="pt-tl-time">' + esc(t('pt.a.nBatches', { n: r.v.n })) + '</div>' +
          '<div class="pt-tl-dur">' + dur(r.v.avg) + '</div></div>';
      }).join('');

    const tankRows = Object.keys(a.tank).map(k =>
      '<div class="pt-tl-row"><div class="pt-tl-name">' + esc(tankName(k)) + '</div>' +
      '<div class="pt-tl-time">' + esc(t('pt.a.immersionN', { n: a.tank[k].n })) +
      (a.drainTank[k] ? ' · ' + esc(t('pt.a.drainAvg', { d: dur(a.drainTank[k].avg) })) : '') + '</div>' +
      '<div class="pt-tl-dur">' + dur(a.tank[k].avg) + '</div></div>').join('');

    const prodRows = Object.keys(a.product).map(k =>
      '<div class="pt-tl-row"><div class="pt-tl-name">' + esc(k) + '</div>' +
      '<div class="pt-tl-time">' + esc(t('pt.a.nBatches', { n: a.product[k].n })) + '</div>' +
      '<div class="pt-tl-dur">' + dur(a.product[k].avg) + '</div></div>').join('');

    return '' +
      '<p class="pt-subtitle">' + esc(t('pt.sec.production')) + '</p><div class="pt-stats">' +
        stat(t('pt.a.batches'), a.count) +
        stat(t('pt.a.weight'), Math.round(a.weight), t('pt.kg')) +
        stat(t('pt.a.avgCycle'), hms(a.cycle)) +
        stat(t('pt.a.avgProc'), hms(a.processing)) +
        stat(t('pt.a.avgWait'), hms(a.waiting), '', a.waiting >= 60000) +
        stat(t('pt.a.avgDown'), hms(a.downtime), '', a.downtime >= 60000) +
        stat(t('pt.a.rate'), a.kgPerHour ? a.kgPerHour.toFixed(0) : '—', t('pt.a.kgh')) +
        stat(t('pt.a.rate'), a.piecesPerHour ? a.piecesPerHour.toFixed(1) : '—', t('pt.a.pch')) +
      '</div>' +
      '<p class="pt-subtitle">' + esc(t('pt.sec.bottlenecks')) + '</p><div class="pt-stats">' +
        stat(t('pt.a.longestStage'), esc(a.topStage ? stageName(a.topStage) : '—')) +
        stat(t('pt.a.mostWait'), esc(a.topWaitStage ? stageName(a.topWaitStage) : '—')) +
        stat(t('pt.a.longestTank'), esc(a.topTank ? tankName(a.topTank) : '—')) +
        stat(t('pt.a.topDown'), esc(a.topDownReason ? reasonName(a.topDownReason) : '—')) +
        stat(t('pt.a.craneWait'), hms(a.craneWait)) +
        stat(t('pt.a.craneMove'), hms(a.craneMove)) +
      '</div>' +
      '<p class="pt-subtitle">' + esc(t('pt.sec.quality')) + '</p><div class="pt-stats">' +
        stat(t('pt.a.withIssues'), a.issues, '', a.issues > 0) +
        stat(t('pt.a.cleanPct'), a.count ? Math.round((a.count - a.issues) / a.count * 100) : 0, '%') +
        stat(t('pt.a.topIssue'), esc(a.topIssue ? reasonName(a.topIssue) : '—')) +
        stat(t('pt.a.reworks'), a.reworks, '', a.reworks > 0) +
        stat(t('pt.a.issueCycle'), a.issueCycle ? hms(a.issueCycle) : '—') +
      '</div>' +
      (stageRows ? '<p class="pt-subtitle">' + esc(t('pt.sec.stageAvg')) + '</p><div class="pt-timeline">' + stageRows + '</div>' : '') +
      (tankRows ? '<p class="pt-subtitle">' + esc(t('pt.sec.tankAvg')) + '</p><div class="pt-timeline">' + tankRows + '</div>' : '') +
      (prodRows ? '<p class="pt-subtitle">' + esc(t('pt.sec.productAvg')) + '</p><div class="pt-timeline">' + prodRows + '</div>' : '');
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
        '<div class="sechead"><span class="secnum">١</span><h2 class="sectitle">' + esc(t('pt.active.title')) + '</h2></div>' +
        '<p class="secsub">' + esc(t('pt.active.sub')) + '</p>' +
        '<div class="pt-bar">' +
          (IS_EDITOR ? '<button class="btn" id="pt-new">' + esc(t('pt.new')) + '</button>' : '') +
          '<span class="spacer"></span>' +
          '<button class="btn ghost" id="pt-export">' + esc(t('pt.export')) + '</button>' +
        '</div>' +
        (act.length
          ? '<div class="pt-active-grid">' + act.map(batchCard).join('') + '</div>'
          : '<div class="pt-empty">' + esc(t('pt.noActive')) + '</div>') +
      '</section>' +

      '<section class="pt-section">' +
        '<div class="sechead"><span class="secnum">٢</span><h2 class="sectitle">' + esc(t('pt.analytics.title')) + '</h2></div>' +
        '<p class="secsub">' + esc(t('pt.analytics.sub')) + '</p>' +
        analyticsHtml() +
      '</section>' +

      '<section class="pt-section">' +
        '<div class="sechead"><span class="secnum">٣</span><h2 class="sectitle">' + esc(t('pt.history.title')) + '</h2></div>' +
        '<p class="secsub">' + esc(t('pt.history.sub')) + '</p>' +
        '<div class="pt-filters">' +
          '<input id="pt-f-q" placeholder="' + esc(t('pt.search')) + '">' +
          '<input id="pt-f-from" type="date" title="' + esc(t('pt.h.start')) + '">' +
          '<input id="pt-f-to" type="date" title="' + esc(t('pt.h.end')) + '">' +
          '<select id="pt-f-prod"><option value="">' + esc(t('pt.allProducts')) + '</option>' +
            products.map(p => '<option>' + esc(p) + '</option>').join('') + '</select>' +
          '<select id="pt-f-tank"><option value="">' + esc(t('pt.allTanks')) + '</option>' +
            tanks.map(t => '<option value="' + esc(t) + '">' + esc(tankName(t)) + '</option>').join('') + '</select>' +
          '<select id="pt-f-issue"><option value="">' + esc(t('pt.all')) + '</option><option value="no">' + esc(t('pt.cleanOnly')) + '</option><option value="yes">' + esc(t('pt.withIssues')) + '</option></select>' +
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
          case 'delete': deleteBatch(id); break;
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
      if (el.dataset.frozen === '1') return;   // batch is stopped — the clock stands still
      const since = Number(el.dataset.since);
      if (!since) return;
      const off = Number(el.dataset.offset) || 0;
      el.textContent = hms(Math.max(0, Date.now() - since - off));
    });
  }, 1000);

  // expose a couple of helpers for the daily export script / console use
  if (window.I18N) I18N.onChange(render);

  window.KGCProduction = {
    exportCsv: exportCsv, analytics: analytics, totals: totals, render: render,
    _batches: () => batches, _stages: () => STAGES
  };
})();
