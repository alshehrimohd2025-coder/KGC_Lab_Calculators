/* ATC-AD20 supplier method, 16 August 2026, page 2.
   Fixed 25 mL bath aliquot; 50 mL distilled water is NOT a dilution factor.
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
  function calculate(segments, normality) {
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
    const percent = volume * FACTOR * n;
    if (!Number.isFinite(percent) || percent > 100) return { error: 'range' };
    return { volume, normality: n, percent: Math.round(percent * 1e8) / 1e8 };
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
  return { FACTOR, calculate, dayKey, readingUpdates };
});
