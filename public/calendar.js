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

function tileBarFillPercent(value, goalVal) {
  return Math.min(100, round(value / goalVal * 100, 1));
}

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
    if (!$('#calendar-popover').classList.contains('hidden')) renderCalendarMonth();
    if (calendarSelectedDate) {
      $('#day-panel-date-text').textContent = formatDateDisplay(calendarSelectedDate);
      renderDayPanel(calendarSelectedDate, calendarCache[calendarSelectedDate]);
    }
    $('#day-totals-section').classList.toggle('collapsed', currentSettings.totalsCollapsed);
  });

  $('#day-totals-section').classList.toggle('collapsed', currentSettings.totalsCollapsed);
  $('#day-totals-toggle').addEventListener('click', () => {
    const isCollapsed = $('#day-totals-section').classList.toggle('collapsed');
    saveSettings({ totalsCollapsed: isCollapsed });
  });

  $('#day-prev').addEventListener('click', () => selectDay(addDays(calendarSelectedDate, -1)));
  $('#day-next').addEventListener('click', () => selectDay(addDays(calendarSelectedDate, 1)));
  $('#day-today').addEventListener('click', () => selectDay(todayStr()));

  $('#day-panel-date').addEventListener('click', () => toggleCalendarPopover());
  $('#cal-prev').addEventListener('click', () => {
    calendarRefDate = new Date(calendarRefDate.getFullYear(), calendarRefDate.getMonth() - 1, 1);
    renderCalendarMonth();
  });
  $('#cal-next').addEventListener('click', () => {
    calendarRefDate = new Date(calendarRefDate.getFullYear(), calendarRefDate.getMonth() + 1, 1);
    renderCalendarMonth();
  });
  document.addEventListener('click', (e) => {
    const popover = $('#calendar-popover');
    if (popover.classList.contains('hidden')) return;
    if (popover.contains(e.target) || $('#day-panel-date').contains(e.target)) return;
    closeCalendarPopover();
  });

  $('#day-panel-refresh').addEventListener('click', () => {
    if (calendarSelectedDate) fetchDayStats(calendarSelectedDate, { force: true }).then(() => selectDay(calendarSelectedDate));
  });
  $('#day-panel-log').addEventListener('click', () => {
    if (calendarSelectedDate && window.startLogForDayPart) window.startLogForDayPart(calendarSelectedDate);
  });

  // Day-panel-header keyboard navigation: a roving toolbar — Left/Right move between its
  // own buttons (prev/date/next/today/+Log food/refresh), Left from the first one hands
  // off to the sidebar, Down drops into the totals toggle below.
  $('.day-panel-header').addEventListener('keydown', (e) => {
    const btns = $$('.day-panel-header button');
    const idx = btns.indexOf(e.target);
    if (idx === -1) return;

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      btns[Math.min(idx + 1, btns.length - 1)]?.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (idx === 0) { if (window.focusSidebar) window.focusSidebar(); }
      else btns[idx - 1]?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      $('#day-totals-toggle')?.focus();
    }
  });

  // Day-panel keyboard navigation: Up/Down move vertically through the totals toggle
  // ("kcal" summary pill) and the day's parts (breakfast/lunch/...), Left hands off to
  // the sidebar, Enter opens the log-food modal for the focused part.
  $('#day-panel').addEventListener('keydown', (e) => {
    if (e.target.id === 'day-totals-toggle') {
      if (e.key === 'ArrowDown') { e.preventDefault(); focusDayPartGroup(0); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); $('#day-panel-date')?.focus(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); if (window.focusSidebar) window.focusSidebar(); }
      return;
    }

    const group = e.target.closest('.day-part-group');
    if (!group) return;
    const groups = dayPartGroups();
    const idx = groups.indexOf(group);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (idx + 1 < groups.length) focusDayPartGroup(idx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (idx > 0) focusDayPartGroup(idx - 1);
      else $('#day-totals-toggle')?.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (window.focusSidebar) window.focusSidebar();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (window.startLogForDayPart) window.startLogForDayPart(group.dataset.date, group.dataset.dayPart);
    }
  });

  renderWeekdayHeader();
  // Land keyboard focus on the first day part as soon as the initial day loads, so arrow
  // keys work right away instead of requiring an initial click/Tab to "enter" the panel.
  // Scoped to just this first call — initCalendar's own guard above ensures it never
  // re-fires and steals focus on later day switches, refreshes, etc.
  selectDay(todayStr()).then(() => focusDayPartGroup(0));
};

function dayPartGroups() {
  return $$('#day-panel-items .day-part-group');
}
function focusDayPartGroup(idx) {
  const groups = dayPartGroups();
  if (!groups.length) return;
  const clamped = Math.max(0, Math.min(idx, groups.length - 1));
  groups[clamped].focus();
  groups[clamped].scrollIntoView({ block: 'nearest' });
}
// Entry point for the sidebar's ArrowRight handoff (see app.js).
window.focusFirstDayPart = function focusFirstDayPart() {
  focusDayPartGroup(0);
};

