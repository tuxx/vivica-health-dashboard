const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let dayParts = [];
let selectedLogItem = null;   // merged search-result + item_data, for the log-food modal
let mealItems = [];           // items being assembled into a new meal
let pendingMealProduct = null; // product awaiting a quantity before being added to mealItems
let logContext = null;        // { date, day_part, dayPartExplicit } for the currently open log-food modal
let editingItem = null;       // { pivotId, upstreamType, date } for the entry being replaced, or null when just logging

// ---------- time inputs: HH:MM text entry, 24h or 12h+AM/PM per the time-format setting ----------
// Each input tracks its ground-truth value in 24h form via `dataset.value24`, so switching the
// setting mid-session re-renders correctly and API payloads always send 24h HH:MM regardless of
// how the user typed it.

function ampmSelectFor(el) {
  return el.parentElement.querySelector('.ampm-select');
}
function isValidTime24(v) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}
function isValidTime12(v) {
  return /^(0[1-9]|1[0-2]):[0-5]\d$/.test(v);
}
function is12hMode(el) {
  const sel = ampmSelectFor(el);
  return !!(sel && currentSettings.timeFormat === '12h');
}
function isValidTimeInput(el) {
  return is12hMode(el) ? isValidTime12(el.value) : isValidTime24(el.value);
}
// Converts the input's current displayed value (+ AM/PM select) to 24h HH:MM for the API.
function timeInputToApi(el) {
  if (!is12hMode(el)) return el.value;
  const [h, m] = el.value.split(':').map(Number);
  let h24 = h % 12;
  if (ampmSelectFor(el).value === 'PM') h24 += 12;
  return `${String(h24).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
}
// Sets the input (+ AM/PM select) from a 24h HH:MM ground-truth value.
function setTimeInputValue(el, hhmm24) {
  el.dataset.value24 = hhmm24;
  if (!is12hMode(el) || !isValidTime24(hhmm24)) { el.value = hhmm24; return; }
  const [H, M] = hhmm24.split(':').map(Number);
  let h12 = H % 12; if (h12 === 0) h12 = 12;
  el.value = `${String(h12).padStart(2, '0')}:${String(M).padStart(2, '0')}`;
  ampmSelectFor(el).value = H >= 12 ? 'PM' : 'AM';
}
function refreshTimeInputMode(el) {
  const sel = ampmSelectFor(el);
  if (!sel) return;
  sel.classList.toggle('hidden', currentSettings.timeFormat !== '12h');
  if (el.dataset.value24) setTimeInputValue(el, el.dataset.value24);
}
function setupTimeInput(el) {
  refreshTimeInputMode(el);
  el.addEventListener('input', () => {
    let digits = el.value.replace(/\D/g, '').slice(0, 4);
    el.value = digits.length >= 3 ? digits.slice(0, 2) + ':' + digits.slice(2) : digits;
    if (isValidTimeInput(el)) el.dataset.value24 = timeInputToApi(el);
  });
  const sel = ampmSelectFor(el);
  if (sel) sel.addEventListener('change', () => {
    if (isValidTimeInput(el)) el.dataset.value24 = timeInputToApi(el);
  });
  el.addEventListener('blur', () => {
    el.classList.toggle('invalid', el.value !== '' && !isValidTimeInput(el));
  });
}
$$('.time-input').forEach(setupTimeInput);
document.addEventListener('vivica:settings-changed', () => {
  $$('.time-input').forEach(refreshTimeInputMode);
});

// ---------- auth / bootstrap ----------

async function boot() {
  const status = await api('/status');
  if (status.authenticated) {
    await enterApp();
  } else {
    $('#login-view').classList.remove('hidden');
  }
}

async function enterApp() {
  const me = await api('/me');
  dayParts = me.day_parts;
  window.dayParts = dayParts;
  fillDayPartSelect($('#log-day-part'));

  window.currentUser = me.user || null;

  $('#shell').classList.remove('hidden');
  $('#login-view').classList.add('hidden');
  showTab('calendar');
  if (window.initCalendar) window.initCalendar();
  if (window.initProfile) window.initProfile();
}

function fillDayPartSelect(select) {
  select.innerHTML = '';
  for (const dp of dayParts) {
    const opt = document.createElement('option');
    opt.value = dp;
    opt.textContent = ucFirst(dp.replace(/_/g, ' '));
    select.appendChild(opt);
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = $('#login-error');
  errorEl.classList.add('hidden');

  const email = $('#login-email').value;
  const password = $('#login-password').value;
  const token = $('#login-token').value;
  const needs2fa = !$('#twofa-field').classList.contains('hidden');

  try {
    const result = await api('/login', {
      method: 'POST',
      body: { email, password, token, authCodeRequested: needs2fa }
    });
    if (result.needs2fa) {
      $('#twofa-field').classList.remove('hidden');
      errorEl.textContent = result.method === 'google_auth'
        ? 'Enter the code from your authenticator app.'
        : 'A code was emailed to you, enter it below.';
      errorEl.classList.remove('hidden');
      return;
    }
    await enterApp();
  } catch (err) {
    errorEl.textContent = err.data?.errors ? Object.values(err.data.errors).flat().join(' ') : err.message;
    errorEl.classList.remove('hidden');
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  location.reload();
});

// ---------- tabs ----------

$$('[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

function showTab(name) {
  $$('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('#calendar-view').classList.toggle('hidden', name !== 'calendar');
  $('#settings-view').classList.toggle('hidden', name !== 'settings');
  $('#profile-view').classList.toggle('hidden', name !== 'profile');
}

// ---------- keyboard shortcuts ----------
// Single-key shortcuts, active whenever focus isn't in a text field/select, so
// they never fight with typing. "N" is the fast path for the everyday action:
// opens the quick-log modal for the selected calendar day (or today).
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if ($('#palette-modal').classList.contains('hidden')) openCommandPalette();
    else closeCommandPalette();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === 'Escape') {
    if (!$('#calendar-popover').classList.contains('hidden')) {
      window.closeCalendarPopover();
      e.preventDefault();
    } else if (!$('#palette-modal').classList.contains('hidden')) {
      closeCommandPalette();
      e.preventDefault();
    } else if (!$('#shortcuts-modal').classList.contains('hidden')) {
      closeShortcutsModal();
      e.preventDefault();
    } else if (!$('#scan-modal').classList.contains('hidden')) {
      closeScanModal();
      e.preventDefault();
    } else if (!$('#log-modal').classList.contains('hidden')) {
      closeLogModal();
      e.preventDefault();
    } else if (!$('#qty-modal').classList.contains('hidden')) {
      $('#qty-modal-cancel').click();
      e.preventDefault();
    } else {
      document.activeElement?.blur();
    }
    return;
  }

  const target = e.target;
  const isTyping = target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
  if (isTyping || $('#shell').classList.contains('hidden')) return;

  switch (e.key.toLowerCase()) {
    case 'n':
    case 'l':
      openLogModal(typeof calendarSelectedDate !== 'undefined' && calendarSelectedDate ? calendarSelectedDate : todayStr());
      e.preventDefault();
      break;
    case 'c':
      showTab('calendar');
      e.preventDefault();
      break;
    case 's':
      showTab('settings');
      e.preventDefault();
      break;
    case 'p':
      showTab('profile');
      e.preventDefault();
      break;
    case '/': {
      let visibleSearch = null;
      if (!$('#log-modal').classList.contains('hidden')) {
        if (!$('#log-modal-search-step').classList.contains('hidden')) visibleSearch = $('#search-input');
        else if (!$('#log-modal-meal-step').classList.contains('hidden')) visibleSearch = $('#meal-search-input');
      }
      if (visibleSearch) { visibleSearch.focus(); e.preventDefault(); }
      break;
    }
    case '?':
      openShortcutsModal();
      e.preventDefault();
      break;
  }
});

function openShortcutsModal() {
  $('#shortcuts-modal').classList.remove('hidden');
}
function closeShortcutsModal() {
  $('#shortcuts-modal').classList.add('hidden');
}
$('#shortcuts-close').addEventListener('click', closeShortcutsModal);
$('#shortcuts-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeShortcutsModal();
});

// ---------- Sidebar collapse (desktop only — the mobile layout ignores this class) ----------

$('.sidebar').classList.toggle('collapsed', currentSettings.sidebarCollapsed);
$('#sidebar-collapse-toggle').addEventListener('click', () => {
  const isCollapsed = $('.sidebar').classList.toggle('collapsed');
  saveSettings({ sidebarCollapsed: isCollapsed });
});

// ---------- Command palette ----------
// Ctrl/Cmd+K from anywhere. Static navigation commands filtered by substring match,
// plus a live product/meal search once the query is long enough — picking a product
// result opens the log modal straight to that item's log-it form.

function paletteTargetDate() {
  return typeof calendarSelectedDate !== 'undefined' && calendarSelectedDate ? calendarSelectedDate : todayStr();
}
const PALETTE_COMMANDS = [
  { label: 'Food Log', hint: 'C', action: () => showTab('calendar') },
  { label: 'Profile', hint: 'P', action: () => showTab('profile') },
  { label: 'Settings', hint: 'S', action: () => showTab('settings') },
  { label: 'Log food for today', hint: 'N', action: () => openLogModal(paletteTargetDate()) },
  { label: 'Build a meal', action: () => { openLogModal(paletteTargetDate()); openMealBuilder(); } },
  { label: 'Copy from another day', action: () => { openLogModal(paletteTargetDate()); if (window.openCopyStep) window.openCopyStep(); } },
  { label: 'Keyboard shortcuts', hint: '?', action: () => openShortcutsModal() }
];

function openCommandPalette() {
  $('#palette-modal').classList.remove('hidden');
  $('#palette-input').value = '';
  renderPaletteResults('');
  $('#palette-input').focus();
}
function closeCommandPalette() {
  $('#palette-modal').classList.add('hidden');
}
$('#palette-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeCommandPalette();
});
$('#palette-input').addEventListener('input', (e) => renderPaletteResults(e.target.value));
setupListKeyboardNav($('#palette-input'), () => $('#palette-results'));

function renderPaletteResults(query) {
  const q = query.trim().toLowerCase();
  const container = $('#palette-results');
  container.innerHTML = '';

  const matchingCommands = PALETTE_COMMANDS.filter((c) => !q || c.label.toLowerCase().includes(q));
  for (const cmd of matchingCommands) {
    const row = document.createElement('div');
    row.className = 'result-item command-item';
    row.innerHTML = `<div class="product-card">
      <div class="product-card-body"><span class="name">${escapeHtml(cmd.label)}</span></div>
      ${cmd.hint ? `<kbd>${escapeHtml(cmd.hint)}</kbd>` : ''}
    </div>`;
    row.addEventListener('click', () => { closeCommandPalette(); cmd.action(); });
    container.appendChild(row);
  }

  if (q.length >= 2) {
    runPaletteProductSearch(q);
  } else if (!matchingCommands.length) {
    container.innerHTML = '<p class="muted">No matches.</p>';
  }
}

const runPaletteProductSearch = debounce(async (q) => {
  try {
    const res = await api('/nutrition/search', {
      method: 'POST',
      body: { search: q, brand: '', supermarket: null, page: 1, type: '', meal_tab: 'all' }
    });
    if ($('#palette-input').value.trim().toLowerCase() !== q) return; // query changed while this was in flight
    const items = Array.isArray(res.data) ? res.data : Object.values(res.data || {});
    if (!items.length) return;

    const container = $('#palette-results');
    const heading = document.createElement('p');
    heading.className = 'muted palette-section-label';
    heading.textContent = 'Products & meals';
    container.appendChild(heading);
    for (const item of items) {
      const wrap = document.createElement('div');
      wrap.className = 'result-item';
      wrap.innerHTML = renderProductCard(item);
      wrap.addEventListener('click', () => {
        closeCommandPalette();
        openLogModal(paletteTargetDate());
        selectLogItem(item);
      });
      container.appendChild(wrap);
    }
  } catch {
    // silent — a failed live search shouldn't block the static commands above it
  }
}, 300);

// Enter-to-confirm in the quantity modal (it's not a <form>, so Enter does nothing by default).
$('#qty-modal-amount').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#qty-modal-confirm').click(); }
});
$('#qty-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('#qty-modal-cancel').click();
});

// ---------- Log food modal ----------
// Opened from the calendar: either a specific day-part's "+" (dayPart explicit, never
// overridden below) or the day panel's general "+ Log food" button / the N/L shortcut
// (dayPart guessed from the current time, but still overridable by the item's own
// server-suggested day-part once one is picked — see selectLogItem).

window.startLogForDayPart = function startLogForDayPart(date, dayPart) {
  openLogModal(date, dayPart);
};

function openLogModal(date, dayPart) {
  logContext = { date, day_part: dayPart || guessDayPartForTime(dayParts), dayPartExplicit: !!dayPart };
  editingItem = null;
  selectedLogItem = null;
  backToSearchStep();
  $('#log-modal-title').textContent = `Log food — ${formatDateDisplay(date)}`;
  $('#log-modal').classList.remove('hidden');
  $('#search-input').focus();
}

function closeLogModal() {
  $('#log-modal').classList.add('hidden');
  logContext = null;
  editingItem = null;
  selectedLogItem = null;
  mealItems = [];
}

function backToSearchStep() {
  editingItem = null;
  $('#log-back-to-search').classList.remove('hidden');
  $('#log-modal-form-step').classList.add('hidden');
  $('#log-modal-meal-step').classList.add('hidden');
  $('#log-modal-copy-step').classList.add('hidden');
  $('#log-modal-search-step').classList.remove('hidden');
  $('#log-error').classList.add('hidden');
  $('#log-success').classList.add('hidden');
  $('#search-input').value = '';
  setActiveQuickButton('show-recent');
  loadQuickList('/products/recent'); // default the results box to recent items instead of leaving it empty
  $('#search-input').focus();
}

// Opened from the calendar day panel's pencil icon on a logged item: jumps straight to the
// form step (no search) pre-filled with that entry's actual persisted values. Submitting
// logs a new entry then deletes the old one — there's no documented in-place "update
// logged item" endpoint, so this is create-then-delete under the hood.
window.startEditLogItem = async function startEditLogItem(item, ds) {
  const isMeal = item.type_record === 'meal';
  const pivotId = isMeal ? item.meal_pivot_id : item.product_pivot_id;
  const upstreamType = typeForRecord(item.type_record);
  const id = isMeal ? item.meal_id : item.id;
  const date = item.intended_date || ds;

  logContext = { date, day_part: item.day_part, dayPartExplicit: true };
  editingItem = { pivotId, upstreamType, date };

  selectedLogItem = {
    id,
    type_record: item.type_record,
    description: isMeal ? (item.meal_name || item.description) : item.description,
    measuring_unit: item.measuring_unit,
    date,
    time: item.intended_time || nowTimeStr(),
    day_part: item.day_part,
    amount_value: item.nutrient_conversion_id ? '' : (item.used_product_amount ?? ''),
    amount_pieces: item.amount_pieces ?? item.used_amount ?? '',
    selected_conversion_id: item.nutrient_conversion_id || '',
    specify_method: item.nutrient_conversion_id ? 'conversion' : 'manual',
    meal_amount: item.meal_amount || 1
  };

  $('#log-modal-title').textContent = `Edit — ${formatDateDisplay(date)}`;
  $('#log-modal').classList.remove('hidden');

  try {
    const itemData = await api('/nutrition/item_data', { method: 'POST', body: { type: upstreamType, id } });
    selectedLogItem = Object.assign({}, itemData, selectedLogItem);
  } catch (err) {
    $('#log-error').textContent = 'Could not load item details: ' + err.message;
    $('#log-error').classList.remove('hidden');
  }

  renderLogForm();
};

$('#log-modal-close').addEventListener('click', closeLogModal);
$('#log-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeLogModal();
});
$('#log-back-to-search').addEventListener('click', backToSearchStep);

// ---------- Log food modal: search ----------

$('#search-input').addEventListener('input', debounce((e) => {
  const val = e.target.value;
  setActiveQuickButton(null);
  if (val.length < 2) { $('#search-results').innerHTML = ''; return; }
  runNutritionSearch(val);
}, 350));
setupListKeyboardNav($('#search-input'), () => $('#search-results'));

async function runNutritionSearch(val) {
  const container = $('#search-results');
  container.innerHTML = '<p class="muted">Searching...</p>';
  try {
    const res = await api('/nutrition/search', {
      method: 'POST',
      body: { search: val, brand: '', supermarket: null, page: 1, type: '', meal_tab: 'all' }
    });
    const items = Array.isArray(res.data) ? res.data : Object.values(res.data || {});
    renderResultList(container, items, { onClick: selectLogItem });
    // A barcode (all-digit input, 6+ chars — whether typed or scanned) with exactly one
    // match auto-advances straight to the log form, mirroring the real app's isBarcode() UX.
    if (/^\d+$/.test(val) && val.length >= 6 && items.length === 1) {
      selectLogItem(items[0]);
    }
  } catch (err) {
    container.innerHTML = `<p class="error"></p>`;
    container.querySelector('.error').textContent = err.message;
  }
}

function renderResultList(container, items, { onClick, metaFn } = {}) {
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = '<p class="muted">No results.</p>';
    return;
  }
  for (const item of items) {
    const wrap = document.createElement('div');
    wrap.className = 'result-item';
    wrap.innerHTML = renderProductCard(item, { meta: metaFn ? metaFn(item) : null });
    wrap.addEventListener('click', () => onClick(item));
    container.appendChild(wrap);
  }
}

function setActiveQuickButton(id) {
  $('#show-recent').classList.toggle('is-active', id === 'show-recent');
  $('#show-frequent').classList.toggle('is-active', id === 'show-frequent');
}

$('#show-recent').addEventListener('click', () => { setActiveQuickButton('show-recent'); loadQuickList('/products/recent'); });
$('#show-frequent').addEventListener('click', () => { setActiveQuickButton('show-frequent'); loadQuickList('/products/frequent'); });

async function loadQuickList(path) {
  const container = $('#search-results');
  container.innerHTML = '<p class="muted">Loading...</p>';
  const res = await api(path);
  renderResultList(container, res.data, {
    metaFn: (item) => `used ${item.use_count}×`,
    onClick: selectLogItem
  });
}

async function selectLogItem(item) {
  const ctx = logContext || { date: todayStr(), day_part: guessDayPartForTime(dayParts), dayPartExplicit: false };

  selectedLogItem = {
    ...item,
    date: ctx.date,
    time: nowTimeStr(),
    day_part: ctx.day_part,
    amount_value: '',
    amount_pieces: '',
    selected_conversion_id: '',
    specify_method: 'manual',
    meal_amount: 1
  };

  const type = typeForRecord(item.type_record);
  try {
    const itemData = await api('/nutrition/item_data', {
      method: 'POST',
      body: { type, id: item.id }
    });
    selectedLogItem = Object.assign({}, itemData, selectedLogItem);
    if (!ctx.dayPartExplicit && itemData.suggested_day_part) selectedLogItem.day_part = itemData.suggested_day_part;
    if (itemData.conversions && itemData.conversions.length) {
      selectedLogItem.specify_method = 'conversion';
      selectedLogItem.selected_conversion_id = itemData.suggested_nutrient_conversion_id || itemData.conversions[0].id;
      selectedLogItem.amount_pieces = 1;
    }
  } catch (err) {
    $('#log-error').textContent = 'Could not load item details: ' + err.message;
    $('#log-error').classList.remove('hidden');
  }

  renderLogForm();
}

function renderLogForm() {
  $('#log-modal-search-step').classList.add('hidden');
  $('#log-modal-meal-step').classList.add('hidden');
  $('#log-modal-copy-step').classList.add('hidden');
  $('#log-modal-form-step').classList.remove('hidden');
  $('#log-back-to-search').classList.toggle('hidden', !!editingItem);
  $('#log-error').classList.add('hidden');
  $('#log-success').classList.add('hidden');

  $('#log-item-name').textContent = selectedLogItem.description;
  $('#log-submit').textContent = editingItem ? 'Save changes' : 'Log it';
  $('#log-date').value = selectedLogItem.date;
  setTimeInputValue($('#log-time'), selectedLogItem.time);
  $('#log-day-part').value = selectedLogItem.day_part || dayParts[0];

  const isMeal = selectedLogItem.type_record === 'meal';
  $('#log-meal-amount-wrap').classList.toggle('hidden', !isMeal);
  $('#log-amount-wrap').classList.toggle('hidden', isMeal);
  if (isMeal) $('#log-meal-amount').value = selectedLogItem.meal_amount || 1;

  const hasConversions = selectedLogItem.conversions && selectedLogItem.conversions.length > 0;
  $('#log-method-row').classList.toggle('hidden', !hasConversions);

  $(`input[name="specify_method"][value="${selectedLogItem.specify_method}"]`).checked = true;
  toggleAmountMethod(selectedLogItem.specify_method);

  $('#log-manual-label').childNodes[0].textContent =
    `Amount (${selectedLogItem.measuring_unit || ''})`;
  $('#log-amount-value').value = selectedLogItem.amount_value || '';

  if (hasConversions) {
    const sel = $('#log-conversion-id');
    sel.innerHTML = '';
    for (const conv of selectedLogItem.conversions) {
      const opt = document.createElement('option');
      opt.value = conv.id;
      opt.textContent = `${ucFirst(conv.measurement)} — ${conv.amount} ${conv.unit} • ${conv.values?.enercc_kcal ?? '?'} kcal`;
      sel.appendChild(opt);
    }
    sel.value = selectedLogItem.selected_conversion_id;
    $('#log-amount-pieces').value = selectedLogItem.amount_pieces || 1;
  }
}

$$('input[name="specify_method"]').forEach((el) => {
  el.addEventListener('change', (e) => toggleAmountMethod(e.target.value));
});
function toggleAmountMethod(method) {
  $('#log-manual-wrap').classList.toggle('hidden', method !== 'manual');
  $('#log-conversion-wrap').classList.toggle('hidden', method !== 'conversion');
}

$('#log-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = $('#log-error');
  const successEl = $('#log-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  if (!isValidTimeInput($('#log-time'))) {
    errorEl.textContent = 'Time must be in HH:MM format.';
    errorEl.classList.remove('hidden');
    return;
  }

  const method = $('input[name="specify_method"]:checked').value;
  const payload = {
    ...selectedLogItem,
    date: $('#log-date').value,
    time: timeInputToApi($('#log-time')),
    day_part: $('#log-day-part').value,
    specify_method: method,
    meal_amount: Number($('#log-meal-amount').value) || 1,
    amount_value: method === 'manual' ? Number($('#log-amount-value').value) : selectedLogItem.amount_value,
    selected_conversion_id: method === 'conversion' ? Number($('#log-conversion-id').value) : '',
    amount_pieces: method === 'conversion' ? Number($('#log-amount-pieces').value) : ''
  };

  const wasEditing = editingItem;

  try {
    $('#log-submit').disabled = true;
    await api('/nutrition/submit_item', { method: 'POST', body: payload });

    // No documented in-place "update logged item" endpoint — editing logs the new
    // values as a fresh entry, then removes the one being replaced.
    let note = '';
    if (wasEditing) {
      try {
        await api('/nutrition/delete_scheduled_item', {
          method: 'POST',
          body: { id: wasEditing.pivotId, type: wasEditing.upstreamType, date: wasEditing.date }
        });
        if (wasEditing.date !== payload.date && window.invalidateCalendarDay) window.invalidateCalendarDay(wasEditing.date);
      } catch {
        note = ' (Could not remove the previous entry — you may need to delete it manually.)';
      }
      editingItem = null;
    }

    successEl.textContent = `Logged ${selectedLogItem.description}.${note}`;
    successEl.classList.remove('hidden');
    if (window.invalidateCalendarDay) window.invalidateCalendarDay(payload.date);
    selectedLogItem = null;
    // Brief confirmation, then close — don't linger open after a successful log.
    setTimeout(() => {
      if (!$('#log-modal').classList.contains('hidden')) closeLogModal();
    }, 900);
  } catch (err) {
    errorEl.textContent = err.data?.errors ? Object.values(err.data.errors).flat().join(' ') : err.message;
    errorEl.classList.remove('hidden');
  } finally {
    $('#log-submit').disabled = false;
  }
});

// ---------- Build a meal (inside the log-food modal) ----------
// "+ New meal" swaps the search step for a meal-builder step: search/add products,
// name it, save. Saving posts the meal then immediately feeds it into the normal
// selectLogItem()/renderLogForm() flow so it can be logged for today in one motion.

$('#meal-builder-open').addEventListener('click', openMealBuilder);
$('#meal-builder-cancel').addEventListener('click', backToSearchStep);

function openMealBuilder() {
  mealItems = [];
  $('#meal-name').value = '';
  $('#meal-favorite').checked = false;
  $('#meal-search-input').value = '';
  $('#meal-search-results').innerHTML = '';
  $('#meal-error').classList.add('hidden');
  renderMealItems();

  $('#log-modal-search-step').classList.add('hidden');
  $('#log-modal-meal-step').classList.remove('hidden');
  $('#meal-search-input').focus();
}

$('#meal-search-input').addEventListener('input', debounce((e) => {
  const val = e.target.value;
  if (val.length < 2) { $('#meal-search-results').innerHTML = ''; return; }
  runMealProductSearch(val);
}, 350));
setupListKeyboardNav($('#meal-search-input'), () => $('#meal-search-results'));

async function runMealProductSearch(val) {
  const container = $('#meal-search-results');
  container.innerHTML = '<p class="muted">Searching...</p>';
  try {
    const res = await api('/search_nutrient_products', { method: 'POST', body: { query: val } });
    renderResultList(container, res.data || [], {
      metaFn: (item) => `${item.amount ?? ''}${item.measuring_unit ?? ''}`,
      onClick: openQtyModal
    });
  } catch (err) {
    container.innerHTML = `<p class="error"></p>`;
    container.querySelector('.error').textContent = err.message;
  }
}

function openQtyModal(product) {
  pendingMealProduct = product;
  $('#qty-modal-title').textContent = product.description;
  $('#qty-modal-unit').textContent = product.measuring_unit || '';
  $('#qty-modal-amount').value = product.amount || '';
  $('#qty-modal').classList.remove('hidden');
  $('#qty-modal-amount').focus();
}
$('#qty-modal-cancel').addEventListener('click', () => {
  $('#qty-modal').classList.add('hidden');
  pendingMealProduct = null;
});
$('#qty-modal-confirm').addEventListener('click', () => {
  const amount = Number($('#qty-modal-amount').value);
  if (!amount || !pendingMealProduct) return;

  const product = pendingMealProduct;
  const productItemAmount = round(amount / product.amount, 3);
  const productAmount = round(productItemAmount * product.amount, 2);

  mealItems.push({
    target_id: product.id,
    product_item_amount: productItemAmount,
    product_amount: productAmount,
    nutrient_product: product,
    conversion: { id: '' }
  });

  $('#qty-modal').classList.add('hidden');
  pendingMealProduct = null;
  renderMealItems();
});

function renderMealItems() {
  const container = $('#meal-items');
  container.innerHTML = '';
  if (!mealItems.length) {
    container.innerHTML = '<p class="muted">No products added yet.</p>';
  } else {
    mealItems.forEach((item, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'result-item';
      wrap.innerHTML = renderProductCard(item.nutrient_product, {
        meta: `${item.product_amount}${item.nutrient_product.measuring_unit || ''}`
      }) + `<span class="remove" title="Remove">✕</span>`;
      wrap.style.cursor = 'default';
      wrap.querySelector('.remove').addEventListener('click', () => {
        mealItems.splice(idx, 1);
        renderMealItems();
      });
      container.appendChild(wrap);
    });
  }
  updateMealSubmitState();
}

function updateMealSubmitState() {
  const name = $('#meal-name').value.trim();
  $('#meal-save').disabled = !(mealItems.length && name.length >= 3);
}
$('#meal-name').addEventListener('input', updateMealSubmitState);

$('#meal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = $('#meal-error');
  errorEl.classList.add('hidden');

  const ctx = logContext || { date: todayStr(), day_part: guessDayPartForTime(dayParts), dayPartExplicit: false };
  const name = $('#meal-name').value.trim();
  const payload = {
    name,
    day_part: ctx.day_part,
    time: nowTimeStr(),
    is_favorite: $('#meal-favorite').checked,
    items: mealItems
  };

  try {
    $('#meal-save').disabled = true;
    await api('/submit_nutrient_meal', { method: 'POST', body: payload });
    await findAndSelectCreatedMeal(name);
  } catch (err) {
    errorEl.textContent = err.data?.errors ? Object.values(err.data.errors).flat().join(' ') : err.message;
    errorEl.classList.remove('hidden');
  } finally {
    $('#meal-save').disabled = false;
  }
});

// The meal-create endpoint doesn't hand back an id we can log directly, so find the
// meal we just created the same way a user would: search for it by name (it's the
// same search/select pipeline used for every other item).
async function findAndSelectCreatedMeal(name) {
  const errorEl = $('#meal-error');
  try {
    const res = await api('/nutrition/search', {
      method: 'POST',
      body: { search: name, brand: '', supermarket: null, page: 1, type: '', meal_tab: 'all' }
    });
    const items = Array.isArray(res.data) ? res.data : Object.values(res.data || {});
    const match = items.find((it) => it.type_record === 'meal' && it.description === name)
      || items.find((it) => it.type_record === 'meal');
    if (!match) {
      errorEl.textContent = `Meal "${name}" was saved, but couldn't be found again to log now — search for it manually.`;
      errorEl.classList.remove('hidden');
      return;
    }
    mealItems = [];
    await selectLogItem(match);
  } catch (err) {
    errorEl.textContent = `Meal "${name}" was saved, but logging it now failed: ${err.message}`;
    errorEl.classList.remove('hidden');
  }
}

