/* ATC-AD20 supplier method, 16 August 2026, page 2.
   Reference method: 25 mL bath sample, 50 mL distilled water, titrate all.
   Supplier: product % = mL of 1.0 N NaOH consumed * 0.151.
   For standardized NaOH, scale equivalents by actual N / 1.0 N.
   The sheet calls the result product %, without defining w/w or v/v. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KGCDegreaserCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const FACTOR = 0.151;
  // Supplier immersion recipe: 100–150 parts product per 1000 parts WATER.
  // User confirmed with supplier that these parts are volumes (27 Oct 2026).
  const RECIPE = { waterParts: 1000, minParts: 100, midParts: 125, maxParts: 150 };
  const percentFromParts = parts => 100 * parts / (RECIPE.waterParts + parts);
  const MIN_MAKEUP = percentFromParts(RECIPE.minParts), MAX_MAKEUP = percentFromParts(RECIPE.maxParts);
  function number(value) {
    if (value == null || String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function prepare(options) {
    const o = Object.assign({ sampleVolume: 25, dilutionMode: 'final', dilutionVolume: 75,
      portion: 'whole', aliquotVolume: 75 }, options);
    const sampleVolume = number(o.sampleVolume), dilutionVolume = number(o.dilutionVolume);
    if (sampleVolume == null || sampleVolume <= 0) return { error: 'sample' };
    if (dilutionVolume == null || !['water', 'final'].includes(o.dilutionMode)) return { error: 'dilution' };
    if (o.dilutionMode === 'water' && dilutionVolume < 0) return { error: 'dilution' };
    const finalVolume = o.dilutionMode === 'water' ? sampleVolume + dilutionVolume : dilutionVolume;
    if (!Number.isFinite(finalVolume) || finalVolume < sampleVolume) return { error: 'dilution' };
    if (!['whole', 'aliquot'].includes(o.portion)) return { error: 'aliquot' };
    const aliquotVolume = o.portion === 'whole' ? finalVolume : number(o.aliquotVolume);
    if (aliquotVolume == null || aliquotVolume <= 0 || aliquotVolume > finalVolume) return { error: 'aliquot' };
    // Only this equivalent amount of the original bath reaches the endpoint.
    const effectiveSample = sampleVolume * (aliquotVolume / finalVolume);
    const correctionFactor = 25 / effectiveSample;
    if (!Number.isFinite(correctionFactor)) return { error: 'range' };
    return { sampleVolume, finalVolume, aliquotVolume, effectiveSample,
      waterVolume: finalVolume - sampleVolume, dilutionFactor: finalVolume / sampleVolume,
      aliquotFactor: finalVolume / aliquotVolume, sampleFactor: 25 / sampleVolume, correctionFactor };
  }
  function calculate(segments, normality, preparation) {
    const prep = prepare(preparation);
    if (prep.error) return prep;
    const n = number(normality);
    if (n == null || n <= 0) return { error: 'normality' };
    if (!Array.isArray(segments) || !segments.length) return { error: 'reading' };
    let volume = 0;
    for (const segment of segments) {
      const initial = number(segment.initial), final = number(segment.final);
      if (initial == null || final == null) return { error: 'reading' };
      if (initial < 0 || final < 0) return { error: 'negative' };
      if (final < initial) return { error: 'order' };
      volume += final - initial;
    }
    const percent = volume * FACTOR * n * prep.correctionFactor;
    if (!Number.isFinite(percent) || percent > 100) return { error: 'range' };
    return { volume, normality: n, percent: Math.round(percent * 1e8) / 1e8, preparation: prep };
  }
  function dayKey(now) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const get = type => parts.find(p => p.type === type).value;
    return get('year') + '-' + get('month') + '-' + get('day');
  }
  function makeup(options) {
    const { mode, basisVerified } = options || {};
    const volume = number(options && options.volume), target = number(options && options.target);
    const current = number(options && options.current), capacity = number(options && options.capacity);
    if (!['fresh', 'add', 'replace'].includes(mode)) return { error: 'mode' };
    if (volume == null || volume <= 0) return { error: 'volume' };
    if (target == null || target <= 0 || target >= 100) return { error: 'target' };
    if (options.capacity != null && String(options.capacity).trim() !== '' && (capacity == null || capacity <= 0)) return { error: 'capacity' };
    if (mode !== 'fresh' && (current == null || current < 0 || current > 100)) return { error: 'current' };
    if (mode !== 'fresh' && basisVerified !== true) return { error: 'basis' };
    let product = 0, water = 0, withdraw = 0;
    if (mode === 'fresh') {
      product = volume * target / 100;
      water = volume - product;
    } else if (mode === 'add') {
      if (target > current) product = volume * (target - current) / (100 - target);
      if (target < current) water = volume * (current - target) / target;
    } else {
      // Withdraw from a homogeneous bath FIRST, then replace the same volume.
      if (target > current) product = volume * (target - current) / (100 - current);
      if (target < current) water = volume * (current - target) / current;
      withdraw = product + water;
    }
    const finalVolume = mode === 'add' ? volume + product + water : volume;
    if (![product, water, withdraw, finalVolume].every(Number.isFinite)) return { error: 'range' };
    return { mode, volume, target, product, water, withdraw, finalVolume, capacity,
      overCapacity: capacity != null && finalVolume > capacity + 1e-8,
      supplierRange: target < MIN_MAKEUP - 1e-8 ? 'low' : target > MAX_MAKEUP + 1e-8 ? 'high' : 'within',
      productPer1000Water: RECIPE.waterParts * target / (100 - target),
      referenceMinProduct: volume * MIN_MAKEUP / 100, referenceMaxProduct: volume * MAX_MAKEUP / 100 };
  }
  // Resolve the EXISTING tank's array/object key by id, never by its position.
  // Field-level, atomic writes preserve other tanks and concurrent readings.
  function readingUpdates(remote, percent, now) {
    if (!remote || !Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('tank');
    const matches = Object.entries(remote).filter(([, tank]) => tank && Number(tank.id) === 1);
    if (matches.length !== 1) throw new Error('tank');
    const [key, tank] = matches[0];
    if (tank.name !== 'Degreasing Tank' || !Array.isArray(tank.fields) || !tank.fields.includes('conc')) throw new Error('tank');
    const date = dayKey(now), base = 'tanks_data/' + key + '/';
    const log = 'readings_log/1_' + date + '/';
    return {
      [base + 'conc']: percent,
      [base + 'measured/conc']: date,
      [log + 'tankId']: 1,
      [log + 'date']: date,
      [log + 'ts']: now.getTime(),
      [log + 'conc']: percent
    };
  }
  return { FACTOR, RECIPE, MIN_MAKEUP, MAX_MAKEUP, percentFromParts, prepare, calculate, makeup, dayKey, readingUpdates };
});
