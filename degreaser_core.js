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
  return { FACTOR, prepare, calculate, dayKey, readingUpdates };
});
