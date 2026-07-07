// Shared helpers used by app.js, calendar.js and settings.js

// ---------- persisted user preferences ----------

const SETTINGS_KEY = 'vivica-dashboard-settings';
const DEFAULT_SETTINGS = {
  theme: 'system',        // 'light' | 'dark' | 'system'
  timeFormat: '24h',      // '24h' | '12h'
  firstDayOfWeek: 'mon',  // 'mon' | 'sun'
  dateFormat: 'long',     // 'long' | 'dmy' | 'mdy' | 'ymd'
  totalsCollapsed: true,  // whether the day panel's nutrient-tiles grid starts collapsed
  sidebarCollapsed: false, // whether the desktop sidebar starts as an icon-only rail
  keybindings: {},        // actionId -> single-key override; see shortcuts.js for the registry/defaults
  showShortcutHints: false, // whether buttons show their bound key as a <kbd> badge
  hiddenDayParts: []      // day_part strings to omit from the day panel's main view
};

function loadSettings() {
  try {
    return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  } catch (e) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

let currentSettings = loadSettings();

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme; // 'system' → let prefers-color-scheme decide
}

function saveSettings(patch) {
  currentSettings = Object.assign({}, currentSettings, patch);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings));
  applyTheme(currentSettings.theme);
  document.dispatchEvent(new CustomEvent('vivica:settings-changed', { detail: currentSettings }));
  return currentSettings;
}

applyTheme(currentSettings.theme); // apply as early as possible (shared.js loads before app.js/calendar.js)

// Formats a 'YYYY-MM-DD' string per the dateFormat setting.
function formatDateDisplay(ds) {
  const d = new Date(ds + 'T00:00:00');
  if (currentSettings.dateFormat === 'long') {
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  switch (currentSettings.dateFormat) {
    case 'mdy': return `${mm}/${dd}/${yyyy}`;
    case 'ymd': return `${yyyy}-${mm}-${dd}`;
    default: return `${dd}/${mm}/${yyyy}`; // 'dmy'
  }
}



async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || data?.message || `request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function todayStr() {
  return dateToStr(new Date());
}
function dateToStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(ds, delta) {
  const d = new Date(ds + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return dateToStr(d);
}
function nowTimeStr() {
  return new Date().toTimeString().slice(0, 5);
}
function ucFirst(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
function typeForRecord(typeRecord) {
  switch (typeRecord) {
    case 'product': case 'gs1': return 'nutrient_product';
    case 'supplement': return 'nutrient_supplement';
    case 'medical': return 'nutrient_medical';
    case 'prepared_meal': return 'nutrient_prepared_meal';
    case 'meal': return 'nutrient_meal';
    default: return 'nutrient_product';
  }
}

const TYPE_RECORD_LABELS = {
  product: 'Product',
  gs1: 'Barcode',
  supplement: 'Supplement',
  medical: 'Medical',
  prepared_meal: 'Prepared meal',
  meal: 'Meal'
};
const TYPE_RECORD_BADGE = {
  product: 'info',
  gs1: 'info',
  supplement: 'success',
  medical: 'danger',
  prepared_meal: 'warning',
  meal: 'primary'
};
// server-driven badge "type" values (from AddEditNutrientItem's floating_labels)
const FLOATING_LABEL_BADGE = {
  primary: 'primary', success: 'success', info: 'info', danger: 'danger', warning: 'warning'
};

function typeBadgeHtml(typeRecord) {
  if (!typeRecord) return '';
  const cls = TYPE_RECORD_BADGE[typeRecord] || 'info';
  const label = TYPE_RECORD_LABELS[typeRecord] || ucFirst(typeRecord);
  return `<span class="badge badge-${cls}">${label}</span>`;
}

function floatingLabelsHtml(labels) {
  if (!labels || !labels.length) return '';
  return labels.map((l) => {
    const cls = FLOATING_LABEL_BADGE[l?.type] || 'primary';
    return `<span class="badge badge-${cls}">${escapeHtml(l?.value ?? '')}</span>`;
  }).join('');
}

// Safe for both text content and quoted attribute values (used as both in calendar.js/app.js).
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Renders a source-aware "product card" row: thumbnail, description, sub_title, badges.
function renderProductCard(item, { meta } = {}) {
  const thumb = item.avatar_url || item.thumb_url;
  const thumbHtml = thumb
    ? `<img class="thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" />`
    : `<div class="thumb thumb-placeholder">${foodIcon(item.type_record)}</div>`;

  const badges = typeBadgeHtml(item.type_record) + floatingLabelsHtml(item.floating_labels);
  const subParts = [];
  if (item.sub_title) subParts.push(escapeHtml(item.sub_title));
  if (meta) subParts.push(escapeHtml(meta));

  return `
    <div class="product-card">
      ${thumbHtml}
      <div class="product-card-body">
        <div class="product-card-title-row">
          <span class="name">${escapeHtml(item.description || '')}</span>
        </div>
        <div class="badges">${badges}</div>
        ${subParts.length ? `<div class="meta">${subParts.join(' • ')}</div>` : ''}
      </div>
    </div>
  `;
}

function foodIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
    <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 3v3.75M12 3v3.75M15.75 3v3.75M3.75 9h16.5M4.5 9v10.125c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V9M8.25 15h7.5" />
  </svg>`;
}

