// Settings tab: reads/writes the shared `currentSettings` (shared.js) via localStorage.

function populateSettingsForm() {
  $('#setting-theme').value = currentSettings.theme;
  $('#setting-time-format').value = currentSettings.timeFormat;
  $('#setting-first-day').value = currentSettings.firstDayOfWeek;
  $('#setting-date-format').value = currentSettings.dateFormat;
  $('#setting-show-shortcut-hints').checked = !!currentSettings.showShortcutHints;
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

$('#setting-show-shortcut-hints').addEventListener('change', (e) => {
  saveSettings({ showShortcutHints: e.target.checked });
  showSettingsSaved();
});

// ---------- Keyboard shortcuts: rebind list ----------
// One row per registry action (shortcuts.js) with a button showing its current key.
// Clicking it enters "listening" mode: the next non-Escape keydown becomes the new
// binding, unless it's already used by a different action (shown as an inline warning
// instead of silently creating a collision).

let listeningForShortcutId = null;

function renderShortcutsSettingsList() {
  const container = $('#shortcuts-rebind-list');
  container.innerHTML = SHORTCUT_ACTIONS.map((a) => `
    <div class="kv-row shortcut-row">
      <span class="k">${escapeHtml(a.label)}</span>
      <button type="button" class="btn-ghost small shortcut-rebind-btn${listeningForShortcutId === a.id ? ' listening' : ''}" data-shortcut-id="${a.id}">${
        listeningForShortcutId === a.id ? 'Press a key…' : escapeHtml(shortcutLabelFor(a.id))
      }</button>
    </div>
  `).join('');

  container.querySelectorAll('.shortcut-rebind-btn').forEach((btn) => {
    btn.addEventListener('click', () => startListeningForShortcut(btn.dataset.shortcutId));
  });
}

function startListeningForShortcut(id) {
  listeningForShortcutId = id;
  $('#shortcuts-rebind-conflict').classList.add('hidden');
  renderShortcutsSettingsList();
}

document.addEventListener('keydown', (e) => {
  if (!listeningForShortcutId) return;
  e.preventDefault();
  e.stopPropagation();

  const id = listeningForShortcutId;
  if (e.key === 'Escape') {
    listeningForShortcutId = null;
    renderShortcutsSettingsList();
    return;
  }

  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const conflict = SHORTCUT_ACTIONS.find((a) => a.id !== id && shortcutKeyFor(a.id).toLowerCase() === key.toLowerCase());
  if (conflict) {
    const warning = $('#shortcuts-rebind-conflict');
    warning.textContent = `"${key}" is already used by "${conflict.label}". Choose a different key.`;
    warning.classList.remove('hidden');
    return;
  }

  saveSettings({ keybindings: Object.assign({}, currentSettings.keybindings, { [id]: key }) });
  listeningForShortcutId = null;
  renderShortcutsSettingsList();
}, true); // capture phase: intercept before the global shortcut/nav handlers see it

$('#shortcuts-reset').addEventListener('click', () => {
  saveSettings({ keybindings: {} });
  renderShortcutsSettingsList();
});

populateSettingsForm();
renderShortcutsSettingsList();
