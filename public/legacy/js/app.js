/* ═══════════════════════════════════════
   app.js — core application logic
   Handles: login, logout, theme toggle
   Edit this file for auth and routing init
   ═══════════════════════════════════════ */

'use strict';

/* ── THEME ── */
const THEME_KEY = 'sacs-theme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
  // update all toggle button icons
  document.querySelectorAll('.theme-toggle').forEach(btn => {
    btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  });
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  document.body.classList.add('theme-transitioning');
  applyTheme(current === 'dark' ? 'light' : 'dark');
  setTimeout(() => document.body.classList.remove('theme-transitioning'), 300);
}

/* ── AUTH CONSTANTS ── */
const AUTH_CONTEXT_KEY = 'sacs-auth-context';
const AUTH_CONTEXT_EVENT = 'sacs-auth-context-changed';
const ROLE_PAGE_STATE_PREFIX = 'sacs-active-page-';

function dispatchAuthContextChanged(context) {
  try {
    window.dispatchEvent(new CustomEvent(AUTH_CONTEXT_EVENT, { detail: context || null }));
  } catch {
    // CustomEvent may fail in very old browsers; ignore.
  }
}

function toTitleCase(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  return text
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function inferNameFromIdentity(identity) {
  const raw = String(identity || '').trim();
  if (!raw) return '';

  const fromEmail = raw.includes('@') ? raw.split('@')[0] : raw;
  return toTitleCase(fromEmail.replace(/[._-]+/g, ' '));
}

/**
 * Print one document out of a portal.
 *
 * css/print.css keys every rule off body[data-print="<kind>"], so the sheet
 * that comes out contains that document alone — not whichever card happened
 * to be on screen. The attribute is cleared on afterprint rather than on the
 * line after window.print(): Safari and Firefox return from print() before
 * the dialog is dismissed, and clearing it early strips the styling out of
 * the preview. The timeout is the fallback for browsers that never fire
 * afterprint, so the portal can't get stuck in print styling.
 *
 * @param {'payslip'|'report'|'timesheet'} kind
 */
function printDocument(kind) {
  const body = document.body;
  if (!body) return;

  body.setAttribute('data-print', String(kind || '').trim());

  let done = false;
  const restore = () => {
    if (done) return;
    done = true;
    body.removeAttribute('data-print');
    window.removeEventListener('afterprint', restore);
  };

  window.addEventListener('afterprint', restore);
  setTimeout(restore, 60000);

  window.print();
}

/* ── Cross-portal utilities ───────────────────────────────────────────────
   These live here because more than one portal needs them. They used to be
   defined inside admin.js/accountant.js, which only worked because every
   portal script was loaded into the same global scope — so hr.js and
   super-admin.js were silently borrowing admin.js's copies. The loader now
   loads only the signed-in role's script, so anything shared has to be in
   this file, which every role loads.                                        */

const ALLOWED_SUFFIXES = ['', 'Jr.', 'Sr.', 'II', 'III', 'IV', 'V'];

// Delays `fn` until `wait` ms after the last call — for a search box wired to
// a server round trip (e.g. the audit log search, whose query already
// combines a search term with a row limit server-side, so it can't just be
// filtered client-side without changing which rows show up). Typing a
// 10-character term used to fire 10 requests and 10 full-table re-renders;
// this fires one, after typing pauses.
function debounce(fn, wait = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/**
 * Today's date as YYYY-MM-DD in Asia/Manila — the same calendar the API uses
 * (every route's getDateKey()). new Date().toISOString().slice(0, 10) is the
 * UTC date, which in Manila is still *yesterday* until 8 AM: HR's attendance
 * page opened at 7:30 showed the previous day, just as the morning taps came in.
 */
function localDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes the five HTML-significant characters in one pass.
 *
 * This runs for every cell of every table the portals render — a 15-row
 * employee table is ~150 calls, and the search boxes re-render on each
 * keystroke. The five chained replaceAll() calls this replaces walked the
 * whole string five times each, four of those passes finding nothing:
 * ordinary names and dates contain none of these characters.
 *
 * String(value || '') is kept exactly as it was, not switched to ??, because
 * callers rely on escapeHtml(0) returning '' rather than '0'.
 */
function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function formatTimeOnly(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-PH', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function formatHours(value) {
  const total = Number(value || 0);
  if (!Number.isFinite(total) || total <= 0) return '—';

  const wholeHours = Math.floor(total);
  const minutes = Math.round((total - wholeHours) * 60);
  return `${wholeHours}h ${String(minutes).padStart(2, '0')}m`;
}

function splitFullName(fullName) {
  const raw = String(fullName || '').trim();
  if (!raw) {
    return {
      first_name: '',
      second_name: '',
      middle_initial: '',
      last_name: '',
      suffix: '',
    };
  }

  const tokens = raw.split(/\s+/).filter(Boolean);
  const result = {
    first_name: '',
    second_name: '',
    middle_initial: '',
    last_name: '',
    suffix: '',
  };

  if (tokens.length === 1) {
    result.first_name = tokens[0];
    return result;
  }

  let nameTokens = [...tokens];
  const maybeSuffix = nameTokens[nameTokens.length - 1];
  if (ALLOWED_SUFFIXES.includes(maybeSuffix)) {
    result.suffix = maybeSuffix;
    nameTokens.pop();
  }

  if (!nameTokens.length) return result;

  const maybeMiddle = nameTokens[nameTokens.length - 2] || '';
  if (/^[A-Za-z]\.?$/.test(maybeMiddle)) {
    result.middle_initial = maybeMiddle[0].toUpperCase();
    nameTokens.splice(nameTokens.length - 2, 1);
  }

  result.first_name = nameTokens[0] || '';
  result.last_name = nameTokens[nameTokens.length - 1] || '';
  result.second_name = nameTokens.slice(1, -1).join(' ');

  if (!result.second_name) {
    result.second_name = result.last_name;
  }

  return result;
}

function saveAuthContext(result, role, identityInput) {
  const profile = result?.profile || {};
  const resolvedRole = String(profile.role || role || 'employee').toLowerCase();
  const fullName = String(profile.full_name || '').trim() || inferNameFromIdentity(profile.email || identityInput);

  const context = {
    role: resolvedRole,
    full_name: fullName,
    email: String(profile.email || '').trim(),
    employee_id: String(profile.employee_id || '').trim(),
    employee_type: String(profile.employee_type || '').trim(),
    position: String(profile.position || '').trim(),
    address: String(profile.address || '').trim(),
    sss_number: String(profile.sss_number || '').trim(),
    pagibig_number: String(profile.pagibig_number || '').trim(),
    philhealth_number: String(profile.philhealth_number || '').trim(),
    tin_number: String(profile.tin_number || '').trim(),
    bank_name: String(profile.bank_name || '').trim(),
    bank_account_number: String(profile.bank_account_number || '').trim(),
    cp_number: String(profile.cp_number || '').trim(),
    date_hired: String(profile.date_hired || '').trim(),
    date_of_birth: String(profile.date_of_birth || '').trim(),
    sex: String(profile.sex || '').trim(),
    civil_status: String(profile.civil_status || '').trim(),
    employment_type: String(profile.employment_type || '').trim(),
    employment_status: String(profile.employment_status || '').trim(),
    branch_id: profile.branch_id || null,
    // Display hint only: the signed session cookie is what actually boxes the
    // account into the change-password screen (src/proxy.js).
    must_change_password: result?.must_change_password === true || profile.must_change_password === true,
  };

  localStorage.setItem(AUTH_CONTEXT_KEY, JSON.stringify(context));
  dispatchAuthContextChanged(context);
}

function setMustChangePasswordFlag(value) {
  const ctx = getAuthContext();
  if (!ctx) return;
  ctx.must_change_password = Boolean(value);
  localStorage.setItem(AUTH_CONTEXT_KEY, JSON.stringify(ctx));
}

function getAuthContext() {
  try {
    const raw = localStorage.getItem(AUTH_CONTEXT_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getRolePageStateKey(role) {
  return `${ROLE_PAGE_STATE_PREFIX}${String(role || '').trim().toLowerCase()}`;
}

function persistRolePageState(role, pageId) {
  const normalizedRole = String(role || '').trim().toLowerCase();
  const normalizedPage = String(pageId || '').trim();
  if (!normalizedRole || !normalizedPage) return;

  localStorage.setItem(getRolePageStateKey(normalizedRole), normalizedPage);

  const params = new URLSearchParams(window.location.search);
  if (params.get('role') === normalizedRole) {
    params.set('page', normalizedPage);
    const next = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, '', next);
  }
}

function getPersistedRolePageState(role) {
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (!normalizedRole) return '';

  const params = new URLSearchParams(window.location.search);
  if (params.get('role') === normalizedRole) {
    const fromUrl = String(params.get('page') || '').trim();
    if (fromUrl) return fromUrl;
  }

  return String(localStorage.getItem(getRolePageStateKey(normalizedRole)) || '').trim();
}

function clearPersistedRolePageStates() {
  ['super_admin', 'admin', 'accountant', 'employee', 'hr'].forEach((role) => {
    localStorage.removeItem(getRolePageStateKey(role));
  });
}

function ensureConfirmDialog() {
  let backdrop = document.getElementById('legacy-confirm-backdrop');
  if (backdrop) return backdrop;

  backdrop = document.createElement('div');
  backdrop.id = 'legacy-confirm-backdrop';
  backdrop.className = 'confirm-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.innerHTML = `
    <div class="confirm-card card" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div class="confirm-header">
        <div class="confirm-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
        </div>
        <div class="confirm-title" id="confirm-title">Warning</div>
      </div>
      <div class="confirm-body" id="confirm-body"></div>
      <div class="confirm-actions">
        <button type="button" class="btn btn-outline" id="confirm-cancel-btn">Cancel</button>
        <button type="button" class="btn btn-primary btn-red" id="confirm-ok-btn">Continue</button>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);
  return backdrop;
}

async function confirmDestructiveAction(actionLabel, detailText) {
  const action = String(actionLabel || 'this action').trim();
  const detail = String(detailText || '').trim();
  const backdrop = ensureConfirmDialog();
  const body = backdrop.querySelector('#confirm-body');
  const okButton = backdrop.querySelector('#confirm-ok-btn');
  const cancelButton = backdrop.querySelector('#confirm-cancel-btn');

  if (!body || !okButton || !cancelButton) {
    return window.confirm(`WARNING: You are about to ${action}. Continue?`);
  }

  body.innerHTML = `
    <p>You are about to <strong style="color:var(--t1);">${escapeHtml(action)}</strong>.</p>
    ${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
  `;

  backdrop.classList.add('active');
  backdrop.setAttribute('aria-hidden', 'false');

  return new Promise((resolve) => {
    const cleanup = (result) => {
      backdrop.classList.remove('active');
      backdrop.setAttribute('aria-hidden', 'true');

      okButton.removeEventListener('click', onOk);
      cancelButton.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onEsc);

      resolve(result);
    };

    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (event) => {
      if (event.target === backdrop) cleanup(false);
    };
    const onEsc = (event) => {
      if (event.key === 'Escape') cleanup(false);
    };

    okButton.addEventListener('click', onOk, { once: true });
    cancelButton.addEventListener('click', onCancel, { once: true });
    backdrop.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onEsc);
  });
}

/* ── SETTINGS MODAL ── */
function populateSettingsModalProfile(prefix) {
  const ctx = getAuthContext();
  if (!ctx) return;
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };

  // Only a single composed full_name is stored — split it back into parts
  // so Name starts pre-filled with something reasonable. splitFullName()
  // is defined in admin.js, loaded before any of this runs.
  const nameParts = typeof splitFullName === 'function' ? splitFullName(ctx.full_name || '') : {};
  const midName = nameParts.middle_initial
    || (nameParts.second_name && nameParts.second_name !== nameParts.last_name ? nameParts.second_name : '');
  setVal(`${prefix}-edit-firstname`,  nameParts.first_name);
  setVal(`${prefix}-edit-middlename`, midName);
  setVal(`${prefix}-edit-lastname`,   nameParts.last_name);
  setVal(`${prefix}-edit-suffix`,     nameParts.suffix);

  // Only the employee portal's settings modal has an address/contact-number
  // field — other roles' own profiles don't display or edit these.
  setVal(`${prefix}-edit-address`,     ctx.address);
  setVal(`${prefix}-edit-bankname`,    ctx.bank_name);
  setVal(`${prefix}-edit-bankaccount`, ctx.bank_account_number);

  const cpInput = document.getElementById(`${prefix}-edit-cpnumber`);
  if (cpInput) {
    setFormattedDigitValue(cpInput, ctx.cp_number, DIGIT_FIELD_SPECS.cp_number.groups, DIGIT_FIELD_SPECS.cp_number.separator);
    bindDigitInput(cpInput, DIGIT_FIELD_SPECS.cp_number);
  }
}

