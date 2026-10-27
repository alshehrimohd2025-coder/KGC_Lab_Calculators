/* Lab calculator; writes only the existing conc / measured / daily-log fields.
   Raw burette readings and standardization confirmation remain local to the
   current calculation. No new Firebase fields or collections are introduced. */
(function () {
  'use strict';
  const core = window.KGCDegreaserCore;
  const mount = document.getElementById('degreaser-body');
  if (!core || !mount) return;
  let segments = [{ initial: '0', final: '' }];
  let normality = '1.0000', verified = false, busy = false;
  let preparation = { sampleVolume: '25', dilutionMode: 'final', dilutionVolume: '75', portion: 'whole', aliquotVolume: '10' };
  let indicator = 'unknown';
  let remote = null, readError = false, message = '', messageKind = '';
  const esc = value => String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const tr = (key, vars) => esc(t('dg.' + key, vars));
  const editable = () => typeof IS_EDITOR !== 'undefined' && IS_EDITOR && typeof IS_AUTHED !== 'undefined' && IS_AUTHED;
  const currentTank = () => Object.values(remote || {}).find(tank => tank && Number(tank.id) === 1);
  const currentResult = () => core.calculate(segments, normality, preparation);
  function render() {
    mount.innerHTML = `<div class="dg-card">
      <div class="dg-heading"><div><p class="dg-eyebrow">${tr('product')}</p><h3>${tr('heading')}</h3></div><span class="dg-method">${tr('methodBadge')}</span></div>
      <div class="dg-workspace"><div class="dg-inputs">
        <fieldset class="dg-preparation" ${busy ? 'disabled' : ''}>
          <legend>${tr('preparationTitle')}</legend>
          <div class="dg-presets"><button type="button" class="btn mini" id="dg-supplier">${tr('supplierPreset')}</button><button type="button" class="btn mini" id="dg-nine">${tr('ninePreset')}</button></div>
          <div class="dg-pair"><div><label for="dg-sample">${tr('originalSample')}</label><input id="dg-sample" type="number" inputmode="decimal" min="0" step="any" value="${esc(preparation.sampleVolume)}" aria-describedby="dg-error"></div>
          <div><label for="dg-dilution-mode">${tr('dilutionEntry')}</label><select id="dg-dilution-mode"><option value="final" ${preparation.dilutionMode === 'final' ? 'selected' : ''}>${tr('finalVolumeChoice')}</option><option value="water" ${preparation.dilutionMode === 'water' ? 'selected' : ''}>${tr('waterChoice')}</option></select></div></div>
          <label for="dg-dilution-volume" id="dg-dilution-label">${tr(preparation.dilutionMode === 'water' ? 'waterVolume' : 'finalVolume')}</label>
          <input id="dg-dilution-volume" type="number" inputmode="decimal" min="0" step="any" value="${esc(preparation.dilutionVolume)}" aria-describedby="dg-dilution-help dg-error">
          <p class="dg-help" id="dg-dilution-help">${tr('dilutionHelp')}</p>
          <label for="dg-portion">${tr('portion')}</label><select id="dg-portion"><option value="whole" ${preparation.portion === 'whole' ? 'selected' : ''}>${tr('whole')}</option><option value="aliquot" ${preparation.portion === 'aliquot' ? 'selected' : ''}>${tr('aliquot')}</option></select>
          <div id="dg-aliquot-wrap" ${preparation.portion === 'whole' ? 'hidden' : ''}><label for="dg-aliquot">${tr('aliquotVolume')}</label><input id="dg-aliquot" type="number" inputmode="decimal" min="0" step="any" value="${esc(preparation.aliquotVolume)}" ${preparation.portion === 'whole' ? 'disabled' : ''} aria-describedby="dg-error"></div>
        </fieldset>
        <p class="dg-help">${tr('readingHelp')}</p>
        <div id="dg-segments">${segments.map((s, index) => `<fieldset class="dg-segment" ${busy ? 'disabled' : ''}>
          <legend>${tr('fill', { n: index + 1 })}</legend>
          <div class="dg-pair"><div><label for="dg-initial-${index}">${tr('initial')}</label><input id="dg-initial-${index}" data-segment="${index}" data-field="initial" type="number" inputmode="decimal" min="0" step="any" value="${esc(s.initial)}" aria-describedby="dg-error"></div>
          <div><label for="dg-final-${index}">${tr('final')}</label><input id="dg-final-${index}" data-segment="${index}" data-field="final" type="number" inputmode="decimal" min="0" step="any" value="${esc(s.final)}" aria-describedby="dg-error"></div>
          ${index ? `<button type="button" class="btn mini dg-remove" data-remove="${index}" aria-label="${tr('removeFill', { n: index + 1 })}">×</button>` : ''}</div>
        </fieldset>`).join('')}</div>
        <button type="button" class="btn dg-add" id="dg-add" ${busy ? 'disabled' : ''}>${tr('addFill')}</button>
        <div class="dg-indicator"><label for="dg-indicator">${tr('indicator')}</label><select id="dg-indicator" ${busy ? 'disabled' : ''} aria-describedby="dg-indicator-help"><option value="unknown" ${indicator !== 'phenolphthalein' ? 'selected' : ''}>${tr('indicatorUnknown')}</option><option value="phenolphthalein" ${indicator === 'phenolphthalein' ? 'selected' : ''}>${tr('indicatorPhenolphthalein')}</option></select><p id="dg-indicator-help" class="dg-help">${tr('indicatorHelp')}</p></div>
        <div class="dg-normality"><label for="dg-normality">${tr('normality')}</label><input id="dg-normality" type="number" inputmode="decimal" min="0" step="any" value="${esc(normality)}" ${busy ? 'disabled' : ''} aria-describedby="dg-normality-help dg-error"></div>
        <p class="dg-help" id="dg-normality-help">${tr('normalityHelp')}</p>
        <label class="dg-check"><input id="dg-verified" type="checkbox" ${verified ? 'checked' : ''} ${busy ? 'disabled' : ''}><span>${tr('verified')}</span></label>
      </div><div class="dg-output">
        <p class="dg-eyebrow">${tr('resultLabel')}</p><div class="dg-result" dir="ltr"><output id="dg-percent">—</output><span>%</span></div>
        <div id="dg-confidence" class="dg-confidence"></div>
        <dl class="dg-metrics"><div><dt>${tr('consumed')}</dt><dd id="dg-consumed" dir="ltr">—</dd></div>
          <div><dt>${tr('finalVolume')}</dt><dd id="dg-final-volume" dir="ltr">—</dd></div>
          <div><dt>${tr('dilutionFactor')}</dt><dd id="dg-dilution-factor" dir="ltr">—</dd></div>
          <div><dt>${tr('aliquotFactor')}</dt><dd id="dg-aliquot-factor" dir="ltr">—</dd></div>
          <div><dt>${tr('effectiveSample')}</dt><dd id="dg-effective-sample" dir="ltr">—</dd></div>
          <div><dt>${tr('correctionFactor')}</dt><dd id="dg-correction-factor" dir="ltr">—</dd></div></dl>
        <p id="dg-preparation-summary" class="dg-help"></p>
        <p id="dg-equation" class="dg-equation" dir="ltr">—</p>
        <p id="dg-error" class="dg-error" role="status"></p>
        <p class="dg-help">${tr('percentBasis')}</p>
        <button type="button" class="btn dg-save" id="dg-save" disabled>${tr('save')}</button>
        <p id="dg-save-help" class="dg-help"></p>
        <p id="dg-message" class="dg-message" role="status"></p>
      </div></div>
      <div class="dg-current"><span>${tr('current')}</span><strong id="dg-current">—</strong><span id="dg-measured"></span></div>
      <details class="dg-protocol"><summary>${tr('protocolTitle')}</summary>
        <ol><li>${tr('step1')}</li><li>${tr('step2')}</li><li>${tr('step3')}</li><li>${tr('step4')}</li></ol>
        <p class="dg-help">${tr('supplierFormula')}</p><p class="dg-help">${tr('normalityCorrection')}</p><p class="dg-help">${tr('dilutionFormula')}</p>
        <p class="dg-help">${tr('source')}</p>
        <a href="https://www.metrohm.com/da_dk/discover/blog/20-21/what-to-consider-when-standardizing-titrant.html" target="_blank" rel="noopener noreferrer">${tr('titrantReference')}</a>
      </details>
    </div>`;
    const changed = () => { message = ''; updateResult(); };
    document.getElementById('dg-sample').addEventListener('input', function () { preparation.sampleVolume = this.value; changed(); });
    document.getElementById('dg-dilution-volume').addEventListener('input', function () { preparation.dilutionVolume = this.value; changed(); });
    document.getElementById('dg-aliquot').addEventListener('input', function () { preparation.aliquotVolume = this.value; changed(); });
    document.getElementById('dg-dilution-mode').addEventListener('change', function () {
      const prep = core.prepare(Object.assign({}, preparation, { portion: 'whole' }));
      const next = this.value;
      if (!prep.error) preparation.dilutionVolume = String(next === 'water' ? prep.waterVolume : prep.finalVolume);
      else preparation.dilutionVolume = '';
      preparation.dilutionMode = next;
      document.getElementById('dg-dilution-label').textContent = t(next === 'water' ? 'dg.waterVolume' : 'dg.finalVolume');
      document.getElementById('dg-dilution-volume').value = preparation.dilutionVolume;
      changed();
    });
    document.getElementById('dg-portion').addEventListener('change', function () {
      preparation.portion = this.value;
      document.getElementById('dg-aliquot-wrap').hidden = this.value === 'whole';
      document.getElementById('dg-aliquot').disabled = this.value === 'whole';
      changed();
    });
    document.getElementById('dg-indicator').addEventListener('change', function () { indicator = this.value; changed(); });
    const preset = (sample, total) => {
      if (busy) return;
      preparation = { sampleVolume: sample, dilutionMode: 'final', dilutionVolume: total, portion: 'whole', aliquotVolume: '10' };
      message = '';
      render();
      document.getElementById('dg-sample').focus();
    };
    document.getElementById('dg-supplier').addEventListener('click', () => preset('25', '75'));
    document.getElementById('dg-nine').addEventListener('click', () => preset('9', '50'));
    mount.querySelectorAll('[data-segment]').forEach(input => input.addEventListener('input', function () {
      segments[Number(input.dataset.segment)][input.dataset.field] = input.value;
      message = '';
      updateResult();
    }));
    mount.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', function () {
      segments.splice(Number(button.dataset.remove), 1);
      message = '';
      render();
      document.getElementById('dg-add').focus();
    }));
    document.getElementById('dg-add').addEventListener('click', function () {
      if (busy) return;
      segments.push({ initial: '0', final: '' });
      message = '';
      render();
      document.getElementById('dg-final-' + (segments.length - 1)).focus();
    });
    document.getElementById('dg-normality').addEventListener('input', function () {
      normality = this.value;
      verified = false; // A changed titrant value must be deliberately reconfirmed.
      document.getElementById('dg-verified').checked = false;
      message = '';
      updateResult();
    });
    document.getElementById('dg-verified').addEventListener('change', function () {
      verified = this.checked;
      message = '';
      updateResult();
    });
    document.getElementById('dg-save').addEventListener('click', save);
    updateResult();
    updateCurrent();
  }
  function updateCurrent() {
    const tank = currentTank(), value = tank && tank.conc;
    const display = document.getElementById('dg-current');
    if (!display) return;
    display.textContent = readError ? t('dg.readFailed') : !remote ? t('dg.loading') :
      value == null || value === '' || !Number.isFinite(Number(value)) ? t('dg.noReading') : Number(value).toFixed(3) + '%';
    document.getElementById('dg-measured').textContent = tank && tank.measured && tank.measured.conc ? t('dg.measured', { date: tank.measured.conc }) : '';
  }
  function updateResult() {
    const result = currentResult(), valid = !result.error;
    const compatible = indicator === 'phenolphthalein';
    const prep = core.prepare(preparation);
    const fmt = n => Number(n.toPrecision(6)).toString();
    document.getElementById('dg-percent').textContent = valid && compatible ? result.percent.toFixed(3) : '—';
    document.getElementById('dg-consumed').textContent = valid ? result.volume.toFixed(2) + ' mL' : '—';
    for (const [id, value, unit] of [
      ['dg-final-volume', prep.finalVolume, ' mL'], ['dg-dilution-factor', prep.dilutionFactor, ' ×'],
      ['dg-aliquot-factor', prep.aliquotFactor, ' ×'], ['dg-effective-sample', prep.effectiveSample, ' mL'],
      ['dg-correction-factor', prep.correctionFactor, ' ×']
    ]) document.getElementById(id).textContent = prep.error ? '—' : fmt(value) + unit;
    document.getElementById('dg-preparation-summary').textContent = prep.error ? '' : t('dg.preparationSummary', {
      sample: fmt(prep.sampleVolume), water: fmt(prep.waterVolume), total: fmt(prep.finalVolume), aliquot: fmt(prep.aliquotVolume)
    });
    document.getElementById('dg-equation').textContent = valid && compatible ? result.volume.toFixed(2) + ' × 0.151 × (' + result.normality + ' / 1.0) × (25 / ' + fmt(prep.sampleVolume) + ') × (' + fmt(prep.finalVolume) + ' / ' + fmt(prep.aliquotVolume) + ') = ' + result.percent.toFixed(3) + '%' : '';
    document.getElementById('dg-error').textContent = result.error && result.error !== 'reading' ? t('dg.error.' + result.error) : '';
    const confidence = document.getElementById('dg-confidence');
    confidence.textContent = t(!compatible ? 'dg.indicatorBlocked' : verified ? 'dg.verifiedResult' : 'dg.estimate');
    confidence.classList.toggle('dg-unverified', !verified || !compatible);
    const saveButton = document.getElementById('dg-save');
    saveButton.disabled = busy || !valid || !verified || !compatible || !editable() || !currentTank() || readError;
    saveButton.textContent = t(busy ? 'dg.saving' : 'dg.save');
    document.getElementById('dg-save-help').textContent = !editable() ? t('dg.editorOnly') : !compatible ? t('dg.indicatorSaveHelp') : !verified ? t('dg.verifyFirst') : t('dg.saveHelp');
    const msg = document.getElementById('dg-message');
    msg.textContent = message ? t('dg.' + message) : '';
    msg.classList.toggle('dg-error', messageKind === 'error');
  }
  async function save() {
    // Recheck inside the action as UI visibility is not authorization.
    const result = currentResult();
    if (busy || !editable() || !verified || indicator !== 'phenolphthalein' || result.error || !currentTank() || readError) return;
    busy = true;
    message = '';
    render();
    try {
      const snapshot = await database.ref('tanks_data').once('value');
      if (!editable()) throw new Error('auth');
      const updates = core.readingUpdates(snapshot.val(), result.percent, new Date());
      await database.ref().update(updates);
      // A confirmed save is shown only after Firebase acknowledges the atomic update.
      message = 'saved';
      messageKind = 'success';
    } catch (error) {
      console.error('[degreaser] reading was not confirmed saved', error);
      message = 'saveFailed';
      messageKind = 'error';
    } finally {
      busy = false;
      render();
    }
  }
  window.KGCDegreaser = { refreshAuth: updateResult };
  render();
  if (typeof database !== 'undefined') {
    database.ref('tanks_data').on('value', snapshot => {
      remote = snapshot.val();
      readError = false;
      updateCurrent();
      updateResult();
    }, () => {
      readError = true;
      updateCurrent();
      updateResult();
    });
  }
  if (window.I18N) I18N.onChange(render);
})();
