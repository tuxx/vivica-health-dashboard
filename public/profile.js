// Profile tab: "My info" (from the already-fetched /auth/me user object),
// "Care team / practice" (/auth/company_info) and "Medical form"
// (/auth/medical_form). All read-only — no update-profile endpoint has been
// found in the reconstructed API, see API_REFERENCE.md.

let profileLoaded = false;

window.initProfile = function initProfile() {
  if (profileLoaded) return;
  profileLoaded = true;
  loadProfile();
};

async function loadProfile() {
  const loadingEl = $('#profile-loading');
  setLoadingState(loadingEl, 2);
  loadingEl.classList.remove('hidden');
  $('#profile-content').classList.add('hidden');

  renderMyInfo(window.currentUser);
  await Promise.allSettled([loadCompanyInfo(), loadMedicalForm()]);

  loadingEl.classList.add('hidden');
  $('#profile-content').classList.remove('hidden');
}

function formatValue(v) {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.join(', ');
  return v;
}
function kvRow(label, value) {
  if (value == null || value === '') return '';
  return `<div class="kv-row"><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(String(formatValue(value)))}</span></div>`;
}

// ---------- my info ----------

function renderMyInfo(user) {
  const el = $('#profile-my-info');
  if (!user) { el.innerHTML = '<p class="muted">No user info available.</p>'; return; }

  const avatarUrl = user.avatar_url || user.thumb_md_url || user.thumb_url;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.name || '';

  // Explicit allowlist only — the real `user` payload also carries sensitive fields
  // (e.g. `ssn`, `auth_token`, internal refs) that must never be rendered here.
  const rows = [
    kvRow('Name', name),
    kvRow('Email', user.email),
    kvRow('Phone', user.phone || user.phone_number),
    kvRow('Date of birth', user.date_of_birth || user.birth_date),
    kvRow('Gender', user.gender),
    kvRow('Preferred form of address', user.preferred_form_of_address),
    kvRow('Nickname', user.nickname),
    kvRow('Language', user.language)
  ].join('');

  el.innerHTML = (avatarUrl ? `<img class="profile-avatar" src="${escapeHtml(avatarUrl)}" alt="" />` : '') + rows;
}

// ---------- care team / practice ----------

async function loadCompanyInfo() {
  const el = $('#profile-company-info');
  try {
    const res = await api('/company_info');
    renderCompanyInfo(res.data ?? null);
  } catch (err) {
    el.innerHTML = `<p class="muted">Not available (${escapeHtml(err.message)}).</p>`;
  }
}

function renderCompanyInfo(data) {
  const el = $('#profile-company-info');
  if (!data || !Object.keys(data).length) { el.innerHTML = '<p class="muted">No practice info available.</p>'; return; }

  const avatarUrl = data.avatar_lg_url || data.avatar_normal_url;
  const rows = [kvRow('Name', data.name), kvRow('Email', data.email), kvRow('Phone', data.phone)].join('');

  const addresses = (data.addresses || [])
    .map((a) => Object.values(a || {}).filter((v) => typeof v === 'string' && v).join(', '))
    .filter(Boolean);
  const addressHtml = addresses.length
    ? `<div class="profile-subsection"><h3>Address</h3>${addresses.map((a) => `<p class="muted">${escapeHtml(a)}</p>`).join('')}</div>`
    : '';

  const users = (data.users || []).filter((u) => !u.deleted_at);
  const usersHtml = users.length
    ? `<div class="profile-subsection"><h3>Team (${users.length})</h3>${users.map((u) => {
        const uname = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.name || u.email || 'Unnamed';
        return kvRow(uname, u.pivot?.fallback_role_display || '');
      }).join('')}</div>`
    : '';

  el.innerHTML = (avatarUrl ? `<img class="profile-avatar" src="${escapeHtml(avatarUrl)}" alt="" />` : '') + rows + addressHtml + usersHtml;
}

// ---------- medical form ----------

async function loadMedicalForm() {
  const el = $('#profile-medical-form');
  try {
    const res = await api('/medical_form');
    renderMedicalForm(res.data ?? null);
  } catch (err) {
    el.innerHTML = `<p class="muted">Not available (${escapeHtml(err.message)}).</p>`;
  }
}

function renderMedicalForm(data) {
  const el = $('#profile-medical-form');
  if (!data || !Object.keys(data).length) { el.innerHTML = '<p class="muted">No medical form on file.</p>'; return; }

  const parts = [];

  const topRows = kvRow('Cancer type ID', data.cancer_type_id) + kvRow('Menopausal ID', data.menopausal_id);
  if (topRows) parts.push(topRows);

  (data.tumor_informations || []).forEach((info, idx) => {
    const side = info.side || info.location || (idx === 0 ? 'left' : idx === 1 ? 'right' : `#${idx + 1}`);
    const rows = [
      kvRow('Diagnoses', info.diagnoses_ids),
      kvRow('Tumor stage ID', info.tumor_stage_id),
      kvRow('Multifocality', info.multifocality),
      kvRow('Tumor size ID', info.tumor_size_id),
      kvRow('Nodal stage ID', info.nodal_stage_id),
      kvRow('Metastasis ID', info.metastasis_id),
      kvRow('Date', info.date)
    ].join('');
    if (rows) parts.push(`<div class="profile-subsection"><h3>${escapeHtml(ucFirst(String(side)))} tumor</h3>${rows}</div>`);
  });

  const treatments = data.treatments || [];
  if (treatments.length) {
    const rows = treatments.map((t) =>
      kvRow(`Treatment ${t.treatment_id ?? ''}`.trim(), [t.start_date, t.end_date].filter(Boolean).join(' → '))
    ).join('');
    parts.push(`<div class="profile-subsection"><h3>Treatments</h3>${rows}</div>`);
  }

  const medications = data.medications || [];
  if (medications.length) {
    const rows = medications.map((m) =>
      kvRow(m.name || 'Medication', [m.dosage, [m.start_date, m.end_date].filter(Boolean).join(' → ')].filter(Boolean).join(' • '))
    ).join('');
    parts.push(`<div class="profile-subsection"><h3>Medications</h3>${rows}</div>`);
  }

  el.innerHTML = parts.length ? parts.join('') : '<p class="muted">No medical form on file.</p>';
}

// Note: cancer_type_id / tumor_stage_id / tumor_size_id / nodal_stage_id / metastasis_id are raw
// IDs — the reconstructed API doesn't document a lookup endpoint for their human-readable labels.