async function saveProfileInfo(prefix) {
  const ctx = getAuthContext();
  const email = String(ctx?.email || '').trim();
  const feedbackEl = document.getElementById(`${prefix}-profile-feedback`);

  if (!email) {
    if (feedbackEl) { feedbackEl.textContent = 'Unable to identify account. Please sign in again.'; feedbackEl.className = 'adm-feedback err'; }
    return;
  }

  const first_name  = String(document.getElementById(`${prefix}-edit-firstname`)?.value  || '').trim();
  const middle_name = String(document.getElementById(`${prefix}-edit-middlename`)?.value || '').trim();
  const last_name   = String(document.getElementById(`${prefix}-edit-lastname`)?.value   || '').trim();
  const suffix      = String(document.getElementById(`${prefix}-edit-suffix`)?.value     || '').trim();
  const bank_name        = String(document.getElementById(`${prefix}-edit-bankname`)?.value     || '').trim();
  const bank_account_number = String(document.getElementById(`${prefix}-edit-bankaccount`)?.value || '').trim();
  // Address is only present in the employee portal's modal — other roles
  // have no such field, so leave it out of their payload entirely rather
  // than sending an empty string that would wipe out any address already
  // on file for that account.
  const addressEl = document.getElementById(`${prefix}-edit-address`);
  const address = addressEl ? String(addressEl.value || '').trim() : undefined;

  // Same story as address: only the employee portal's modal has this field.
  const cpNumberEl = document.getElementById(`${prefix}-edit-cpnumber`);
  const cp_number = cpNumberEl ? digitsOnly(cpNumberEl.value) : undefined;

  if (!first_name || !last_name) {
    if (feedbackEl) { feedbackEl.textContent = 'First and last name are required.'; feedbackEl.className = 'adm-feedback err'; }
    return;
  }
  if (!/^[A-Za-z\s]+$/.test(first_name)) {
    if (feedbackEl) { feedbackEl.textContent = 'First name must contain only letters.'; feedbackEl.className = 'adm-feedback err'; }
    return;
  }
  if (!/^[A-Za-z\s]+$/.test(last_name)) {
    if (feedbackEl) { feedbackEl.textContent = 'Last name must contain only letters.'; feedbackEl.className = 'adm-feedback err'; }
    return;
  }
  if (middle_name && !/^[A-Za-z\s]+$/.test(middle_name)) {
    if (feedbackEl) { feedbackEl.textContent = 'Middle name must contain only letters.'; feedbackEl.className = 'adm-feedback err'; }
    return;
  }

  const full_name = typeof composeFullName === 'function'
    ? composeFullName({ first_name, middle_initial: middle_name, last_name, suffix })
    : [first_name, middle_name, last_name, suffix].filter(Boolean).join(' ');

  if (feedbackEl) { feedbackEl.textContent = 'Saving...'; feedbackEl.className = 'adm-feedback loading'; }

  try {
    const payload = { email, full_name, bank_name, bank_account_number };
    if (address !== undefined) payload.address = address;
    if (cp_number !== undefined) payload.cp_number = cp_number;

    const response = await fetch('/api/legacy-auth/update-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Failed to update profile.');

    // Reflect what the server actually stored, not just what was submitted —
    // e.g. an employee's bank fields are ignored server-side, so trusting
    // the submitted values here would show a change that didn't happen.
    const savedProfile = result.profile || {};
    const updatedCtx = {
      ...ctx,
      full_name,
      bank_name: savedProfile.bank_name ?? bank_name,
      bank_account_number: savedProfile.bank_account_number ?? bank_account_number,
    };
    if (address !== undefined) updatedCtx.address = savedProfile.address ?? address;
    if (cp_number !== undefined) updatedCtx.cp_number = savedProfile.cp_number ?? cp_number;
    localStorage.setItem(AUTH_CONTEXT_KEY, JSON.stringify(updatedCtx));
    dispatchAuthContextChanged(updatedCtx);

    if (feedbackEl) { feedbackEl.textContent = 'Profile updated successfully.'; feedbackEl.className = 'adm-feedback ok'; }
    pushNotification('Profile Updated', 'Your information has been saved.', 'success');

    setTimeout(() => {
      if (feedbackEl && feedbackEl.textContent.includes('successfully')) {
        feedbackEl.textContent = '';
        feedbackEl.className = 'adm-feedback';
      }
    }, 3000);
  } catch (error) {
    if (feedbackEl) { feedbackEl.textContent = error.message; feedbackEl.className = 'adm-feedback err'; }
  }
}

// `section` picks which view of the modal shows: 'password' (the gear-icon
// Settings shortcut — just Change Password) or 'profile' (the Profile
// page's Edit Account button — Personal Information/Bank only, no
// password). Only portals with both `${prefix}-settings-profile-section`
// and `${prefix}-settings-password-section` wrapper ids in their modal
// markup actually split; portals without them (e.g. admin, which has only
// one entry point) show the same combined content regardless of `section`.
function openSettingsModal(prefix, section = 'password') {
  const modal = document.getElementById(`${prefix}-settings-modal`);
  if (!modal) return;

  const profileSection = document.getElementById(`${prefix}-settings-profile-section`);
  const passwordSection = document.getElementById(`${prefix}-settings-password-section`);
  if (profileSection) profileSection.hidden = section !== 'profile';
  if (passwordSection) passwordSection.hidden = section === 'profile';

  const titleEl = document.getElementById(`${prefix}-settings-title`);
  if (titleEl && profileSection && passwordSection) {
    titleEl.textContent = section === 'profile' ? 'Edit Account' : 'Account Settings';
  }

  populateSettingsModalProfile(prefix);
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');

  if (!modal._escBound) {
    modal._escBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('active')) closeSettingsModal(prefix);
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeSettingsModal(prefix);
    });
  }
}

function closeSettingsModal(prefix) {
  const modal = document.getElementById(`${prefix}-settings-modal`);
  if (!modal) return;
  modal.classList.remove('active');
  modal.setAttribute('aria-hidden', 'true');

  const feedback = document.getElementById(`${prefix}-change-password-feedback`);
  if (feedback) { feedback.textContent = ''; feedback.className = 'adm-feedback'; }

  const profileFeedback = document.getElementById(`${prefix}-profile-feedback`);
  if (profileFeedback) { profileFeedback.textContent = ''; profileFeedback.className = 'adm-feedback'; }
}

function ensureApproveDialog() {
  let backdrop = document.getElementById('legacy-approve-backdrop');
  if (backdrop) return backdrop;

  backdrop = document.createElement('div');
  backdrop.id = 'legacy-approve-backdrop';
  backdrop.className = 'confirm-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.innerHTML = `
    <div class="confirm-card card" role="dialog" aria-modal="true" aria-labelledby="approve-title">
      <div class="confirm-header">
        <div class="confirm-icon confirm-icon-approve">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </div>
        <div class="confirm-title" id="approve-title">Confirm Approval</div>
      </div>
      <div class="confirm-body" id="approve-body"></div>
      <div class="confirm-actions">
        <button type="button" class="btn btn-outline" id="approve-cancel-btn">Cancel</button>
        <button type="button" class="btn btn-green" id="approve-ok-btn">Approve</button>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);
  return backdrop;
}

// options: { title, confirmLabel } — lets non-approval positive actions (e.g.
// restoring a user) reuse this dialog without saying "Approve". The dialog
// element is created once and reused, so both are always set, not just when
// overridden, otherwise wording would leak from the previous call.
async function confirmApproveAction(actionLabel, detailText, options = {}) {
  const action = String(actionLabel || 'this action').trim();
  const detail = String(detailText || '').trim();
  const title = String(options.title || 'Confirm Approval').trim();
  const confirmLabel = String(options.confirmLabel || 'Approve').trim();
  const backdrop = ensureApproveDialog();
  const body = backdrop.querySelector('#approve-body');
  const okButton = backdrop.querySelector('#approve-ok-btn');
  const cancelButton = backdrop.querySelector('#approve-cancel-btn');
  const titleEl = backdrop.querySelector('#approve-title');

  if (!body || !okButton || !cancelButton) {
    return window.confirm(`Confirm: You are about to ${action}. Continue?`);
  }

  if (titleEl) titleEl.textContent = title;
  okButton.textContent = confirmLabel;

  body.innerHTML = `
    <p>You are about to <strong style="color:var(--t1);">${escapeHtml(action)}</strong>.</p>
    ${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
  `;

  backdrop.classList.add('active');
  backdrop.setAttribute('aria-hidden', 'false');

  return new Promise((resolve) => {
    const cleanup = (result) => {
      backdrop.classList.remove('active');
      backdrop.setAttribute('aria-hidden', 'true');

      okButton.removeEventListener('click', onOk);
      cancelButton.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onEsc);

      resolve(result);
    };

    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (event) => {
      if (event.target === backdrop) cleanup(false);
    };
    const onEsc = (event) => {
      if (event.key === 'Escape') cleanup(false);
    };

    okButton.addEventListener('click', onOk, { once: true });
    cancelButton.addEventListener('click', onCancel, { once: true });
    backdrop.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onEsc);
  });
}

/* ── GLOBAL SEARCH + NOTIFICATIONS ── */
let searchDebounceTimer = null;

function getActiveScreen() {
  return document.querySelector('.screen.active') || null;
}

function getRoleNameFromScreen(screen) {
  const id = screen?.id;
  if (id === 's-super-admin') return 'Super Administrator';
  if (id === 's-admin') return 'Administrator';
  if (id === 's-accountant') return 'Accountant';
  if (id === 's-emp') return 'Employee';
  if (id === 's-hr') return 'HR';
  return 'Portal';
}

function syncSearchInputs(value, sourceInput) {
  document.querySelectorAll('.global-search-input').forEach((input) => {
    if (sourceInput && input === sourceInput) return;
    input.value = value;
  });
}

function updateSearchContainerState(input, state, term = '') {
  const container = input?.closest('.tb-search');
  if (!container) return;

  container.classList.remove('search-hit', 'search-miss');

  if (!term) {
    input.title = '';
    return;
  }

  if (state === 'hit') {
    container.classList.add('search-hit');
    input.title = `Search hit for "${term}"`;
    return;
  }

  container.classList.add('search-miss');
  input.title = `No match for "${term}"`;
}

