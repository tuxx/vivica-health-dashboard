const calendarCache = {}; // dateStr -> stats payload, or { error: true }
let calendarRefDate = new Date();
calendarRefDate.setDate(1);
let calendarSelectedDate = null;
let calendarInitialized = false;

const NUTRIENT_TILES = [
  { key: 'enercc_kcal', label: 'Energy', unit: 'kcal' },
  { key: 'prot_g', label: 'Protein', unit: 'g' },
  { key: 'fat_g', label: 'Fat', unit: 'g' },
  { key: 'cho_g', label: 'Carbs', unit: 'g' },
  { key: 'fibt_g', label: 'Fiber', unit: 'g' }
];

window.initCalendar = function initCalendar() {
  if (calendarInitialized) return;
  calendarInitialized = true;

  $('#cal-prev').addEventListener('click', () => {
    calendarRefDate = new Date(calendarRefDate.getFullYear(), calendarRefDate.getMonth() - 1, 1);
    renderCalendarMonth();
  });
  $('#cal-next').addEventListener('click', () => {
    calendarRefDate = new Date(calendarRefDate.getFullYear(), calendarRefDate.getMonth() + 1, 1);
    renderCalendarMonth();
  });
  $('#cal-today').addEventListener('click', () => {
    calendarRefDate = new Date();
    calendarRefDate.setDate(1);
    renderCalendarMonth();
    selectDay(todayStr());
  });
  $('#day-panel-refresh').addEventListener('click', () => {
    if (calendarSelectedDate) fetchDayStats(calendarSelectedDate, { force: true }).then(() => selectDay(calendarSelectedDate));
  });

  renderCalendarMonth();
};

window.invalidateCalendarDay = function invalidateCalendarDay(ds) {
  delete calendarCache[ds];
  fetchDayStats(ds, { force: true }).then((data) => {
    updateDayCell(ds, data);
    if (ds === calendarSelectedDate) renderDayPanel(ds, data);
  });
};

function renderCalendarMonth() {
  const year = calendarRefDate.getFullYear();
  const month = calendarRefDate.getMonth();

  $('#cal-month-label').textContent = calendarRefDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // Monday = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  const grid = $('#calendar-grid');
  grid.innerHTML = '';

  for (let i = 0; i < firstWeekday; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-day empty';
    grid.appendChild(empty);
  }

  const dates = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    dates.push(ds);

    const cell = document.createElement('div');
    cell.className = 'cal-day';
    cell.dataset.date = ds;
    if (ds === today) cell.classList.add('is-today');
    if (ds === calendarSelectedDate) cell.classList.add('selected');
    cell.innerHTML = `<span class="day-num">${d}</span>`;
    cell.addEventListener('click', () => selectDay(ds));
    grid.appendChild(cell);

    if (calendarCache[ds]) updateDayCell(ds, calendarCache[ds]);
    else if (ds <= today) {
      const loading = document.createElement('span');
      loading.className = 'day-loading';
      loading.textContent = '…';
      cell.appendChild(loading);
    }
  }

  loadMonthStats(dates.filter((ds) => ds <= today && !calendarCache[ds]));
}

async function loadMonthStats(dates) {
  const concurrency = 4;
  let idx = 0;
  async function worker() {
    while (idx < dates.length) {
      const ds = dates[idx++];
      const data = await fetchDayStats(ds);
      updateDayCell(ds, data);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, dates.length) }, worker));
}

async function fetchDayStats(ds, { force } = {}) {
  if (!force && calendarCache[ds]) return calendarCache[ds];
  try {
    const data = await api(`/nutrition/stats?date=${ds}${force ? '&refresh=1' : ''}`);
    calendarCache[ds] = data;
    return data;
  } catch (err) {
    const errData = { error: true, message: err.message };
    calendarCache[ds] = errData;
    return errData;
  }
}

function dayItemCount(data) {
  if (!data || data.error || !data.items) return 0;
  return Object.values(data.items).reduce((sum, arr) => sum + (arr?.length || 0), 0);
}