// Popover calendar: only fetched/rendered on demand (opening it), not on page load —
// the day view is the main focus now, a whole month's stats shouldn't be a startup cost.
function openCalendarPopover() {
  trackFocusBeforeModal();
  const popover = $('#calendar-popover');
  calendarRefDate = new Date(calendarSelectedDate + 'T00:00:00');
  calendarRefDate.setDate(1);
  renderCalendarMonth();

  popover.classList.remove('hidden');
  const anchor = $('#day-panel-date').getBoundingClientRect();
  const maxLeft = window.innerWidth - popover.offsetWidth - 12;
  popover.style.top = `${anchor.bottom + 8}px`;
  popover.style.left = `${Math.max(12, Math.min(anchor.left, maxLeft))}px`;

  // Land keyboard focus on the grid straight away so arrow keys work without an extra Tab.
  (calDayCells().find((c) => c.classList.contains('selected'))
    || calDayCells().find((c) => c.classList.contains('is-today'))
    || calDayCells()[0])?.focus();
}
window.closeCalendarPopover = function closeCalendarPopover() {
  $('#calendar-popover').classList.add('hidden');
  restoreFocusAfterModal();
};
function toggleCalendarPopover() {
  if ($('#calendar-popover').classList.contains('hidden')) openCalendarPopover();
  else closeCalendarPopover();
}

// Calendar-grid keyboard navigation: arrows move between day cells (Left/Right by one day,
// Up/Down by a week), Enter/Space selects the focused day.
function calDayCells() {
  return $$('#calendar-grid .cal-day:not(.empty)');
}
function focusCalDay(idx) {
  const cells = calDayCells();
  if (idx < 0 || idx >= cells.length) return; // stays within the currently rendered month
  cells[idx].focus();
}
$('#calendar-grid').addEventListener('keydown', (e) => {
  const cell = e.target.closest('.cal-day');
  if (!cell || cell.classList.contains('empty')) return;
  const cells = calDayCells();
  const idx = cells.indexOf(cell);

  if (e.key === 'ArrowRight') { e.preventDefault(); focusCalDay(idx + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); focusCalDay(idx - 1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); focusCalDay(idx + 7); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); focusCalDay(idx - 7); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cell.click(); }
});

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
    cell.tabIndex = 0;
    cell.dataset.date = ds;
    if (ds === today) cell.classList.add('is-today');
    if (ds === calendarSelectedDate) cell.classList.add('selected');
    cell.innerHTML = `<span class="day-num">${d}</span>`;
    cell.addEventListener('click', () => { selectDay(ds); closeCalendarPopover(); });
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
  $('#day-today').classList.toggle('is-active', ds === todayStr());

  $('#day-panel-date-text').textContent = formatDateDisplay(ds);
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
    $('#day-totals-summary-text').textContent = '';
    $('#day-totals-summary-fill').style.width = '0%';
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
      ? `<div class="tile-bar"><div class="tile-bar-fill${value > goalVal ? ' over-goal' : ''}" style="width: ${tileBarFillPercent(value, goalVal)}%"></div></div>`
      : '';
    return `<div class="day-total-tile">
      <div class="value">${value}${goalStr} ${unit}</div>
      <div class="label">${label}</div>
      ${bar}
    </div>`;
  }).join('');

  // Header summary bar (Energy) — stays visible whether the tile grid is collapsed or not.
  const energyValue = round(stats.enercc_kcal || 0, 0);
  const energyGoal = parseInt(goal.enercc_kcal, 10);
  $('#day-totals-summary-text').textContent = energyGoal ? `${energyValue} / ${energyGoal} kcal` : `${energyValue} kcal`;
  const summaryFill = $('#day-totals-summary-fill');
  summaryFill.style.width = `${energyGoal ? tileBarFillPercent(energyValue, energyGoal) : 0}%`;
  summaryFill.classList.toggle('over-goal', !!energyGoal && energyValue > energyGoal);

  const items = data.items || {};
  const orderedDayParts = (window.dayParts && window.dayParts.length ? window.dayParts : Object.keys(items));

  dayItemsByPivot = {};

  const groups = orderedDayParts.map((dp) => {
    const dayItems = items[dp] || [];
    const rows = dayItems.length
      ? dayItems.map((item) => renderDayItemRow(item, ds)).join('')
      : '<p class="muted day-part-empty">Nothing logged.</p>';
    const label = escapeHtml(ucFirst(dp.replace(/_/g, ' ')));
    return `<div class="day-part-group" tabindex="0" role="group" aria-label="${label}"
      data-date="${escapeHtml(ds)}" data-day-part="${escapeHtml(dp)}">
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
