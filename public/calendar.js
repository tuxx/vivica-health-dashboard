const calendarCache = {}; // dateStr -> stats payload, or { error: true }
let calendarRefDate = new Date();
calendarRefDate.setDate(1);
let calendarSelectedDate = null;
let calendarInitialized = false;
let dayItemsByPivot = {}; // pivotId -> raw stats item, refreshed on every renderDayPanel; used by the edit button

const NUTRIENT_TILES = [
  { key: 'enercc_kcal', label: 'Energy', unit: 'kcal' },
  { key: 'prot_g', label: 'Protein', unit: 'g' },
  { key: 'fat_g', label: 'Fat', unit: 'g' },
  { key: 'cho_g', label: 'Carbs', unit: 'g' },
  { key: 'fibt_g', label: 'Fiber', unit: 'g' }
];

const WEEKDAY_LABELS = {
  mon: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  sun: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
};

function renderWeekdayHeader() {
  const labels = WEEKDAY_LABELS[currentSettings.firstDayOfWeek] || WEEKDAY_LABELS.mon;
  $('#calendar-weekdays').innerHTML = labels.map((l) => `<span>${l}</span>`).join('');
}

// Column index (0-6) of a JS Date#getDay() value, given the configured first day of the week.
function weekdayColumn(getDay) {
  return currentSettings.firstDayOfWeek === 'sun' ? getDay : (getDay + 6) % 7;
}

window.initCalendar = function initCalendar() {
  if (calendarInitialized) return;
  calendarInitialized = true;

  document.addEventListener('vivica:settings-changed', () => {
    renderWeekdayHeader();
    renderCalendarMonth();
    if (calendarSelectedDate) renderDayPanel(calendarSelectedDate, calendarCache[calendarSelectedDate]);
  });

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
  $('#day-panel-log').addEventListener('click', () => {
    if (calendarSelectedDate && window.startLogForDayPart) window.startLogForDayPart(calendarSelectedDate);
  });

  renderWeekdayHeader();
  renderCalendarMonth();
  selectDay(todayStr());
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

  const firstWeekday = weekdayColumn(new Date(year, month, 1).getDay());
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
  $('#day-panel-date').textContent = formatDateDisplay(ds);
  $('#day-panel-items').innerHTML = '<p class="muted">Loading…</p>';
  $('#day-panel-totals').innerHTML = '';

  const data = await fetchDayStats(ds);
  updateDayCell(ds, data);
  if (ds === calendarSelectedDate) renderDayPanel(ds, data);
}

function renderDayPanel(ds, data) {
  const totalsEl = $('#day-panel-totals');
  const itemsEl = $('#day-panel-items');

  if (!data) return; // not loaded yet; the in-flight fetch will call this again on resolution

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
    const bar = goalVal
      ? `<div class="tile-bar"><div class="tile-bar-fill${value > goalVal ? ' over-goal' : ''}" style="width: ${Math.min(100, round(value / goalVal * 100, 1))}%"></div></div>`
      : '';
    return `<div class="day-total-tile">
      <div class="value">${value}${goalStr} ${unit}</div>
      <div class="label">${label}</div>
      ${bar}
    </div>`;
  }).join('');

  const items = data.items || {};
  const orderedDayParts = (window.dayParts && window.dayParts.length ? window.dayParts : Object.keys(items));

  dayItemsByPivot = {};

  const groups = orderedDayParts.map((dp) => {
    const dayItems = items[dp] || [];
    const rows = dayItems.length
      ? dayItems.map((item) => renderDayItemRow(item, ds)).join('')
      : '<p class="muted day-part-empty">Nothing logged.</p>';
    const label = escapeHtml(ucFirst(dp.replace(/_/g, ' ')));
    return `<div class="day-part-group">
      <div class="day-part-header">
        <h3>${label}</h3>
        <button type="button" class="btn-ghost btn-icon add-day-part" title="Log food for ${label}"
          data-date="${escapeHtml(ds)}" data-day-part="${escapeHtml(dp)}">+</button>
      </div>
      ${rows}
    </div>`;
  });

  itemsEl.innerHTML = groups.length ? groups.join('') : '<p class="muted">Nothing logged for this day.</p>';

  itemsEl.querySelectorAll('[data-delete-pivot]').forEach((btn) => {
    btn.addEventListener('click', () => deleteLoggedItem(btn.dataset, ds));
  });
  itemsEl.querySelectorAll('[data-edit-pivot]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = dayItemsByPivot[btn.dataset.editPivot];
      if (item && window.startEditLogItem) window.startEditLogItem(item, ds);
    });
  });
  itemsEl.querySelectorAll('.add-day-part').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (window.startLogForDayPart) window.startLogForDayPart(btn.dataset.date, btn.dataset.dayPart);
    });
  });
}

function renderDayItemRow(item, ds) {
  const kcal = item.values?.enercc_kcal ? `${round(item.values.enercc_kcal, 0)} kcal` : '';
  const amount = item.used_product_amount ? `${item.used_product_amount} ${item.measuring_unit || ''}` : '';
  const meta = [amount, kcal].filter(Boolean).join(' • ');

  const pivotId = item.type_record === 'meal' ? item.meal_pivot_id : item.product_pivot_id;
  const upstreamType = typeForRecord(item.type_record);
  dayItemsByPivot[pivotId] = item;

  return `<div class="day-item">
    <span class="name">${escapeHtml(item.description || '')}</span>
    <span class="meta">${escapeHtml(meta)}</span>
    <button class="edit-item" title="Edit"
      data-edit-pivot="${escapeHtml(String(pivotId))}"
    >✎</button>
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