function performGlobalSearch(term, forward = true) {
  const query = String(term || '').trim();
  if (!query) return true;

  if (typeof window.find !== 'function') {
    return false;
  }

  return Boolean(window.find(query, false, !forward, true, false, false, false));
}

function runSearchFromInput(input, forward = true) {
  const term = String(input?.value || '').trim();
  if (!term) {
    updateSearchContainerState(input, '', '');
    return;
  }

  const found = performGlobalSearch(term, forward);
  updateSearchContainerState(input, found ? 'hit' : 'miss', term);

  document.querySelectorAll('.global-search-input').forEach((otherInput) => {
    if (otherInput === input) return;
    updateSearchContainerState(otherInput, found ? 'hit' : 'miss', term);
  });
}

function attachGlobalSearchHandlers() {
  document.querySelectorAll('.global-search-input').forEach((input) => {
    if (input.dataset.searchBound === 'true') return;
    input.dataset.searchBound = 'true';

    input.addEventListener('input', () => {
      const term = String(input.value || '');
      syncSearchInputs(term, input);

      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
      }

      searchDebounceTimer = setTimeout(() => {
        runSearchFromInput(input, true);
      }, 120);
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runSearchFromInput(input, !event.shiftKey);
      }

      if (event.key === 'Escape') {
        input.value = '';
        syncSearchInputs('', input);
        runSearchFromInput(input, true);
      }
    });
  });

  document.querySelectorAll('.tb-search').forEach((container) => {
    if (container.dataset.searchContainerBound === 'true') return;
    container.dataset.searchContainerBound = 'true';

    const icon = container.querySelector('.search-ic');
    const input = container.querySelector('.global-search-input');
    if (!icon || !input) return;

    icon.style.cursor = 'pointer';
    icon.addEventListener('click', () => {
      runSearchFromInput(input, true);
      input.focus();
    });
  });
}

/* ── TOAST + NOTIFICATION HISTORY ── */
const notificationHistory = [];
let unreadNotificationCount = 0;

function notifEscape(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatNotifTime(date) {
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}

function showToast(title, desc, type) {
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }

  const iconMap = {
    success: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    info:    `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`,
    error:   `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type || 'success'}`;
  toast.innerHTML = `
    <div class="toast-icon">${iconMap[type] || iconMap.success}</div>
    <div class="toast-text">
      <div class="toast-title"></div>
      ${desc ? '<div class="toast-desc"></div>' : ''}
    </div>
    <button class="toast-close" aria-label="Dismiss">×</button>
  `;
  toast.querySelector('.toast-title').textContent = title;
  if (desc) toast.querySelector('.toast-desc').textContent = desc;

  toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));
  stack.appendChild(toast);

  const timer = setTimeout(() => dismissToast(toast), 4500);
  toast._dismissTimer = timer;
}

function dismissToast(toast) {
  if (toast._dismissed) return;
  toast._dismissed = true;
  clearTimeout(toast._dismissTimer);
  toast.classList.add('toast-out');
  setTimeout(() => toast.remove(), 350);
}

function updateNotificationDot() {
  document.querySelectorAll('.global-notification-trigger .nd').forEach((dot) => {
    dot.style.display = unreadNotificationCount > 0 ? '' : 'none';
  });
}

function pushNotification(title, desc, type) {
  const safeType = type || 'success';
  notificationHistory.unshift({ title: String(title || ''), desc: String(desc || ''), type: safeType, time: new Date(), unread: true });
  if (notificationHistory.length > 30) notificationHistory.length = 30;

  unreadNotificationCount++;
  updateNotificationDot();
  showToast(title, desc, safeType);

  const panel = document.getElementById('global-notification-panel');
  if (panel?.classList.contains('active')) renderNotificationPanel();
}

function getRoleNotifications() {
  const screenId = getActiveScreen()?.id;

  if (screenId === 's-super-admin') {
    const users = Number(document.getElementById('sa-dash-users')?.textContent || 0);
    const dbStatus = String(document.getElementById('sa-dash-status')?.textContent || 'Online');

    return [
      {
        title: `System Status: ${dbStatus}`,
        desc: 'All services are being monitored centrally.',
      },
      {
        title: users > 0 ? `${users} users registered system-wide` : 'User data loading…',
        desc: 'Go to Roles & Permissions to manage user accounts.',
      },
    ];
  }

  if (screenId === 's-admin') {
    const absentToday = Number(document.getElementById('adm-panel-absent-today')?.textContent || 0);
    const totalEmployees = Number(document.getElementById('adm-panel-total-employees')?.textContent || 0);

    return [
      {
        title: absentToday > 0 ? `${absentToday} employee${absentToday > 1 ? 's' : ''} absent today` : 'Full attendance today',
        desc: 'Open Attendance to review today\'s records.',
      },
      {
        title: `${totalEmployees || 0} active employees loaded`,
        desc: 'Manage Employees has the current staff list and status.',
      },
    ];
  }

  if (screenId === 's-accountant') {
    const pending = Number(document.getElementById('ac-pending-count')?.textContent || 0);
    const period = String(document.getElementById('pc-period')?.value || 'Current period');

    return [
      {
        title: pending > 0 ? `${pending} payroll submissions are pending` : 'No pending payroll submissions',
        desc: pending > 0
          ? 'Submitted payroll is locked while waiting for admin approval.'
          : 'You can prepare and send payroll drafts for approval.',
      },
      {
        title: `Current pay period: ${period}`,
        desc: 'Use Process Payroll to compute and submit payroll entries.',
      },
    ];
  }

  if (screenId === 's-hr') {
    const pending = Number(document.getElementById('hr-dash-pending-leaves')?.textContent || 0);
    const total = Number(document.getElementById('hr-dash-total-employees')?.textContent || 0);

    return [
      {
        title: pending > 0 ? `${pending} leave request${pending > 1 ? 's' : ''} pending approval` : 'No pending leave requests',
        desc: pending > 0
          ? 'Open Leave Approval to review and approve pending requests.'
          : 'All leave requests have been processed.',
      },
      {
        title: `${total || 0} employees on record`,
        desc: 'Use Employee Records to view and update staff information.',
      },
    ];
  }

  if (screenId === 's-emp') {
    const present = String(document.getElementById('emp-stat-present')?.textContent || '').trim();
    const late    = String(document.getElementById('emp-stat-late')?.textContent    || '').trim();
    const absent  = String(document.getElementById('emp-stat-absent')?.textContent  || '').trim();
    const salary  = String(document.getElementById('emp-stat-netpay')?.textContent  || '').trim();

    const hasStats = present && present !== '—';
    const leaveItems = document.querySelectorAll('#emp-leave-list > div[style*="border"]');
    const pendingLeaves = Array.from(leaveItems).filter(el =>
      el.querySelector('.badge.ba')
    ).length;

    return [
      {
        title: hasStats
          ? `This month: ${present} present · ${late} late · ${absent} absent`
          : 'Attendance data loading…',
        desc: salary && salary !== '—'
          ? `Basic salary: ${salary}`
          : 'Attendance is tracked via RFID tap.',
      },
      {
        title: pendingLeaves > 0
          ? `${pendingLeaves} leave request${pendingLeaves > 1 ? 's' : ''} pending approval`
          : 'No pending leave requests',
        desc: 'Submit a leave request from the Leave Request form below.',
      },
    ];
  }

  return [
    {
      title: 'No notifications right now',
      desc: 'Switch to a role page to view current updates.',
    },
  ];
}

function ensureNotificationPanel() {
  let panel = document.getElementById('global-notification-panel');
  if (panel) return panel;

  panel = document.createElement('div');
  panel.id = 'global-notification-panel';
  panel.className = 'notif-panel';
  panel.innerHTML = `
    <div class="notif-head">
      <div class="notif-title">Notifications</div>
      <div class="notif-sub" id="global-notif-sub">Portal</div>
    </div>
    <div class="notif-list" id="global-notif-list"></div>
  `;

  document.body.appendChild(panel);
  return panel;
}

function renderNotificationPanel() {
  const panel = ensureNotificationPanel();
  const list = panel.querySelector('#global-notif-list');
  const sub = panel.querySelector('#global-notif-sub');
  if (!list || !sub) return;

  sub.textContent = getRoleNameFromScreen(getActiveScreen());

  let html = '';

  if (notificationHistory.length > 0) {
    html += '<div class="notif-section-label">Recent Activity</div>';
    html += notificationHistory.map((item) => `
      <div class="notif-item${item.unread ? ' notif-unread' : ''}">
        <div class="notif-item-row">
          <div class="notif-item-dot notif-dot-${notifEscape(item.type)}"></div>
          <div class="notif-item-title">${notifEscape(item.title)}</div>
          <div class="notif-item-time">${formatNotifTime(item.time)}</div>
        </div>
        ${item.desc ? `<div class="notif-item-desc">${notifEscape(item.desc)}</div>` : ''}
      </div>
    `).join('');
    html += '<div class="notif-section-label">Status</div>';
  }

  // These are assembled from on-screen text (a pay period label, a status
  // cell), so they are escaped like the history items above.
  const roleItems = getRoleNotifications();
  html += roleItems.map((item) => `
    <div class="notif-item">
      <div class="notif-item-title">${notifEscape(item.title)}</div>
      <div class="notif-item-desc">${notifEscape(item.desc)}</div>
    </div>
  `).join('');

  list.innerHTML = html;
}

function closeNotificationPanel() {
  const panel = document.getElementById('global-notification-panel');
  if (!panel) return;
  panel.classList.remove('active');
}

function refreshCurrentPortal() {
  if (typeof window.getPersistedRolePageState === 'function') {
    const currentRole = new URLSearchParams(window.location.search).get('role');
    if (currentRole) {
      const pageId = window.getPersistedRolePageState(currentRole);
      
      if (currentRole === 'admin' && typeof adminNav === 'function' && pageId) {
        const navEl = document.querySelector(`#s-admin .ni[onclick*="${pageId}"]`);
        adminNav(pageId, navEl);
        return;
      }
      if (currentRole === 'accountant' && typeof acctNav === 'function' && pageId) {
        const navEl = document.querySelector(`#s-accountant .ni[onclick*="${pageId}"]`);
        acctNav(pageId, navEl);
        return;
      }
      if (currentRole === 'employee') {
        if (typeof applyEmployeeIdentity === 'function') applyEmployeeIdentity();
        if (typeof renderPayslipOptions === 'function') renderPayslipOptions();
        if (typeof loadMyLeaveRequests === 'function') loadMyLeaveRequests();
        // renderPayslipOptions() is the accountant portal's — the employee
        // portal's payslips and attendance tiles load through these two.
        if (typeof loadPayslips === 'function') loadPayslips();
        if (typeof loadEmployeeStats === 'function') loadEmployeeStats();
        return;
      }
      if (currentRole === 'hr' && typeof hrNav === 'function' && pageId) {
        const navEl = document.querySelector(`#s-hr .ni[onclick*="${pageId}"]`);
        hrNav(pageId, navEl);
        return;
      }
      if (currentRole === 'super_admin' && typeof saNav === 'function' && pageId) {
        const navEl = document.querySelector(`#s-super-admin .ni[onclick*="${pageId}"]`);
        saNav(pageId, navEl);
        return;
      }
    }
  }

  // Fallback
  window.location.reload();
}