// Picks the day_part whose typical time window best matches `now`, out of the
// user's actual day_parts (dynamic strings like 'breakfast'/'snack_afternoon').
// Falls back to the first day_part if nothing matches a known keyword.
const DAY_PART_TIME_WINDOWS = [
  { re: /breakfast|morning/i, start: 5, end: 10.5 },
  { re: /lunch|midday|\bnoon\b/i, start: 11, end: 14 },
  { re: /afternoon/i, start: 14, end: 17 },
  { re: /dinner|supper|evening/i, start: 17, end: 21.5 },
  { re: /night/i, start: 21.5, end: 29 } // wraps past midnight
];
function guessDayPartForTime(dayParts, now = new Date()) {
  if (!dayParts || !dayParts.length) return '';
  let hour = now.getHours() + now.getMinutes() / 60;
  let best = null;
  let bestDist = Infinity;
  for (const dp of dayParts) {
    const win = DAY_PART_TIME_WINDOWS.find((w) => w.re.test(dp));
    if (!win) continue;
    const h = hour < win.start - 12 ? hour + 24 : hour; // handle post-midnight "night"
    const dist = h < win.start ? win.start - h : h > win.end ? h - win.end : 0;
    if (dist < bestDist) { bestDist = dist; best = dp; }
  }
  return best || dayParts[0];
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Arrow-key/Enter navigation over a list of result rows, driven from a text input.
// `getItems()` is called fresh on every keypress so it always sees the current DOM
// (result lists get rebuilt on every search). `itemSelector` matches the row elements.
function setupListKeyboardNav(input, getContainer, itemSelector = '.result-item') {
  let highlighted = -1;
  input.addEventListener('input', () => { highlighted = -1; });
  input.addEventListener('keydown', (e) => {
    const container = getContainer();
    const items = container ? Array.from(container.querySelectorAll(itemSelector)) : [];
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlighted = Math.min(highlighted + 1, items.length - 1);
      applyHighlight(items, highlighted);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
      applyHighlight(items, highlighted);
    } else if (e.key === 'Enter' && highlighted >= 0 && items[highlighted]) {
      e.preventDefault();
      items[highlighted].click();
    }
  });
}
function applyHighlight(items, idx) {
  items.forEach((el, i) => el.classList.toggle('highlighted', i === idx));
  items[idx].scrollIntoView({ block: 'nearest' });
}

// ---------- shared view states: skeleton / empty / error ----------
// One loading, empty and error treatment for every view (see style.css counterparts),
// instead of each view improvising "Loading…" text or silently swapping content.

