const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let dayParts = [];
let selectedLogItem = null;   // merged search-result + item_data, for the log-food modal
let mealItems = [];           // items being assembled into a new meal
let pendingMealProduct = null; // product awaiting a quantity before being added to mealItems
let logContext = null;        // { date, day_part, dayPartExplicit } for the currently open log-food modal

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

  $('#user-email').textContent = me.user?.email || '';
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

$$('#tabs button[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

function showTab(name) {
  $$('#tabs button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('#calendar-view').classList.toggle('hidden', name !== 'calendar');
  $('#settings-view').classList.toggle('hidden', name !== 'settings');
  $('#profile-view').classList.toggle('hidden', name !== 'profile');
}

// ---------- keyboard shortcuts ----------
// Single-key shortcuts, active whenever focus isn't in a text field/select, so
// they never fight with typing. "N" is the fast path for the everyday action:
// opens the quick-log modal for the selected calendar day (or today).
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === 'Escape') {
    if (!$('#log-modal').classList.contains('hidden')) {
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
    case 'b':
      openLogModal(typeof calendarSelectedDate !== 'undefined' && calendarSelectedDate ? calendarSelectedDate : todayStr());
      openMealBuilder();
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
  }
});

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
  selectedLogItem = null;
  backToSearchStep();
  $('#log-modal-title').textContent = `Log food — ${formatDateDisplay(date)}`;
  $('#log-modal').classList.remove('hidden');
  $('#search-input').focus();
}

function closeLogModal() {
  $('#log-modal').classList.add('hidden');
  logContext = null;
  selectedLogItem = null;
  mealItems = [];
}

function backToSearchStep() {
  $('#log-modal-form-step').classList.add('hidden');
  $('#log-modal-meal-step').classList.add('hidden');
  $('#log-modal-search-step').classList.remove('hidden');
  $('#log-error').classList.add('hidden');
  $('#log-success').classList.add('hidden');
  $('#search-input').value = '';
  $('#search-results').innerHTML = '';
  $('#search-input').focus();
}

$('#log-modal-close').addEventListener('click', closeLogModal);
$('#log-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeLogModal();
});
$('#log-back-to-search').addEventListener('click', backToSearchStep);

// ---------- Log food modal: search ----------

$('#search-input').addEventListener('input', debounce((e) => {
  const val = e.target.value;
  if (val.length < 2) { $('#search-results').innerHTML = ''; return; }
  runNutritionSearch(val);
}, 350));

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

$('#show-recent').addEventListener('click', () => loadQuickList('/products/recent'));
$('#show-frequent').addEventListener('click', () => loadQuickList('/products/frequent'));

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
  $('#log-modal-form-step').classList.remove('hidden');
  $('#log-error').classList.add('hidden');
  $('#log-success').classList.add('hidden');

  $('#log-item-name').textContent = selectedLogItem.description;
  $('#log-date').value = selectedLogItem.date;
  setTimeInputValue($('#log-time'), selectedLogItem.time);
  $('#log-day-part').value = selectedLogItem.day_part || dayParts[0];

  const isMeal = selectedLogItem.type_record === 'meal';
  $('#log-meal-amount-wrap').classList.toggle('hidden', !isMeal);
  $('#log-amount-wrap').classList.toggle('hidden', isMeal);

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

  try {
    $('#log-submit').disabled = true;
    await api('/nutrition/submit_item', { method: 'POST', body: payload });
    successEl.textContent = `Logged ${selectedLogItem.description}.`;
    successEl.classList.remove('hidden');
    if (window.invalidateCalendarDay) window.invalidateCalendarDay(payload.date);
    selectedLogItem = null;
    // Brief confirmation, then back to search so another item can be logged for the
    // same day/day-part without re-opening the modal.
    setTimeout(() => {
      if (!$('#log-modal').classList.contains('hidden')) backToSearchStep();
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

renderMealItems();
boot();