// ---------- Copy entries from another day (inside the log-food modal) ----------
// "+ Copy from day" opens a picker: choose a source date, check which of that day's
// items to bring over, copy them into the modal's target day. Each copy re-fetches
// item_data (same as a normal log) and submits with the source item's own day-part/time
// and amount/serving carried over — only the date changes.

let copySourceItems = []; // flat list of the currently-loaded source day's items

window.openCopyStep = function openCopyStep() {
  $('#log-modal-search-step').classList.add('hidden');
  $('#log-modal-copy-step').classList.remove('hidden');
  $('#copy-error').classList.add('hidden');
  $('#copy-success').classList.add('hidden');
  $('#copy-select-all').checked = false;

  const targetDate = logContext?.date || todayStr();
  const sourceDate = new Date(targetDate + 'T00:00:00');
  sourceDate.setDate(sourceDate.getDate() - 1);
  $('#copy-source-date').value = dateToStr(sourceDate);
  loadCopySourceDay($('#copy-source-date').value);
};
$('#copy-day-open').addEventListener('click', window.openCopyStep);
$('#copy-day-cancel').addEventListener('click', backToSearchStep);
$('#copy-source-date').addEventListener('change', (e) => loadCopySourceDay(e.target.value));

async function loadCopySourceDay(dateStr) {
  const container = $('#copy-source-items');
  container.innerHTML = '<p class="muted">Loading…</p>';
  copySourceItems = [];
  updateCopySubmitState();
  try {
    const data = await api('/nutrition/stats?date=' + dateStr);
    const items = data.items || {};
    for (const [dp, arr] of Object.entries(items)) {
      for (const item of (arr || [])) {
        copySourceItems.push(Object.assign({}, item, { day_part: item.day_part || dp }));
      }
    }
    renderCopySourceItems();
  } catch (err) {
    container.innerHTML = `<p class="error"></p>`;
    container.querySelector('.error').textContent = err.message;
  }
}