function toggleNotificationPanel(trigger) {
  const panel = ensureNotificationPanel();
  renderNotificationPanel();

  const isOpen = panel.classList.contains('active');
  if (isOpen) {
    closeNotificationPanel();
    return;
  }

  const rect = trigger.getBoundingClientRect();
  panel.style.top = `${Math.max(12, Math.round(rect.bottom + 8))}px`;
  panel.style.right = `${Math.max(12, Math.round(window.innerWidth - rect.right))}px`;
  panel.classList.add('active');

  notificationHistory.forEach((item) => { item.unread = false; });
  unreadNotificationCount = 0;
  updateNotificationDot();
}

function attachNotificationHandlers() {
  document.querySelectorAll('.global-notification-trigger').forEach((button) => {
    if (button.dataset.notifBound === 'true') return;
    button.dataset.notifBound = 'true';

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleNotificationPanel(button);
    });
  });

  if (document.body.dataset.notifGlobalBound === 'true') return;
  document.body.dataset.notifGlobalBound = 'true';

  document.addEventListener('click', (event) => {
    const panel = document.getElementById('global-notification-panel');
    if (!panel || !panel.classList.contains('active')) return;

    if (panel.contains(event.target)) return;
    if (event.target.closest('.global-notification-trigger')) return;
    closeNotificationPanel();
  });
}

function openProofDocument(proofUrl) {
  const url = String(proofUrl || '').trim();
  if (!url) {
    showProofError('No proof document attached to this request.');
    return;
  }

  // Remove any existing viewer
  const existing = document.getElementById('proof-viewer-overlay');
  if (existing) existing.remove();

  const isDataUrl = url.startsWith('data:');
  const mime = isDataUrl ? url.slice(5, Math.max(url.indexOf(';'), url.indexOf(','))).replace(/[;,].*/, '') : '';
  const isImage = isDataUrl ? mime.startsWith('image/') : /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(url);
  const isPdf   = (isDataUrl && mime === 'application/pdf') || /\.pdf$/i.test(url);

  const overlay = document.createElement('div');
  overlay.id = 'proof-viewer-overlay';
  overlay.style.cssText = [
    'position:fixed;inset:0;z-index:99999;',
    'background:rgba(11,15,20,.93);',
    'display:flex;flex-direction:column;',
    'animation:proofFadeIn .15s ease;',
  ].join('');

  // Inject keyframe once
  if (!document.getElementById('proof-viewer-style')) {
    const s = document.createElement('style');
    s.id = 'proof-viewer-style';
    s.textContent = '@keyframes proofFadeIn{from{opacity:0}to{opacity:1}}';
    document.head.appendChild(s);
  }

  // Data URLs only contain base64-safe chars; plain URLs don't need HTML-escaping here.
  const safeUrl = url;

  overlay.innerHTML = `
    <div style="padding:10px 16px;display:flex;align-items:center;justify-content:space-between;
                border-bottom:1px solid rgba(255,255,255,.12);flex-shrink:0;gap:12px;">
      <span style="color:#e6eef8;font-size:13px;font-weight:600;">Proof Document</span>
      <div style="display:flex;gap:10px;align-items:center;">
        <a id="proof-dl-link" href="${safeUrl}" download="proof-document"
           style="color:#60a5fa;font-size:12px;text-decoration:underline;cursor:pointer;">
          ⬇ Download
        </a>
        <button id="proof-close-btn"
          style="background:#ef4444;border:none;color:#fff;padding:5px 14px;
                 border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">
          ✕ Close
        </button>
      </div>
    </div>
    <div id="proof-viewer-body"
         style="flex:1;display:flex;align-items:center;justify-content:center;
                overflow:auto;padding:${(isPdf || (!isImage && isDataUrl)) ? '0' : '20px'};"></div>
  `;

  document.body.appendChild(overlay);

  const body = document.getElementById('proof-viewer-body');

  if (isImage) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'Proof Document';
    img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;box-shadow:0 4px 32px rgba(0,0,0,.6);';
    body.appendChild(img);
  } else if (isPdf || isDataUrl) {
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.title = 'Proof Document';
    frame.style.cssText = 'width:100%;height:100%;border:none;';
    body.appendChild(frame);
  } else {
    body.innerHTML = `
      <div style="color:#e6eef8;text-align:center;font-family:system-ui,sans-serif;padding:32px;">
        <div style="font-size:48px;margin-bottom:16px;">📎</div>
        <div style="margin-bottom:12px;">This file type cannot be previewed inline.</div>
        <a href="${safeUrl}" download
           style="color:#60a5fa;text-decoration:underline;font-size:14px;">Download the file</a>
      </div>`;
  }

  function closeViewer() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) { if (e.key === 'Escape') closeViewer(); }

  document.getElementById('proof-close-btn').addEventListener('click', closeViewer);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeViewer(); });
  document.addEventListener('keydown', onKey);
}

function showProofError(message) {
  const banner = document.createElement('div');
  banner.style.cssText = [
    'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);',
    'background:#1e293b;border:1px solid #475569;border-radius:8px;',
    'color:#e6eef8;padding:12px 20px;font-size:13px;z-index:99999;',
    'box-shadow:0 4px 16px rgba(0,0,0,.4);',
  ].join('');
  banner.textContent = message;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 4000);
}

/* ── GLOBAL SCROLL HELPERS ── */
function isScrollableElement(element) {
  if (!element) return false;
  const styles = window.getComputedStyle(element);
  const allowsScroll = styles.overflowY === 'auto' || styles.overflowY === 'scroll';
  return allowsScroll && element.scrollHeight > element.clientHeight;
}

function getActiveScrollContainer() {
  const activeScreen = document.querySelector('.screen.active');
  if (!activeScreen) {
    return document.scrollingElement || document.documentElement;
  }

  const activePage = activeScreen.querySelector('.page.active');
  if (activePage) return activePage;

  const employeeBody = activeScreen.querySelector('.emp-body');
  if (employeeBody) return employeeBody;

  const mainArea = activeScreen.querySelector('.main');
  if (mainArea) return mainArea;

  if (isScrollableElement(activeScreen)) return activeScreen;

  if (activePage) return activePage;

  return document.scrollingElement || document.documentElement;
}

function scrollWebsite(direction = 'down', amount = 320) {
  const target = getActiveScrollContainer();
  const delta = direction === 'up' ? -Math.abs(amount) : Math.abs(amount);

  target.scrollBy({
    top: delta,
    behavior: 'smooth',
  });
}

function scrollWebsiteTo(position = 'top') {
  const target = getActiveScrollContainer();
  const top = position === 'bottom' ? target.scrollHeight : 0;

  target.scrollTo({
    top,
    behavior: 'smooth',
  });
}

/* ── RESET PASSWORD (LOGIN PAGE) ── */
function openResetPasswordModal() {
  const modal = document.getElementById('reset-password-modal');
  const input = document.getElementById('reset-identity-input');
  const feedback = document.getElementById('reset-password-feedback');
  const btn = document.getElementById('reset-submit-btn');

  if (!modal) return;

  if (input) input.value = '';
  if (feedback) { feedback.textContent = ''; feedback.style.color = ''; }
  if (btn) { btn.textContent = 'Send Reset Link'; btn.disabled = false; }

  modal.style.display = 'flex';
}

function closeResetPasswordModal() {
  const modal = document.getElementById('reset-password-modal');
  if (modal) modal.style.display = 'none';
}

async function submitResetPassword() {
  const input = document.getElementById('reset-identity-input');
  const feedback = document.getElementById('reset-password-feedback');
  const btn = document.getElementById('reset-submit-btn');

  const identity = String(input?.value || '').trim();

  if (!identity) {
    if (feedback) {
      feedback.textContent = 'Enter your Employee ID or email address.';
      feedback.style.color = '#E85555';
    }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
  if (feedback) { feedback.textContent = ''; feedback.style.color = ''; }

  try {
    const response = await fetch('/api/legacy-auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity }),
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result.error || 'Failed to send reset link.');
    }

    if (feedback) {
      feedback.textContent = result.message || 'Reset link sent. Check your registered email address.';
      feedback.style.color = '#3EC97A';
    }
    if (btn) { btn.textContent = 'Sent'; }
    if (input) input.value = '';
  } catch (error) {
    if (feedback) {
      feedback.textContent = error.message;
      feedback.style.color = '#E85555';
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Send Reset Link'; }
  }
}

/* ── LOGIN ── */
function toggleLoginPasswordVisibility() {
  const input = document.getElementById('login-password-input');
  const btn = document.getElementById('login-password-toggle');
  if (!input) return;

  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  if (btn) {
    btn.textContent = isHidden ? 'Hide' : 'Show';
    btn.title = isHidden ? 'Hide password' : 'Show password';
    btn.setAttribute('aria-label', btn.title);
  }
}

// Set while a sign-in request is in flight. Enter on the page and a click on
// Sign In both call login(), so without this one keypress-plus-click sent two
// attempts — and a mistyped password then spent two of the account's five
// throttled attempts (src/lib/auth/login-throttle.js) instead of one.
let loginInFlight = false;

async function login() {
  if (loginInFlight) return;

  const usernameInput = document.getElementById('login-identity-input')?.value?.trim();
  const password = document.getElementById('login-password-input')?.value?.trim();

  if (!usernameInput || !password) {
    window.alert(`Enter your username or email and password to sign in.`);
    return;
  }

  const button = document.querySelector('#s-login .lb');
  const buttonLabel = button?.textContent;
  loginInFlight = true;
  if (button) { button.disabled = true; button.textContent = 'Signing in...'; }

  let navigating = false;
  try {
    const response = await fetch('/api/legacy-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: usernameInput, password }),
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.redirectTo) {
      window.alert(result.error || 'Unable to sign in.');
      return;
    }

    // result.role is sent from our updated API
    saveAuthContext(result, result.role || 'employee', usernameInput);

    navigating = true;
    window.top.location.href = result.redirectTo;
  } catch {
    window.alert('Unable to reach the server. Check your connection and try again.');
  } finally {
    // Leave the button in its "Signing in..." state while the portal loads,
    // so it cannot be pressed again between the redirect and the new page.
    if (!navigating) {
      loginInFlight = false;
      if (button) { button.disabled = false; button.textContent = buttonLabel || 'Sign In'; }
    }
  }
}

/* ── LOGOUT ── */
function logout() {
  localStorage.removeItem(AUTH_CONTEXT_KEY);
  clearPersistedRolePageStates();
  dispatchAuthContextChanged(null);

  const forcedRole = new URLSearchParams(window.location.search).get('role');
  if (forcedRole) {
    window.top.location.href = '/login';
    return;
  }

  ['s-super-admin', 's-admin', 's-accountant', 's-emp', 's-hr'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  document.getElementById('s-login').classList.add('active');
}

function showRoleScreen(role) {
  const screens = ['s-login', 's-super-admin', 's-admin', 's-accountant', 's-emp', 's-hr'];
  screens.forEach(id => document.getElementById(id)?.classList.remove('active'));

  if (role === 'super_admin') {
    document.getElementById('s-super-admin')?.classList.add('active');
  } else if (role === 'admin') {
    document.getElementById('s-admin')?.classList.add('active');
  } else if (role === 'accountant') {
    document.getElementById('s-accountant')?.classList.add('active');
  } else if (role === 'employee') {
    document.getElementById('s-emp')?.classList.add('active');
  } else if (role === 'hr') {
    document.getElementById('s-hr')?.classList.add('active');
  } else {
    document.getElementById('s-login')?.classList.add('active');
  }
}

/* ── SKELETON LOADING ── */
function skeletonRows(cols, count = 5) {
  const widths = [55, 80, 70, 90, 65, 75];
  const tds = Array.from({ length: cols }, (_, i) =>
    `<td><div class="sk-bar" style="width:${widths[i % widths.length]}%"></div></td>`
  ).join('');
  return Array.from({ length: count }, () => `<tr class="sk-row">${tds}</tr>`).join('');
}

function skeletonCards(count = 3) {
  return Array.from({ length: count }, () => `
    <div class="sk-card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px;">
        <div class="sk-bar" style="width:40%;height:13px;border-radius:5px;"></div>
        <div class="sk-bar" style="width:18%;height:13px;border-radius:10px;"></div>
      </div>
      <div class="sk-bar" style="width:60%;height:10px;margin-bottom:6px;"></div>
      <div class="sk-bar" style="width:85%;height:10px;margin-bottom:6px;"></div>
      <div class="sk-bar" style="width:35%;height:9px;"></div>
    </div>
  `).join('');
}

/**
 * Shared, stale-time-capped cache for /api/admin/branches, mirroring
 * listUsersCached() on the server (src/lib/auth/users-cache.js) — every
 * portal's branch-assign, transfer-requests, and employee tables were each
 * independently re-fetching the same rarely-changing list. Concurrent
 * callers share one in-flight request; a failed fetch is never cached.
 */
let __branchesCache = null;   // { branches, expiresAt }
let __branchesInFlight = null;
const BRANCHES_CACHE_TTL_MS = 60_000;

function invalidateBranchesCache() {
  __branchesCache = null;
  __branchesInFlight = null;
}

async function fetchBranchesCached({ activeOnly = true } = {}) {
  if (__branchesCache && __branchesCache.expiresAt > Date.now()) {
    return filterBranches(__branchesCache.branches, activeOnly);
  }

  if (!__branchesInFlight) {
    __branchesInFlight = fetch('/api/admin/branches')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('Failed to load branches.'))))
      .then((data) => {
        const branches = data.branches || [];
        __branchesCache = { branches, expiresAt: Date.now() + BRANCHES_CACHE_TTL_MS };
        return branches;
      })
      .catch((err) => {
        __branchesCache = null;
        throw err;
      })
      .finally(() => {
        __branchesInFlight = null;
      });
  }

  const branches = await __branchesInFlight;
  return filterBranches(branches, activeOnly);
}

