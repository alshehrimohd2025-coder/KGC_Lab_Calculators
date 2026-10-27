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
  let remote = null, readError = false, message = '', messageKind = '';
  const esc = value => String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const tr = (key, vars) => esc(t('dg.' + key, vars));
  const editable = () => typeof IS_EDITOR !== 'undefined' && IS_EDITOR && typeof IS_AUTHED !== 'undefined' && IS_AUTHED;
  const currentTank = () => Object.values(remote || {}).find(tank => tank && Number(tank.id) === 1);
  const currentResult = () => core.calculate(segments, normality);
  function render() {
    mount.innerHTML = `<div class="dg-card">
      <div class="dg-heading"><div><p class="dg-eyebrow">${tr('product')}</p><h3>${tr('heading')}</h3></div><span class="dg-method">${tr('methodBadge')}</span></div>
      <div class="dg-workspace"><div class="dg-inputs">
        <p class="dg-help">${tr('readingHelp')}</p>
        <div id="dg-segments">${segments.map((s, index) => `<fieldset class="dg-segment" ${busy ? 'disabled' : ''}>
          <legend>${tr('fill', { n: index + 1 })}</legend>
          <div class="dg-pair"><div><label for="dg-initial-${index}">${tr('initial')}</label><input id="dg-initial-${index}" data-segment="${index}" data-field="initial" type="number" inputmode="decimal" min="0" step="any" value="${esc(s.initial)}" aria-describedby="dg-error"></div>
          <div><label for="dg-final-${index}">${tr('final')}</label><input id="dg-final-${index}" data-segment="${index}" data-field="final" type="number" inputmode="decimal" min="0" step="any" value="${esc(s.final)}" aria-describedby="dg-error"></div>
          ${index ? `<button type="button" class="btn mini dg-remove" data-remove="${index}" aria-label="${tr('removeFill', { n: index + 1 })}">×</button>` : ''}</div>
        </fieldset>`).join('')}</div>
        <button type="button" class="btn dg-add" id="dg-add" ${busy ? 'disabled' : ''}>${tr('addFill')}</button>
        <div class="dg-normality"><label for="dg-normality">${tr('normality')}</label><input id="dg-normality" type="number" inputmode="decimal" min="0" step="any" value="${esc(normality)}" ${busy ? 'disabled' : ''} aria-describedby="dg-normality-help dg-error"></div>
        <p class="dg-help" id="dg-normality-help">${tr('normalityHelp')}</p>
        <label class="dg-check"><input id="dg-verified" type="checkbox" ${verified ? 'checked' : ''} ${busy ? 'disabled' : ''}><span>${tr('verified')}</span></label>
      </div><div class="dg-output">
        <p class="dg-eyebrow">${tr('resultLabel')}</p><div class="dg-result" dir="ltr"><output id="dg-percent">—</output><span>%</span></div>
        <div id="dg-confidence" class="dg-confidence"></div>
        <dl class="dg-metrics"><div><dt>${tr('consumed')}</dt><dd id="dg-consumed" dir="ltr">—</dd></div><div><dt>${tr('sample')}</dt><dd dir="ltr">25 mL</dd></div></dl>
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
        <p class="dg-help">${tr('supplierFormula')}</p><p class="dg-help">${tr('normalityCorrection')}</p>
        <p class="dg-help">${tr('source')}</p>
        <a href="https://www.metrohm.com/da_dk/discover/blog/20-21/what-to-consider-when-standardizing-titrant.html" target="_blank" rel="noopener noreferrer">${tr('titrantReference')}</a>
      </details>
    </div>`;
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
    document.getElementById('dg-percent').textContent = valid ? result.percent.toFixed(3) : '—';
    document.getElementById('dg-consumed').textContent = valid ? result.volume.toFixed(2) + ' mL' : '—';
    document.getElementById('dg-equation').textContent = valid ? result.volume.toFixed(2) + ' × 0.151 × (' + result.normality + ' / 1.0) = ' + result.percent.toFixed(3) + '%' : '';
    document.getElementById('dg-error').textContent = result.error && result.error !== 'reading' ? t('dg.error.' + result.error) : '';
    const confidence = document.getElementById('dg-confidence');
    confidence.textContent = t(verified ? 'dg.verifiedResult' : 'dg.estimate');
    confidence.classList.toggle('dg-unverified', !verified);
    const saveButton = document.getElementById('dg-save');
    saveButton.disabled = busy || !valid || !verified || !editable() || !currentTank() || readError;
    saveButton.textContent = t(busy ? 'dg.saving' : 'dg.save');
    document.getElementById('dg-save-help').textContent = !editable() ? t('dg.editorOnly') : !verified ? t('dg.verifyFirst') : t('dg.saveHelp');
    const msg = document.getElementById('dg-message');
    msg.textContent = message ? t('dg.' + message) : '';
    msg.classList.toggle('dg-error', messageKind === 'error');
  }
  async function save() {
    // Recheck inside the action as UI visibility is not authorization.
    const result = currentResult();
    if (busy || !editable() || !verified || result.error || !currentTank() || readError) return;
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