function renderCopySourceItems() {
  const container = $('#copy-source-items');
  container.innerHTML = '';
  if (!copySourceItems.length) {
    container.innerHTML = '<p class="muted">Nothing logged that day.</p>';
    updateCopySubmitState();
    return;
  }
  copySourceItems.forEach((item, idx) => {
    const isMeal = item.type_record === 'meal';
    const kcal = item.values?.enercc_kcal ? `${round(item.values.enercc_kcal, 0)} kcal` : '';
    const dayPartLabel = ucFirst((item.day_part || '').replace(/_/g, ' '));
    const meta = [item.intended_time, dayPartLabel, kcal].filter(Boolean).join(' • ');

    const wrap = document.createElement('label');
    wrap.className = 'result-item copy-item-row';
    wrap.innerHTML = `<input type="checkbox" class="copy-item-checkbox" data-idx="${idx}" />` +
      renderProductCard({ ...item, description: isMeal ? (item.meal_name || item.description) : item.description }, { meta });
    container.appendChild(wrap);
  });
  container.querySelectorAll('.copy-item-checkbox').forEach((cb) => cb.addEventListener('change', updateCopySubmitState));
  updateCopySubmitState();
}

$('#copy-select-all').addEventListener('change', (e) => {
  $$('.copy-item-checkbox').forEach((cb) => { cb.checked = e.target.checked; });
  updateCopySubmitState();
});

