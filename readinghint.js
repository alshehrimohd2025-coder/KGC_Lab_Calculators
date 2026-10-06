/* ============================================================
   Reading hints — hover a reading on a tank card to see what it means
   ------------------------------------------------------------
   For the reading under the pointer: its current value and status, the
   operating range and the best value, and what happens to the process when
   the figure sits low or high. The limits come from the spec engine
   (specs.js), so they follow any change made on the standards page; only
   the process consequences are written here.

   Depends on globals from index.html: tanks, tankLabel(), fieldLabel(),
   and window.KGCSpecs.
   ============================================================ */
(function () {
  'use strict';

  const GROUP = { 1: 'degrease', 2: 'rinsePre', 3: 'acid', 4: 'acid', 5: 'acid', 6: 'acid', 8: 'acid',
                  7: 'strip', 9: 'rinse2', 10: 'flux' };

  /* What a low or high figure does to the line, per bath. Plain process
     consequences, tied where possible to zinc: iron carried forward ends up
     as dross in the kettle (about 25 kg of zinc lost per kg of iron). */
  const KB = {
    degrease: {
      conc: {
        why: ['يحدد قدرة الحوض على إزالة الزيوت والشحوم قبل الحمض.', 'Sets how well the bath removes oil and grease before pickling.'],
        low: ['الزيوت لا تُزال، فالحمض لا يبلّل سطح الحديد بالتساوي ← تخليل غير متجانس وبقع سوداء غير مجلفنة، وزيت يُحمل إلى أحواض الحمض.',
              'Oil stays on the steel, so acid cannot wet it evenly → patchy pickling, black ungalvanized spots, and oil carried into the acid tanks.'],
        high: ['هدر في الكيميائي، وحمل زائد إلى الرينس والحمض، ورغوة.', 'Chemical wasted, more carry-over into the rinse and acid, foaming.'] },
      sg: {
        why: ['مؤشر على تركيز الحوض وما تراكم فيه من زيوت وأملاح.', 'Indicates bath strength and the oil and salts built up in it.'],
        low: ['الحوض مخفّف أو مستنفد ← تنظيف ضعيف.', 'Bath diluted or exhausted → weak cleaning.'],
        high: ['تراكم زيوت وأملاح مذابة ← الحوض قديم ويقترب من التجديد.', 'Dissolved oil and salts building up → bath ageing, due for renewal.'] },
      temp: {
        why: ['الحرارة تسرّع استحلاب الزيوت.', 'Temperature drives how fast oil is emulsified.'],
        low: ['إزالة الشحوم بطيئة وغير كاملة، خاصة على القطع المزيّتة بكثافة.', 'Degreasing slow and incomplete, especially on heavily oiled parts.'],
        high: ['تبخر وتحلل للمادة، وأبخرة، واستهلاك أسرع للكيميائي.', 'Evaporation and breakdown of the chemical, fumes, faster consumption.'] }
    },
    rinsePre: {
      ph: {
        why: ['يكشف ما يُحمل من حوض الشحوم إلى الحمض.', 'Shows what is being carried from degreasing into the acid.'],
        low: ['تراكم حمل من حوض الشحوم الحمضي ← الماء مشبع، يجب تغييره.', 'Carry-over from the acidic degreaser has built up → water saturated, change it.'],
        high: ['تلوث قلوي يُحمل إلى الحمض ويعادله ← يقصّر عمر أحواض الحمض.', 'Alkaline contamination carried into the acid, neutralising it → shorter acid life.'] },
      ec: {
        why: ['كمية الأملاح والمواد المذابة في ماء الغسيل.', 'How much salt and residue is dissolved in the rinse water.'],
        high: ['الماء محمّل بالشحوم والأملاح ← تُنقل إلى الحمض وتقصّر عمره، والغسيل لم يعد يغسل.', 'Water loaded with degreaser and salts → carried into the acid, shortening its life; the rinse no longer rinses.'] }
    },
    acid: {
      acidPercent: {
        why: ['تركيز حمض الهيدروكلوريك الحر — يحدد سرعة إزالة الصدأ والقشور.', 'Free HCl strength — sets how fast rust and scale come off.'],
        low: ['تخليل بطيء، يحتاج غمراً أطول، وقد تبقى قشور ← بقع غير مجلفنة. الحوض يقترب من الاستنفاد.',
              'Slow pickling, longer immersion, scale may remain → bare spots after galvanizing. Bath approaching exhaustion.'],
        high: ['أبخرة HCl، وتخليل زائد يخشّن السطح ← طلاء أسمك واستهلاك زنك أعلى، وخطر هشاشة هيدروجينية، وهدر حمض بالتبخر.',
               'HCl fumes, over-pickling roughens the surface → thicker coat and more zinc, risk of hydrogen embrittlement, acid lost to evaporation.'] },
      fe: {
        why: ['الحديد المذاب (كلوريد الحديدوز) — يتراكم مع كل شدّة ويحدد عمر الحوض.', 'Dissolved iron (ferrous chloride) — builds with every jig and sets the bath life.'],
        low: ['حوض جديد — وضع جيد.', 'Fresh bath — fine.'],
        high: ['الحوض يقترب من التشبع ← التخليل يتباطأ بشدة حتى مع وجود حمض، وحديد أكثر يُحمل إلى الفلكس ثم الحمام ← خبث أكثر واستهلاك زنك أعلى. فوق الحد الحرج يتبلور كلوريد الحديد: تجديد جزئي أو كامل.',
               'Bath near saturation → pickling slows sharply even with acid present, and more iron reaches the flux and kettle → more dross and higher zinc use. Past the critical limit ferrous chloride crystallises: partial or full renewal.'] },
      baume: {
        why: ['كثافة الحوض = الحمض + الحديد المذاب معاً.', 'Bath density — acid and dissolved iron together.'],
        low: ['حوض مخفّف أو جديد ← تحقق من نسبة الحمض.', 'Bath diluted or fresh → check the acid %.'],
        high: ['حمولة حديد عالية ← الحوض مستهلك، قارن مع قراءة الحديد.', 'Heavy iron loading → bath spent, compare with the iron reading.'] },
      sg: {
        why: ['الكثافة النوعية = الحمض + الحديد المذاب معاً.', 'Specific gravity — acid and dissolved iron together.'],
        low: ['حوض مخفّف أو جديد.', 'Bath diluted or fresh.'],
        high: ['حمولة حديد عالية ← الحوض مستهلك.', 'Heavy iron loading → bath spent.'] }
    },
    strip: {
      acidPercent: {
        why: ['يحدد سرعة إزالة الطلاء المرفوض قبل إعادة الجلفنة.', 'Sets how fast a rejected coat is stripped before re-galvanizing.'],
        low: ['تعرية بطيئة ← تأخير في الريباس وبقايا زنك على القطعة.', 'Slow stripping → rework delayed, zinc left on the part.'],
        high: ['أبخرة، وهجوم على حديد القطعة بعد إزالة الزنك.', 'Fumes, and attack on the base steel once the zinc is gone.'] },
      zn: {
        why: ['الزنك المذاب من الطلاءات المعرّاة.', 'Zinc dissolved from stripped coatings.'],
        high: ['الحوض مشبع بالزنك ← التعرية تتباطأ، وكلوريد الزنك يُحمل للتخليل.', 'Bath saturated with zinc → stripping slows, zinc chloride carried into pickling.'] },
      fe: {
        why: ['الحديد هنا يعني أن الحمض يهاجم حديد القطع.', 'Iron here means the acid is attacking the steel itself.'],
        high: ['تعرية زائدة (القطع تُترك طويلاً) أو اختلاط بحمض التخليل ← حديد يُحمل إلى إعادة الجلفنة.', 'Over-stripping (parts left too long) or mixing with pickling acid → iron carried into the rework.'] }
    },
    rinse2: {
      ph: {
        why: ['آخر حاجز قبل الفلكس — يكشف الحمض المحمول.', 'Last barrier before the flux — shows acid being carried forward.'],
        low: ['حمض محمول إلى الفلكس ← ينخفض pH الفلكس ويذيب حديداً من القطع ← خبث أكثر في الحمام.', 'Acid carried into the flux → flux pH drops and dissolves iron from the parts → more dross in the kettle.'],
        high: ['نادر — تحقق من مصدر الماء.', 'Unusual — check the water source.'] },
      fe: {
        why: ['الحديد الذي سيدخل الفلكس مباشرة.', 'Iron that goes straight into the flux.'],
        high: ['حديد يُحمل إلى الفلكس ← يرتفع حديد الفلكس ← خبث واستهلاك زنك أعلى. غيّر الماء.', 'Iron carried into the flux → flux iron rises → more dross and zinc use. Change the water.'] },
      ec: {
        why: ['الأملاح المذابة التي ستُحمل إلى الفلكس.', 'Dissolved salts that will be carried into the flux.'],
        high: ['أملاح وحمض محمولة إلى الفلكس ← تلوث الفلكس وتقصير عمره.', 'Salts and acid carried into the flux → flux contaminated, shorter life.'] }
    },
    flux: {
      salt: {
        why: ['تركيز أملاح الفلكس (كلوريد الزنك والأمونيوم) — يحدد سماكة طبقة الفلكس على القطعة.', 'Flux salt strength (zinc ammonium chloride) — sets the flux film on the part.'],
        low: ['طبقة فلكس رقيقة ← ترطيب ضعيف بالزنك، بقع سوداء ومناطق غير مجلفنة.', 'Thin flux film → poor zinc wetting, black spots and bare areas.'],
        high: ['طبقة سميكة ← رذاذ وأبخرة في الحمام، رماد أكثر واستهلاك زنك أعلى، وتبلور الفلكس عند التجفيف.', 'Thick film → spatter and fumes at the kettle, more ash and zinc use, flux crystallising in the dryer.'] },
      ph: {
        why: ['حموضة الفلكس — تحدد كم حديداً يذيب الفلكس من القطع.', 'Flux acidity — sets how much iron the flux dissolves from the parts.'],
        low: ['حمض حر في الفلكس ← يذيب حديداً من القطع ← يرتفع حديد الفلكس ← خبث في الحمام. عالج بالأمونيا.', 'Free acid in the flux → dissolves iron from the parts → flux iron rises → dross in the kettle. Correct with ammonia.'],
        high: ['ترسّب هيدروكسيدات الزنك ← رواسب وطين، وفاعلية فلكس أقل.', 'Zinc hydroxides precipitate → sludge, and less effective flux.'] },
      baume: {
        why: ['كثافة الفلكس — مقياس سريع لتركيز الأملاح.', 'Flux density — a quick measure of salt strength.'],
        low: ['أملاح قليلة ← طبقة رقيقة وترطيب ضعيف. أضف ملحاً (انظر حاسبة الملح).', 'Low salt → thin film, poor wetting. Add salt (see the salt calculator).'],
        high: ['أملاح زائدة ← رماد واستهلاك زنك أعلى، رذاذ.', 'Excess salt → more ash and zinc use, spatter.'] },
      sg: {
        why: ['الكثافة النوعية للفلكس — مقياس لتركيز الأملاح.', 'Flux specific gravity — a measure of salt strength.'],
        low: ['أملاح قليلة ← طبقة رقيقة وترطيب ضعيف.', 'Low salt → thin film, poor wetting.'],
        high: ['أملاح زائدة ← رماد واستهلاك زنك أعلى.', 'Excess salt → more ash and zinc use.'] },
      fe: {
        why: ['الحديد في الفلكس يدخل الحمام مع كل شدّة.', 'Iron in the flux enters the kettle with every jig.'],
        high: ['كل 1 كجم حديد يدخل الحمام ينتج ~25 كجم خبث ← استهلاك زنك أعلى مباشرة. فوق الحد الحرج: عالج بالبيروكسيد والأمونيا.', 'Each 1 kg of iron entering the kettle makes ~25 kg of dross → directly higher zinc use. Past the critical limit: treat with peroxide and ammonia.'] }
    }
  };

  const LOWER_BETTER = { fe: 1, zn: 1, ec: 1 };
  const L = () => document.documentElement.classList.contains('lang-en') ? 1 : 0;
  const tx = pair => pair ? pair[L()] : '';
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const n = (v, d) => Number(v).toLocaleString(undefined, { maximumFractionDigits: d == null ? 2 : d });

  const STATUS = {
    good: ['ضمن النطاق', 'In range'], low: ['أقل من النطاق', 'Below range'], high: ['أعلى من النطاق', 'Above range'],
    critLow: ['تحت الحد الحرج', 'Below critical limit'], critHigh: ['تجاوز الحد الحرج', 'Past critical limit'],
    none: ['لم يُقَس', 'Not measured'], na: ['لا يوجد جهاز قياس', 'No instrument']
  };
  const LBL = {
    now: ['القراءة الحالية', 'Current reading'], range: ['النطاق التشغيلي', 'Operating range'],
    best: ['القيمة المثلى', 'Best value'], mid: ['منتصف النطاق', 'Middle of range'],
    crit: ['الحد الحرج', 'Critical limit'], effect: ['الأثر الآن', 'Effect now'],
    ifLow: ['إذا انخفض', 'If low'], ifHigh: ['إذا ارتفع', 'If high'],
    lowest: ['أقل ما يمكن', 'As low as possible']
  };

  /* ---------------- the card's own diagnosis ----------------
     One short line per reading out of range, worst first, written from the
     same limits that colour the card -- so the message under each tank is
     never older than its readings and never written by hand. */
  const SHORT = {
    degrease: {
      conc: { low: ['الشحوم لا تُزال ← بقع غير مجلفنة وزيت يُحمل للحمض', 'oil not removed → bare spots, oil carried into the acid'],
              high: ['هدر كيميائي وحمل زائد للرينس', 'chemical wasted, extra carry-over'] },
      sg: { low: ['الحوض مخفّف أو مستنفد', 'bath diluted or exhausted'], high: ['تراكم زيوت وأملاح — الحوض يقترب من التجديد', 'oil and salts building up — due for renewal'] },
      temp: { low: ['إزالة شحوم بطيئة وغير كاملة', 'slow, incomplete degreasing'], high: ['تبخر وتحلل للمادة', 'evaporation and breakdown'] } },
    rinsePre: {
      ph: { low: ['الماء مشبع بحمل حوض الشحوم — غيّره', 'water saturated with degreaser carry-over — change it'],
            high: ['تلوث قلوي يعادل الحمض', 'alkaline carry-over neutralising the acid'] },
      ec: { high: ['أملاح ومواد تُحمل إلى الحمض وتقصّر عمره', 'salts carried into the acid, shortening its life'] } },
    acid: {
      acidPercent: { low: ['تخليل بطيء وقد تبقى قشور ← بقع غير مجلفنة', 'slow pickling, scale may remain → bare spots'],
                     high: ['أبخرة وتخليل زائد ← طلاء أسمك وزنك أكثر', 'fumes and over-pickling → thicker coat, more zinc'] },
      fe: { high: ['الحوض قرب التشبع: تخليل بطيء وحديد يصل للحمام ← خبث', 'near saturation: slow pickling, iron to the kettle → dross'] },
      baume: { low: ['حوض مخفّف — راجع نسبة الحمض', 'bath diluted — check the acid'], high: ['حمولة حديد عالية — الحوض مستهلك', 'heavy iron load — bath spent'] },
      sg: { low: ['حوض مخفّف', 'bath diluted'], high: ['حمولة حديد عالية — الحوض مستهلك', 'heavy iron load — bath spent'] } },
    strip: {
      acidPercent: { low: ['تعرية بطيئة تؤخر الريباس', 'slow stripping delays rework'], high: ['أبخرة وهجوم على حديد القطع', 'fumes, attack on the steel'] },
      zn: { high: ['مشبع بالزنك — التعرية تتباطأ', 'saturated with zinc — stripping slows'] },
      fe: { high: ['تعرية زائدة أو اختلاط بحمض التخليل', 'over-stripping or mixed with pickling acid'] } },
    rinse2: {
      ph: { low: ['حمض محمول للفلكس ← حديد وخبث أكثر', 'acid carried into the flux → more iron and dross'], high: ['قراءة غير معتادة — تحقق من الماء', 'unusual — check the water'] },
      fe: { high: ['حديد يُحمل للفلكس ← خبث وزنك أكثر — غيّر الماء', 'iron carried into the flux → dross — change the water'] },
      ec: { high: ['أملاح وحمض تُحمل للفلكس', 'salts and acid carried into the flux'] } },
    flux: {
      salt: { low: ['طبقة فلكس رقيقة ← بقع سوداء وغير مجلفنة', 'thin flux film → black and bare spots'],
              high: ['طبقة سميكة ← رذاذ ورماد وزنك أكثر', 'thick film → spatter, ash, more zinc'] },
      ph: { low: ['حمض حر يذيب حديداً ← خبث — عالج بالأمونيا', 'free acid dissolves iron → dross — add ammonia'],
            high: ['ترسّب هيدروكسيدات ← طين وفاعلية أقل', 'hydroxides precipitate → sludge, weaker flux'] },
      baume: { low: ['أملاح قليلة ← ترطيب ضعيف — أضف ملحاً', 'low salt → poor wetting — add salt'], high: ['أملاح زائدة ← رماد وزنك أكثر', 'excess salt → ash, more zinc'] },
      sg: { low: ['أملاح قليلة ← ترطيب ضعيف', 'low salt → poor wetting'], high: ['أملاح زائدة ← رماد وزنك أكثر', 'excess salt → ash, more zinc'] },
      fe: { high: ['حديد يدخل الحمام (~25 كجم خبث لكل كجم حديد) — عالج بالبيروكسيد', 'iron into the kettle (~25 kg dross per kg) — treat with peroxide'] } }
  };
  const RANKT = { crit: 2, warn: 1 };

  function diagnose(tank) {
    const SP = window.KGCSpecs;
    if (!tank || !SP || !SP.hasSpec(tank.id)) return null;
    const lines = [];
    let measured = 0, total = 0;
    SP.paramsFor(tank.id).forEach(function (p) {
      if (p.unavailable) return;
      total++;
      const raw = tank[p.key];
      if (raw == null || raw === '' || !isFinite(Number(raw))) return;
      measured++;
      const v = Number(raw);
      let dir = null, tier = 'warn', lim = null;
      if (p.critMax != null && v >= p.critMax) { dir = 'high'; tier = 'crit'; lim = '≥ ' + n(p.critMax); }
      else if (p.critMin != null && v <= p.critMin) { dir = 'low'; tier = 'crit'; lim = '≤ ' + n(p.critMin); }
      else if (p.max != null && v > p.max) { dir = 'high'; lim = '> ' + n(p.max); }
      else if (p.min != null && v < p.min) { dir = 'low'; lim = '< ' + n(p.min); }
      if (!dir) return;
      const sh = ((SHORT[GROUP[tank.id]] || {})[p.key] || {})[dir];
      const msg = sh ? tx(sh) : tx(dir === 'high' ? STATUS.high : STATUS.low);
      // the number and unit kept as one left-to-right run inside Arabic text
      const fig = esc(fieldLabel(p.key)) + ' <bdi dir="ltr">' + esc(n(v) + (p.unit ? ' ' + p.unit : '')) + '</bdi>';
      // Baumé and SG often say the same thing: one line naming both readings
      const same = lines.find(l => l.msg === msg);
      if (same) { same.figs.push(fig); if (RANKT[tier] > RANKT[same.tier]) same.tier = tier; }
      else lines.push({ tier: tier, key: p.key, msg: msg, figs: [fig] });
    });
    lines.forEach(l => { l.html = '<b>' + l.figs.join('، ') + '</b> — ' + esc(l.msg); });
    lines.sort((a, b) => RANKT[b.tier] - RANKT[a.tier]);
    // a bath past its usual life is a problem the readings alone may not show
    const F = window.KGCForecast && window.KGCForecast.forecast(tank.id);
    if (F && F.state === 'ok' && F.tier === 'crit') {
      lines.push({ tier: 'warn', html: esc(tx(['تجاوز عمره المعتاد بـ ', 'Past its usual life by ']) + Math.abs(F.remaining) +
        tx([' يوم — جدول الاستبدال', ' days — schedule a change'])) });
    }
    const tier = lines.some(l => l.tier === 'crit') ? 'crit' : lines.length ? 'warn' : measured ? 'good' : 'none';
    return { tier: tier, lines: lines, measured: measured, total: total };
  }

  function diagnosisHTML(tank) {
    const d = diagnose(tank);
    if (!d) return '';
    if (d.tier === 'none') return '<div class="tank-diag d-none">' + esc(tx(['لا توجد قراءات للحكم', 'No readings to judge'])) + '</div>';
    if (d.tier === 'good') return '<div class="tank-diag d-good">' + esc(tx(['كل القراءات ضمن النطاق', 'All readings in range'])) +
      (d.measured < d.total ? ' <small>' + esc(tx(['(' + d.measured + ' من ' + d.total + ' مقيسة)', '(' + d.measured + ' of ' + d.total + ' measured)'])) + '</small>' : '') + '</div>';
    return '<div class="tank-diag d-' + d.tier + '"><ul>' +
      d.lines.map(l => '<li class="dl-' + l.tier + '">' + l.html + '</li>').join('') + '</ul></div>';
  }

  window.KGCHints = { diagnose: diagnose, diagnosisHTML: diagnosisHTML };

  let box = null;
  function ensureBox() {
    if (box) return box;
    box = document.createElement('div');
    box.id = 'rh-tip';
    box.setAttribute('role', 'tooltip');
    document.body.appendChild(box);
    return box;
  }

  function content(tankId, key) {
    const tank = (typeof tanks !== 'undefined' ? tanks : []).find(x => x.id === tankId);
    const SP = window.KGCSpecs;
    const p = SP && SP.paramsFor(tankId).find(x => x.key === key);
    if (!tank || !p) return null;
    const kb = (KB[GROUP[tankId]] || {})[key] || {};
    const raw = tank[key];
    const has = raw != null && raw !== '' && isFinite(Number(raw));
    const v = Number(raw);
    const unit = p.unit ? ' ' + p.unit : '';

    let st = 'good';
    if (p.unavailable) st = 'na';
    else if (!has) st = 'none';
    else if (p.critMax != null && v >= p.critMax) st = 'critHigh';
    else if (p.critMin != null && v <= p.critMin) st = 'critLow';
    else if (p.max != null && v > p.max) st = 'high';
    else if (p.min != null && v < p.min) st = 'low';
    const tier = st === 'good' ? 'good' : (st === 'critHigh' || st === 'critLow') ? 'crit' : (st === 'low' || st === 'high') ? 'warn' : 'none';

    const range = p.min != null && p.max != null ? n(p.min) + ' – ' + n(p.max)
      : p.max != null ? '≤ ' + n(p.max) : p.min != null ? '≥ ' + n(p.min) : '—';
    // contaminants have no middle value to aim for: the less the better
    let best = null, bestLbl = LBL.best, bestTxt = null;
    if (p.optimum != null) best = p.optimum;
    else if (LOWER_BETTER[key]) bestTxt = tx(LBL.lowest);
    else if (p.min != null && p.max != null) { best = (p.min + p.max) / 2; bestLbl = LBL.mid; }
    const crit = [p.critMin != null ? '≤ ' + n(p.critMin) : '', p.critMax != null ? '≥ ' + n(p.critMax) : ''].filter(Boolean).join(' · ');

    const dirLow = st === 'low' || st === 'critLow', dirHigh = st === 'high' || st === 'critHigh';
    let effect = '';
    if (dirLow && kb.low) effect = '<div class="rh-eff rh-' + tier + '"><b>' + esc(tx(LBL.effect)) + '</b>' + esc(tx(kb.low)) + '</div>';
    else if (dirHigh && kb.high) effect = '<div class="rh-eff rh-' + tier + '"><b>' + esc(tx(LBL.effect)) + '</b>' + esc(tx(kb.high)) + '</div>';
    else {
      effect = (kb.low ? '<div class="rh-side"><b>' + esc(tx(LBL.ifLow)) + '</b>' + esc(tx(kb.low)) + '</div>' : '') +
               (kb.high ? '<div class="rh-side"><b>' + esc(tx(LBL.ifHigh)) + '</b>' + esc(tx(kb.high)) + '</div>' : '');
    }

    return '<div class="rh-head"><span>' + esc(fieldLabel(key)) + '</span><small>' + esc(tankLabel(tank.name)) + '</small></div>' +
      (kb.why ? '<p class="rh-why">' + esc(tx(kb.why)) + '</p>' : '') +
      '<dl class="rh-grid">' +
        '<dt>' + esc(tx(LBL.now)) + '</dt><dd><b dir="ltr">' + (has ? n(v) + unit : '—') + '</b>' +
          '<span class="rh-st rh-' + tier + '">' + esc(tx(STATUS[st])) + '</span></dd>' +
        '<dt>' + esc(tx(LBL.range)) + '</dt><dd dir="ltr">' + range + unit + '</dd>' +
        (best != null ? '<dt>' + esc(tx(bestLbl)) + '</dt><dd dir="ltr">' + n(best) + unit + '</dd>'
          : bestTxt ? '<dt>' + esc(tx(LBL.best)) + '</dt><dd>' + esc(bestTxt) + '</dd>' : '') +
        (crit ? '<dt>' + esc(tx(LBL.crit)) + '</dt><dd dir="ltr" class="rh-critv">' + crit + unit + '</dd>' : '') +
      '</dl>' + effect;
  }

  function show(row) {
    const html = content(Number(row.getAttribute('data-tank')), row.getAttribute('data-key'));
    if (!html) return;
    const b = ensureBox();
    b.innerHTML = html;
    b.classList.add('on');
    const r = row.getBoundingClientRect(), w = b.offsetWidth, h = b.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    b.style.left = left + 'px';
    b.style.top = top + 'px';
  }
  function hide() { if (box) box.classList.remove('on'); }

  document.addEventListener('mouseover', function (e) {
    const row = e.target.closest && e.target.closest('.data-row[data-key]');
    if (row) show(row); else if (!(e.target.closest && e.target.closest('#rh-tip'))) hide();
  });
  // touch screens: tap the label side of a reading to open, tap elsewhere to close
  document.addEventListener('click', function (e) {
    const row = e.target.closest && e.target.closest('.data-row[data-key]');
    if (row && !e.target.closest('.data-input')) show(row); else hide();
  });
  window.addEventListener('scroll', hide, { passive: true });
  // the cards may have drawn before this file loaded
  if (typeof renderAll === 'function') { try { renderAll(); } catch (e) {} }
})();