function filterBranches(branches, activeOnly) {
  return activeOnly ? branches.filter((b) => b.status === 'Active') : branches;
}

/**
 * Same short-stale-time cache shape as fetchBranchesCached(), for
 * /api/admin/dashboard — clicking away to another sidebar page and back
 * was re-running the full dashboard aggregation every time. A short TTL
 * (payroll/attendance figures, not real-time data) keeps quick navigation
 * instant without showing meaningfully stale numbers.
 */
let __dashboardCache = null;
let __dashboardInFlight = null;
const DASHBOARD_CACHE_TTL_MS = 20_000;

function invalidateDashboardCache() {
  __dashboardCache = null;
  __dashboardInFlight = null;
}

async function fetchDashboardCached() {
  if (__dashboardCache && __dashboardCache.expiresAt > Date.now()) {
    return __dashboardCache.payload;
  }

  if (!__dashboardInFlight) {
    __dashboardInFlight = fetch('/api/admin/dashboard')
      .then(async (res) => {
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error || 'Failed to load dashboard data');
        __dashboardCache = { payload, expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS };
        return payload;
      })
      .catch((err) => {
        __dashboardCache = null;
        throw err;
      })
      .finally(() => {
        __dashboardInFlight = null;
      });
  }

  return __dashboardInFlight;
}

/**
 * Same short-stale-time cache shape as fetchDashboardCached(), for
 * /api/employee/stats. Two separate callers want this exact payload:
 * loadEmployeeStats() (dashboard tiles + calendar + today's log) and
 * loadAttendanceRecords() (the Attendance tab's table), which reads
 * `records`/`month_label` out of the very same response. Opening the
 * Attendance tab therefore re-ran the whole stats aggregation a second
 * time, and every trip back to that tab ran it again.
 *
 * Keyed by email because the URL varies per signed-in user; a different
 * email simply misses and re-fetches. Concurrent callers share one
 * in-flight request, and a failed fetch is never cached.
 */
let __empStatsCache = null;   // { email, payload, expiresAt }
let __empStatsInFlight = null;
let __empStatsInFlightEmail = '';
const EMP_STATS_CACHE_TTL_MS = 20_000;

async function fetchEmployeeStatsCached(email) {
  const key = String(email || '').trim();
  if (!key) throw new Error('Missing employee email.');

  if (__empStatsCache && __empStatsCache.email === key && __empStatsCache.expiresAt > Date.now()) {
    return __empStatsCache.payload;
  }

  if (!__empStatsInFlight || __empStatsInFlightEmail !== key) {
    __empStatsInFlightEmail = key;
    __empStatsInFlight = fetch(`/api/employee/stats?email=${encodeURIComponent(key)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to load attendance data.');
        const payload = await res.json();
        __empStatsCache = { email: key, payload, expiresAt: Date.now() + EMP_STATS_CACHE_TTL_MS };
        return payload;
      })
      .catch((err) => {
        __empStatsCache = null;
        throw err;
      })
      .finally(() => {
        __empStatsInFlight = null;
        __empStatsInFlightEmail = '';
      });
  }

  return __empStatsInFlight;
}

/**
 * Same short-stale-time cache shape as fetchDashboardCached(), for
 * /api/admin/attendance — the one payload behind both Admin's and Super
 * Admin's Attendance page (panels + the paginated log table). Leaving the
 * page and coming back re-ran the full day's tap collapse every time, so
 * the table sat on skeleton rows on every visit.
 *
 * Attendance is closer to live than the dashboard figures, so the window is
 * shorter — and both RFID scan handlers call invalidateAttendanceCache()
 * before reloading, so a scan is never masked by a cached response.
 */
let __attendanceCache = null;   // { payload, expiresAt }
let __attendanceInFlight = null;
const ATTENDANCE_CACHE_TTL_MS = 15_000;

function invalidateAttendanceCache() {
  __attendanceCache = null;
  __attendanceInFlight = null;
}

async function fetchAttendanceCached() {
  if (__attendanceCache && __attendanceCache.expiresAt > Date.now()) {
    return __attendanceCache.payload;
  }

  if (!__attendanceInFlight) {
    __attendanceInFlight = fetch('/api/admin/attendance')
      .then(async (res) => {
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error || 'Failed to load attendance data.');
        __attendanceCache = { payload, expiresAt: Date.now() + ATTENDANCE_CACHE_TTL_MS };
        return payload;
      })
      .catch((err) => {
        __attendanceCache = null;
        throw err;
      })
      .finally(() => {
        __attendanceInFlight = null;
      });
  }

  return __attendanceInFlight;
}

/**
 * Same short-stale-time cache shape as fetchDashboardCached(), for
 * /api/admin/system. This one payload backs four separate views — Super
 * Admin's Dashboard health rows, Backup page, and Maintenance RFID table,
 * plus Admin's own RFID table — so moving between them re-ran the same
 * database probe each time.
 *
 * Every RFID assign/void path calls invalidateSystemCache() before its
 * reload, so an edit is never masked by a cached response.
 */
let __systemCache = null;   // { payload, expiresAt }
let __systemInFlight = null;
const SYSTEM_CACHE_TTL_MS = 20_000;

function invalidateSystemCache() {
  __systemCache = null;
  __systemInFlight = null;
}

async function fetchSystemCached() {
  if (__systemCache && __systemCache.expiresAt > Date.now()) {
    return __systemCache.payload;
  }

  if (!__systemInFlight) {
    __systemInFlight = fetch('/api/admin/system')
      .then(async (res) => {
        const payload = await res.json();
        if (!res.ok) {
          // Tagged so a caller can tell a non-OK response apart from an
          // unreachable endpoint — loadSABackupStatus() reports them
          // differently.
          const err = new Error(payload.error || 'Failed to load system data');
          err.responseReceived = true;
          throw err;
        }
        __systemCache = { payload, expiresAt: Date.now() + SYSTEM_CACHE_TTL_MS };
        return payload;
      })
      .catch((err) => {
        __systemCache = null;
        throw err;
      })
      .finally(() => {
        __systemInFlight = null;
      });
  }

  return __systemInFlight;
}

/**
 * Numeric-only input handling for the government-ID / bank-account fields
 * (SSS, Pag-IBIG, PhilHealth, Bank Account Number) shared across Admin's and
 * HR's Add/Edit Employee forms. Stored values are always digits-only — the
 * dashes here are a display/input-mask concern, matching each field's
 * placeholder format (e.g. 12-3456789-0) and the DB CHECK constraint added in
 * supabase/migrations/20260914_profile_id_fields_and_perf.sql, which also
 * strips non-digits server-side as a second line of defense.
 */
function digitsOnly(value) {
  return String(value || '').replace(/\D+/g, '');
}

function formatDigitGroups(digits, groups, separator = '-') {
  if (!groups || !groups.length) return digits;
  let result = '';
  let pos = 0;
  for (let i = 0; i < groups.length && pos < digits.length; i++) {
    const chunk = digits.slice(pos, pos + groups[i]);
    if (!chunk) break;
    result += (i > 0 ? separator : '') + chunk;
    pos += groups[i];
  }
  return result;
}

const DIGIT_FIELD_SPECS = {
  sss_number: { maxLength: 10, groups: [2, 7, 1] },
  pagibig_number: { maxLength: 12, groups: [4, 4, 4] },
  philhealth_number: { maxLength: 12, groups: [2, 9, 1] },
  // BIR TIN: 9 digits, or 12 with the 3-digit branch code (123-456-789-000).
  tin_number: { maxLength: 12, groups: [3, 3, 3, 3] },
  bank_account_number: { maxLength: 20, groups: null },
  // PH mobile numbers are 11 digits (e.g. 0917 123 4567) — space-separated
  // to match this field's placeholder everywhere it appears, not the dash
  // style used by the government ID fields above.
  cp_number: { maxLength: 11, groups: [4, 3, 4], separator: ' ' },
};

function setFormattedDigitValue(input, rawValue, groups, separator) {
  if (!input) return;
  input.value = formatDigitGroups(digitsOnly(rawValue), groups, separator);
}

function bindDigitInput(input, { maxLength, groups, separator = '-' } = {}) {
  if (!input || input.dataset.digitBound === '1') return;
  input.dataset.digitBound = '1';
  input.setAttribute('inputmode', 'numeric');

  input.addEventListener('input', () => {
    const atEnd = input.selectionStart === input.value.length;
    input.value = formatDigitGroups(digitsOnly(input.value).slice(0, maxLength), groups, separator);
    if (atEnd) input.setSelectionRange(input.value.length, input.value.length);
  });

  // Blocks a non-digit keystroke from landing at all — the 'input' handler
  // above already strips it, but this avoids the visible flicker of a
  // rejected character appearing then disappearing.
  input.addEventListener('keypress', (e) => {
    if (e.key.length === 1 && !/[0-9]/.test(e.key)) e.preventDefault();
  });

  input.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text');
    input.value = formatDigitGroups(digitsOnly(text).slice(0, maxLength), groups, separator);
  });
}

/** Binds every known numeric ID field present in the given form. */
function bindDigitFieldsIn(form) {
  if (!form) return;
  Object.keys(DIGIT_FIELD_SPECS).forEach((name) => {
    const input = form.elements[name];
    if (input) bindDigitInput(input, DIGIT_FIELD_SPECS[name]);
  });
}

/** Populates every known numeric ID field from `source`, formatted per spec. */
function populateDigitFieldsIn(form, source) {
  if (!form || !source) return;
  Object.keys(DIGIT_FIELD_SPECS).forEach((name) => {
    const input = form.elements[name];
    const spec = DIGIT_FIELD_SPECS[name];
    if (input) setFormattedDigitValue(input, source[name], spec.groups, spec.separator);
  });
}

function attachSidebarSpotlight(sidebar) {
  if (!sidebar) return;

  // mousemove fires once per frame at best and several times per frame on a
  // 120Hz trackpad. Reading getBoundingClientRect() in that handler forced a
  // synchronous layout every time — and because the previous event had just
  // written --mx/--my, the layout it flushed was one this handler itself had
  // dirtied. Two fixes, both invisible to the user:
  //
  //   1. The rect only moves when the sidebar does, which mousemove cannot
  //      cause. Measure on enter and on resize, then reuse it.
  //   2. Collapse a burst of moves into one style write on the frame that is
  //      about to paint, instead of one write per event.
  let rect = null;
  let lastX = 0;
  let lastY = 0;
  let rafPending = false;

  const measure = () => { rect = sidebar.getBoundingClientRect(); };

  sidebar.addEventListener('mouseenter', measure, { passive: true });
  window.addEventListener('resize', () => { rect = null; }, { passive: true });

  sidebar.addEventListener('mousemove', (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!rect) measure();
      sidebar.style.setProperty('--mx', `${lastX - rect.left}px`);
      sidebar.style.setProperty('--my', `${lastY - rect.top}px`);
    });
  }, { passive: true });

  sidebar.addEventListener('mouseleave', () => {
    sidebar.style.removeProperty('--mx');
    sidebar.style.removeProperty('--my');
  }, { passive: true });
}

/* ── PAGINATION ── */
const _pgRegistry = {};

function createPaginator({ id, pageSize = 15, renderFn }) {
  const state = { data: [], currentPage: 1, pageSize };
  _pgRegistry[id] = state;

  function renderBar() {
    const bar = document.getElementById(`${id}-pg`);
    if (!bar) return;
    const total = state.data.length;
    const pages = Math.max(1, Math.ceil(total / state.pageSize));

    if (pages <= 1) {
      bar.innerHTML = '';
      return;
    }

    const cur = state.currentPage;
    let html = `<span class="pg-info">${total} records · page ${cur} of ${pages}</span>`;
    html += `<button ${cur === 1 ? 'disabled' : ''} onclick="paginatorGoTo('${id}',${cur - 1})">&#8249;</button>`;
    for (let p = 1; p <= pages; p++) {
      if (pages > 9 && p !== 1 && p !== pages && Math.abs(p - cur) > 2) {
        if (p === 2 || p === pages - 1) html += `<span class="pg-info">…</span>`;
        continue;
      }
      html += `<button class="${p === cur ? 'pg-active' : ''}" onclick="paginatorGoTo('${id}',${p})">${p}</button>`;
    }
    html += `<button ${cur === pages ? 'disabled' : ''} onclick="paginatorGoTo('${id}',${cur + 1})">&#8250;</button>`;
    bar.innerHTML = html;
  }

  function goToPage(page) {
    const pages = Math.max(1, Math.ceil(state.data.length / state.pageSize));
    state.currentPage = Math.min(Math.max(1, Number(page)), pages);
    const start = (state.currentPage - 1) * state.pageSize;
    renderFn(state.data.slice(start, start + state.pageSize));
    renderBar();
  }

  state._goToPage = goToPage;
  return {
    setData(data) {
      state.data = Array.isArray(data) ? data : [];
      goToPage(1);
    },
  };
}

function paginatorGoTo(id, page) {
  _pgRegistry[id]?._goToPage(Number(page));
}

/* ══════════════════════════════════════════════════════════════════════════
   PASSWORDS
   ══════════════════════════════════════════════════════════════════════════ */

const PASSWORD_MIN_LENGTH = 8;

// Mirrors src/lib/auth/password-policy.js so problems show while typing; the
// server applies the same rules and has the final say.
function lastNameCandidates(fullName) {
  const suffixes = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'v']);
  const tokens = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  while (tokens.length && suffixes.has(tokens[tokens.length - 1].toLowerCase())) tokens.pop();
  const candidates = [];
  for (let start = tokens.length - 1; start >= 1; start -= 1) {
    candidates.push(tokens.slice(start).join('').toLowerCase());
  }
  return candidates;
}

