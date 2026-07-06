// Settings tab: reads/writes the shared `currentSettings` (shared.js) via localStorage.

function populateSettingsForm() {
  $('#setting-theme').value = currentSettings.theme;
  $('#setting-time-format').value = currentSettings.timeFormat;
  $('#setting-first-day').value = currentSettings.firstDayOfWeek;
  $('#setting-date-format').value = currentSettings.dateFormat;
}

function showSettingsSaved() {
  const el = $('#settings-saved');
  el.classList.remove('hidden');
  clearTimeout(showSettingsSaved._t);
  showSettingsSaved._t = setTimeout(() => el.classList.add('hidden'), 1500);
}

$('#settings-form').addEventListener('change', (e) => {
  saveSettings({
    theme: $('#setting-theme').value,
    timeFormat: $('#setting-time-format').value,
    firstDayOfWeek: $('#setting-first-day').value,
    dateFormat: $('#setting-date-format').value
  });
  showSettingsSaved();
});

populateSettingsForm();