function updateCopySubmitState() {
  const checked = $$('.copy-item-checkbox').filter((cb) => cb.checked);
  $('#copy-submit').disabled = checked.length === 0;
  $('#copy-submit').textContent = checked.length
    ? `Copy ${checked.length} selected item${checked.length === 1 ? '' : 's'}`
    : 'Copy selected items';
}

$('#copy-submit').addEventListener('click', async () => {
  const errorEl = $('#copy-error');
  const successEl = $('#copy-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  const checkedIdxs = $$('.copy-item-checkbox').filter((cb) => cb.checked).map((cb) => Number(cb.dataset.idx));
  const targetDate = logContext?.date || todayStr();
  let copied = 0;
  let failed = 0;

  $('#copy-submit').disabled = true;
  for (const idx of checkedIdxs) {
    try {
      await copyLoggedItemToDate(copySourceItems[idx], targetDate);
      copied++;
    } catch {
      failed++;
    }
  }
  $('#copy-submit').disabled = false;

  if (copied && window.invalidateCalendarDay) window.invalidateCalendarDay(targetDate);

  if (failed) {
    errorEl.textContent = `Copied ${copied}, ${failed} failed — search for those manually if needed.`;
    errorEl.classList.remove('hidden');
  } else {
    successEl.textContent = `Copied ${copied} item${copied === 1 ? '' : 's'}.`;
    successEl.classList.remove('hidden');
    setTimeout(() => {
      if (!$('#log-modal').classList.contains('hidden')) closeLogModal();
    }, 900);
  }
});

async function copyLoggedItemToDate(item, targetDate) {
  const isMeal = item.type_record === 'meal';
  const id = isMeal ? item.meal_id : item.id;
  const upstreamType = typeForRecord(item.type_record);
  const itemData = await api('/nutrition/item_data', { method: 'POST', body: { type: upstreamType, id } });
  const payload = {
    ...itemData,
    id,
    type_record: item.type_record,
    date: targetDate,
    time: item.intended_time || nowTimeStr(),
    day_part: item.day_part,
    specify_method: item.nutrient_conversion_id ? 'conversion' : 'manual',
    amount_value: item.nutrient_conversion_id ? '' : (item.used_product_amount ?? ''),
    selected_conversion_id: item.nutrient_conversion_id || '',
    amount_pieces: item.amount_pieces ?? item.used_amount ?? '',
    meal_amount: item.meal_amount || 1
  };
  await api('/nutrition/submit_item', { method: 'POST', body: payload });
}

renderMealItems();
boot();
