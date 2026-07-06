// Shared helpers used by app.js and calendar.js

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

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
