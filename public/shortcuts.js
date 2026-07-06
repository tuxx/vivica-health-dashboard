// Configurable keyboard shortcuts registry. Single source of truth for: the default
// key per action, the user's overrides (stored in currentSettings.keybindings, shared.js),
// the shortcut-hint <kbd> badges shown on buttons, and the read-only help list in
// #shortcuts-modal / the editable rebind list in the Settings tab (settings.js).

const SHORTCUT_ACTIONS = [
  { id: 'today', label: 'Jump to today', group: 'Day view', default: 't' },
  { id: 'logFood', label: 'Log food for the selected day', group: 'Actions', default: 'n' },
  { id: 'newMeal', label: 'Add new meal', group: 'Actions', default: 'm' },
  { id: 'copyFromDay', label: 'Copy from day', group: 'Actions', default: 'd' },
  { id: 'scanBarcode', label: 'Scan barcode', group: 'Actions', default: 'b' },
  { id: 'tabFoodLog', label: 'Food Log tab', group: 'Navigation', default: 'c' },
  { id: 'tabProfile', label: 'Profile tab', group: 'Navigation', default: 'p' },
  { id: 'tabSettings', label: 'Settings tab', group: 'Navigation', default: 's' },
  { id: 'focusSearch', label: 'Focus search', group: 'Navigation', default: '/' },
  { id: 'showShortcuts', label: 'Keyboard shortcuts help', group: 'Navigation', default: '?' }
];

function shortcutDefault(id) {
  const def = SHORTCUT_ACTIONS.find((a) => a.id === id);
  return def ? def.default : '';
}
function shortcutKeyFor(id) {
  const override = currentSettings.keybindings && currentSettings.keybindings[id];
  return (override !== undefined && override !== null && override !== '') ? override : shortcutDefault(id);
}
function shortcutLabelFor(id) {
  const key = shortcutKeyFor(id);
  if (!key) return '';
  return key.length === 1 ? key.toUpperCase() : key;
}
function matchesShortcut(e, id) {
  const key = shortcutKeyFor(id);
  if (!key) return false;
  return e.key.toLowerCase() === key.toLowerCase();
}

// Keeps every visible shortcut-hint badge and icon-button tooltip in sync with the
// current bindings — called on boot and whenever settings change (rebind, hints toggle).
function refreshShortcutHints() {
  document.body.classList.toggle('show-shortcut-hints', !!currentSettings.showShortcutHints);
  // Visible <kbd> badges (data-shortcut-key) — a separate attribute from the title-only
  // buttons below, so setting textContent here never clobbers a button's own label.
  $$('[data-shortcut-key]').forEach((el) => {
    el.textContent = shortcutLabelFor(el.dataset.shortcutKey);
  });
  $$('[data-shortcut-title]').forEach((el) => {
    const base = el.dataset.shortcutTitle;
    const key = shortcutLabelFor(el.dataset.shortcutId);
    el.title = key ? `${base} (${key})` : base;
  });
}

// Read-only rows for #shortcuts-modal (the '?' help dialog) — one per registry action,
// plus the fixed navigation keys that aren't rebindable (arrows/Enter/Escape).
function renderShortcutsHelpList(container) {
  const rows = SHORTCUT_ACTIONS.map((a) =>
    `<div class="kv-row"><span class="k">${escapeHtml(a.label)}</span><kbd>${escapeHtml(shortcutLabelFor(a.id))}</kbd></div>`
  );
  container.innerHTML = rows.join('') + `
    <div class="kv-row"><span class="k">Move through search results</span><kbd>↑</kbd><kbd>↓</kbd></div>
    <div class="kv-row"><span class="k">Move between day parts</span><kbd>↑</kbd><kbd>↓</kbd></div>
    <div class="kv-row"><span class="k">Move to sidebar</span><kbd>←</kbd></div>
    <div class="kv-row"><span class="k">Move to day panel</span><kbd>→</kbd></div>
    <div class="kv-row"><span class="k">Log food for the focused part</span><kbd>⏎</kbd></div>
    <div class="kv-row"><span class="k">Close modal / cancel</span><kbd>Esc</kbd></div>
  `;
}