// Fixed symbol appended to the generated default password (see
// DEFAULT_PASSWORD_SYMBOL in src/lib/auth/password-policy.js) so it satisfies
// the Supabase project's "at least one symbol" requirement.
const DEFAULT_PASSWORD_SYMBOL = '!';

function looksLikeDefaultPassword(password, ctx) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ctx?.date_of_birth || ''));
  if (!match || !password) return false;
  const suffix = `${match[2]}${match[3]}${match[1]}${DEFAULT_PASSWORD_SYMBOL}`;
  if (!password.endsWith(suffix)) return false;
  const prefix = password.slice(0, -suffix.length).toLowerCase();
  return Boolean(prefix) && lastNameCandidates(ctx?.full_name).includes(prefix);
}

function evaluatePasswordRules(current, next, confirm, ctx) {
  return {
    length: next.length >= PASSWORD_MIN_LENGTH,
    mix: /[A-Za-z]/.test(next) && /\d/.test(next),
    spaces: next.length > 0 && !/\s/.test(next),
    different: next.length > 0 && next !== current,
    'not-default': next.length > 0 && !looksLikeDefaultPassword(next, ctx),
    match: next.length > 0 && next === confirm,
  };
}

/**
 * Change the signed-in account's password. Every portal's Account Settings
 * and the mandatory first-sign-in screen go through this one call.
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function requestPasswordChange(currentPassword, newPassword, confirmPassword) {
  const current = String(currentPassword || '').trim();
  const next = String(newPassword || '').trim();
  const confirm = String(confirmPassword || '').trim();

  if (!current || !next || !confirm) return { ok: false, message: 'All password fields are required.' };
  if (next !== confirm) return { ok: false, message: 'New passwords do not match.' };

  const rules = evaluatePasswordRules(current, next, confirm, getAuthContext());
  if (!rules.length) return { ok: false, message: `New password must be at least ${PASSWORD_MIN_LENGTH} characters.` };
  if (!rules.spaces) return { ok: false, message: 'New password cannot contain spaces.' };
  if (!rules.mix) return { ok: false, message: 'New password must contain both letters and numbers.' };
  if (!rules.different) return { ok: false, message: 'New password must be different from your current password.' };
  if (!rules['not-default']) return { ok: false, message: 'New password cannot be your default password (last name + birth date).' };

  try {
    const response = await fetch('/api/legacy-auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: current, new_password: next, confirm_password: confirm }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, message: result.error || 'Failed to update password.' };

    setMustChangePasswordFlag(false);
    return { ok: true, message: result.message || 'Password updated successfully.' };
  } catch {
    return { ok: false, message: 'Network error — your password was not changed. Please try again.' };
  }
}

/**
 * Account Settings "Update Password" for any portal. Reads
 * `${prefix}-{current,new,confirm}-password` (or the given ids) and writes the
 * result into `${prefix}-change-password-feedback`.
 */
async function submitAccountPasswordChange(prefix, ids = {}) {
  const currentId = ids.current || `${prefix}-current-password`;
  const newId = ids.next || `${prefix}-new-password`;
  const confirmId = ids.confirm || `${prefix}-confirm-password`;
  const feedback = document.getElementById(ids.feedback || `${prefix}-change-password-feedback`);

  const show = (message, state) => {
    if (!feedback) return;
    feedback.textContent = message;
    feedback.className = `adm-feedback${state ? ` ${state}` : ''}`;
    feedback.style.color = '';
  };

  show('Updating password...', 'loading');
  const result = await requestPasswordChange(
    document.getElementById(currentId)?.value,
    document.getElementById(newId)?.value,
    document.getElementById(confirmId)?.value,
  );

  if (!result.ok) {
    show(result.message, 'err');
    return;
  }

  [currentId, newId, confirmId].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
  [currentId, newId, confirmId].forEach((id) => {
    document.getElementById(id)?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  show(result.message, 'ok');
  pushNotification('Password Changed', 'Your account password has been updated successfully.', 'success');
  setTimeout(() => closeSettingsModal(prefix), 1200);
}

/**
 * Wires the same live rule checklist used by the mandatory first-sign-in
 * screen onto a portal's Settings > Change Password fields, so every place a
 * user changes their password shows the same requirements as they type.
 * Idempotent per prefix (safe to call before the section is ever opened).
 */
function bindSettingsPasswordRulesUI(prefix, ids = {}) {
  const currentId = ids.current || `${prefix}-current-password`;
  const nextId = ids.next || `${prefix}-new-password`;
  const confirmId = ids.confirm || `${prefix}-confirm-password`;
  const current = document.getElementById(currentId);
  const next = document.getElementById(nextId);
  const confirm = document.getElementById(confirmId);
  const rulesList = document.getElementById(`${prefix}-pw-rules`);
  if (!current || !next || !confirm || !rulesList || rulesList.dataset.bound === '1') return;
  rulesList.dataset.bound = '1';

  const ruleItems = Array.from(rulesList.querySelectorAll('li[data-rule]'));
  const refresh = () => {
    const rules = evaluatePasswordRules(current.value.trim(), next.value.trim(), confirm.value.trim(), getAuthContext());
    ruleItems.forEach((item) => item.classList.toggle('ok', Boolean(rules[item.dataset.rule])));
  };
  [current, next, confirm].forEach((input) => input.addEventListener('input', refresh));
  refresh();
}

/** Binds the live rule checklist for every portal's Settings password section. */
function initAllSettingsPasswordRulesUI() {
  bindSettingsPasswordRulesUI('emp', { current: 'emp-cur-password', next: 'emp-new-password', confirm: 'emp-confirm-password' });
  bindSettingsPasswordRulesUI('adm', { current: 'adm-cur-password', next: 'adm-new-password', confirm: 'adm-confirm-password' });
  bindSettingsPasswordRulesUI('hr');
  bindSettingsPasswordRulesUI('ac', { current: 'ac-cur-password', next: 'ac-new-password', confirm: 'ac-confirm-password' });
  bindSettingsPasswordRulesUI('sa');
}

/**
 * Show/hide toggle for any password field marked up with the `.cp-eye`
 * button pattern (`data-target` pointing at the input's id). Delegated once
 * on `document` so it works for the first-sign-in screen and every portal's
 * Settings password section alike, regardless of when their markup appears.
 */
function attachPasswordEyeToggle() {
  if (document.body.dataset.cpEyeDelegationBound === '1') return;
  document.body.dataset.cpEyeDelegationBound = '1';
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('.cp-eye');
    if (!btn) return;
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    btn.textContent = reveal ? 'Hide' : 'Show';
    btn.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
  });
}

