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

// ---------- Keyboard shortcuts panel: roving nav ----------
// Up/Down move between this panel's controls (the hints checkbox, each rebind button,
// and Reset) and Left hands off to the sidebar — the same pattern used in the day panel.
// Scoped to just these controls (via indexOf) so it never touches the Appearance form's
// <select> elements, which already use Up/Down natively to change their own value.

function keyboardPanelFocusables() {
  return [$('#setting-show-shortcut-hints'), ...$$('.shortcut-rebind-btn'), $('#shortcuts-reset')];
}
window.focusFirstSettingsControl = function focusFirstSettingsControl() {
  keyboardPanelFocusables()[0]?.focus();
};

$('#settings-view').addEventListener('keydown', (e) => {
  const focusables = keyboardPanelFocusables();
  const idx = focusables.indexOf(e.target);
  if (idx === -1) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    focusables[Math.min(idx + 1, focusables.length - 1)]?.focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    focusables[Math.max(idx - 1, 0)]?.focus();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (window.focusSidebar) window.focusSidebar();
  }
});

// ---------- Day panel: hide day parts ----------
// Checkbox per day_part (from the user's actual dayParts, loaded async at boot — see
// app.js enterApp) letting them omit sections they don't use from the day panel view.

window.renderDayPartsSettingsList = function renderDayPartsSettingsList() {
  const container = $('#day-parts-hide-list');
  const hidden = new Set(currentSettings.hiddenDayParts || []);

  container.innerHTML = (window.dayParts || []).map((dp) => `
    <label class="checkbox-label">
      <input type="checkbox" class="day-part-hide-checkbox" data-day-part="${escapeHtml(dp)}" ${hidden.has(dp) ? 'checked' : ''} />
      ${escapeHtml(ucFirst(dp.replace(/_/g, ' ')))}
    </label>
  `).join('');

  container.querySelectorAll('.day-part-hide-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => {
      const dp = cb.dataset.dayPart;
      const next = new Set(currentSettings.hiddenDayParts || []);
      if (cb.checked) next.add(dp); else next.delete(dp);
      saveSettings({ hiddenDayParts: Array.from(next) });
      showSettingsSaved();
    });
  });
};

populateSettingsForm();
renderShortcutsSettingsList();
window.renderDayPartsSettingsList();
