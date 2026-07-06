const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let dayParts = [];
let selectedLogItem = null;   // merged search-result + item_data, for the "Log food" tab
let mealItems = [];           // items being assembled into a new meal
let pendingMealProduct = null; // product awaiting a quantity before being added to mealItems
let logContext = null;        // { date, day_part } set by the calendar's "+" button, consumed by selectLogItem

// ---------- 24h time inputs (guaranteed HH:MM regardless of browser/OS locale) ----------

function setupTimeInput(el) {
  el.addEventListener('input', () => {
    let digits = el.value.replace(/\D/g, '').slice(0, 4);
    el.value = digits.length >= 3 ? digits.slice(0, 2) + ':' + digits.slice(2) : digits;
  });
  el.addEventListener('blur', () => {
    el.classList.toggle('invalid', el.value !== '' && !isValidTime(el.value));
  });
}
function isValidTime(v) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}
$$('.time-input').forEach(setupTimeInput);

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
  fillDayPartSelect($('#meal-day-part'));

  $('#user-email').textContent = me.user?.email || '';
  $('#shell').classList.remove('hidden');
  $('#login-view').classList.add('hidden');
  showTab('calendar');
  if (window.initCalendar) window.initCalendar();

  $('#meal-day-part').value = guessDayPartForTime(dayParts);
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
  btn.addEventListener('click', () => {
    if (btn.dataset.tab !== 'log') logContext = null;
    showTab(btn.dataset.tab);
  });
});

function showTab(name) {
  $$('#tabs button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('#log-view').classList.toggle('hidden', name !== 'log');
  $('#meals-view').classList.toggle('hidden', name !== 'meals');
  $('#calendar-view').classList.toggle('hidden', name !== 'calendar');
}

// ---------- keyboard shortcuts ----------
// Single-key shortcuts, active whenever focus isn't in a text field/select, so
// they never fight with typing. "N" is the fast path for the everyday action
// (log a food/meal): jumps straight to the Log food tab with the search box focused.
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === 'Escape') {
    if (!$('#qty-modal').classList.contains('hidden')) {
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
      logContext = null;
      showTab('log');
      $('#search-input').focus();
      e.preventDefault();
      break;
    case 'c':
      showTab('calendar');
      e.preventDefault();
      break;
    case 'b':
      showTab('meals');
      e.preventDefault();
      break;
    case '/': {
      const visibleSearch = $('#log-view:not(.hidden) #search-input') || $('#meals-view:not(.hidden) #meal-search-input');
      if (visibleSearch) { visibleSearch.focus(); e.preventDefault(); }
      break;
    }
  }
});

// Enter-to-confirm in the quantity modal (it's not a <form>, so Enter does nothing by default).
$('#qty-modal-amount').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#qty-modal-confirm').click(); }
});

// Called from the calendar's day panel "+" buttons to jump into the Log food tab
// with the date/day-part already decided, instead of defaulting to today/blank.
window.startLogForDayPart = function startLogForDayPart(date, dayPart) {
  logContext = { date, day_part: dayPart };
  showTab('log');
  $('#search-input').focus();
};

// ---------- Log food tab: search ----------

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
  const ctx = logContext;
  logContext = null;

  selectedLogItem = {
    ...item,
    date: ctx?.date || todayStr(),
    time: nowTimeStr(),
    day_part: ctx?.day_part || guessDayPartForTime(dayParts),
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
    if (!ctx?.day_part && itemData.suggested_day_part) selectedLogItem.day_part = itemData.suggested_day_part;
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
  $('#log-empty').classList.add('hidden');
  $('#log-form').classList.remove('hidden');
  $('#log-error').classList.add('hidden');
  $('#log-success').classList.add('hidden');

  $('#log-item-name').textContent = selectedLogItem.description;
  $('#log-date').value = selectedLogItem.date;
  $('#log-time').value = selectedLogItem.time;
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

  if (!isValidTime($('#log-time').value)) {
    errorEl.textContent = 'Time must be in 24h HH:MM format.';
    errorEl.classList.remove('hidden');
    return;
  }

  const method = $('input[name="specify_method"]:checked').value;
  const payload = {
    ...selectedLogItem,
    date: $('#log-date').value,
    time: $('#log-time').value,
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
    $('#log-form').classList.add('hidden');
    $('#log-empty').classList.remove('hidden');
    if (window.invalidateCalendarDay) window.invalidateCalendarDay(payload.date);
    selectedLogItem = null;
  } catch (err) {
    errorEl.textContent = err.data?.errors ? Object.values(err.data.errors).flat().join(' ') : err.message;
    errorEl.classList.remove('hidden');
  } finally {
    $('#log-submit').disabled = false;
  }
});

// ---------- Build a meal tab ----------

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
  const dayPart = $('#meal-day-part').value;
  $('#meal-submit').disabled = !(mealItems.length && name.length >= 3 && dayPart);
}
$('#meal-name').addEventListener('input', updateMealSubmitState);
$('#meal-day-part').addEventListener('change', updateMealSubmitState);

$('#meal-time').value = nowTimeStr();

$('#meal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = $('#meal-error');
  const successEl = $('#meal-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  if (!isValidTime($('#meal-time').value)) {
    errorEl.textContent = 'Time must be in 24h HH:MM format.';
    errorEl.classList.remove('hidden');
    return;
  }

  const payload = {
    name: $('#meal-name').value.trim(),
    day_part: $('#meal-day-part').value,
    time: $('#meal-time').value,
    is_favorite: $('#meal-favorite').checked,
    items: mealItems
  };

  try {
    $('#meal-submit').disabled = true;
    await api('/submit_nutrient_meal', { method: 'POST', body: payload });
    successEl.textContent = `Meal "${payload.name}" saved — search for it in the Log food tab to add it to a day.`;
    successEl.classList.remove('hidden');
    mealItems = [];
    $('#meal-form').reset();
    $('#meal-time').value = nowTimeStr();
    renderMealItems();
  } catch (err) {
    errorEl.textContent = err.data?.errors ? Object.values(err.data.errors).flat().join(' ') : err.message;
    errorEl.classList.remove('hidden');
  } finally {
    updateMealSubmitState();
  }
});

renderMealItems();
boot();
