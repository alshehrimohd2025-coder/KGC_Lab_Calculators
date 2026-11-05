/* Choices apply to the current download only; they do not delete site data. */
(function () {
  'use strict';
  const fields = [
    ['kpis', 'المؤشرات الرئيسية', 'Key figures'],
    ['summary', 'ملخص المهندس', 'Engineer summary'],
    ['status', 'حالة الأحواض', 'Tank status'],
    ['operations', 'الأعطال وأحداث التشغيل', 'Operating events'],
    ['changed', 'المعالجة ونتائج قبل وبعد', 'Treatments and before / after'],
    ['needs', 'الإجراءات والدعم المطلوب', 'Actions and support'],
    ['consumption', 'الإضافات والإنتاج', 'Materials and production'],
    ['notes', 'خانة ملاحظات المهندس', 'Engineer notes box']
  ];
  let current = null;
  function mount(wrap) {
    const body = wrap.querySelector('.pt-modal-body');
    if (!body) return;
    const ar = !window.I18N || window.I18N.lang !== 'en';
    const section = document.createElement('fieldset');
    section.className = 'wk-export-sections';
    const legend = document.createElement('legend');
    legend.textContent = ar ? 'أقسام ملف Excel' : 'Excel report sections';
    section.appendChild(legend);
    const hint = document.createElement('p');
    hint.className = 'tk-hint';
    hint.textContent = ar ? 'اختر ما تريد تضمينه في هذا التصدير. لن تُحذف بيانات الموقع.' : 'Choose what to include in this export. Site records are not deleted.';
    section.appendChild(hint);
    fields.forEach(function (field) {
      const label = document.createElement('label');
      label.className = 'wk-chk wk-export-section';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.checked = true;
      checkbox.dataset.weeklySection = field[0];
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(' ' + (ar ? field[1] : field[2])));
      section.appendChild(label);
    });
    const noteLabel = document.createElement('label');
    noteLabel.className = 'wk-export-note';
    noteLabel.appendChild(document.createTextNode(ar ? 'ملاحظة للتقرير (اختياري)' : 'Report note (optional)'));
    const noteInput = document.createElement('textarea');
    noteInput.dataset.weeklyManagerNote = 'true';
    noteInput.rows = 3; noteInput.maxLength = 2000;
    noteInput.placeholder = ar ? 'اكتب الملاحظة الخاصة بهذه الفترة' : 'Add a note for this reporting period';
    noteLabel.appendChild(noteInput);
    section.appendChild(noteLabel);
    const note = body.lastElementChild;
    body.insertBefore(section, note);
    current = section;
  }
  function get() {
    const result = {};
    fields.forEach(function (field) {
      const input = current && current.isConnected && current.querySelector('[data-weekly-section="' + field[0] + '"]');
      result[field[0]] = input ? input.checked : true;
    });
    const note = current && current.isConnected && current.querySelector('[data-weekly-manager-note]');
    result.managerNote = note ? note.value.trim() : '';
    return result;
  }
  window.KGCWeeklyExportOptions = { mount: mount, get: get };
})();