/* ── MANDATORY CHANGE-PASSWORD SCREEN ── */
function initPasswordChangeScreen() {
  const form = document.getElementById('cp-form');
  if (!form || form.dataset.bound === '1') return;
  form.dataset.bound = '1';

  const ctx = getAuthContext() || {};
  const firstName = String(ctx.full_name || '').trim().split(/\s+/)[0];
  const greeting = document.getElementById('cp-greeting');
  if (greeting && firstName) {
    greeting.textContent = `Welcome, ${firstName}! Before you continue, set a new password for your account.`;
  }
  const account = document.getElementById('cp-account');
  if (account) account.textContent = ctx.email ? `Signed in as ${ctx.email}` : '';

  const current = document.getElementById('cp-current');
  const next = document.getElementById('cp-new');
  const confirm = document.getElementById('cp-confirm');
  const feedback = document.getElementById('cp-feedback');
  const submit = document.getElementById('cp-submit');
  const ruleItems = Array.from(document.querySelectorAll('#cp-rules li'));

  const refreshRules = () => {
    const rules = evaluatePasswordRules(current.value.trim(), next.value.trim(), confirm.value.trim(), ctx);
    ruleItems.forEach((item) => {
      const passed = Boolean(rules[item.dataset.rule]);
      item.classList.toggle('ok', passed);
      item.classList.toggle('pending', !passed);
    });
    return Object.values(rules).every(Boolean);
  };

  [current, next, confirm].forEach((input) => input.addEventListener('input', () => {
    refreshRules();
    if (feedback.classList.contains('err')) {
      feedback.textContent = '';
      feedback.className = 'cp-feedback';
    }
  }));

  refreshRules();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;

    submit.disabled = true;
    submit.textContent = 'Updating...';
    feedback.textContent = '';
    feedback.className = 'cp-feedback';

    const result = await requestPasswordChange(current.value, next.value, confirm.value);
    if (!result.ok) {
      feedback.textContent = result.message;
      feedback.className = 'cp-feedback err';
      submit.disabled = false;
      submit.textContent = 'Update password & continue';
      refreshRules();
      return;
    }

    feedback.textContent = 'Password updated. Opening your portal...';
    feedback.className = 'cp-feedback ok';
    submit.textContent = 'Done';
    [current, next, confirm].forEach((input) => { input.value = ''; });
    // Reload the portal frame: with the flag cleared, index.html now loads the
    // real portal instead of this screen.
    setTimeout(() => window.location.reload(), 900);
  });

  setTimeout(() => current.focus(), 0);
}

/* ══════════════════════════════════════════════════════════════════════════
   SIGN-IN NOTICES
   ══════════════════════════════════════════════════════════════════════════ */

const LOGIN_REASON_MESSAGES = {
  signed_in_elsewhere: 'You were signed out because your account signed in on another device or browser. Only one active sign-in is allowed per account.',
  account_archived: 'This account has been archived and can no longer sign in.',
  session_expired: 'Your session has expired. Please sign in again.',
};

function showLoginReasonNotice() {
  let reason = '';
  try {
    reason = new URLSearchParams((window.top || window).location.search).get('reason') || '';
  } catch {
    reason = new URLSearchParams(window.location.search).get('reason') || '';
  }

  const message = LOGIN_REASON_MESSAGES[reason];
  const notice = document.getElementById('login-notice');
  if (!message || !notice) return false;

  notice.textContent = message;
  notice.hidden = false;
  return true;
}

/* ══════════════════════════════════════════════════════════════════════════
   MOBILE NAVIGATION
   Below 1024px the sidebar is hidden outright (see layout.css) rather than
   becoming a slide-in drawer — the sitemap FAB (setupSitemapFab) is the
   only way to reach other pages on a phone, so there is no second,
   redundant "see everything" menu competing with it.
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   SCROLLABLE TAB FADE
   The employee portal's tab strip (.emp-tabnav) scrolls horizontally on
   phones — it has more tabs than fit. Without a hint, a clipped tab at the
   edge reads as a layout bug rather than "swipe for more". Mask-fade
   whichever edge still has hidden content, cleared once fully scrolled.
   ══════════════════════════════════════════════════════════════════════════ */

function setupTabScrollFade() {
  document.querySelectorAll('.emp-tabnav').forEach((nav) => {
    if (nav.dataset.fadeBound === '1') return;
    nav.dataset.fadeBound = '1';

    const update = () => {
      const scrollable = nav.scrollWidth > nav.clientWidth + 1;
      // Centered (CSS default) only while every tab actually fits — centering
      // an overflowing flex line clips its start, which hid the default
      // active Dashboard tab off-screen on load rather than just the last
      // tab needing a scroll.
      nav.classList.toggle('scrollable', scrollable);
      nav.classList.toggle('fade-l', scrollable && nav.scrollLeft > 2);
      nav.classList.toggle('fade-r', scrollable && nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2);
    };

    // update() reads scrollWidth/clientWidth and then writes classes, so
    // calling it straight from an event handler forces a synchronous layout
    // and dirties it again on the same tick. Scroll fires far more often than
    // resize — once per frame or more while a finger drags the tab strip —
    // so it needs this coalescing at least as much: one measurement per
    // frame, on the frame that is about to paint anyway.
    let rafPending = false;
    const scheduleUpdate = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        update();
      });
    };

    nav.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate, { passive: true });
    update();
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   SITEMAP FAB
   A "more" button in the sidebar-based portals (Admin, Accountant, HR,
   Super Admin) that opens an overview of every page the current portal's
   sidebar exposes, since that sidebar is otherwise hidden. Employee has no
   equivalent button: its pages are already always visible as tabs, so a
   second "see everything" menu would only duplicate it. Built by reading
   whatever the active screen's own sidebar already renders (rbac.js adds/
   removes items per permission), so it never lists a page the signed-in
   user cannot reach and never needs updating when a portal's pages do.
   ══════════════════════════════════════════════════════════════════════════ */

function activePortalScreen() {
  const screen = document.querySelector('.screen.active');
  if (!screen) return null;
  const hasNav = screen.querySelector(':scope > .sidebar .ni');
  return hasNav ? screen : null;
}

function navCardLabel(navEl) {
  const clone = navEl.cloneNode(true);
  clone.querySelectorAll('svg, .nib').forEach((el) => el.remove());
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

function setupSitemapFab() {
  if (document.body.dataset.sitemapFabBound === '1') return;
  document.body.dataset.sitemapFabBound = '1';

  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'sitemap-fab';
  fab.setAttribute('aria-label', 'Show all pages');
  fab.setAttribute('aria-expanded', 'false');
  fab.title = 'Show all pages';
  fab.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="5" r="1.9" fill="currentColor"/><circle cx="12" cy="12" r="1.9" fill="currentColor"/><circle cx="12" cy="19" r="1.9" fill="currentColor"/></svg>';

  const backdrop = document.createElement('div');
  backdrop.className = 'sitemap-backdrop';

  const panel = document.createElement('div');
  panel.className = 'sitemap-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'All pages');

  // panel nests inside backdrop so the >=640px CSS (backdrop centers its
  // flex child) actually applies — as siblings, "position: relative" at
  // that breakpoint had no flex container to center within and the panel
  // landed wherever document.body's normal flow put it.
  backdrop.appendChild(panel);
  document.body.append(fab, backdrop);

  function closeSitemap() {
    panel.classList.remove('active');
    backdrop.classList.remove('active');
    fab.setAttribute('aria-expanded', 'false');
    // Wait for the fade/slide-out transition to finish before dropping
    // `open` (which switches display back to none) — otherwise closing
    // snaps instantly instead of reversing the open animation.
    window.setTimeout(() => {
      if (!panel.classList.contains('active')) {
        panel.classList.remove('open');
        backdrop.classList.remove('open');
      }
    }, 160);
  }

  function buildCard(navEl) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'sitemap-card';
    if (navEl.classList.contains('active')) card.classList.add('active');

    const icon = navEl.querySelector('svg');
    if (icon) {
      const iconWrap = document.createElement('span');
      iconWrap.className = 'sitemap-card-icon';
      iconWrap.appendChild(icon.cloneNode(true));
      card.appendChild(iconWrap);
    }

    const label = document.createElement('span');
    label.className = 'sitemap-card-label';
    label.textContent = navCardLabel(navEl);
    card.appendChild(label);

    card.addEventListener('click', () => {
      closeSitemap();
      navEl.click();
    });
    return card;
  }

  function buildGroup(labelText, navEls) {
    const group = document.createElement('div');
    group.className = 'sitemap-group';

    const label = document.createElement('div');
    label.className = 'sitemap-group-label';
    label.textContent = labelText;
    group.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'sitemap-grid';
    navEls.forEach((navEl) => grid.appendChild(buildCard(navEl)));
    group.appendChild(grid);

    return group;
  }

  function buildContent(screen) {
    const brandName = screen.querySelector('.bn')?.textContent.trim() || 'SACS Payroll';
    const brandSub = screen.querySelector('.bs')?.textContent.trim() || '';

    panel.replaceChildren();

    const head = document.createElement('div');
    head.className = 'sitemap-head';
    const title = document.createElement('div');
    title.className = 'sitemap-title';
    title.textContent = brandName;
    const sub = document.createElement('div');
    sub.className = 'sitemap-sub';
    sub.textContent = brandSub ? `${brandSub} — all pages` : 'All pages';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sitemap-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '✕';
    close.addEventListener('click', closeSitemap);
    head.append(title, sub, close);
    panel.appendChild(head);

    const body = document.createElement('div');
    body.className = 'sitemap-body';
    panel.appendChild(body);

    // activePortalScreen() only returns screens with a sidebar, so this is
    // always present here.
    const sidebar = screen.querySelector(':scope > .sidebar');
    let pendingLabel = null;
    let items = [];
    const flush = () => {
      if (pendingLabel && items.length) body.appendChild(buildGroup(pendingLabel, items));
      items = [];
    };
    Array.from(sidebar.children).forEach((el) => {
      if (el.classList.contains('sb-sec')) {
        flush();
        pendingLabel = el.textContent.trim();
      } else if (el.classList.contains('ni')) {
        items.push(el);
      }
    });
    flush();

    // The sidebar's own footer (signed-in user + Sign Out) is hidden along
    // with the rest of it — clone it in rather than reimplement sign-out,
    // so it stays whatever rbac.js last rendered there.
    const sbFoot = sidebar.querySelector(':scope > .sb-foot');
    if (sbFoot) {
      const foot = document.createElement('div');
      foot.className = 'sitemap-foot';
      foot.appendChild(sbFoot.cloneNode(true));
      panel.appendChild(foot);
    }
  }

  function openSitemap() {
    const screen = activePortalScreen();
    if (!screen) return;
    buildContent(screen);
    // Switch on `display` first and let the browser paint that (still
    // invisible, opacity: 0) frame, then start the opacity/transform
    // transition on the *next* frame. Adding `open` and `active` together
    // right after buildContent()'s DOM rebuild let the two land in the same
    // style/layout pass, so the transition either got skipped or played
    // over dropped frames — the "slow/laggy" appearance reported for this
    // and every other 3-dot sidebar that shares this component.
    panel.classList.add('open');
    backdrop.classList.add('open');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        panel.classList.add('active');
        backdrop.classList.add('active');
      });
    });
    fab.setAttribute('aria-expanded', 'true');
  }

  fab.addEventListener('click', () => {
    if (panel.classList.contains('open')) closeSitemap();
    else openSitemap();
  });
  // Only a direct click on the backdrop itself closes it — panel is now a
  // child of backdrop, so clicks inside the panel would otherwise bubble
  // up and close it before a card's own click handler ever ran.
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeSitemap();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSitemap();
  });

  const refreshVisibility = () => {
    const screen = activePortalScreen();
    const visible = Boolean(screen);
    if (visible) {
      // Lives in the top bar itself, left of the title, rather than a
      // floating circle pinned to a corner — it stays put as part of the
      // page chrome, not as an overlay sitting on top of it. The top bar
      // is sticky, so it stays on screen while the page scrolls.
      const topbar = screen.querySelector(':scope > .main .topbar');
      if (topbar && fab.parentElement !== topbar) topbar.insertBefore(fab, topbar.firstChild);
    }
    fab.classList.toggle('visible', visible);
    if (!visible) closeSitemap();
  };

  document.querySelectorAll('.screen').forEach((screen) => {
    new MutationObserver(refreshVisibility).observe(screen, { attributes: true, attributeFilter: ['class'] });
  });

  refreshVisibility();
}