function updateDayCell(ds, data) {
  const cell = document.querySelector(`.cal-day[data-date="${ds}"]`);
  if (!cell) return; // month scrolled away before the fetch resolved

  const loading = cell.querySelector('.day-loading');
  if (loading) loading.remove();

  const count = dayItemCount(data);
  cell.classList.toggle('has-items', count > 0);

  let kcalEl = cell.querySelector('.day-kcal');
  if (!kcalEl) {
    kcalEl = document.createElement('span');
    kcalEl.className = 'day-kcal';
    cell.appendChild(kcalEl);
  }
  if (data?.error) {
    kcalEl.textContent = '';
  } else if (count > 0) {
    kcalEl.textContent = `${Math.round(data.stats?.enercc_kcal || 0)} kcal`;
  } else {
    kcalEl.textContent = '';
  }
}

async function selectDay(ds) {
  calendarSelectedDate = ds;
  $$('.cal-day').forEach((el) => el.classList.toggle('selected', el.dataset.date === ds));

  $('#day-panel-empty').classList.add('hidden');
  $('#day-panel-content').classList.remove('hidden');
  $('#day-panel-date').textContent = new Date(ds + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  $('#day-panel-items').innerHTML = '<p class="muted">Loading…</p>';
  $('#day-panel-totals').innerHTML = '';

  const data = await fetchDayStats(ds);
  updateDayCell(ds, data);
  if (ds === calendarSelectedDate) renderDayPanel(ds, data);
}

function renderDayPanel(ds, data) {
  const totalsEl = $('#day-panel-totals');
  const itemsEl = $('#day-panel-items');

  if (data?.error) {
    totalsEl.innerHTML = '';
    itemsEl.innerHTML = `<p class="error">Could not load this day: ${escapeHtml(data.message || '')}</p>`;
    return;
  }

  const stats = data.stats || {};
  const goal = data.goal || {};

  totalsEl.innerHTML = NUTRIENT_TILES.map(({ key, label, unit }) => {
    if (!(key in stats)) return '';
    const value = round(stats[key] || 0, key === 'enercc_kcal' ? 0 : 1);
    const goalVal = parseInt(goal[key], 10);
    const goalStr = goalVal ? ` / ${goalVal}` : '';
    return `<div class="day-total-tile">
      <div class="value">${value}${goalStr} ${unit}</div>
      <div class="label">${label}</div>
    </div>`;
  }).join('');

  const items = data.items || {};
  const orderedDayParts = (window.dayParts && window.dayParts.length ? window.dayParts : Object.keys(items));

  const groups = orderedDayParts
    .filter((dp) => items[dp] && items[dp].length)
    .map((dp) => {
      const rows = items[dp].map((item) => renderDayItemRow(item, ds)).join('');
      return `<div class="day-part-group">
        <h3>${escapeHtml(ucFirst(dp.replace(/_/g, ' ')))}</h3>
        ${rows}
      </div>`;
    });

  itemsEl.innerHTML = groups.length ? groups.join('') : '<p class="muted">Nothing logged for this day.</p>';

  itemsEl.querySelectorAll('[data-delete-pivot]').forEach((btn) => {
    btn.addEventListener('click', () => deleteLoggedItem(btn.dataset, ds));
  });
}

function renderDayItemRow(item, ds) {
  const kcal = item.values?.enercc_kcal ? `${round(item.values.enercc_kcal, 0)} kcal` : '';
  const amount = item.used_product_amount ? `${item.used_product_amount} ${item.measuring_unit || ''}` : '';
  const meta = [amount, kcal].filter(Boolean).join(' • ');

  const pivotId = item.type_record === 'meal' ? item.meal_pivot_id : item.product_pivot_id;
  const upstreamType = typeForRecord(item.type_record);

  return `<div class="day-item">
    <span class="name">${escapeHtml(item.description || '')}</span>
    <span class="meta">${escapeHtml(meta)}</span>
    <button class="delete-item" title="Remove"
      data-delete-pivot="${escapeHtml(String(pivotId))}"
      data-delete-type="${escapeHtml(upstreamType)}"
      data-delete-name="${escapeHtml(item.description || 'this item')}"
    >✕</button>
  </div>`;
}

async function deleteLoggedItem(dataset, ds) {
  if (!confirm(`Remove "${dataset.deleteName}" from this day?`)) return;
  try {
    await api('/nutrition/delete_scheduled_item', {
      method: 'POST',
      body: { id: dataset.deletePivot, type: dataset.deleteType, date: ds }
    });
    delete calendarCache[ds];
    const data = await fetchDayStats(ds, { force: true });
    updateDayCell(ds, data);
    renderDayPanel(ds, data);
  } catch (err) {
    alert('Could not remove item: ' + err.message);
  }
}