function setLoadingState(el, rows = 3) {
  const row = `<div class="skeleton-row">
    <div class="skeleton-thumb"></div>
    <div class="skeleton-lines"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>
  </div>`;
  el.innerHTML = `<div class="skeleton-list" aria-hidden="true">${row.repeat(rows)}</div>`;
}

// `action: { label, onClick }` renders an optional action button under the message.
function setEmptyState(el, message, { icon, action } = {}) {
  el.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'empty-state';
  block.innerHTML = icon || foodIcon();
  const p = document.createElement('p');
  p.textContent = message;
  block.appendChild(p);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-ghost small';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    block.appendChild(btn);
  }
  el.appendChild(block);
}

function setErrorState(el, message) {
  el.innerHTML = '<p class="state-error"></p>';
  el.querySelector('.state-error').textContent = message;
}

// ---------- confirm / alert dialog ----------
// Promise-based replacement for native confirm()/alert(): same modal language as the
// rest of the app, doesn't block the event loop, and plays nice with the focus stack.
// showConfirmDialog(...) resolves true (confirm) or false (cancel/Escape/backdrop);
// showAlertDialog(...) hides the cancel button and always resolves after dismissal.

function showConfirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, alertOnly = false }) {
  return new Promise((resolve) => {
    trackFocusBeforeModal();
    const modal = $('#confirm-modal');
    const confirmBtn = $('#confirm-modal-confirm');
    const cancelBtn = $('#confirm-modal-cancel');

    $('#confirm-modal-title').textContent = title || '';
    $('#confirm-modal-message').textContent = message || '';
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className = danger ? 'btn-danger' : 'btn-primary';
    cancelBtn.textContent = cancelLabel;
    cancelBtn.classList.toggle('hidden', alertOnly);

    function finish(result) {
      modal.classList.add('hidden');
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKeydown, true);
      restoreFocusAfterModal();
      resolve(result);
    }
    const onConfirm = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (e) => { if (e.target === modal) finish(false); };
    // Capture phase so Escape is consumed here before the app-wide Escape handler runs.
    const onKeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    };

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKeydown, true);

    modal.classList.remove('hidden');
    confirmBtn.focus();
  });
}

function showAlertDialog(title, message) {
  return showConfirmDialog({ title, message, confirmLabel: 'OK', alertOnly: true });
}

// Every modal/popover open should push whatever had focus, and its close should pop
// and restore it — otherwise focus is left on a now-hidden element (or drops to <body>),
// which silently breaks any keyboard navigation scoped to "focus is inside container X".
// A stack (not a single slot) handles nested overlays correctly, e.g. the barcode scanner
// opening on top of the still-open log-food modal.
const modalFocusStack = [];
function trackFocusBeforeModal() {
  modalFocusStack.push(document.activeElement);
}
function restoreFocusAfterModal() {
  const el = modalFocusStack.pop();
  if (el && typeof el.focus === 'function' && document.body.contains(el)) el.focus();
}

// Lets ArrowUp/ArrowDown move focus between fields inside a modal, so a form is fully
// operable without Tab. Excluded: <select>/<textarea> and input types where the arrow
// keys already have native meaning the user expects to keep (number/range spinners, date
// sub-field cycling, radio-group selection) — and any field marked data-list-nav="true",
// which already drives its own result-list navigation via setupListKeyboardNav.
const FIELD_NAV_EXCLUDED_TYPES = new Set(['number', 'date', 'range', 'radio']);
function setupModalFieldNav(modalEl) {
  if (!modalEl) return;
  modalEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.listNav === 'true') return;
    if (FIELD_NAV_EXCLUDED_TYPES.has(target.type)) return;

    const focusables = Array.from(modalEl.querySelectorAll('input, select, textarea, button'))
      .filter((el) => !el.disabled && el.offsetParent !== null);
    const idx = focusables.indexOf(target);
    if (idx === -1) return;
    const next = e.key === 'ArrowDown' ? focusables[idx + 1] : focusables[idx - 1];
    if (next) {
      e.preventDefault();
      next.focus();
      if (next instanceof HTMLInputElement && next.select) next.select();
    }
  });
}