/* ══════════════════════════════════════════════════════════════════════════
   NUMBER-ONLY INPUTS
   type="number" still lets a browser accept "e", "+", "-" (and Firefox any
   letter at all). Inputs inside `root` get filtered by their inputmode:
     inputmode="numeric"  whole numbers only (days, counts)
     inputmode="decimal"  digits and one decimal point, at most 2 decimals
   Delegated, so rows rendered later (e.g. batch payroll) are covered too.
   ══════════════════════════════════════════════════════════════════════════ */

function numericModeOf(input) {
  if (!input || input.tagName !== 'INPUT' || input.readOnly || input.disabled) return '';
  // Formatted ID fields (SSS, TIN, contact number...) run their own digit
  // filter in bindDigitInput(), which also inserts the separators.
  if (input.dataset.digitBound === '1') return '';
  const mode = String(input.getAttribute('inputmode') || '').toLowerCase();
  if (mode === 'numeric' || mode === 'decimal') return mode;
  return '';
}

function sanitizeNumericText(text, mode) {
  let value = String(text || '').replace(mode === 'decimal' ? /[^\d.]/g : /\D/g, '');
  if (mode === 'decimal') {
    const firstDot = value.indexOf('.');
    if (firstDot !== -1) {
      value = value.slice(0, firstDot + 1) + value.slice(firstDot + 1).replace(/\./g, '').slice(0, 2);
    }
  }
  return value;
}

function enforceNumericInputs(root) {
  if (!root || root.dataset.numericGuard === '1') return;
  root.dataset.numericGuard = '1';

  root.addEventListener('keydown', (event) => {
    const mode = numericModeOf(event.target);
    if (!mode || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
    const allowed = mode === 'decimal' ? /[\d.]/ : /\d/;
    if (!allowed.test(event.key)) {
      event.preventDefault();
      return;
    }
    if (event.key === '.' && String(event.target.value).includes('.')) event.preventDefault();
  });

  // Touch keyboards often report keydown as "Unidentified", so the typed text
  // itself is checked as well before it lands in the field.
  root.addEventListener('beforeinput', (event) => {
    const mode = numericModeOf(event.target);
    if (!mode || event.data == null || !String(event.inputType || '').startsWith('insert')) return;
    const allowed = mode === 'decimal' ? /^[\d.]*$/ : /^\d*$/;
    if (!allowed.test(event.data)) event.preventDefault();
  });

  root.addEventListener('paste', (event) => {
    const mode = numericModeOf(event.target);
    if (!mode) return;
    const text = String((event.clipboardData || window.clipboardData)?.getData('text') || '').trim();
    const clean = sanitizeNumericText(text, mode);
    if (clean !== text) {
      event.preventDefault();
      if (clean) {
        event.target.value = clean;
        event.target.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  });

  // A text field (not type="number", which never exposes stray characters)
  // can still receive text by drag-and-drop or autofill: strip it.
  root.addEventListener('input', (event) => {
    const input = event.target;
    const mode = numericModeOf(input);
    if (!mode || input.type === 'number') return;
    const clean = sanitizeNumericText(input.value, mode);
    if (clean !== input.value) input.value = clean;
  }, true);
}

/* ── INIT ── */
/* ── BODY SCROLL LOCK ──
   Every overlay in the portals is position:fixed, so on a touch device the page
   behind one keeps scrolling underneath it — you open a modal, flick, and the
   list behind moves while the modal stays put.

   Rather than adding paired lock/unlock calls to every open and close site
   across five portal scripts, one observer watches the document and keeps
   <body> locked for exactly as long as an overlay is actually visible. That
   also covers the .adm-modal-backdrop dialogs, which live in the page markup
   and are shown by toggling inline style.display rather than a class.

   The check is coalesced into a single animation frame, so a table re-render
   that fires hundreds of mutations still costs one DOM query. */
const SCROLL_LOCK_CLASS_SELECTOR =
  '.confirm-backdrop.active, .settings-backdrop.active, .sitemap-panel.open';

function isAnyOverlayOpen() {
  if (document.querySelector(SCROLL_LOCK_CLASS_SELECTOR)) return true;
  const modals = document.querySelectorAll('.adm-modal-backdrop');
  for (const modal of modals) {
    if (modal.style.display !== 'none') return true;
  }
  return false;
}

let scrollLockFrame = 0;

function syncBodyScrollLock() {
  scrollLockFrame = 0;
  document.body.classList.toggle('scroll-locked', isAnyOverlayOpen());
}

function startScrollLockWatcher() {
  syncBodyScrollLock();
  const observer = new MutationObserver(() => {
    if (scrollLockFrame) return;
    scrollLockFrame = requestAnimationFrame(syncBodyScrollLock);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
}

function initApp() {
  // Restore saved theme or default to dark
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved);

  startScrollLockWatcher();

  const roleRouteMap = {
    super_admin: '/super-admin',
    admin: '/admin',
    accountant: '/accountant',
    employee: '/employee',
    hr: '/hr',
  };

  const role = new URLSearchParams(window.location.search).get('role');
  if (role) {
    const ctx = getAuthContext();
    // The proxy already verified the signed session cookie owns this portal
    // before this page could load, so localStorage (display-only) is not the
    // authority here. Repair a stale mismatch instead of redirecting on it —
    // redirecting from a value this same code is about to correct is how the
    // browser used to bounce forever between two portals.
    if (!ctx || !ctx.role) {
      window.top.location.href = '/login';
      return;
    }
    if (ctx.role !== role) {
      localStorage.setItem(AUTH_CONTEXT_KEY, JSON.stringify({ ...ctx, role }));
    }
    if (window._passwordGate) {
      // Still on the issued password: only the change-password screen exists
      // in this document (index.html never loaded the portal).
      document.getElementById('s-login')?.classList.remove('active');
      document.getElementById('s-change-password')?.classList.add('active');
      initPasswordChangeScreen();
    } else {
      showRoleScreen(role);
    }
  } else {
    // On the login page — if localStorage claims we're already signed in,
    // confirm the server session is still valid before leaving this page.
    // localStorage never expires on its own; trusting it alone would bounce
    // the browser forever between here and the portal once the session
    // cookie lapses, since the portal's proxy always sends an unauthenticated
    // visitor straight back to /login — that endless bounce is what showed up
    // as the site "flickering" and never finishing load.
    //
    // Arriving here because this sign-in was ended elsewhere: say why, and
    // drop the stale local context instead of trying to resume it.
    if (showLoginReasonNotice()) {
      localStorage.removeItem(AUTH_CONTEXT_KEY);
    }
    const ctx = getAuthContext();
    if (ctx && ctx.role && roleRouteMap[ctx.role]) {
      fetch('/api/rbac/me')
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null)
        .then((me) => {
          if (me?.user?.role === ctx.role) {
            window.top.location.href = roleRouteMap[ctx.role];
          } else {
            // Server disagrees (expired/missing/mismatched session): the
            // stale localStorage context can no longer be trusted.
            localStorage.removeItem(AUTH_CONTEXT_KEY);
          }
        });
    }
    showRoleScreen('');
  }

  document.addEventListener('keydown', (event) => {
    // A textarea (leave reason, remarks) or a select uses Page Up/Down itself —
    // hijacking the key there scrolled the page instead of the field.
    const pagingField = event.target?.closest?.('textarea, select, [contenteditable="true"]');

    if (event.key === 'PageDown' && !pagingField) {
      event.preventDefault();
      scrollWebsite('down');
    }

    if (event.key === 'PageUp' && !pagingField) {
      event.preventDefault();
      scrollWebsite('up');
    }

    if (event.key === 'Enter') {
      const loginScreen = document.getElementById('s-login');
      if (loginScreen && loginScreen.classList.contains('active')) {
        // The Forgot Password dialog sits on top of the login screen, so Enter
        // typed there used to fire login() behind it — an "enter your
        // username" alert popped over the reset form. Enter there sends the
        // reset link instead.
        const resetModal = document.getElementById('reset-password-modal');
        if (resetModal && resetModal.style.display !== 'none') {
          if (event.target?.id === 'reset-identity-input') submitResetPassword();
          return;
        }
        login();
      }
    }
  });

  // Native mouse-wheel scrolling is more reliable across browsers and devices.
  // Do not intercept wheel events globally.

  // Expose helpers for manual usage when needed.
  window.scrollWebsite = scrollWebsite;
  window.scrollWebsiteTo = scrollWebsiteTo;
  window.getLegacyAuthContext = getAuthContext;
  window.confirmDestructiveAction = confirmDestructiveAction;
  window.confirmApproveAction = confirmApproveAction;
  window.pushNotification = pushNotification;
  window.openSettingsModal = openSettingsModal;
  window.closeSettingsModal = closeSettingsModal;
  window.saveProfileInfo = saveProfileInfo;
  window.persistRolePageState = persistRolePageState;
  window.getPersistedRolePageState = getPersistedRolePageState;
  window.refreshCurrentPortal = refreshCurrentPortal;
  window.openProofDocument = openProofDocument;
  window.openResetPasswordModal = openResetPasswordModal;
  window.closeResetPasswordModal = closeResetPasswordModal;
  window.submitResetPassword = submitResetPassword;
  window.toggleLoginPasswordVisibility = toggleLoginPasswordVisibility;
  window.login = login;
  window.logout = logout;
  window.createPaginator = createPaginator;
  window.paginatorGoTo = paginatorGoTo;
  window.skeletonRows = skeletonRows;
  window.skeletonCards = skeletonCards;
  window.printDocument = printDocument;
  window.submitAccountPasswordChange = submitAccountPasswordChange;
  window.requestPasswordChange = requestPasswordChange;
  window.setMustChangePasswordFlag = setMustChangePasswordFlag;
  window.enforceNumericInputs = enforceNumericInputs;

  setupTabScrollFade();
  setupSitemapFab();

  // Sync auth context across tabs/windows without requiring refresh.
  window.addEventListener('storage', (event) => {
    if (event && event.key === AUTH_CONTEXT_KEY) {
      dispatchAuthContextChanged(getAuthContext());
    }
  });

  attachGlobalSearchHandlers();
  attachNotificationHandlers();
  attachLoginPasswordToggle();
  attachPasswordEyeToggle();
  initAllSettingsPasswordRulesUI();
}

function attachLoginPasswordToggle() {
  const btn = document.getElementById('login-password-toggle');
  if (btn && btn.dataset.toggleBound !== '1') {
    btn.dataset.toggleBound = '1';
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleLoginPasswordVisibility();
    });
  }

  // Document-level delegation as a final fallback in case the inline
  // onclick and direct listener both fail to fire (overlapping element,
  // cached HTML, etc.). The dataset.toggleBound guard prevents this from
  // double-firing alongside the direct listener.
  if (!document.body.dataset.passwordToggleDelegationBound) {
    document.body.dataset.passwordToggleDelegationBound = '1';
    document.addEventListener('click', (event) => {
      const target = event.target?.closest?.('[data-action="toggle-login-password"]');
      if (!target) return;
      if (target.dataset.toggleBound === '1') return;
      event.preventDefault();
      toggleLoginPasswordVisibility();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
