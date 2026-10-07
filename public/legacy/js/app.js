/* ═══════════════════════════════════════
   app.js — core application logic
   Handles: login, logout
   Edit this file for auth and routing init
   ═══════════════════════════════════════ */

'use strict';

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

/* ── FIELD MESSAGES ──
   One way, in every portal, to say which field is missing or wrong: a red
   outline, a red message under the field (the .field-error style the HR and
   Super Admin forms already use) and focus on the first one. The message
   clears as soon as the field is edited.
   A field inside a field box (.fg in the portals, .fl on the sign-in page,
   .ts-step on the timesheet) gets its message under it. A field sitting in a
   toolbar row has no box; it gets the outline only, and the caller shows the
   message in that section's feedback line, so no row changes shape. */
const FIELD_BOX_SELECTOR = '.fg, .fl, .ts-step';

function resolveField(field) {
  return typeof field === 'string' ? document.getElementById(field) : field || null;
}

function fieldMessageSlot(input, create) {
  const box = input.closest(FIELD_BOX_SELECTOR);
  if (!box) return null;
  let slot = box.querySelector(':scope > .field-error');
  if (!slot && create) {
    slot = document.createElement('span');
    slot.className = 'field-error';
    slot.setAttribute('aria-live', 'polite');
    box.appendChild(slot);
  }
  return slot;
}

/** The field's own label, for "<label> is required." */
function fieldLabel(input) {
  const label = input.id ? document.querySelector(`label[for="${input.id}"]`) : null;
  const text = String(label?.textContent || input.getAttribute('aria-label') || input.placeholder || 'This field')
    .replace(/\*/g, '')
    .replace(/\(optional\)/i, '')
    .replace(/:\s*$/, '')
    .trim();
  return text || 'This field';
}

function clearFieldError(field) {
  const input = resolveField(field);
  if (!input) return;
  input.classList.remove('field-invalid');
  input.removeAttribute('aria-invalid');
  const slot = fieldMessageSlot(input, false);
  if (slot) slot.textContent = '';
}

function showFieldError(field, message) {
  const input = resolveField(field);
  if (!input) return;
  input.classList.add('field-invalid');
  input.setAttribute('aria-invalid', 'true');
  const slot = fieldMessageSlot(input, true);
  if (slot) slot.textContent = message || `${fieldLabel(input)} is required.`;
  if (!input.dataset.fieldMessageBound) {
    input.dataset.fieldMessageBound = '1';
    const clear = () => clearFieldError(input);
    input.addEventListener('input', clear);
    input.addEventListener('change', clear);
  }
}

/**
 * Check fields before sending. Each entry is a field (element or id), or
 * { field, label, check }: `check(value, input)` returns a message, or ''
 * when the value is fine; without it the field only has to be filled in.
 * Marks every failing field, focuses the first, and returns true only when
 * all of them pass.
 */
function requireFields(entries) {
  let first = null;
  entries.forEach((entry) => {
    const spec = typeof entry === 'string' || entry instanceof Element ? { field: entry } : entry;
    const input = resolveField(spec.field);
    if (!input) return;
    const value = input.type === 'file' ? (input.files?.length ? input.files[0].name : '') : String(input.value || '').trim();
    const message = spec.check
      ? spec.check(value, input)
      : (value ? '' : `${spec.label || fieldLabel(input)} is required.`);
    if (message) {
      showFieldError(input, message);
      if (!first) first = input;
    } else {
      clearFieldError(input);
    }
  });
  if (first) {
    first.focus({ preventScroll: true });
    first.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }
  return !first;
}

// Forms that use the browser's own checks (required, min, pattern) get the
// same red message under the field as everything else.
document.addEventListener('invalid', (event) => {
  const input = event.target;
  if (input instanceof HTMLElement && input.matches('input, select, textarea')) {
    showFieldError(input, input.validity?.valueMissing ? `${fieldLabel(input)} is required.` : input.validationMessage);
  }
}, true);

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

const AUDIT_ROLE_LABELS = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  hr: 'HR',
  accountant: 'Accountant',
  employee: 'Employee',
};

/**
 * The "Performed By" cell of the Admin and Super Admin audit tables: who did
 * it, with their role beneath. Entries written before the audit log recorded
 * its actor (2026-09-27) show a dash.
 */
function auditActorCell(log) {
  const name = String(log?.actor_name || '').trim();
  const role = String(log?.actor_role || '').trim().toLowerCase();
  if (!name && !role) return '<span style="color:var(--t3);">—</span>';
  const roleLabel = AUDIT_ROLE_LABELS[role] || role.replaceAll('_', ' ');
  return `<div style="font-size:12px;">${escapeHtml(name || 'Unknown user')}</div>`
    + (roleLabel ? `<div style="font-size:11px;color:var(--t3);">${escapeHtml(roleLabel)}</div>` : '');
}

/**
 * A value placed inside a quoted JavaScript string in an inline handler,
 * e.g. onclick="openThing('${escapeJsArg(id)}')". escapeHtml alone is not
 * enough there: the browser decodes &#39; back into ' before the handler is
 * parsed, so a quote in the value would close the JS string. The value is
 * JS-escaped first, then HTML-escaped for the attribute.
 */
function escapeJsArg(value) {
  const js = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n')
    .replace(/</g, '\\x3C');
  return escapeHtml(js);
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
    first_name: String(profile.first_name || '').trim(),
    middle_name: String(profile.middle_name || '').trim(),
    last_name: String(profile.last_name || '').trim(),
    suffix: String(profile.suffix || '').trim(),
    emergency_contact_name: String(profile.emergency_contact_name || '').trim(),
    emergency_contact_relationship: String(profile.emergency_contact_relationship || '').trim(),
    emergency_contact_address: String(profile.emergency_contact_address || '').trim(),
    emergency_contact_number: String(profile.emergency_contact_number || '').trim(),
    email: String(profile.email || '').trim(),
    employee_id: String(profile.employee_id || '').trim(),
    staff_id: String(profile.staff_id || '').trim(),
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

/* ── EMERGENCY CONTACT (Profile page, read-only) ── */
// Fills the Profile page's Emergency Contact card (`${prefix}-name`,
// `-relationship`, `-number`, `-address`) from the sign-in context, then
// refreshes it from GET /api/legacy-auth/update-profile so a contact HR or
// Super Admin changed since sign-in shows without signing out.
function renderEmergencyContactCard(prefix, source) {
  const set = (suffix, value) => {
    const el = document.getElementById(`${prefix}-${suffix}`);
    if (el) el.textContent = value || '—';
  };
  const number = digitsOnly(source?.emergency_contact_number || '');
  set('name', source?.emergency_contact_name);
  set('relationship', source?.emergency_contact_relationship);
  set('number', number
    ? formatDigitGroups(number, DIGIT_FIELD_SPECS.cp_number.groups, DIGIT_FIELD_SPECS.cp_number.separator)
    : '');
  set('address', source?.emergency_contact_address);
}

const EMERGENCY_CONTACT_KEYS = [
  'emergency_contact_name', 'emergency_contact_relationship',
  'emergency_contact_address', 'emergency_contact_number',
];

function loadOwnEmergencyContact(prefix) {
  renderEmergencyContactCard(prefix, getAuthContext());
  fetch('/api/legacy-auth/update-profile', { method: 'GET', cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const stored = data?.profile;
      if (!stored) return;
      renderEmergencyContactCard(prefix, stored);
      const latest = getAuthContext();
      if (!latest) return;
      const next = { ...latest };
      EMERGENCY_CONTACT_KEYS.forEach((key) => { next[key] = stored[key] || ''; });
      localStorage.setItem(AUTH_CONTEXT_KEY, JSON.stringify(next));
    })
    .catch(() => {});
}

/* ── CONTACT + GOVERNMENT NUMBERS (Profile page, read-only) ── */
// Fills `${prefix}-info-cpnumber`, `-info-address`, `-sss-number`,
// `-philhealth-number`, `-pagibig-number` and `-tin-number` from the sign-in
// context, formatted as the Employee portal's Profile page shows them.
function renderOwnContactAndGovIds(prefix, ctx) {
  const set = (suffix, value) => {
    const el = document.getElementById(`${prefix}-${suffix}`);
    if (el) el.textContent = value || '—';
  };
  const cp = digitsOnly(ctx?.cp_number);
  set('info-cpnumber', cp ? formatDigitGroups(cp, DIGIT_FIELD_SPECS.cp_number.groups, DIGIT_FIELD_SPECS.cp_number.separator) : '');
  set('info-address', ctx?.address);
  set('sss-number', ctx?.sss_number);
  set('philhealth-number', ctx?.philhealth_number);
  set('pagibig-number', ctx?.pagibig_number);
  set('tin-number', formatPiiForDisplay(ctx?.tin_number, DIGIT_FIELD_SPECS.tin_number.groups));
}

// Government IDs and bank account numbers reach the browser masked
// ("••••1234", src/lib/employees/pii.js) everywhere except HR's Edit Employee.
// A masked value is shown as it is; only a full number is dash-grouped.
function isMaskedPii(value) {
  return String(value || '').includes('•');
}

function formatPiiForDisplay(value, groups) {
  if (isMaskedPii(value)) return String(value);
  const digits = digitsOnly(value);
  return digits ? formatDigitGroups(digits, groups) : '';
}

/* ── STAFF ID (Profile page, read-only) ── */
// Super Admin / Admin / HR carry a STAFF-### ID instead of an employee ID.
// Shown from the sign-in context, then refreshed from
// GET /api/legacy-auth/update-profile so a session that started before the ID
// was issued still shows it.
function loadOwnStaffId(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const ctx = getAuthContext();
  el.textContent = ctx?.staff_id || '—';
  fetch('/api/legacy-auth/update-profile', { method: 'GET', cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const staffId = data?.profile?.staff_id;
      if (!staffId) return;
      el.textContent = staffId;
      const latest = getAuthContext();
      if (latest) localStorage.setItem(AUTH_CONTEXT_KEY, JSON.stringify({ ...latest, staff_id: staffId }));
    })
    .catch(() => {});
}

/* ── SETTINGS MODAL ── */
function populateSettingsModalProfile(prefix) {
  const ctx = getAuthContext();
  if (!ctx) return;
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };

  // Name parts exactly as last saved (profiles.first_name / middle_name /
  // last_name / suffix, carried in the sign-in context).
  const fillName = (parts) => {
    setVal(`${prefix}-edit-firstname`,  parts.first_name);
    setVal(`${prefix}-edit-middlename`, parts.middle_name);
    setVal(`${prefix}-edit-lastname`,   parts.last_name);
    setVal(`${prefix}-edit-suffix`,     ALLOWED_SUFFIXES.includes(parts.suffix) ? parts.suffix : '');
  };
  if (ctx.first_name || ctx.last_name) {
    fillName(ctx);
  } else {
    // A context from before the parts were stored: start from a best-effort
    // split, then replace it with the stored parts once they arrive.
    const guess = splitFullName(ctx.full_name || '');
    fillName({
      first_name: guess.first_name,
      middle_name: guess.middle_initial
        || (guess.second_name && guess.second_name !== guess.last_name ? guess.second_name : ''),
      last_name: guess.last_name,
      suffix: guess.suffix,
    });
    fetch('/api/legacy-auth/update-profile', { method: 'GET', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const stored = data?.profile || {};
        if (!stored.first_name && !stored.last_name) return;
        fillName(stored);
        const latest = getAuthContext();
        if (latest) {
          localStorage.setItem(AUTH_CONTEXT_KEY, JSON.stringify({
            ...latest,
            first_name: stored.first_name || '',
            middle_name: stored.middle_name || '',
            last_name: stored.last_name || '',
            suffix: stored.suffix || '',
          }));
        }
      })
      .catch(() => {});
  }

  // Contact, emergency contact, government numbers and bank: filled from the
  // sign-in context first, then from GET /api/legacy-auth/update-profile so a
  // change HR made since sign-in shows. A box the person has already typed in
  // is left alone when the fresh values arrive.
  EDIT_ACCOUNT_FIELDS.forEach(({ id, spec }) => {
    const input = document.getElementById(`${prefix}-edit-${id}`);
    if (!input) return;
    delete input.dataset.touched;
    if (!input.dataset.touchBound) {
      input.dataset.touchBound = '1';
      input.addEventListener('input', () => { input.dataset.touched = '1'; });
      input.addEventListener('change', () => { input.dataset.touched = '1'; });
      // A masked number ("••••1234") clears when the box is entered so a new
      // one can be typed, and comes back if the box is left empty.
      input.addEventListener('focus', () => {
        if (!input.readOnly && input.dataset.masked && input.value === input.dataset.masked) input.value = '';
      });
      input.addEventListener('blur', () => {
        if (input.dataset.masked && !input.value) input.value = input.dataset.masked;
      });
    }
    if (spec) bindDigitInput(input, DIGIT_FIELD_SPECS[spec]);
  });
  fillEditAccountFields(prefix, ctx);

  fetch('/api/legacy-auth/update-profile', { method: 'GET', cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const stored = data?.profile;
      if (!stored) return;
      fillEditAccountFields(prefix, stored, true);
      const latest = getAuthContext();
      if (!latest) return;
      const next = { ...latest };
      EDIT_ACCOUNT_FIELDS.forEach(({ key }) => {
        if (stored[key] !== undefined) next[key] = stored[key] || '';
      });
      localStorage.setItem(AUTH_CONTEXT_KEY, JSON.stringify(next));
    })
    .catch(() => {});
}

// The Edit Account boxes beyond the name: `${prefix}-edit-${id}` holds the
// profile field `key`; `spec` names its DIGIT_FIELD_SPECS input mask.
// Government numbers and bank details are read-only (the `readonly`
// attribute in the page markup) on the Employee and Accountant portals, where
// HR sets them; saveProfileInfo() leaves read-only boxes out of the request.
const EDIT_ACCOUNT_FIELDS = [
  { id: 'cpnumber',        key: 'cp_number',                      spec: 'cp_number' },
  { id: 'address',         key: 'address' },
  { id: 'ec-name',         key: 'emergency_contact_name' },
  { id: 'ec-relationship', key: 'emergency_contact_relationship' },
  { id: 'ec-number',       key: 'emergency_contact_number',       spec: 'emergency_contact_number' },
  { id: 'ec-address',      key: 'emergency_contact_address' },
  { id: 'sss',             key: 'sss_number',                     spec: 'sss_number' },
  { id: 'philhealth',      key: 'philhealth_number',              spec: 'philhealth_number' },
  { id: 'pagibig',         key: 'pagibig_number',                 spec: 'pagibig_number' },
  { id: 'tin',             key: 'tin_number',                     spec: 'tin_number' },
  { id: 'bankname',        key: 'bank_name' },
  { id: 'bankaccount',     key: 'bank_account_number',            spec: 'bank_account_number' },
];

function fillEditAccountFields(prefix, source, skipTouched = false) {
  EDIT_ACCOUNT_FIELDS.forEach(({ id, key, spec }) => {
    const input = document.getElementById(`${prefix}-edit-${id}`);
    if (!input || source[key] === undefined) return;
    if (skipTouched && input.dataset.touched) return;
    if (isMaskedPii(source[key])) {
      input.value = source[key];
      input.dataset.masked = source[key];
    } else if (spec) {
      delete input.dataset.masked;
      const { groups, separator } = DIGIT_FIELD_SPECS[spec];
      setFormattedDigitValue(input, source[key], groups, separator);
    } else {
      delete input.dataset.masked;
      input.value = source[key] || '';
    }
  });
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
  // A box missing from this portal's dialog, or read-only on it (government
  // numbers and bank on Employee / Accountant), is left out of the payload so
  // nothing on file is wiped.
  const extra = {};
  EDIT_ACCOUNT_FIELDS.forEach(({ id, key, spec }) => {
    const input = document.getElementById(`${prefix}-edit-${id}`);
    if (!input || input.readOnly) return;
    // Still showing the stored number's mask: unchanged, so not sent.
    if (input.dataset.masked && input.value === input.dataset.masked) return;
    extra[key] = spec ? digitsOnly(input.value) : String(input.value || '').trim();
  });

  // Same rules and wording as before, now also shown under each field.
  const namePart = (label, required) => (value) => {
    if (!value) return required ? `${label} is required.` : '';
    return /^[A-Za-z\s]+$/.test(value) ? '' : `${label} must contain only letters.`;
  };
  if (!requireFields([
    { field: `${prefix}-edit-firstname`, check: namePart('First name', true) },
    { field: `${prefix}-edit-middlename`, check: namePart('Middle name', false) },
    { field: `${prefix}-edit-lastname`, check: namePart('Last name', true) },
  ])) {
    if (feedbackEl) { feedbackEl.textContent = 'Please correct the highlighted fields.'; feedbackEl.className = 'adm-feedback err'; }
    return;
  }

  const full_name = typeof composeFullName === 'function'
    ? composeFullName({ first_name, middle_initial: middle_name, last_name, suffix })
    : [first_name, middle_name, last_name, suffix].filter(Boolean).join(' ');

  if (feedbackEl) { feedbackEl.textContent = 'Saving...'; feedbackEl.className = 'adm-feedback loading'; }

  try {
    const payload = { email, full_name, first_name, middle_name, last_name, suffix, ...extra };

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
      full_name: savedProfile.full_name || full_name,
      first_name: savedProfile.first_name ?? first_name,
      middle_name: savedProfile.middle_name ?? middle_name,
      last_name: savedProfile.last_name ?? last_name,
      suffix: savedProfile.suffix ?? suffix,
    };
    EDIT_ACCOUNT_FIELDS.forEach(({ key }) => {
      if (savedProfile[key] !== undefined) updatedCtx[key] = savedProfile[key] || '';
    });
    localStorage.setItem(AUTH_CONTEXT_KEY, JSON.stringify(updatedCtx));
    dispatchAuthContextChanged(updatedCtx);
    // Redraw the Profile page behind the dialog with what was just saved.
    const profileLoader = { emp: 'loadProfilePage', ac: 'loadAccountantProfile', hr: 'loadHRProfile', adm: 'loadAdminProfile' }[prefix];
    if (profileLoader && typeof window[profileLoader] === 'function') window[profileLoader]();

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
  resetPasswordChangeFlow(prefix);

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

  // Only the shapes a proof can legitimately take are opened: a base64 data
  // URL of a PDF / PNG / JPEG (what the employee portal uploads, and all the
  // API now accepts -- src/lib/leave-requests/proof.js), an https:// link, or
  // a same-origin path. The URL used to be pasted into this viewer's HTML
  // unescaped, so a crafted proof_url broke out of the href attribute and ran
  // as script in the reviewer's session. It is now only ever assigned through
  // DOM properties, never through markup.
  const dataMatch = /^data:(application\/pdf|image\/png|image\/jpeg);base64,[A-Za-z0-9+/]+={0,2}$/i.exec(url);
  const isDataUrl = Boolean(dataMatch);
  const isHttpsUrl = /^https:\/\//i.test(url);
  const isSameOriginPath = url.startsWith('/') && !url.startsWith('//');
  if (!isDataUrl && !isHttpsUrl && !isSameOriginPath) {
    showProofError('This proof document cannot be opened.');
    return;
  }
  const mime = isDataUrl ? dataMatch[1].toLowerCase() : '';
  const isImage = isDataUrl ? mime.startsWith('image/') : /\.(png|jpe?g|gif|webp|bmp)$/i.test(url);
  const isPdf   = (isDataUrl && mime === 'application/pdf') || /\.pdf$/i.test(url);

  const overlay = document.createElement('div');
  overlay.id = 'proof-viewer-overlay';
  overlay.style.cssText = [
    'position:fixed;inset:0;z-index:99999;',
    'background:color-mix(in srgb, var(--color-primary-dark) 94%, transparent);',
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

  overlay.innerHTML = `
    <div style="padding:10px 16px;display:flex;align-items:center;justify-content:space-between;
                border-bottom:2px solid var(--gold);flex-shrink:0;gap:12px;">
      <span style="color:var(--chrome-text);font-size:13px;font-weight:600;">Proof Document</span>
      <div style="display:flex;gap:10px;align-items:center;">
        <a id="proof-dl-link" download="proof-document"
           style="color:var(--chrome-accent);font-size:12px;text-decoration:underline;cursor:pointer;">
          ⬇ Download
        </a>
        <button id="proof-close-btn"
          style="background:var(--red);border:none;color:var(--on-color);padding:5px 14px;
                 border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">
          ✕ Close
        </button>
      </div>
    </div>
    <div id="proof-viewer-body"
         style="flex:1;display:flex;align-items:center;justify-content:center;
                overflow:auto;padding:${(isPdf || (!isImage && isDataUrl)) ? '0' : '20px'};"></div>
  `;
  overlay.querySelector('#proof-dl-link').href = url;

  document.body.appendChild(overlay);

  const body = document.getElementById('proof-viewer-body');

  if (isImage) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'Proof Document';
    img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;box-shadow:0 4px 32px color-mix(in srgb, var(--shadow-color) 60%, transparent);';
    body.appendChild(img);
  } else if (isPdf || isDataUrl) {
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.title = 'Proof Document';
    frame.style.cssText = 'width:100%;height:100%;border:none;';
    body.appendChild(frame);
  } else {
    body.innerHTML = `
      <div style="color:var(--chrome-text);text-align:center;font-family:system-ui,sans-serif;padding:32px;">
        <div style="font-size:48px;margin-bottom:16px;">📎</div>
        <div style="margin-bottom:12px;">This file type cannot be previewed inline.</div>
        <a id="proof-dl-fallback" download
           style="color:var(--chrome-accent);text-decoration:underline;font-size:14px;">Download the file</a>
      </div>`;
    body.querySelector('#proof-dl-fallback').href = url;
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
    'background:var(--bg2);border:1px solid var(--red);border-left:3px solid var(--red);border-radius:8px;',
    'color:var(--t1);padding:12px 20px;font-size:13px;z-index:99999;',
    'box-shadow:var(--shadow);',
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
// Three steps in one dialog, all through POST /api/legacy-auth/reset-password:
//   1. "send"    Employee ID or email -> a 6-digit OTP (valid 5 minutes)
//   2. "verify"  the OTP; only when it checks out does step 3 appear
//   3. "reset"   new password + confirmation
// The server keeps which step you are on in a signed cookie, so the email
// address never reaches the browser and step 3 cannot be reached without
// step 2.
const RESET_OTP_RESEND_SECONDS = 60;
let resetOtpCountdownTimer = null;
let resetRequestInFlight = false;
let resetStage = 'identity';

const RESET_STAGE_LABELS = { identity: 'Send OTP', otp: 'Verify OTP', password: 'Reset Password' };

function resetDialogElements() {
  return {
    modal: document.getElementById('reset-password-modal'),
    identity: document.getElementById('reset-identity-input'),
    otpStep: document.getElementById('reset-otp-step'),
    passwordStep: document.getElementById('reset-password-step'),
    otp: document.getElementById('reset-otp-input'),
    next: document.getElementById('reset-new-password'),
    confirm: document.getElementById('reset-confirm-password'),
    rules: document.getElementById('reset-pw-rules'),
    feedback: document.getElementById('reset-password-feedback'),
    submit: document.getElementById('reset-submit-btn'),
    resend: document.getElementById('reset-resend-btn'),
  };
}

function showResetFeedback(message, ok) {
  const { feedback } = resetDialogElements();
  if (!feedback) return;
  feedback.textContent = message || '';
  feedback.style.color = message ? (ok ? 'var(--green)' : 'var(--red)') : '';
}

/** Show the controls for `stage` and label the main button to match. */
function setResetStage(stage) {
  const els = resetDialogElements();
  resetStage = stage;
  if (els.identity) els.identity.readOnly = stage !== 'identity';
  if (els.otpStep) els.otpStep.hidden = stage !== 'otp';
  if (els.passwordStep) els.passwordStep.hidden = stage !== 'password';
  if (els.submit) { els.submit.disabled = false; els.submit.textContent = RESET_STAGE_LABELS[stage]; }
  if (stage !== 'otp') clearInterval(resetOtpCountdownTimer);
  if (stage === 'identity') {
    [els.otp, els.next, els.confirm].forEach((input) => { if (input) input.value = ''; });
    refreshResetRules();
  }
  const focusTarget = { identity: els.identity, otp: els.otp, password: els.next }[stage];
  setTimeout(() => focusTarget?.focus(), 0);
}

function refreshResetRules() {
  const { next, confirm, rules } = resetDialogElements();
  if (!next || !rules) return {};
  const value = next.value.trim();
  const result = {
    ...evaluatePasswordShape(value),
    match: value.length > 0 && value === String(confirm?.value || '').trim(),
  };
  rules.querySelectorAll('li[data-rule]').forEach((item) => {
    item.classList.toggle('ok', Boolean(result[item.dataset.rule]));
  });
  return result;
}

function bindResetDialogInputs() {
  const { otp, next, confirm, rules } = resetDialogElements();
  if (!rules || rules.dataset.bound === '1') return;
  rules.dataset.bound = '1';
  if (otp) bindNumericOtpInput(otp);
  [next, confirm].forEach((input) => input?.addEventListener('input', refreshResetRules));
}

function startResetResendCountdown(seconds) {
  const { resend } = resetDialogElements();
  clearInterval(resetOtpCountdownTimer);
  resetOtpCountdownTimer = startOtpButtonCountdown(resend, seconds, 'Resend OTP');
}

function openResetPasswordModal() {
  const els = resetDialogElements();
  if (!els.modal) return;

  bindResetDialogInputs();
  resetRequestInFlight = false;
  if (els.identity) els.identity.value = '';
  if (els.resend) { els.resend.disabled = false; els.resend.textContent = 'Resend OTP'; }
  showResetFeedback('', true);
  setResetStage('identity');

  els.modal.style.display = 'flex';
}

function closeResetPasswordModal() {
  const { modal } = resetDialogElements();
  clearInterval(resetOtpCountdownTimer);
  if (modal) modal.style.display = 'none';
}

/** POST one step. Returns { response, result } or null on a network failure. */
async function postResetStep(payload) {
  try {
    const response = await fetch('/api/legacy-auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { response, result: await response.json().catch(() => ({})) };
  } catch {
    showResetFeedback('Unable to reach the server. Check your connection and try again.', false);
    return null;
  }
}

/** Codes after which the OTP step cannot continue: back to step 1. */
const RESET_RESTART_CODES = ['otp_expired', 'otp_locked_out', 'grant_expired', 'grant_used'];

/** Step 1, and "Resend OTP". */
async function sendResetOtp() {
  if (resetRequestInFlight) return;
  const els = resetDialogElements();
  const identity = String(els.identity?.value || '').trim();
  if (!identity) {
    showResetFeedback('Enter your Employee ID or email address.', false);
    showFieldError(els.identity, 'Enter your Employee ID or email address.');
    return;
  }

  resetRequestInFlight = true;
  if (els.submit) els.submit.disabled = true;
  if (els.resend) els.resend.disabled = true;
  if (resetStage === 'identity' && els.submit) els.submit.textContent = 'Sending...';
  showResetFeedback('', true);

  let cooldown = 0;
  const reply = await postResetStep({ action: 'send', identity });
  resetRequestInFlight = false;
  if (els.submit) { els.submit.disabled = false; els.submit.textContent = RESET_STAGE_LABELS[resetStage]; }

  if (reply) {
    const { response, result } = reply;
    if (!response.ok) {
      showResetFeedback(result.error || 'Unable to send the OTP. Please try again.', false);
      if (response.status === 429) cooldown = Number(response.headers.get('Retry-After')) || RESET_OTP_RESEND_SECONDS;
    } else {
      if (resetStage !== 'otp') setResetStage('otp');
      if (els.otp) { els.otp.value = ''; els.otp.focus(); }
      showResetFeedback(result.message || 'If the account exists, an OTP has been sent.', true);
      cooldown = Number(result.resend_after) || RESET_OTP_RESEND_SECONDS;
    }
  }

  if (cooldown > 0 && resetStage === 'otp') startResetResendCountdown(cooldown);
  else if (els.resend) els.resend.disabled = false;
}

function resendResetOtp() {
  const { resend } = resetDialogElements();
  if (resend?.disabled) return;
  sendResetOtp();
}

/** Step 2. */
async function verifyResetOtp() {
  if (resetRequestInFlight) return;
  const els = resetDialogElements();
  const code = String(els.otp?.value || '').trim();
  if (!/^\d{6}$/.test(code)) {
    showResetFeedback('Enter the 6-digit code from your email.', false);
    showFieldError(els.otp, 'Enter the 6-digit code from your email.');
    return;
  }

  resetRequestInFlight = true;
  if (els.submit) { els.submit.disabled = true; els.submit.textContent = 'Verifying...'; }
  showResetFeedback('', true);

  const reply = await postResetStep({ action: 'verify', code });
  resetRequestInFlight = false;
  if (els.submit) { els.submit.disabled = false; els.submit.textContent = RESET_STAGE_LABELS[resetStage]; }
  if (!reply) return;

  const { response, result } = reply;
  if (!response.ok) {
    showResetFeedback(result.error || 'Unable to verify the OTP. Please try again.', false);
    if (RESET_RESTART_CODES.includes(result.code)) setResetStage('identity');
    else if (els.otp) { els.otp.value = ''; els.otp.focus(); }
    return;
  }

  showResetFeedback(result.message || 'OTP verified. Choose your new password.', true);
  setResetStage('password');
}

/** Step 3. */
async function completeResetPassword() {
  if (resetRequestInFlight) return;
  const els = resetDialogElements();
  const password = String(els.next?.value || '').trim();
  const confirm = String(els.confirm?.value || '').trim();
  const rules = refreshResetRules();
  // The message goes under the field it is about, as well as in the dialog.
  const fail = (message, input) => { showResetFeedback(message, false); showFieldError(input, message); };

  if (!requireFields([
    { field: els.next, label: 'New password' },
    { field: els.confirm, label: 'Confirm password' },
  ])) { showResetFeedback('Fill in both password fields.', false); return; }
  if (!rules.length) { fail(`New password must be ${PASSWORD_MIN_LENGTH}-72 characters.`, els.next); return; }
  if (!rules.spaces) { fail('New password cannot contain spaces.', els.next); return; }
  if (!rules.mix) { fail('New password must contain both letters and numbers.', els.next); return; }
  if (!rules.upper) { fail('New password must contain at least one uppercase letter.', els.next); return; }
  if (!rules.symbol) { fail('New password must contain at least one symbol (e.g. ! @ # $).', els.next); return; }
  if (!rules.match) { fail('Passwords do not match.', els.confirm); return; }

  resetRequestInFlight = true;
  if (els.submit) { els.submit.disabled = true; els.submit.textContent = 'Resetting...'; }
  showResetFeedback('', true);

  const reply = await postResetStep({ action: 'reset', password, confirm_password: confirm });
  if (!reply || !reply.response.ok) {
    resetRequestInFlight = false;
    if (els.submit) { els.submit.disabled = false; els.submit.textContent = RESET_STAGE_LABELS[resetStage]; }
    if (reply) {
      showResetFeedback(reply.result.error || 'Unable to reset your password. Please try again.', false);
      if (RESET_RESTART_CODES.includes(reply.result.code)) setResetStage('identity');
    }
    return;
  }

  showResetFeedback(reply.result.message || 'Your password has been reset.', true);
  if (els.submit) els.submit.textContent = 'Done';
  [els.otp, els.next, els.confirm].forEach((input) => { if (input) input.value = ''; });
  // The reset also signed the account in (same reply shape as a sign-in):
  // go straight to its portal instead of making them sign in again.
  if (reply.result.redirectTo) {
    showResetFeedback('Password updated. Opening your account...', true);
    saveAuthContext(reply.result, reply.result.role || 'employee', reply.result.profile?.email);
    (window.top || window).location.href = reply.result.redirectTo;
    return;
  }
  // Back to a fresh login screen, which shows the success notice.
  setTimeout(() => {
    (window.top || window).location.href = '/login?reason=password_reset';
  }, 1200);
}

/** The dialog's main button runs whichever step is showing. */
function submitResetPassword() {
  if (resetStage === 'otp') return verifyResetOtp();
  if (resetStage === 'password') return completeResetPassword();
  return sendResetOtp();
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

  if (!requireFields([
    { field: 'login-identity-input', label: 'Username or email' },
    { field: 'login-password-input', label: 'Password' },
  ])) return;

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

    if (!response.ok) {
      window.alert(result.error || 'Unable to sign in.');
      return;
    }

    // Two shapes come back, decided server-side by the account's role
    // (src/lib/auth/otp-policy.js) — never by anything the browser sends.
    //
    //   { otp_required: true, masked_email }  Employee / Accountant. No
    //       session exists yet: a code was emailed and has to be verified
    //       before saveAuthContext()/navigation ever happen (verifyLoginOtp()
    //       below finishes it).
    //   { redirectTo, role, profile }         Super Admin / Admin / HR. The
    //       session cookie is already set on this response, so this is the
    //       same completion verifyLoginOtp() performs, reached one step
    //       earlier.
    if (result.otp_required) {
      navigating = true;
      showVerifyOtpScreen(result.masked_email);
      return;
    }

    if (!result.redirectTo) {
      window.alert(result.error || 'Unable to sign in.');
      return;
    }

    saveAuthContext(result, result.role || 'employee', result.profile?.email);
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

/* ── LOGIN, STEP 2: EMAIL OTP ── */
let otpVerifyInFlight = false;
let otpResendCooldownTimer = null;

function showVerifyOtpScreen(maskedEmail) {
  document.getElementById('s-login')?.classList.remove('active');
  document.getElementById('s-verify-otp')?.classList.add('active');

  const sub = document.getElementById('votp-sub');
  if (sub) {
    sub.textContent = maskedEmail
      ? `Enter the code we emailed to ${maskedEmail}.`
      : 'Enter the code we emailed you.';
  }

  const feedback = document.getElementById('votp-feedback');
  if (feedback) { feedback.textContent = ''; feedback.style.color = ''; }

  const codeInput = document.getElementById('votp-code-input');
  if (codeInput) { bindNumericOtpInput(codeInput); codeInput.value = ''; codeInput.focus(); }
}

function showVotpFeedback(message, ok) {
  const feedback = document.getElementById('votp-feedback');
  if (!feedback) return;
  feedback.textContent = message;
  feedback.style.color = ok ? 'var(--green)' : 'var(--red)';
}

async function verifyLoginOtp() {
  if (otpVerifyInFlight) return;

  const code = document.getElementById('votp-code-input')?.value?.trim();
  if (!code) {
    showVotpFeedback('Enter the code from your email.', false);
    showFieldError('votp-code-input', 'Enter the code from your email.');
    return;
  }

  const button = document.getElementById('votp-verify-btn');
  const buttonLabel = button?.textContent;
  otpVerifyInFlight = true;
  if (button) { button.disabled = true; button.textContent = 'Verifying...'; }
  showVotpFeedback('', true);

  let navigating = false;
  try {
    const response = await fetch('/api/legacy-auth/verify-login-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.redirectTo) {
      showVotpFeedback(result.error || 'Unable to verify your code.', false);
      // A lockout or an expired pending sign-in cannot be retried here —
      // send them back to start over rather than let them keep pressing
      // Verify against a state the server has already discarded.
      if (result.code === 'otp_locked_out' || result.code === 'pending_login_expired') {
        setTimeout(cancelLoginOtp, 1800);
      }
      return;
    }

    saveAuthContext(result, result.role || 'employee', result.profile?.email);
    navigating = true;
    window.top.location.href = result.redirectTo;
  } catch {
    showVotpFeedback('Unable to reach the server. Check your connection and try again.', false);
  } finally {
    if (!navigating) {
      otpVerifyInFlight = false;
      if (button) { button.disabled = false; button.textContent = buttonLabel || 'Verify & Sign In'; }
    }
  }
}

function startOtpResendCooldown(seconds) {
  const btn = document.getElementById('votp-resend-btn');
  if (!btn) return;

  clearInterval(otpResendCooldownTimer);
  let remaining = Math.max(1, Math.ceil(seconds));
  btn.disabled = true;

  const tick = () => {
    btn.textContent = `Resend code (${remaining}s)`;
    if (remaining <= 0) {
      clearInterval(otpResendCooldownTimer);
      btn.disabled = false;
      btn.textContent = 'Resend code';
      return;
    }
    remaining -= 1;
  };
  tick();
  otpResendCooldownTimer = setInterval(tick, 1000);
}

async function resendLoginOtp() {
  const btn = document.getElementById('votp-resend-btn');
  if (btn?.disabled) return;

  showVotpFeedback('', true);
  if (btn) btn.disabled = true;

  try {
    const response = await fetch('/api/legacy-auth/resend-login-otp', { method: 'POST' });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      showVotpFeedback(result.error || 'Unable to send a new code.', false);
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('Retry-After')) || 60;
        startOtpResendCooldown(retryAfter);
      } else if (btn) {
        btn.disabled = false;
      }
      if (result.code === 'pending_login_expired') setTimeout(cancelLoginOtp, 1800);
      return;
    }

    showVotpFeedback(result.message || 'A new code has been sent.', true);
    const codeInput = document.getElementById('votp-code-input');
    if (codeInput) { codeInput.value = ''; codeInput.focus(); }
    startOtpResendCooldown(Number(result.resend_after) || 60);
  } catch {
    showVotpFeedback('Unable to reach the server. Check your connection and try again.', false);
    if (btn) btn.disabled = false;
  }
}

/** Abandon the pending sign-in and return to the password screen. The
 * pending-login cookie is left to expire on its own (10 minutes) — it grants
 * nothing without also supplying a code sent to that specific inbox, so there
 * is no security reason to round-trip a dedicated "cancel" call for it. */
function cancelLoginOtp() {
  clearInterval(otpResendCooldownTimer);
  otpVerifyInFlight = false;
  document.getElementById('s-verify-otp')?.classList.remove('active');
  document.getElementById('s-login')?.classList.add('active');
  const passwordInput = document.getElementById('login-password-input');
  if (passwordInput) { passwordInput.value = ''; passwordInput.focus(); }
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

// { background: true } marks a timed refresh, which must not keep an idle
// session alive (src/proxy.js).
async function fetchEmployeeStatsCached(email, { background = false } = {}) {
  const key = String(email || '').trim();
  if (!key) throw new Error('Missing employee email.');

  if (__empStatsCache && __empStatsCache.email === key && __empStatsCache.expiresAt > Date.now()) {
    return __empStatsCache.payload;
  }

  if (!__empStatsInFlight || __empStatsInFlightEmail !== key) {
    __empStatsInFlightEmail = key;
    __empStatsInFlight = fetch(
      `/api/employee/stats?email=${encodeURIComponent(key)}`,
      background ? { headers: { 'x-sacs-background': '1' } } : undefined,
    )
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
 * supabase/migrations/20260914010000_profile_id_fields_and_perf.sql, which also
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
  emergency_contact_number: { maxLength: 11, groups: [4, 3, 4], separator: ' ' },
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

/**
 * The shape rules every new password must meet: the same checks as
 * validateNewPassword() in src/lib/auth/password-policy.js. Used by the
 * change-password checklists and the reset dialog.
 */
function evaluatePasswordShape(next) {
  return {
    length: next.length >= PASSWORD_MIN_LENGTH && next.length <= 72,
    mix: /[A-Za-z]/.test(next) && /\d/.test(next),
    upper: /[A-Z]/.test(next),
    symbol: /[^A-Za-z0-9\s]/.test(next),
    spaces: next.length > 0 && !/\s/.test(next),
  };
}

/** Digits only, at most six (the emailed code's length), for every OTP field. */
function bindNumericOtpInput(input) {
  if (!input || input.dataset.otpBound === '1') return;
  input.dataset.otpBound = '1';
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 6);
    if (digits !== input.value) input.value = digits;
  });
}

/**
 * Draw a code <input> as the six boxes around it (.otp-boxes, css/base.css),
 * like the sign-in screen's code field. The input stays the real field —
 * typing, paste, autofill and every `input.value` read or write work as
 * before; the boxes only mirror it. Writes made in code (`input.value = ''`)
 * redraw too. `onComplete` runs when the sixth digit is typed.
 */
function mountOtpBoxes(input, { onComplete } = {}) {
  const root = input?.closest('[data-otp-boxes]');
  if (!root || input.dataset.otpBoxes === '1') return;
  input.dataset.otpBoxes = '1';
  const boxes = [...root.querySelectorAll('.otp-box')];

  let completed = ''; // the full code onComplete last ran for
  const render = () => {
    const value = String(input.value || '');
    if (value.length < boxes.length) completed = '';
    const focused = document.activeElement === input;
    boxes.forEach((box, i) => {
      box.textContent = value[i] || '';
      box.classList.toggle('is-active', focused && i === Math.min(value.length, boxes.length - 1));
    });
    root.classList.toggle('is-invalid', input.getAttribute('aria-invalid') === 'true');
  };

  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() { return native.get.call(this); },
    set(next) { native.set.call(this, next); render(); },
  });

  input.addEventListener('input', () => {
    render();
    const value = input.value;
    if (value.length === boxes.length && value !== completed && typeof onComplete === 'function') {
      completed = value;
      onComplete();
    }
  });
  // Always type at the end, like the sign-in boxes.
  const toEnd = () => { const n = input.value.length; input.setSelectionRange(n, n); render(); };
  input.addEventListener('focus', toEnd);
  input.addEventListener('click', toEnd);
  input.addEventListener('keyup', render);
  input.addEventListener('blur', render);
  new MutationObserver(render).observe(input, { attributes: true, attributeFilter: ['aria-invalid'] });
  render();
}

/**
 * Disable `button` and count down on its label ("Resend OTP (42s)"), then
 * restore `idleLabel`. Returns the interval id so the caller can cancel it.
 */
function startOtpButtonCountdown(button, seconds, idleLabel) {
  if (!button) return null;
  let remaining = Math.max(1, Math.ceil(seconds));
  button.disabled = true;

  let timer = null;
  const tick = () => {
    if (remaining <= 0) {
      clearInterval(timer);
      button.disabled = false;
      button.textContent = idleLabel;
      return;
    }
    const left = remaining > 120 ? `${Math.ceil(remaining / 60)} min` : `${remaining}s`;
    button.textContent = `${idleLabel} (${left})`;
    remaining -= 1;
  };
  tick();
  timer = setInterval(tick, 1000);
  return timer;
}

/* ── CHANGE PASSWORD: EMAIL OTP STEPS ── */
// Every account changes its password in three steps, on
// the same form, through POST /api/legacy-auth/change-password-otp:
//   1. current password  -> "Send OTP" (the server checks it, then emails a
//                            6-digit code valid for 5 minutes)
//   2. the OTP           -> "Verify OTP"
//   3. new + confirm     -> the form's own Update button
// The new-password fields stay hidden until step 2 passes, and the server
// refuses step 3 without it. Same roles as sign-in's second factor
// (src/lib/auth/otp-policy.js): every role since 2026-10-07. A role the server
// exempts again answers { otp_required: false } and gets the one-step form.
const PASSWORD_CHANGE_OTP_ROLES = ['super_admin', 'admin', 'hr', 'accountant', 'employee'];
const PASSWORD_CHANGE_RESTART_CODES = ['otp_expired', 'otp_locked_out', 'otp_not_verified'];
const passwordChangeFlows = new Map();

function passwordChangeNeedsOtp() {
  const role = String(getAuthContext()?.role || '').toLowerCase();
  return PASSWORD_CHANGE_OTP_ROLES.includes(role);
}

/**
 * Turn a change-password form into the three-step flow. `key` names it
 * (a portal prefix, or 'cp' for the first-sign-in screen). Uses each screen's
 * own field classes so the OTP field matches its neighbours. Returns the flow,
 * or null for roles that change their password in one step.
 */
function mountPasswordChangeSteps({ key, current, next, confirm, rules, submit, finalLabel, wrapperClass, inputClass, report }) {
  if (!passwordChangeNeedsOtp() || !current || !next || !confirm || !submit) return null;
  if (passwordChangeFlows.has(key)) return passwordChangeFlows.get(key);

  const nextWrap = next.closest('.fg, .fl');
  const confirmWrap = confirm.closest('.fg, .fl');
  const otpId = `${key}-pw-otp`;

  const otpWrap = document.createElement('div');
  otpWrap.className = wrapperClass;
  if (wrapperClass === 'fg') otpWrap.style.margin = '0';
  // inputClass is no longer applied to the code field: it is drawn as six
  // boxes, like the sign-in screen's (mountOtpBoxes below).
  void inputClass;
  otpWrap.innerHTML = `
    <label for="${otpId}">Code from your email</label>
    <div style="display:flex;justify-content:center;">
      <div class="otp-boxes" data-otp-boxes>
        <div class="otp-boxes-group"><div class="otp-box"></div><div class="otp-box"></div><div class="otp-box"></div></div>
        <div class="otp-boxes-dash" aria-hidden="true"></div>
        <div class="otp-boxes-group"><div class="otp-box"></div><div class="otp-box"></div><div class="otp-box"></div></div>
        <input id="${otpId}" class="otp-boxes-input" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6" aria-describedby="${otpId}-expiry" />
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;">
      <span id="${otpId}-expiry" style="font-size:12px;color:var(--t3);line-height:1.5;" aria-live="polite">Sent to your registered email. It expires in 5 minutes.</span>
      <button type="button" id="${otpId}-resend" style="background:none;border:none;cursor:pointer;color:var(--amber);font-size:12px;font-weight:500;text-decoration:underline;padding:2px 0;white-space:nowrap;">Resend OTP</button>
    </div>
  `;
  nextWrap.parentElement.insertBefore(otpWrap, nextWrap);

  const flow = {
    key,
    stage: 'current',
    busy: false,
    timer: null,
    current,
    next,
    confirm,
    rules,
    submit,
    finalLabel,
    report: typeof report === 'function' ? report : () => {},
    nextWrap,
    confirmWrap,
    otpWrap,
    otp: document.getElementById(otpId),
    resend: document.getElementById(`${otpId}-resend`),
    expiry: document.getElementById(`${otpId}-expiry`),
    expiryTimer: null,
  };
  bindNumericOtpInput(flow.otp);
  mountOtpBoxes(flow.otp, {
    // The sixth digit verifies at once, as on the sign-in screen.
    onComplete: () => { if (flow.stage === 'otp' && !flow.busy) advancePasswordChangeFlow(flow); },
  });
  flow.resend.addEventListener('click', () => resendPasswordChangeOtp(flow));

  passwordChangeFlows.set(key, flow);
  setPasswordChangeStage(flow, 'current', { focus: false });
  return flow;
}

function passwordChangeStageLabel(flow) {
  if (flow.stage === 'current') return 'Send OTP';
  if (flow.stage === 'otp') return 'Verify OTP';
  return flow.finalLabel;
}

function setPasswordChangeStage(flow, stage, { focus = true } = {}) {
  flow.stage = stage;
  const show = (el, on) => { if (el) el.style.display = on ? '' : 'none'; };
  show(flow.otpWrap, stage === 'otp');
  show(flow.nextWrap, stage === 'verified');
  show(flow.confirmWrap, stage === 'verified');
  show(flow.rules, stage === 'verified');
  flow.current.readOnly = stage !== 'current';
  flow.submit.disabled = false;
  flow.submit.textContent = passwordChangeStageLabel(flow);

  if (stage !== 'otp') {
    clearInterval(flow.timer);
    clearInterval(flow.expiryTimer);
    flow.otp.value = '';
  }
  if (stage === 'current') {
    flow.next.value = '';
    flow.confirm.value = '';
    flow.next.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (focus) {
    const target = { current: flow.current, otp: flow.otp, verified: flow.next }[stage];
    setTimeout(() => target?.focus(), 0);
  }
}

function startPasswordChangeCountdown(flow, seconds) {
  clearInterval(flow.timer);
  flow.timer = startOtpButtonCountdown(flow.resend, seconds, 'Resend OTP');
}

/** "Code expires in 4:59", counting down from a fresh send, as on the sign-in screen. */
function startPasswordChangeExpiry(flow, seconds = 5 * 60) {
  clearInterval(flow.expiryTimer);
  if (!flow.expiry) return;
  const endsAt = Date.now() + seconds * 1000;
  const tick = () => {
    const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    flow.expiry.textContent = left > 0
      ? `Sent to your registered email. Code expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
      : 'This code has expired. Request a new one.';
    if (left <= 0) clearInterval(flow.expiryTimer);
  };
  tick();
  flow.expiryTimer = setInterval(tick, 1000);
}

async function postPasswordChangeStep(flow, payload) {
  try {
    const response = await fetch('/api/legacy-auth/change-password-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { response, result: await response.json().catch(() => ({})) };
  } catch {
    flow.report('Unable to reach the server. Check your connection and try again.', 'err');
    return null;
  }
}

/** Run the step the form is on (steps 1 and 2; step 3 is the normal submit). */
async function advancePasswordChangeFlow(flow) {
  if (flow.busy) return;

  if (flow.stage === 'current') {
    const currentPassword = flow.current.value.trim();
    if (!currentPassword) {
      flow.report('Enter your current password.', 'err');
      showFieldError(flow.current, 'Enter your current password.');
      flow.current.focus();
      return;
    }
    flow.busy = true;
    flow.submit.disabled = true;
    flow.submit.textContent = 'Sending...';
    flow.report('Checking your password and sending the OTP...', 'loading');

    const reply = await postPasswordChangeStep(flow, { action: 'start', current_password: currentPassword });
    flow.busy = false;
    flow.submit.disabled = false;
    flow.submit.textContent = passwordChangeStageLabel(flow);
    if (!reply) return;

    const { response, result } = reply;
    if (!response.ok) {
      flow.report(result.error || 'Unable to send the OTP. Please try again.', 'err');
      return;
    }
    if (result.otp_required === false) {
      // The server says this account changes its password in one step.
      removePasswordChangeSteps(flow);
      flow.report('Enter and confirm your new password.', 'ok');
      return;
    }
    setPasswordChangeStage(flow, 'otp');
    flow.report(result.message || 'An OTP has been sent to your email.', 'ok');
    startPasswordChangeCountdown(flow, Number(result.resend_after) || 60);
    startPasswordChangeExpiry(flow);
    return;
  }

  if (flow.stage === 'otp') {
    const code = flow.otp.value.trim();
    if (!/^\d{6}$/.test(code)) {
      flow.report('Enter the 6-digit code from your email.', 'err');
      showFieldError(flow.otp, 'Enter the 6-digit code from your email.');
      flow.otp.focus();
      return;
    }
    flow.busy = true;
    flow.submit.disabled = true;
    flow.submit.textContent = 'Verifying...';
    flow.report('', '');

    const reply = await postPasswordChangeStep(flow, { action: 'verify', code });
    flow.busy = false;
    flow.submit.disabled = false;
    flow.submit.textContent = passwordChangeStageLabel(flow);
    if (!reply) return;

    const { response, result } = reply;
    if (!response.ok) {
      flow.report(result.error || 'Unable to verify the OTP. Please try again.', 'err');
      if (PASSWORD_CHANGE_RESTART_CODES.includes(result.code)) setPasswordChangeStage(flow, 'current');
      else { flow.otp.value = ''; flow.otp.focus(); }
      return;
    }
    setPasswordChangeStage(flow, 'verified');
    flow.report(result.message || 'OTP verified. Enter your new password.', 'ok');
  }
}

async function resendPasswordChangeOtp(flow) {
  if (flow.busy || flow.resend.disabled || flow.stage !== 'otp') return;
  flow.resend.disabled = true;
  const reply = await postPasswordChangeStep(flow, { action: 'resend' });
  if (!reply) { flow.resend.disabled = false; return; }

  const { response, result } = reply;
  if (!response.ok) {
    flow.report(result.error || 'Unable to send a new OTP.', 'err');
    if (PASSWORD_CHANGE_RESTART_CODES.includes(result.code)) {
      setPasswordChangeStage(flow, 'current');
    } else if (response.status === 429) {
      startPasswordChangeCountdown(flow, Number(response.headers.get('Retry-After')) || 60);
    } else {
      flow.resend.disabled = false;
    }
    return;
  }
  flow.report(result.message || 'A new OTP has been sent.', 'ok');
  flow.otp.value = '';
  flow.otp.focus();
  startPasswordChangeCountdown(flow, Number(result.resend_after) || 60);
  startPasswordChangeExpiry(flow);
}

/** Back to step 1 (after a change, or when the form is closed). */
function resetPasswordChangeFlow(key) {
  const flow = passwordChangeFlows.get(key);
  if (flow && !flow.busy) setPasswordChangeStage(flow, 'current', { focus: false });
}

/** For an account the server exempts: show the plain one-step form again. */
function removePasswordChangeSteps(flow) {
  clearInterval(flow.timer);
  clearInterval(flow.expiryTimer);
  flow.otpWrap.remove();
  [flow.nextWrap, flow.confirmWrap, flow.rules].forEach((el) => { if (el) el.style.display = ''; });
  flow.current.readOnly = false;
  flow.submit.textContent = flow.finalLabel;
  passwordChangeFlows.delete(flow.key);
}

function evaluatePasswordRules(current, next, confirm, ctx) {
  return {
    length: next.length >= PASSWORD_MIN_LENGTH,
    mix: /[A-Za-z]/.test(next) && /\d/.test(next),
    upper: /[A-Z]/.test(next),
    symbol: /[^A-Za-z0-9\s]/.test(next),
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
  if (!rules.upper) return { ok: false, message: 'New password must contain at least one uppercase letter.' };
  if (!rules.symbol) return { ok: false, message: 'New password must contain at least one symbol (e.g. ! @ # $).' };
  if (!rules.different) return { ok: false, message: 'New password must be different from your current password.' };
  if (!rules['not-default']) return { ok: false, message: 'New password cannot be your default password (last name + birth date).' };

  try {
    const response = await fetch('/api/legacy-auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: current, new_password: next, confirm_password: confirm }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, message: result.error || 'Failed to update password.', code: result.code };

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
  // The section's "Update Password" button, disabled while the request runs.
  const submitButton = document.getElementById(`${prefix}-pw-rules`)?.parentElement?.querySelector('button.btn-primary');
  if (submitButton?.disabled) return;

  // Employee / Accountant: steps 1 and 2 (current password, OTP) first.
  const flow = passwordChangeFlows.get(prefix);
  if (flow && flow.stage !== 'verified') {
    advancePasswordChangeFlow(flow);
    return;
  }

  const show = (message, state) => {
    if (!feedback) return;
    feedback.textContent = message;
    feedback.className = `adm-feedback${state ? ` ${state}` : ''}`;
    feedback.style.color = '';
  };

  if (!requireFields([
    { field: currentId, label: 'Current password' },
    { field: newId, label: 'New password' },
    { field: confirmId, label: 'Confirm password' },
  ])) {
    show('Fill in the highlighted fields.', 'err');
    return;
  }

  show('Updating password...', 'loading');
  if (submitButton) submitButton.disabled = true;
  let result;
  try {
    result = await requestPasswordChange(
      document.getElementById(currentId)?.value,
      document.getElementById(newId)?.value,
      document.getElementById(confirmId)?.value,
    );
  } finally {
    if (submitButton) submitButton.disabled = false;
  }

  if (!result.ok) {
    show(result.message, 'err');
    // Point at the field the message is about.
    if (/do not match/i.test(result.message)) showFieldError(confirmId, result.message);
    else if (/^new password/i.test(result.message)) showFieldError(newId, result.message);
    else if (/current password/i.test(result.message)) showFieldError(currentId, result.message);
    if (flow && PASSWORD_CHANGE_RESTART_CODES.includes(result.code)) setPasswordChangeStage(flow, 'current');
    return;
  }
  resetPasswordChangeFlow(prefix);

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

  const feedback = document.getElementById(ids.feedback || `${prefix}-change-password-feedback`);
  mountPasswordChangeSteps({
    key: prefix,
    current,
    next,
    confirm,
    rules: rulesList,
    submit: rulesList.parentElement?.querySelector('button.btn-primary'),
    finalLabel: 'Update Password',
    wrapperClass: 'fg',
    inputClass: 'fc',
    report: (message, state) => {
      if (!feedback) return;
      feedback.textContent = message;
      feedback.className = `adm-feedback${state ? ` ${state}` : ''}`;
      feedback.style.color = '';
    },
  });

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
  // This screen only appears right after a sign-in whose OTP was already
  // verified, so the password is changed in one step here -- no second OTP.
  // (Account Settings still uses the emailed-code steps.) The server agrees:
  // change-password skips the OTP grant while the session is flagged.
  const firstSignInNeedsOtp = false;
  const flow = !firstSignInNeedsOtp ? null : mountPasswordChangeSteps({
    key: 'cp',
    current,
    next,
    confirm,
    rules: document.getElementById('cp-rules'),
    submit,
    finalLabel: 'Update password & continue',
    wrapperClass: 'fl',
    inputClass: 'fi',
    report: (message, state) => {
      feedback.textContent = message;
      feedback.className = `cp-feedback${state === 'ok' || state === 'err' ? ` ${state}` : ''}`;
    },
  });

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

    // Employee / Accountant: current password, then the OTP, first.
    if (flow && flow.stage !== 'verified') {
      advancePasswordChangeFlow(flow);
      return;
    }

    if (!requireFields([
      { field: current, label: 'Current password' },
      { field: next, label: 'New password' },
      { field: confirm, label: 'Confirm password' },
    ])) {
      feedback.textContent = 'Fill in the highlighted fields.';
      feedback.className = 'cp-feedback err';
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Updating...';
    feedback.textContent = '';
    feedback.className = 'cp-feedback';

    const result = await requestPasswordChange(current.value, next.value, confirm.value);
    if (!result.ok) {
      feedback.textContent = result.message;
      feedback.className = 'cp-feedback err';
      if (/do not match/i.test(result.message)) showFieldError(confirm, result.message);
      else if (/^new password/i.test(result.message)) showFieldError(next, result.message);
      else if (/current password/i.test(result.message)) showFieldError(current, result.message);
      submit.disabled = false;
      submit.textContent = 'Update password & continue';
      if (flow && PASSWORD_CHANGE_RESTART_CODES.includes(result.code)) setPasswordChangeStage(flow, 'current');
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
  account_changed: 'Your role or branch was changed by an administrator. Please sign in again.',
  session_expired: 'Your session has expired. Please sign in again.',
  password_reset: 'Your password has been reset. Sign in with your new password.',
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
    const logo = document.createElement('img');
    logo.className = 'brand-logo sitemap-logo';
    logo.src = 'assets/logo-160.png';
    logo.alt = 'Shepherd Angels Christian School seal';
    logo.width = 44;
    logo.height = 44;
    const text = document.createElement('div');
    text.className = 'sitemap-text';
    text.append(title, sub);
    head.append(logo, text, close);
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
  // The system has a single (light) theme. Drop any mode an older build
  // saved so it can never come back.
  try { localStorage.removeItem('sacs-theme'); } catch (e) { /* blocked storage */ }

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
          if (event.target?.tagName === 'INPUT' && resetModal.contains(event.target)) submitResetPassword();
          return;
        }
        login();
      }

      const verifyOtpScreen = document.getElementById('s-verify-otp');
      if (verifyOtpScreen && verifyOtpScreen.classList.contains('active')) {
        verifyLoginOtp();
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
  window.resendResetOtp = resendResetOtp;
  window.toggleLoginPasswordVisibility = toggleLoginPasswordVisibility;
  window.login = login;
  window.logout = logout;
  window.verifyLoginOtp = verifyLoginOtp;
  window.resendLoginOtp = resendLoginOtp;
  window.cancelLoginOtp = cancelLoginOtp;
  window.createPaginator = createPaginator;
  window.paginatorGoTo = paginatorGoTo;
  window.skeletonRows = skeletonRows;
  window.skeletonCards = skeletonCards;
  window.printDocument = printDocument;
  window.showFieldError = showFieldError;
  window.clearFieldError = clearFieldError;
  window.requireFields = requireFields;
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

/* ══════════════════════════════════════════════════════════════════════════
   ATTENDANCE STATUSES, STATUS BOARD AND CORRECTIONS
   Every status is computed by the database (trigger attendance_logs_compute_
   status, supabase/migrations/20260926010000_attendance_status_engine.sql).
   These helpers only display them, and drive:
     - the status board on the Admin / HR / Super Admin Attendance pages
       (All Records, Incomplete Queue, Correction Requests), and
     - the employee's "This Pay Period" card with Request Correction.
   ══════════════════════════════════════════════════════════════════════════ */

const ATTENDANCE_STATUS_LIST = [
  'On Time', 'Early Bird', 'Late', 'Undertime', 'Half Day', 'Absent',
  'Incomplete', 'Pending Correction', 'Corrected', 'On Leave', 'Holiday',
];

// green: On Time / Early Bird, yellow: Late / Undertime, orange: Half Day,
// red: Absent, gray: Incomplete (and awaiting review), blue: Corrected and
// On Leave (a working day covered by approved leave), teal: Holiday (no tap
// on a holiday or whole-day suspension).
const ATTENDANCE_STATUS_TONE = {
  'On Time': 'var(--green)',
  'Early Bird': 'var(--green)',
  Late: 'var(--yellow)',
  Undertime: 'var(--yellow)',
  'Half Day': 'var(--orange)',
  Absent: 'var(--red)',
  Incomplete: 'var(--t2)',
  'Pending Correction': 'var(--t2)',
  Corrected: 'var(--blue)',
  'On Leave': 'var(--blue)',
  Holiday: 'var(--teal)',
};

const ATTENDANCE_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Canonical label; a pre-engine "Present" reads as On Time. */
function normalizeAttendanceStatusLabel(status) {
  const key = String(status || '').trim().toLowerCase();
  if (!key) return '—';
  if (key === 'present') return 'On Time';
  return ATTENDANCE_STATUS_LIST.find((s) => s.toLowerCase() === key) || String(status);
}

function attendanceStatusColor(status) {
  return ATTENDANCE_STATUS_TONE[normalizeAttendanceStatusLabel(status)] || 'var(--t2)';
}

/** The colour-coded badge every attendance table uses. */
function attendanceStatusBadge(status) {
  const label = normalizeAttendanceStatusLabel(status);
  const color = attendanceStatusColor(label);
  return `<span class="badge" style="color:${color};background:color-mix(in srgb, ${color} 12%, transparent);border:1px solid color-mix(in srgb, ${color} 25%, transparent);">${escapeHtml(label)}</span>`;
}

/** Present / late / absent / leave class for the employee's month calendar. */
function attendanceCalendarClass(status) {
  const label = normalizeAttendanceStatusLabel(status);
  if (label === 'Absent') return 'ab';
  if (label === 'On Leave') return 'lv';
  if (label === 'Holiday') return 'hol';
  if (label === 'Late' || label === 'Undertime' || label === 'Half Day') return 'lt';
  if (label === 'On Time' || label === 'Early Bird' || label === 'Corrected') return 'pr';
  return '';
}

function attendanceStatusLegend() {
  return `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">${
    ['On Time', 'Early Bird', 'Late', 'Undertime', 'Half Day', 'Absent', 'Incomplete', 'Corrected', 'On Leave', 'Holiday']
      .map((s) => attendanceStatusBadge(s)).join('')
  }</div>`;
}

/* ── UPCOMING HOLIDAYS (dashboards) ──
   The next holidays and suspensions from /api/admin/holidays?upcoming=5,
   kept for five minutes so a dashboard refresh does not refetch them. */
const upcomingHolidaysCache = { at: 0, data: null };

async function mountUpcomingHolidays(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  try {
    if (!upcomingHolidaysCache.data || Date.now() - upcomingHolidaysCache.at > 5 * 60 * 1000) {
      const res = await fetch('/api/admin/holidays?upcoming=5', { headers: { 'x-sacs-background': '1' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Unable to load holidays.');
      upcomingHolidaysCache.data = data;
      upcomingHolidaysCache.at = Date.now();
    }
    const { holidays = [], today = '' } = upcomingHolidaysCache.data;
    if (!holidays.length) {
      el.innerHTML = '<div class="ai-item"><div class="ai2"><div class="s">No upcoming holidays saved.</div></div></div>';
      return;
    }
    const todayTime = today ? new Date(`${today}T00:00:00+08:00`).getTime() : Date.now();
    el.innerHTML = holidays.map((holiday) => {
      const date = new Date(`${holiday.holiday_date}T00:00:00+08:00`);
      const day = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', day: 'numeric' }).format(date);
      const when = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(date);
      const daysAway = Math.round((date.getTime() - todayTime) / 86400000);
      const away = daysAway <= 0 ? 'Today' : daysAway === 1 ? 'Tomorrow' : `In ${daysAway} days`;
      const kind = [holiday.type_label, holiday.day_part_label].filter(Boolean).join(' · ');
      return `
        <div class="ai-item">
          <div class="av" style="width:32px;height:32px;font-size:11px;background:var(--teal);">${escapeHtml(day)}</div>
          <div class="ai2">
            <div class="n">${escapeHtml(holiday.name || 'Holiday')}</div>
            <div class="s">${escapeHtml(when)} · ${escapeHtml(kind)}</div>
          </div>
          <div class="air"><div class="st" style="font-size:11px;color:var(--t3);">${escapeHtml(away)}</div></div>
        </div>`;
    }).join('');
  } catch (error) {
    el.innerHTML = `<div class="ai-item"><div class="ai2"><div class="s">${escapeHtml(error.message)}</div></div></div>`;
  }
}

/** "Bonifacio Day, Nov 30 (8 h)": one holiday worked, from a payslip's holiday_lines. */
function holidayLineLabel(line) {
  const date = line?.date ? new Date(`${line.date}T00:00:00+08:00`) : null;
  const when = date && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' }).format(date)
    : '';
  const hours = line?.hours !== null && line?.hours !== undefined ? ` (${line.hours} h)` : '';
  return `${line?.name || 'Holiday'}${when ? `, ${when}` : ''}${hours}`;
}

/** "Sick Leave · Sep 28 – Sep 29, 2026 · With pay · Approved by …" for an On Leave day. */
function attendanceLeaveSummary(leave) {
  if (!leave) return 'Approved leave';
  const fmt = (key) => {
    const date = new Date(`${key}T00:00:00+08:00`);
    if (!key || Number.isNaN(date.getTime())) return key || '—';
    return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  };
  const range = leave.start_date === leave.end_date ? fmt(leave.start_date) : `${fmt(leave.start_date)} – ${fmt(leave.end_date)}`;
  const parts = [leave.leave_type || 'Leave', range, leave.pay_status === 'without_pay' ? 'Without pay' : 'With pay'];
  if (leave.approved_by) parts.push(`Approved by ${leave.approved_by}`);
  return parts.join(' · ');
}

function attManilaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function attFormatTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hour12: true }).format(date);
}

function attFormatDate(key) {
  if (!key) return '—';
  const date = new Date(`${key}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return key;
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: '2-digit', year: 'numeric', weekday: 'short' }).format(date);
}

function attFormatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true }).format(date);
}

function attMinutes(value) {
  const minutes = Number(value || 0);
  return minutes > 0 ? `${minutes} min` : '—';
}

/** Worked minutes of a day with both taps; null when it has no time out. */
function attWorkedMinutes(row) {
  if (!row || !row.time_in || !row.time_out) return null;
  const ms = new Date(row.time_out) - new Date(row.time_in);
  if (Number.isFinite(ms)) return Math.max(0, Math.round(ms / 60000));
  return Math.max(0, Math.round(Number(row.total_hours || 0) * 60));
}

/** 122 -> "2h 02m". */
function attHoursMinutes(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

/** The Hours column: "0h 02m" rather than "0.03". */
function attFormatHours(row) {
  const minutes = attWorkedMinutes(row);
  return minutes === null ? '—' : attHoursMinutes(minutes);
}

/** "HH:MM" (24h, Manila) of an instant, for a time input. */
function attTimeInputValue(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

/** The current pay period and the ones before it, newest first. */
function attPayPeriodLabels(count = 6) {
  let [year, month, day] = attManilaDateKey().split('-').map(Number);
  let firstHalf = day <= 15;
  const labels = [];
  for (let i = 0; i < count; i += 1) {
    const last = firstHalf ? 15 : new Date(Date.UTC(year, month, 0)).getUTCDate();
    labels.push(`${ATTENDANCE_MONTHS[month - 1]} ${firstHalf ? 1 : 16}-${last}, ${year}`);
    if (firstHalf) {
      firstHalf = false;
      month -= 1;
      if (month === 0) { month = 12; year -= 1; }
    } else {
      firstHalf = true;
    }
  }
  return labels;
}

async function attFetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Request failed.');
    error.status = response.status;
    throw error;
  }
  return data;
}

// A correction on a day a Final payslip counted: the payslip does not change
// by itself (src/lib/payroll/final-payslips.js), so the reviewer is told.
function attPayrollNotice(result) {
  if (result?.payroll_notice) window.pushNotification?.('Final Payslip Not Updated', result.payroll_notice, 'info');
}

/* ── STATUS BOARD (Admin / HR / Super Admin) ── */
const attendanceBoards = new Map();

function mountAttendanceBoard(rootId, { branchFilter = false } = {}) {
  const root = document.getElementById(rootId);
  if (!root) return;
  if (attendanceBoards.has(rootId)) {
    refreshAttendanceBoard(rootId);
    return;
  }

  const id = escapeHtml(rootId);
  const periods = attPayPeriodLabels(6);
  root.innerHTML = `
    <div class="card" style="margin-top:14px;">
      <div class="sh" style="margin-bottom:12px;flex-wrap:wrap;gap:10px;">
        <span class="stitle">Attendance Status</span>
        <span class="sp"></span>
        <select class="fc" id="${id}-period" style="max-width:220px;" aria-label="Pay period">
          ${periods.map((label) => `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`).join('')}
        </select>
        <button class="btn btn-outline" type="button" data-att-refresh>Refresh</button>
      </div>
      <div class="status-tabs" role="tablist">
        <button class="st-tab st-active" type="button" data-att-tab="all">All Records</button>
        <button class="st-tab" type="button" data-att-tab="incomplete">Incomplete Queue <span id="${id}-incomplete-count"></span></button>
        <button class="st-tab" type="button" data-att-tab="corrections">Correction Requests <span id="${id}-corrections-count"></span></button>
        <button class="st-tab" type="button" data-att-tab="overtime">Overtime <span id="${id}-overtime-count"></span></button>
        <button class="st-tab" type="button" data-att-tab="blocked">Blocked Taps <span id="${id}-blocked-count"></span></button>
      </div>
      <div id="${id}-legend">${attendanceStatusLegend()}</div>
      <div id="${id}-filter-wrap" style="margin-bottom:12px;display:flex;flex-wrap:wrap;gap:10px;">
        <select class="fc" id="${id}-branch" style="max-width:240px;display:none;" aria-label="Branch"><option value="">All Branches</option></select>
        <select class="fc" id="${id}-status" style="max-width:240px;" aria-label="Status">
          <option value="all">All statuses</option>
          ${ATTENDANCE_STATUS_LIST.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}
        </select>
        <select class="fc" id="${id}-date" style="max-width:260px;" aria-label="Day">
          <option value="all">All days</option>
        </select>
      </div>
      <p id="${id}-note" style="font-size:12px;color:var(--t3);margin-bottom:12px;"></p>
      <div class="tw"><table>
        <thead id="${id}-head"></thead>
        <tbody id="${id}-body">${skeletonRows(8)}</tbody>
      </table></div>
      <div class="pg-bar" id="${id}-board-pg"></div>
      <p id="${id}-feedback" class="adm-feedback" style="margin-top:10px;"></p>
    </div>`;

  const board = {
    rootId,
    tab: 'all',
    period: periods[0],
    status: 'all',
    // One day of the period, or every day ('all') grouped under day headings.
    date: 'all',
    branch: '',
    logs: [],
    corrections: [],
    overtime: [],
    blocked: [],
    overtimeCanReview: false,
    overtimeMinMinutes: 30,
    canReview: false,
    loading: false,
    paginator: null,
    // Branch grouping (every board but an employee's own): collapsed branch
    // sections, branch names, and each employee's current branch.
    scope: '',
    groupByBranch: false,
    collapsed: new Set(),
    branchNames: new Map(),
    employeeBranch: new Map(),
  };
  board.paginator = createPaginator({ id: `${rootId}-board`, pageSize: 20, renderFn: (rows) => renderAttendanceBoardRows(board, rows) });
  attendanceBoards.set(rootId, board);

  root.querySelector('[data-att-refresh]')?.addEventListener('click', () => refreshAttendanceBoard(rootId));
  root.querySelectorAll('[data-att-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      root.querySelectorAll('[data-att-tab]').forEach((b) => b.classList.toggle('st-active', b === button));
      board.tab = button.getAttribute('data-att-tab');
      renderAttendanceBoard(board);
    });
  });
  document.getElementById(`${rootId}-period`)?.addEventListener('change', (event) => {
    board.period = event.target.value;
    board.date = 'all';
    refreshAttendanceBoard(rootId);
  });
  document.getElementById(`${rootId}-status`)?.addEventListener('change', (event) => {
    board.status = event.target.value;
    renderAttendanceBoard(board);
  });
  // Branch filter: applied on the loaded rows, on every tab.
  document.getElementById(`${rootId}-branch`)?.addEventListener('change', (event) => {
    board.branch = event.target.value;
    renderAttendanceBoard(board);
  });
  document.getElementById(`${rootId}-date`)?.addEventListener('change', (event) => {
    board.date = event.target.value;
    renderAttendanceBoard(board);
  });

  // Every branch by name, including ones with no rows yet (the rows' own
  // branch names fill in when this list cannot be read).
  fetchBranchesCached({ activeOnly: !branchFilter }).then((branches) => {
    (branches || []).forEach((b) => { if (b?.id) board.branchNames.set(String(b.id), b.name || 'Branch'); });
    renderAttendanceBranchOptions(board);
  }).catch(() => {});

  refreshAttendanceBoard(rootId);
}

async function refreshAttendanceBoard(rootId) {
  const board = attendanceBoards.get(rootId);
  if (!board || board.loading) return;
  board.loading = true;
  const body = document.getElementById(`${rootId}-body`);
  if (body) body.innerHTML = skeletonRows(8);
  attBoardFeedback(board, '');

  try {
    const params = new URLSearchParams({ period: board.period });
    const [logsData, correctionsData, overtimeData] = await Promise.all([
      attFetchJson(`/api/attendance/logs?${params}`),
      attFetchJson('/api/attendance/corrections?status=pending').catch(() => ({ corrections: [] })),
      attFetchJson(`/api/attendance/overtime?${params}`).catch(() => ({ overtime: [] })),
    ]);
    // One row per employee per day (a real record wins over a "no tap yet" one).
    board.logs = attOneRowPerDay(logsData.logs || []);
    board.canReview = Boolean(logsData.can_review);
    board.scope = String(logsData.scope || '');
    board.groupByBranch = board.scope !== 'self';
    board.employeeBranch = new Map();
    board.logs.forEach((row) => {
      const branch = String(row.group_branch_id || row.branch_id || '');
      if (row.employee_id && branch) board.employeeBranch.set(String(row.employee_id), branch);
      if (branch && row.branch_name && !board.branchNames.has(branch)) board.branchNames.set(branch, row.branch_name);
    });
    board.engineReady = logsData.engine_ready !== false;
    board.corrections = correctionsData.corrections || [];
    board.overtime = overtimeData.overtime || [];
    board.blocked = logsData.blocked_taps || [];
    board.overtimeCanReview = Boolean(overtimeData.can_review);
    board.overtimeMinMinutes = Number(overtimeData.min_minutes) || 30;
  } catch (error) {
    board.logs = [];
    board.corrections = [];
    board.overtime = [];
    board.blocked = [];
    attBoardFeedback(board, error.message, true);
  } finally {
    board.loading = false;
    renderAttendanceBoard(board);
  }
}

function attBoardFeedback(board, message, isError = false) {
  const el = document.getElementById(`${board.rootId}-feedback`);
  if (!el) return;
  el.textContent = message || '';
  el.className = `adm-feedback${message ? (isError ? ' err' : ' ok') : ''}`;
}

function renderAttendanceBoard(board) {
  const id = board.rootId;
  // The branch filter narrows every tab.
  const inBranch = (row) => !board.branch || attRowBranchId(board, row) === board.branch;
  const logs = board.logs.filter(inBranch);
  const corrections = board.corrections.filter(inBranch);
  const overtime = board.overtime.filter(inBranch);
  const blocked = board.blocked.filter(inBranch);
  const incomplete = logs.filter((row) => row.status === 'Incomplete' || row.status === 'Pending Correction');
  const setCount = (suffix, n) => {
    const el = document.getElementById(`${id}-${suffix}`);
    if (el) el.textContent = n ? `(${n})` : '';
  };
  setCount('incomplete-count', incomplete.length);
  setCount('corrections-count', corrections.length);
  // Waiting for a decision (and still decidable).
  setCount('overtime-count', overtime.filter((row) => !row.approval && !row.locked).length);
  setCount('blocked-count', blocked.length);

  const head = document.getElementById(`${id}-head`);
  const note = document.getElementById(`${id}-note`);
  const filterWrap = document.getElementById(`${id}-filter-wrap`);
  const legend = document.getElementById(`${id}-legend`);
  const statusSelect = document.getElementById(`${id}-status`);
  const dateSelect = document.getElementById(`${id}-date`);
  renderAttendanceBranchOptions(board);
  const branchVisible = board.groupByBranch && board.branchNames.size > 0;
  if (filterWrap) filterWrap.style.display = board.tab === 'all' || branchVisible ? '' : 'none';
  if (statusSelect) statusSelect.style.display = board.tab === 'all' ? '' : 'none';
  if (dateSelect) dateSelect.style.display = board.tab === 'all' ? '' : 'none';
  if (legend) legend.style.display = board.tab === 'corrections' || board.tab === 'overtime' || board.tab === 'blocked' ? 'none' : '';

  renderAttendanceDateOptions(board);

  // The day filter applies before the status chips count, so each chip says
  // how many of the visible days' rows it would show.
  const dayRows = logs.filter((row) => board.date === 'all' || row.log_date === board.date);
  if (legend) legend.innerHTML = board.tab === 'all' ? attendanceStatusChips(board, dayRows) : attendanceStatusLegend();

  let rows;
  let groupSource = null;
  if (board.tab === 'incomplete') {
    if (head) head.innerHTML = `<tr><th>Employee</th><th>Date</th><th>Time In</th><th>Time Out</th><th>Status</th>${board.canReview ? '<th>Action</th>' : ''}</tr>`;
    if (note) note.textContent = 'Days with a time in but no time out after the shift ended. They are left out of payroll until resolved — by the employee\'s correction request, by recording the time out (or Absent / Half Day) here, or with Correct.';
    rows = attSortByDay(incomplete);
    groupSource = incomplete;
  } else if (board.tab === 'overtime') {
    if (head) head.innerHTML = `<tr><th>Employee</th><th>Date</th><th>Time Out</th><th>Past Schedule</th><th>Decision</th>${board.overtimeCanReview ? '<th>Action</th>' : ''}</tr>`;
    if (note) note.textContent = `Days whose time out is at least ${board.overtimeMinMinutes} minutes after the branch's end of shift. Payroll pays overtime only for the minutes approved here (hourly rate plus the overtime premium in Payroll Rates). Decisions lock once that pay period is processed.`;
    rows = attSortByDay(overtime);
  } else if (board.tab === 'blocked') {
    if (head) head.innerHTML = '<tr><th>Employee</th><th>Date</th><th>Attempted</th><th>Source</th><th>Reason</th></tr>';
    if (note) note.textContent = 'RFID taps that were refused: an unregistered card, an inactive employee, another branch\'s card, or an employee on approved leave. Nothing was recorded for them. Tapping again soon after a tap is never refused.';
    rows = attSortByDay(blocked);
  } else if (board.tab === 'corrections') {
    if (head) head.innerHTML = `<tr><th>Employee</th><th>Date</th><th>Recorded</th><th>Requested Time Out</th><th>Reason</th><th>Requested</th>${board.canReview ? '<th>Action</th>' : ''}</tr>`;
    if (note) note.textContent = 'Approving replaces the time out and marks the day Corrected. Rejecting keeps it Incomplete (out of payroll) or sets it to Absent or Half Day. Correct enters different times yourself and closes the request.';
    rows = corrections;
  } else {
    if (head) head.innerHTML = `<tr><th>Employee</th><th>Date</th><th>Time In</th><th>Time Out</th><th>Hours</th><th>Late</th><th>Undertime</th><th>Status</th>${board.canReview ? '<th>Action</th>' : ''}</tr>`;
    if (note) {
      note.textContent = board.engineReady === false
        ? 'Automatic statuses are not active yet: apply the attendance database migration (20260926010000_attendance_status_engine.sql).'
        : `Statuses are computed automatically from each branch's schedule. Today's list includes everyone who has not tapped yet.${board.canReview ? ' Use Correct on any day to fix a wrong time in or time out, or to record a day someone worked but did not tap.' : ''}`;
    }
    rows = attSortByDay(dayRows.filter((row) => board.status === 'all' || row.status === board.status));
    groupSource = dayRows;
  }

  // Branch first, then day (newest first), then employee (A–Z).
  if (groupSource && board.groupByBranch) {
    rows = attSortByBranchDay(board, rows);
    attComputeBranchCounts(board, groupSource);
  }

  // Day headings count the whole day, not just the rows on the current page.
  board.dayCounts = board.groupByBranch && groupSource ? attBranchDayCounts(board, rows) : attDayCounts(rows);
  board.paginator.setData(groupSource && board.groupByBranch ? attApplyCollapsed(board, rows) : rows);
  if (!rows.length) {
    const body = document.getElementById(`${id}-body`);
    const cols = board.tab === 'overtime'
      ? 5 + (board.overtimeCanReview ? 1 : 0)
      : board.tab === 'blocked' ? 5
        : (board.tab === 'all' ? 8 : board.tab === 'incomplete' ? 5 : 6) + (board.canReview ? 1 : 0);
    const empty = board.tab === 'blocked' ? 'No taps were blocked in this period.'
      : board.tab === 'corrections' ? 'No correction requests waiting.'
      : board.tab === 'incomplete' ? 'Nothing to resolve.'
        : board.tab === 'overtime' ? 'No overtime in this period.'
          : board.date !== 'all' ? 'No attendance records for this day.'
            : 'No attendance records for this period.';
    if (body) body.innerHTML = `<tr><td colspan="${cols}" style="color:var(--t3);">${empty}</td></tr>`;
  }
}

function renderAttendanceBoardRows(board, rows) {
  const body = document.getElementById(`${board.rootId}-body`);
  if (!body) return;
  const key = escapeJsArg(board.rootId);

  if (board.tab === 'overtime') {
    const overtimeRows = rows.map((row) => {
      const approval = row.approval;
      const decision = approval
        ? (approval.status === 'approved'
          ? `<span class="badge bg"><span class="bd"></span>Approved ${escapeHtml(attMinutes(approval.approved_minutes))}</span>`
          : '<span class="badge br"><span class="bd"></span>Rejected</span>')
        : '<span class="badge ba"><span class="bd"></span>Waiting</span>';
      const action = row.locked
        ? '<span style="font-size:12px;color:var(--t3);">Payroll processed</span>'
        : `<button class="btn ${approval ? 'btn-outline' : 'btn-primary'}" type="button" style="padding:5px 12px;font-size:12px;" onclick="openOvertimeReview('${key}','${escapeJsArg(row.log_id)}')">${approval ? 'Change' : 'Review'}</button>`;
      return `
      <tr>
        <td class="nm">${escapeHtml(row.employee_name || '—')}</td>
        <td>${escapeHtml(attFormatDate(row.log_date))}</td>
        <td class="mn">${escapeHtml(attFormatTime(row.time_out))}<div style="font-size:11px;color:var(--t3);">Shift ends ${escapeHtml(row.work_end || '')}</div></td>
        <td class="mn">${escapeHtml(attMinutes(row.overtime_minutes))}</td>
        <td>${decision}${approval?.decided_by_name ? `<div style="font-size:11px;color:var(--t3);margin-top:3px;">by ${escapeHtml(approval.decided_by_name)}</div>` : ''}</td>
        ${board.overtimeCanReview ? `<td>${action}</td>` : ''}
      </tr>`;
    });
    body.innerHTML = attWithDayHeadings(board, rows, overtimeRows, 5 + (board.overtimeCanReview ? 1 : 0));
    return;
  }

  if (board.tab === 'blocked') {
    const blockedRows = rows.map((row) => `
      <tr>
        <td class="nm">${escapeHtml(row.employee_name || (row.employee_id ? '—' : `Unregistered card ${row.rfid_code || ''}`.trim()))}</td>
        <td>${escapeHtml(attFormatDate(row.log_date))}</td>
        <td class="mn">${escapeHtml(attFormatDateTime(row.attempted_at))}</td>
        <td>${row.source === 'manual_entry' ? 'Manual entry' : 'RFID terminal'}</td>
        <td style="max-width:280px;white-space:normal;">${escapeHtml(row.reason || '')}</td>
      </tr>`);
    body.innerHTML = attWithDayHeadings(board, rows, blockedRows, 5);
    return;
  }

  if (board.tab === 'corrections') {
    body.innerHTML = rows.map((c) => `
      <tr>
        <td class="nm">${escapeHtml(c.employee_name || '—')}</td>
        <td>${escapeHtml(attFormatDate(c.log_date))}</td>
        <td class="mn">${escapeHtml(attFormatTime(c.original_time_in))} – ${escapeHtml(attFormatTime(c.original_time_out))}<div style="margin-top:4px;">${attendanceStatusBadge(c.original_status)}</div></td>
        <td class="mn">${escapeHtml(attFormatTime(c.corrected_time_out))}</td>
        <td style="max-width:260px;white-space:normal;">${escapeHtml(c.reason || '')}</td>
        <td>${escapeHtml(attFormatDateTime(c.requested_at))}</td>
        ${board.canReview ? `<td><div class="att-actions"><button class="btn btn-primary" type="button" style="padding:5px 12px;font-size:12px;" onclick="openAttendanceReview('${key}','${escapeJsArg(c.id)}')">Review</button>${attCorrectButton(attCorrectionRecord(board, c))}</div></td>` : ''}
      </tr>`).join('');
    return;
  }

  if (board.tab === 'incomplete') {
    const incompleteRows = rows.map((row) => (row.__branchStub ? '' : `
      <tr>
        <td class="nm">${attEmployeeCell(row, { link: board.canReview })}</td>
        <td>${escapeHtml(attFormatDate(row.log_date))}</td>
        <td class="mn">${escapeHtml(attFormatTime(row.time_in))}</td>
        <td class="mn">${escapeHtml(attFormatTime(row.time_out))}</td>
        <td>${attendanceStatusBadge(row.status)}</td>
        ${board.canReview ? `<td><div class="att-actions">${row.status === 'Incomplete'
          ? `<button class="btn btn-outline" type="button" style="padding:5px 12px;font-size:12px;" onclick="openAttendanceResolve('${key}','${escapeJsArg(row.id)}')">Resolve</button>`
          : '<span style="font-size:12px;color:var(--t3);">See Correction Requests</span>'}${attCorrectButton(row)}</div></td>` : ''}
      </tr>`));
    body.innerHTML = attWithGroupHeadings(board, rows, incompleteRows, 5 + (board.canReview ? 1 : 0));
    return;
  }

  const recordRows = rows.map((row) => (row.__branchStub ? '' : attRecordRowHtml(row, { canReview: board.canReview })));
  body.innerHTML = attWithGroupHeadings(board, rows, recordRows, 8 + (board.canReview ? 1 : 0));
}

/* ── Day grouping (status board) ──
   Records are listed newest day first, each day under its own heading, so a
   Thursday never runs into a Friday. The heading repeats at the top of every
   page, and its counts cover the whole day, not just that page. */

/** Today's date in Manila as "YYYY-MM-DD". */
function attTodayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** "Friday, September 25, 2026". */
function attFormatDayHeading(key) {
  const date = new Date(`${key}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return key || '—';
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date);
}

/** Newest day first; within a day, by employee name. */
function attSortByDay(rows) {
  return [...(rows || [])].sort((a, b) => {
    const byDay = String(b.log_date || '').localeCompare(String(a.log_date || ''));
    return byDay || String(a.employee_name || '').localeCompare(String(b.employee_name || ''));
  });
}

/** Per day: how many rows, and how many of each status. */
function attDayCounts(rows) {
  const counts = new Map();
  (rows || []).forEach((row) => {
    const key = String(row.log_date || '');
    if (!counts.has(key)) counts.set(key, { total: 0, statuses: new Map() });
    const day = counts.get(key);
    day.total += 1;
    if (row.status) day.statuses.set(row.status, (day.statuses.get(row.status) || 0) + 1);
  });
  return counts;
}

function attDayHeadingRow(board, key, colspan) {
  const day = board.dayCounts?.get(key) || { total: 0, statuses: new Map() };
  const breakdown = board.tab === 'all'
    ? ATTENDANCE_STATUS_LIST.filter((s) => day.statuses.get(s)).map((s) => `${day.statuses.get(s)} ${s}`)
    : [];
  const summary = [`${day.total} record${day.total === 1 ? '' : 's'}`, ...breakdown].join(' · ');
  const today = key === attTodayKey() ? ' <span class="badge bt2" style="margin-left:6px;">Today</span>' : '';
  return `<tr class="att-day-row"><td colspan="${colspan}"><strong>${escapeHtml(attFormatDayHeading(key))}</strong>${today}<span class="att-day-summary">${escapeHtml(summary)}</span></td></tr>`;
}

/** The page's rows with a heading before each new day. */
function attWithDayHeadings(board, rows, rowHtml, colspan) {
  let lastDay = null;
  return rows.map((row, index) => {
    const key = String(row.log_date || '');
    const heading = key !== lastDay ? attDayHeadingRow(board, key, colspan) : '';
    lastDay = key;
    return heading + rowHtml[index];
  }).join('');
}

/** The Day filter: every day of the loaded period, newest first, with its count. */
function renderAttendanceDateOptions(board) {
  const select = document.getElementById(`${board.rootId}-date`);
  if (!select) return;
  const counts = attDayCounts(board.logs.filter((row) => !board.branch || attRowBranchId(board, row) === board.branch));
  const days = [...counts.keys()].filter(Boolean).sort().reverse();
  if (board.date !== 'all' && !counts.has(board.date)) board.date = 'all';
  select.innerHTML = '<option value="all">All days</option>'
    + days.map((key) => {
      const n = counts.get(key).total;
      return `<option value="${escapeHtml(key)}">${escapeHtml(attFormatDate(key))} (${n})</option>`;
    }).join('');
  select.value = board.date;
}

/* ── Branch grouping (status board and Attendance Log) ──
   Rows are grouped by branch first (the branch the employee is in NOW),
   then by day (newest first), then by employee (A–Z). Each branch heading
   can be collapsed and shows the counts for its latest day. The same
   helpers serve the status board and the Admin / HR / Super Admin Attendance Log, whose
   view objects carry the same fields (collapsed, branchNames, ...). */

/** One row per employee per day: a real record wins over a "no tap yet" placeholder. */
function attOneRowPerDay(rows) {
  const byKey = new Map();
  const loose = [];
  (rows || []).forEach((row) => {
    if (!row?.employee_id || !row?.log_date) { loose.push(row); return; }
    const key = `${row.employee_id}|${row.log_date}`;
    const prev = byKey.get(key);
    if (!prev || ((prev.placeholder || prev.not_yet_tapped) && !(row.placeholder || row.not_yet_tapped))) byKey.set(key, row);
  });
  return [...byKey.values(), ...loose];
}

function attRowBranchId(view, row) {
  return String(row?.group_branch_id
    || (row?.employee_id ? view?.employeeBranch?.get(String(row.employee_id)) : '')
    || row?.branch_id
    || '');
}

function attBranchLabel(view, branch) {
  return view?.branchNames?.get(branch) || (branch ? 'Branch' : 'No branch assigned');
}

/** Branch name A–Z ("No branch" last), then newest day, then employee A–Z. */
function attSortByBranchDay(view, rows) {
  return [...(rows || [])].sort((a, b) => {
    const ba = attRowBranchId(view, a);
    const bb = attRowBranchId(view, b);
    if (ba !== bb) {
      if (!ba) return 1;
      if (!bb) return -1;
      return attBranchLabel(view, ba).localeCompare(attBranchLabel(view, bb)) || ba.localeCompare(bb);
    }
    const byDay = String(b.log_date || '').localeCompare(String(a.log_date || ''));
    return byDay || String(a.employee_name || '').localeCompare(String(b.employee_name || ''));
  });
}

/**
 * Per branch: its latest day up to today (an approved leave can already have
 * rows for days ahead), and that day's employees and statuses.
 */
function attComputeBranchCounts(view, rows) {
  const today = attTodayKey();
  const latest = new Map();
  (rows || []).forEach((row) => {
    const branch = attRowBranchId(view, row);
    const day = String(row.log_date || '');
    const prev = latest.get(branch);
    const better = prev === undefined
      || (day <= today && (prev > today || day > prev))
      || (day > today && prev > today && day < prev);
    if (better) latest.set(branch, day);
  });
  const counts = new Map();
  latest.forEach((day, branch) => counts.set(branch, { latestDay: day, employees: new Set(), statuses: new Map() }));
  (rows || []).forEach((row) => {
    const branch = attRowBranchId(view, row);
    const info = counts.get(branch);
    if (!info || String(row.log_date || '') !== info.latestDay) return;
    info.employees.add(String(row.employee_id || row.id || row.employee_name || ''));
    if (row.status) info.statuses.set(row.status, (info.statuses.get(row.status) || 0) + 1);
  });
  view.branchCounts = counts;
  return counts;
}

/** Like attDayCounts(), keyed "branch|day". */
function attBranchDayCounts(view, rows) {
  const counts = new Map();
  (rows || []).forEach((row) => {
    const key = `${attRowBranchId(view, row)}|${String(row.log_date || '')}`;
    if (!counts.has(key)) counts.set(key, { total: 0, statuses: new Map() });
    const day = counts.get(key);
    day.total += 1;
    if (row.status) day.statuses.set(row.status, (day.statuses.get(row.status) || 0) + 1);
  });
  return counts;
}

/** A collapsed branch keeps only its heading (one stub row stands in for its rows). */
function attApplyCollapsed(view, rows) {
  if (!view.collapsed?.size) return rows;
  const out = [];
  const stubbed = new Set();
  rows.forEach((row) => {
    const branch = attRowBranchId(view, row);
    if (!view.collapsed.has(branch)) { out.push(row); return; }
    if (stubbed.has(branch)) return;
    stubbed.add(branch);
    out.push({ __branchStub: true, group_branch_id: branch, log_date: '' });
  });
  return out;
}

function attBranchHeadingRow(view, branch, colspan) {
  const info = view.branchCounts?.get(branch) || { latestDay: '', employees: new Set(), statuses: new Map() };
  const collapsed = Boolean(view.collapsed?.has(branch));
  const employees = info.employees.size;
  const breakdown = ATTENDANCE_STATUS_LIST.filter((s) => info.statuses.get(s)).map((s) => `${info.statuses.get(s)} ${s}`);
  const summary = [`${employees} employee${employees === 1 ? '' : 's'}`, ...breakdown].join(' · ');
  const day = info.latestDay ? `${attFormatDate(info.latestDay)}: ` : '';
  return `<tr class="att-branch-row"><td colspan="${colspan}">
    <button type="button" class="att-branch-toggle" aria-expanded="${collapsed ? 'false' : 'true'}" onclick="toggleAttendanceBranch('${escapeJsArg(view.rootId)}','${escapeJsArg(branch)}')">
      <span class="att-branch-caret" aria-hidden="true">${collapsed ? '&#9656;' : '&#9662;'}</span>${escapeHtml(attBranchLabel(view, branch))}
    </button>
    <span class="att-day-summary">${escapeHtml(day + summary)}</span>
  </td></tr>`;
}

function attBranchDayHeadingRow(view, branch, key, colspan) {
  const day = view.dayCounts?.get(`${branch}|${key}`) || { total: 0, statuses: new Map() };
  const breakdown = ATTENDANCE_STATUS_LIST.filter((s) => day.statuses.get(s)).map((s) => `${day.statuses.get(s)} ${s}`);
  const summary = [`${day.total} record${day.total === 1 ? '' : 's'}`, ...breakdown].join(' · ');
  const today = key === attTodayKey() ? ' <span class="badge bt2" style="margin-left:6px;">Today</span>' : '';
  return `<tr class="att-day-row"><td colspan="${colspan}" style="padding-left:30px;"><strong>${escapeHtml(attFormatDayHeading(key))}</strong>${today}<span class="att-day-summary">${escapeHtml(summary)}</span></td></tr>`;
}

/** The page's rows under branch and day headings (repeated at the top of each page). */
function attWithGroupHeadings(view, rows, rowHtml, colspan) {
  if (!view.groupByBranch) return attWithDayHeadings(view, rows, rowHtml, colspan);
  let lastBranch = null;
  let lastDay = null;
  return rows.map((row, index) => {
    const branch = attRowBranchId(view, row);
    let html = '';
    if (branch !== lastBranch) {
      html += attBranchHeadingRow(view, branch, colspan);
      lastBranch = branch;
      lastDay = null;
    }
    if (row.__branchStub) return html;
    const key = String(row.log_date || '');
    if (key !== lastDay) {
      html += attBranchDayHeadingRow(view, branch, key, colspan);
      lastDay = key;
    }
    return html + rowHtml[index];
  }).join('');
}

function toggleAttendanceBranch(viewId, branch) {
  const board = attendanceBoards.get(viewId);
  const view = board || attLogViews.get(viewId);
  if (!view) return;
  if (view.collapsed.has(branch)) view.collapsed.delete(branch);
  else view.collapsed.add(branch);
  if (board) renderAttendanceBoard(board);
  else view.rerender?.(attApplyCollapsed(view, view.rows));
}

/** The Branch filter: every branch the board knows, A–Z. */
function renderAttendanceBranchOptions(board) {
  const select = document.getElementById(`${board.rootId}-branch`);
  if (!select) return;
  const show = board.groupByBranch && board.branchNames.size > 0;
  select.style.display = show ? '' : 'none';
  if (!show) return;
  const options = [...board.branchNames.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  if (board.branch && !board.branchNames.has(board.branch)) board.branch = '';
  select.innerHTML = '<option value="">All Branches</option>'
    + options.map(([value, name]) => `<option value="${escapeHtml(value)}">${escapeHtml(name)}</option>`).join('');
  select.value = board.branch;
}

/** The status legend as chips with counts; a chip filters the table to that status. */
function attendanceStatusChips(board, rows) {
  const counts = new Map();
  (rows || []).forEach((row) => counts.set(row.status, (counts.get(row.status) || 0) + 1));
  const key = escapeJsArg(board.rootId);
  const statuses = ['On Time', 'Early Bird', 'Late', 'Undertime', 'Half Day', 'Absent', 'Incomplete', 'Pending Correction', 'Corrected', 'On Leave', 'Holiday']
    .filter((s) => (s !== 'Pending Correction' && s !== 'Holiday') || counts.get(s) || board.status === s);
  return `<div class="att-chips" role="group" aria-label="Filter by status">${statuses.map((s) => {
    const n = counts.get(s) || 0;
    const active = board.status === s;
    return `<button type="button" class="att-chip${active ? ' att-chip-active' : ''}${n ? '' : ' att-chip-zero'}" style="--chip:${attendanceStatusColor(s)};" aria-pressed="${active}" title="${active ? 'Show all statuses' : `Show only ${escapeHtml(s)}`}" onclick="setAttendanceStatusChip('${key}','${escapeJsArg(s)}')">${escapeHtml(s)}<span class="att-chip-n">${n}</span></button>`;
  }).join('')}</div>`;
}

function setAttendanceStatusChip(rootId, status) {
  const board = attendanceBoards.get(rootId);
  if (!board) return;
  board.status = board.status === status ? 'all' : status;
  const select = document.getElementById(`${rootId}-status`);
  if (select) select.value = board.status;
  renderAttendanceBoard(board);
}

/* ── Rows: employee cell, notes, actions ── */

/** Name (a link to the employee's record page for HR / Admin) with employee ID and type below. */
function attEmployeeCell(row, { link = false, showType = false } = {}) {
  const name = escapeHtml(row?.employee_name || '—');
  const sub = [row?.employee_code, showType ? row?.employee_type : ''].filter(Boolean).join(' · ');
  const subHtml = sub ? `<div class="att-emp-sub">${escapeHtml(sub)}</div>` : '';
  if (!link || !row?.employee_id || typeof window.attEmployeePageNav !== 'function') return `${name}${subHtml}`;
  return `<a href="#" class="att-emp-link" title="View attendance records" onclick="openAttendanceEmployeePage('${escapeJsArg(row.employee_id)}');return false;">${name}</a>${subHtml}`;
}

/** "Corrected by Juan Dela Cruz · Reader was down" under a Corrected badge. */
function attCorrectedNote(row) {
  const c = row?.last_correction;
  if (normalizeAttendanceStatusLabel(row?.status) !== 'Corrected' || !c) return '';
  const parts = [`Corrected by ${c.approved_by_name || 'HR / Admin'}`];
  if (c.reason) parts.push(c.reason);
  return `<div class="att-row-note">${escapeHtml(parts.join(' · '))}</div>`;
}

/** A tap came in after HR / Admin corrected the day: its times were kept, HR should review. */
function attTapFlagNote(row) {
  if (!row?.tap_after_correction_at || normalizeAttendanceStatusLabel(row.status) !== 'Corrected') return '';
  return `<div class="att-row-note att-flag" title="Latest tap ${escapeHtml(attFormatTapTime(row.tap_after_correction_at))}">New tap after correction</div>`;
}

function attStatusCell(row) {
  return `${attendanceStatusBadge(row.status)}${row.holiday_name ? `<div class="att-row-note">${escapeHtml(row.holiday_name)}</div>` : ''}${row.not_yet_tapped ? '<div class="att-row-note">No tap yet today</div>' : ''}${normalizeAttendanceStatusLabel(row.status) === 'On Leave' ? `<div class="att-row-note">${escapeHtml(attendanceLeaveSummary(row.leave))}</div>` : ''}${attCorrectedNote(row)}${attTapFlagNote(row)}`;
}

/** One record row: Employee, Date, Time In, Time Out, Hours, Late, Undertime, Status, Action. */
function attRecordRowHtml(row, { canReview = false, showType = false } = {}) {
  return `
    <tr>
      <td class="nm">${attEmployeeCell(row, { link: canReview, showType })}</td>
      <td>${escapeHtml(attFormatDate(row.log_date))}</td>
      <td class="mn">${escapeHtml(attFormatTime(row.time_in))}</td>
      <td class="mn">${escapeHtml(attFormatTime(row.time_out))}</td>
      <td class="mn">${escapeHtml(attFormatHours(row))}</td>
      <td class="mn">${escapeHtml(attMinutes(row.late_minutes))}</td>
      <td class="mn">${escapeHtml(attMinutes(row.undertime_minutes))}</td>
      <td>${attStatusCell(row)}</td>
      ${canReview ? `<td><div class="att-actions">${attCorrectButton(row)}${attViewRecordsButton(row)}</div></td>` : ''}
    </tr>`;
}

/* ── Correct any record (HR / Admin) ──
   One dialog for every place a record is shown: All Records, Incomplete
   Queue, Correction Requests, the Attendance Log and the employee's record
   page. PATCH /api/attendance/corrections { action: "correct_record" }; the
   server re-checks the role and branch, and the database keeps the original
   taps (attendance_correct_record). */
const attCorrectRecords = new Map();

const ATT_CORRECTION_TYPES = [
  ['time_in', 'Correct time in (accidental late time in)'],
  ['time_out', 'Correct time out (accidental late or missing time out)'],
  ['both', 'Correct both time in and time out'],
  ['present', 'Mark as present (worked but did not tap)'],
];

function attIsLogId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''));
}

function attCanCorrect(row) {
  return Boolean(row?.employee_id && row?.log_date) && normalizeAttendanceStatusLabel(row.status) !== 'On Leave';
}

function attCorrectButton(row) {
  if (!attCanCorrect(row)) return '';
  const key = `${row.employee_id}|${row.log_date}`;
  attCorrectRecords.set(key, row);
  return `<button class="btn btn-outline" type="button" style="padding:5px 12px;font-size:12px;" onclick="openAttendanceCorrectionByKey('${escapeJsArg(key)}')">Correct</button>`;
}

function attViewRecordsButton(row) {
  if (!row?.employee_id || typeof window.attEmployeePageNav !== 'function') return '';
  return `<button class="btn btn-outline" type="button" style="padding:5px 12px;font-size:12px;" onclick="openAttendanceEmployeePage('${escapeJsArg(row.employee_id)}')">View Records</button>`;
}

/** The record a correction request is about: the loaded row, or the request's own copy of it. */
function attCorrectionRecord(board, c) {
  const live = board.logs.find((row) => String(row.id) === String(c.log_id));
  if (live) return live;
  return {
    id: c.log_id,
    employee_id: c.employee_id,
    employee_name: c.employee_name,
    log_date: c.log_date,
    time_in: c.original_time_in,
    time_out: c.original_time_out,
    status: 'Pending Correction',
    group_branch_id: c.branch_id,
  };
}

function openAttendanceCorrectionByKey(key) {
  const row = attCorrectRecords.get(key);
  if (row) openAttendanceCorrection(row);
}

function attCorrectionNeeds(type) {
  return {
    in: type === 'time_in' || type === 'both' || type === 'present',
    out: type === 'time_out' || type === 'both' || type === 'present',
  };
}

function attSyncCorrectionFields() {
  const needs = attCorrectionNeeds(attDialogValue('att-correct-type'));
  const inWrap = document.getElementById('att-correct-in-wrap');
  const outWrap = document.getElementById('att-correct-out-wrap');
  if (inWrap) inWrap.style.display = needs.in ? '' : 'none';
  if (outWrap) outWrap.style.display = needs.out ? '' : 'none';
}

function openAttendanceCorrection(row) {
  if (!attCanCorrect(row)) return;
  const status = normalizeAttendanceStatusLabel(row.status);
  const defaultType = !row.time_in ? 'present' : (!row.time_out ? 'time_out' : 'time_in');
  const readOnly = (label, value) => `<div class="fg" style="margin:0;"><label>${label}</label><div class="fc att-readonly">${escapeHtml(value)}</div></div>`;

  openAttendanceDialog({
    title: 'Correct Attendance',
    summary: `
      <div><strong>${escapeHtml(row.employee_name || 'Employee')}</strong>${row.employee_code ? ` <span style="color:var(--t3);">(${escapeHtml(row.employee_code)})</span>` : ''} · ${escapeHtml(attFormatDate(row.log_date))} ${attendanceStatusBadge(status)}</div>
      <div class="att-correct-current">
        ${readOnly('Current time in', attFormatTime(row.time_in))}
        ${readOnly('Current time out', attFormatTime(row.time_out))}
      </div>
      ${status === 'Pending Correction' ? '<div style="margin-top:6px;">Saving closes the employee\'s pending correction request.</div>' : ''}`,
    fields: `
      <div class="fg" style="margin:0;">
        <label for="att-correct-type">Resolution</label>
        <select id="att-correct-type" class="fc" onchange="attSyncCorrectionFields()">
          ${ATT_CORRECTION_TYPES.map(([value, label]) => `<option value="${value}"${value === defaultType ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
        </select>
      </div>
      <div class="att-correct-current">
        <div class="fg" style="margin:0;" id="att-correct-in-wrap">
          <label for="att-correct-in">New time in</label>
          <input id="att-correct-in" class="fc" type="time" value="${escapeHtml(attTimeInputValue(row.time_in))}" />
        </div>
        <div class="fg" style="margin:0;" id="att-correct-out-wrap">
          <label for="att-correct-out">New time out</label>
          <input id="att-correct-out" class="fc" type="time" value="${escapeHtml(attTimeInputValue(row.time_out))}" />
        </div>
      </div>
      <div class="fg" style="margin:0;">
        <label for="att-correct-note">Reason</label>
        <textarea id="att-correct-note" class="fc" rows="2" maxlength="500" placeholder="e.g. Tapped in late by mistake; confirmed with the branch logbook"></textarea>
      </div>
      <p style="font-size:11px;color:var(--t3);margin:0;">Hours, late, undertime and status are recomputed from the branch schedule and used by payroll. The original taps are kept in the correction history.</p>`,
    actions: [{
      label: 'Save Correction',
      className: 'btn-primary',
      handler: () => submitAttendanceCorrection(row),
    }],
  });
  attSyncCorrectionFields();
}

async function submitAttendanceCorrection(row) {
  const type = attDialogValue('att-correct-type');
  const needs = attCorrectionNeeds(type);
  const today = attTodayKey();
  const nowHm = attTimeInputValue(new Date().toISOString());
  const currentIn = attTimeInputValue(row.time_in);
  const currentOut = attTimeInputValue(row.time_out);
  const newIn = attDialogValue('att-correct-in');
  const newOut = attDialogValue('att-correct-out');
  const effectiveIn = needs.in ? newIn : currentIn;
  const notFuture = (value) => (row.log_date === today && value && value > nowHm ? 'A corrected time cannot be in the future.' : '');

  attRequireFields([
    {
      field: 'att-correct-type',
      check: (value) => {
        if (!value) return 'Choose a resolution.';
        if (!needs.in && !row.time_in) return 'This record has no time in. Choose "Correct both" or "Mark as present".';
        if (!needs.out && !row.time_out && row.log_date < today) return 'This day has no time out. Choose "Correct both" to enter it too.';
        return '';
      },
    },
    ...(needs.in ? [{
      field: 'att-correct-in',
      check: (value) => {
        if (!value) return 'New time in is required.';
        if (!needs.out && currentOut && value >= currentOut) return `Time in must be earlier than the time out (${attFormatTime(row.time_out)}).`;
        return notFuture(value);
      },
    }] : []),
    ...(needs.out ? [{
      field: 'att-correct-out',
      check: (value) => {
        if (!value) return 'New time out is required.';
        if (effectiveIn && value <= effectiveIn) return 'Time out must be later than time in.';
        return notFuture(value);
      },
    }] : []),
    { field: 'att-correct-note', check: attReasonCheck },
  ]);
  const effectiveOut = needs.out ? newOut : currentOut;
  if (row.time_in && effectiveIn === currentIn && effectiveOut === currentOut) {
    throw new Error('The new times are the same as the current ones.');
  }

  const corrected = await attFetchJson('/api/attendance/corrections', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'correct_record',
      log_id: attIsLogId(row.id) ? row.id : undefined,
      employee_id: row.employee_id,
      log_date: row.log_date,
      type,
      time_in: needs.in ? newIn : undefined,
      time_out: needs.out ? newOut : undefined,
      note: attDialogValue('att-correct-note'),
    }),
  });
  window.pushNotification?.('Attendance Corrected', `${row.employee_name || 'The employee'}'s ${attFormatDate(row.log_date)} record is updated and marked Corrected.`, 'success');
  attPayrollNotice(corrected);
  await attAfterCorrection();
}

/** Reload whatever shows attendance on screen after a correction. */
async function attAfterCorrection() {
  try { invalidateAttendanceCache(); } catch { /* not loaded on this page */ }
  const reloads = [];
  attendanceBoards.forEach((board, rootId) => {
    if (document.getElementById(rootId)?.offsetParent) reloads.push(refreshAttendanceBoard(rootId));
  });
  if (attEmployeeView.rootId && document.getElementById(attEmployeeView.rootId)?.offsetParent) reloads.push(loadAttendanceEmployeePage());
  if (typeof window.onAttendanceCorrected === 'function') reloads.push(Promise.resolve(window.onAttendanceCorrected()));
  await Promise.allSettled(reloads);
}

/* ── Attendance Log (Admin / HR / Super Admin): the same grouping as the status board ── */
const attLogViews = new Map();

function attLogView(viewId) {
  if (!attLogViews.has(viewId)) {
    attLogViews.set(viewId, {
      rootId: viewId,
      tab: 'all',
      groupByBranch: true,
      collapsed: new Set(),
      branchNames: new Map(),
      employeeBranch: new Map(),
      dayCounts: new Map(),
      branchCounts: new Map(),
      canReview: false,
      rows: [],
      rerender: null,
    });
  }
  return attLogViews.get(viewId);
}

/**
 * Prepare an Attendance Log's rows: one per employee per day, sorted by
 * branch, day and employee. Returns the rows to paginate; `rerender(rows)`
 * re-paginates after a branch is collapsed or expanded.
 */
function attPrepareAttendanceLog(viewId, rows, { canReview = false, rerender = null } = {}) {
  const view = attLogView(viewId);
  view.canReview = canReview;
  view.rerender = rerender;
  const list = attOneRowPerDay((rows || []).map((row) => ({ ...row, log_date: row.log_date || row.date })));
  view.employeeBranch = new Map();
  list.forEach((row) => {
    const branch = String(row.group_branch_id || row.branch_id || '');
    if (row.employee_id && branch) view.employeeBranch.set(String(row.employee_id), branch);
    if (branch && row.branch_name) view.branchNames.set(branch, row.branch_name);
  });
  view.rows = attSortByBranchDay(view, list);
  attComputeBranchCounts(view, list);
  view.dayCounts = attBranchDayCounts(view, view.rows);
  return attApplyCollapsed(view, view.rows);
}

/** One page of an Attendance Log, with branch and day headings. */
function attRenderAttendanceLogPage(viewId, pageRows) {
  const view = attLogView(viewId);
  const html = pageRows.map((row) => (row.__branchStub ? '' : attRecordRowHtml(row, { canReview: view.canReview, showType: true })));
  return attWithGroupHeadings(view, pageRows, html, 8 + (view.canReview ? 1 : 0));
}

/* ── INDIVIDUAL EMPLOYEE ATTENDANCE RECORD (Admin / HR / Super Admin) ──
   Opened from an employee's name or View Records. The portal provides
   window.attEmployeePageNav() (show its page) and mounts the page with
   mountAttendanceEmployeePage(rootId, { onBack }). The employee id lives in
   the iframe URL (?employee=) and sessionStorage, so a refresh reopens it. */
const ATT_EMPLOYEE_KEY = 'sacs-att-employee';
const attEmployeeView = { rootId: '', employeeId: '', range: 'this_month', from: '', to: '', status: 'all', data: null, seq: 0, onBack: null };

function openAttendanceEmployeePage(employeeId) {
  if (!employeeId || typeof window.attEmployeePageNav !== 'function') return;
  attEmployeeView.employeeId = String(employeeId);
  try { sessionStorage.setItem(ATT_EMPLOYEE_KEY, attEmployeeView.employeeId); } catch { /* private mode */ }
  try {
    const params = new URLSearchParams(window.location.search);
    params.set('employee', attEmployeeView.employeeId);
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  } catch { /* keep going without the deep link */ }
  closeAttendanceDialog();
  window.attEmployeePageNav();
}

function attEmployeeStoredId() {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('employee');
    if (fromUrl) return fromUrl;
  } catch { /* ignore */ }
  if (attEmployeeView.employeeId) return attEmployeeView.employeeId;
  try { return sessionStorage.getItem(ATT_EMPLOYEE_KEY) || ''; } catch { return ''; }
}

function attEmployeeBack() {
  if (typeof attEmployeeView.onBack === 'function') attEmployeeView.onBack();
}

/** The selected range as { from, to } (Manila dates; never past today for the current week / month). */
function attEmployeeRange(view = attEmployeeView) {
  const today = attTodayKey();
  const [y, m, d] = today.split('-').map(Number);
  const iso = (date) => date.toISOString().slice(0, 10);
  if (view.range === 'this_week') {
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return { from: iso(new Date(Date.UTC(y, m - 1, d - ((weekday + 6) % 7)))), to: today };
  }
  if (view.range === 'last_month') {
    return { from: iso(new Date(Date.UTC(y, m - 2, 1))), to: iso(new Date(Date.UTC(y, m - 1, 0))) };
  }
  if (view.range === 'custom' && view.from && view.to) return { from: view.from, to: view.to };
  return { from: `${today.slice(0, 8)}01`, to: today };
}

function mountAttendanceEmployeePage(rootId, { onBack } = {}) {
  const root = document.getElementById(rootId);
  if (!root) return;
  attEmployeeView.onBack = onBack || null;
  const employeeId = attEmployeeStoredId();
  if (!employeeId) {
    attEmployeeBack();
    return;
  }
  if (attEmployeeView.rootId !== rootId || attEmployeeView.employeeId !== employeeId) {
    attEmployeeView.range = 'this_month';
    attEmployeeView.from = '';
    attEmployeeView.to = '';
    attEmployeeView.status = 'all';
    attEmployeeView.data = null;
  }
  attEmployeeView.rootId = rootId;
  attEmployeeView.employeeId = employeeId;

  const id = escapeHtml(rootId);
  const range = attEmployeeRange();
  root.innerHTML = `
    <div class="sh att-emp-back">
      <button class="btn btn-outline" type="button" onclick="attEmployeeBack()">&#8592; Back to Attendance Monitoring</button>
    </div>
    <div class="card att-emp-head" id="${id}-head"><div class="sk-bar" style="width:40%;height:18px;"></div></div>
    <div class="card att-emp-filters-card">
      <div class="att-emp-filters">
        <div class="fg" style="margin:0;">
          <label for="${id}-range">Date range</label>
          <select id="${id}-range" class="fc">
            <option value="this_week">This Week</option>
            <option value="this_month">This Month</option>
            <option value="last_month">Last Month</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div class="fg att-emp-custom" style="margin:0;" id="${id}-custom-from-wrap">
          <label for="${id}-from">From</label>
          <input id="${id}-from" class="fc" type="date" value="${escapeHtml(attEmployeeView.from || range.from)}" max="${escapeHtml(attTodayKey())}" />
        </div>
        <div class="fg att-emp-custom" style="margin:0;" id="${id}-custom-to-wrap">
          <label for="${id}-to">To</label>
          <input id="${id}-to" class="fc" type="date" value="${escapeHtml(attEmployeeView.to || range.to)}" />
        </div>
        <button class="btn btn-outline att-emp-custom" type="button" id="${id}-apply">Apply</button>
        <div class="fg" style="margin:0;">
          <label for="${id}-status">Status</label>
          <select id="${id}-status" class="fc">
            <option value="all">All statuses</option>
            ${ATTENDANCE_STATUS_LIST.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>
    <div class="sg att-emp-summary" id="${id}-summary"></div>
    <div class="card">
      <div class="sh" style="flex-wrap:wrap;gap:8px;">
        <span class="stitle">Attendance Records</span><span class="sp"></span>
        <span id="${id}-range-label" style="font-size:12px;color:var(--t3);"></span>
      </div>
      <div class="tw"><table>
        <thead><tr><th>Date</th><th>Time In</th><th>Time Out</th><th>Hours</th><th>Late</th><th>Undertime</th><th>Status</th><th>Remarks</th><th>Action</th></tr></thead>
        <tbody id="${id}-body">${skeletonRows(9)}</tbody>
      </table></div>
      <p id="${id}-feedback" class="adm-feedback" style="margin-top:10px;"></p>
    </div>`;

  const rangeSelect = document.getElementById(`${rootId}-range`);
  const statusSelect = document.getElementById(`${rootId}-status`);
  if (rangeSelect) rangeSelect.value = attEmployeeView.range;
  if (statusSelect) statusSelect.value = attEmployeeView.status;
  const syncCustom = () => {
    root.querySelectorAll('.att-emp-custom').forEach((el) => { el.style.display = attEmployeeView.range === 'custom' ? '' : 'none'; });
  };
  syncCustom();
  rangeSelect?.addEventListener('change', () => {
    attEmployeeView.range = rangeSelect.value;
    syncCustom();
    if (attEmployeeView.range !== 'custom') loadAttendanceEmployeePage();
  });
  document.getElementById(`${rootId}-apply`)?.addEventListener('click', () => {
    const ok = requireFields([
      { field: `${rootId}-from`, label: 'From' },
      {
        field: `${rootId}-to`,
        check: (value) => {
          if (!value) return 'To is required.';
          const from = String(document.getElementById(`${rootId}-from`)?.value || '');
          return from && value < from ? 'To must be on or after From.' : '';
        },
      },
    ]);
    if (!ok) return;
    attEmployeeView.from = document.getElementById(`${rootId}-from`).value;
    attEmployeeView.to = document.getElementById(`${rootId}-to`).value;
    loadAttendanceEmployeePage();
  });
  statusSelect?.addEventListener('change', () => {
    attEmployeeView.status = statusSelect.value;
    renderAttendanceEmployeePage();
  });

  loadAttendanceEmployeePage();
}

async function loadAttendanceEmployeePage() {
  const view = attEmployeeView;
  const rootId = view.rootId;
  if (!rootId || !view.employeeId) return;
  const { from, to } = attEmployeeRange(view);
  const seq = ++view.seq;
  const body = document.getElementById(`${rootId}-body`);
  const feedback = document.getElementById(`${rootId}-feedback`);
  if (body) body.innerHTML = skeletonRows(9);
  if (feedback) { feedback.textContent = ''; feedback.className = 'adm-feedback'; }

  try {
    const params = new URLSearchParams({ from, to });
    const data = await attFetchJson(`/api/attendance/employee/${encodeURIComponent(view.employeeId)}?${params}`);
    if (seq !== view.seq) return;
    view.data = data;
    renderAttendanceEmployeePage();
  } catch (error) {
    if (seq !== view.seq) return;
    view.data = null;
    if (body) body.innerHTML = `<tr><td colspan="9" style="color:var(--red);">${escapeHtml(error.message)}</td></tr>`;
    const head = document.getElementById(`${rootId}-head`);
    if (head && (error.status === 403 || error.status === 404)) head.innerHTML = `<div style="color:var(--red);font-size:13px;">${escapeHtml(error.message)}</div>`;
    const summary = document.getElementById(`${rootId}-summary`);
    if (summary) summary.innerHTML = '';
  }
}

/** "October 2026". */
function attFormatMonthHeading(key) {
  const [y, m] = String(key || '').split('-').map(Number);
  return y && m ? `${ATTENDANCE_MONTHS[m - 1]} ${y}` : '—';
}

function renderAttendanceEmployeePage() {
  const view = attEmployeeView;
  const rootId = view.rootId;
  const data = view.data;
  if (!rootId || !data) return;
  const employee = data.employee || {};
  const logs = data.logs || [];

  // Header card.
  const head = document.getElementById(`${rootId}-head`);
  if (head) {
    const schedule = employee.schedule
      ? `${employee.schedule.work_start || '—'} – ${employee.schedule.work_end || '—'} · ${Number(employee.schedule.grace) || 0} min grace${employee.schedule.source === 'branch' ? '' : ' (default schedule)'}`
      : '—';
    const item = (label, value) => `<div class="att-emp-meta-item"><span class="ct">${escapeHtml(label)}</span><span class="att-emp-meta-value">${escapeHtml(value || '—')}</span></div>`;
    const initials = String(employee.full_name || '').trim().split(/\s+/).filter(Boolean);
    head.innerHTML = `
      <div class="att-emp-title">
        <div class="att-emp-avatar" aria-hidden="true">${escapeHtml(initials.length > 1 ? initials[0][0] + initials[initials.length - 1][0] : String(employee.full_name || 'NA').slice(0, 2)).toUpperCase()}</div>
        <div>
          <h3 style="margin:0;color:var(--t1);">${escapeHtml(employee.full_name || 'Employee')}</h3>
          <div style="font-size:12px;color:var(--t3);margin-top:2px;">Individual Attendance Record${employee.archived ? ' · Archived' : ''}</div>
        </div>
      </div>
      <div class="att-emp-meta">
        ${item('Employee ID', employee.employee_code)}
        ${item('Branch', employee.branch_name)}
        ${item('Position', employee.position)}
        ${item('Employment Status', [employee.employee_status, employee.employee_type].filter(Boolean).join(' · '))}
        ${item('Assigned Schedule', schedule)}
        ${item('RFID Card', employee.rfid_masked || 'Not assigned')}
      </div>`;
  }

  const rangeLabel = document.getElementById(`${rootId}-range-label`);
  if (rangeLabel && data.range) rangeLabel.textContent = `${attFormatDate(data.range.from)} – ${attFormatDate(data.range.to)}`;

  // Summary cards: the whole range, whatever the status filter.
  const real = logs.filter((row) => !row.placeholder && !row.not_yet_tapped);
  const attended = ['On Time', 'Early Bird', 'Late', 'Undertime', 'Half Day', 'Corrected'];
  const lateRows = real.filter((row) => Number(row.late_minutes) > 0);
  const underRows = real.filter((row) => Number(row.undertime_minutes) > 0);
  const leaveRows = real.filter((row) => row.status === 'On Leave');
  const unpaidLeave = leaveRows.filter((row) => row.leave?.pay_status === 'without_pay').length;
  const sum = (rows, field) => rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
  const totalMinutes = real.reduce((total, row) => total + (attWorkedMinutes(row) || 0), 0);
  const card = (label, value, tone, sub) => `<div class="card"><div class="ct">${escapeHtml(label)}</div><div class="cv ${tone}">${escapeHtml(String(value))}</div>${sub ? `<div class="cch">${escapeHtml(sub)}</div>` : ''}</div>`;
  const summary = document.getElementById(`${rootId}-summary`);
  if (summary) {
    summary.innerHTML = [
      card('Days Present', real.filter((row) => attended.includes(row.status)).length, 'g'),
      card('Days Absent', real.filter((row) => row.status === 'Absent').length, 'r'),
      card('Times Late', lateRows.length, 'w', `${sum(lateRows, 'late_minutes')} min total`),
      card('Undertime', `${sum(underRows, 'undertime_minutes')} min`, 'w', `${underRows.length} day${underRows.length === 1 ? '' : 's'}`),
      card('Half Days', real.filter((row) => row.is_half_day === true || row.status === 'Half Day').length, 'a'),
      card('Incomplete', real.filter((row) => row.status === 'Incomplete' || row.status === 'Pending Correction').length, ''),
      card('Leave Days', leaveRows.length, 't', leaveRows.length ? `${leaveRows.length - unpaidLeave} with pay · ${unpaidLeave} without pay` : ''),
      card('Total Hours Worked', attHoursMinutes(totalMinutes), 'g'),
    ].join('');
  }

  // Records: by month, then date (newest first).
  const body = document.getElementById(`${rootId}-body`);
  if (!body) return;
  const rows = logs
    .filter((row) => view.status === 'all' || row.status === view.status)
    .sort((a, b) => String(b.log_date || '').localeCompare(String(a.log_date || '')));
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" style="color:var(--t3);">${view.status === 'all' ? 'No attendance records in this range.' : `No ${escapeHtml(view.status)} records in this range.`}</td></tr>`;
    return;
  }
  const monthCounts = new Map();
  rows.forEach((row) => {
    const month = String(row.log_date || '').slice(0, 7);
    monthCounts.set(month, (monthCounts.get(month) || 0) + 1);
  });
  let lastMonth = null;
  body.innerHTML = rows.map((row) => {
    const month = String(row.log_date || '').slice(0, 7);
    let heading = '';
    if (month !== lastMonth) {
      const n = monthCounts.get(month) || 0;
      heading = `<tr class="att-day-row"><td colspan="9"><strong>${escapeHtml(attFormatMonthHeading(month))}</strong><span class="att-day-summary">${n} record${n === 1 ? '' : 's'}</span></td></tr>`;
      lastMonth = month;
    }
    return heading + `
      <tr>
        <td>${escapeHtml(attFormatDate(row.log_date))}</td>
        <td class="mn">${escapeHtml(attFormatTime(row.time_in))}</td>
        <td class="mn">${escapeHtml(attFormatTime(row.time_out))}</td>
        <td class="mn">${escapeHtml(attFormatHours(row))}</td>
        <td class="mn">${escapeHtml(attMinutes(row.late_minutes))}</td>
        <td class="mn">${escapeHtml(attMinutes(row.undertime_minutes))}</td>
        <td>${attendanceStatusBadge(row.status)}</td>
        <td class="att-remarks">${attEmployeeRemarks(row)}</td>
        <td>${attCorrectButton({ ...row, employee_code: employee.employee_code })}</td>
      </tr>`;
  }).join('');
}

/** Remarks: leave, correction (with its history), pending request, no tap yet. */
function attEmployeeRemarks(row) {
  const parts = [];
  if (row.not_yet_tapped) parts.push('<div>No tap yet today</div>');
  if (normalizeAttendanceStatusLabel(row.status) === 'On Leave') parts.push(`<div>${escapeHtml(attendanceLeaveSummary(row.leave))}</div>`);
  const pending = (row.corrections || []).find((c) => c.status === 'pending');
  if (pending) parts.push(`<div>Correction requested: time out ${escapeHtml(attFormatTime(pending.corrected_time_out))} · “${escapeHtml(pending.reason || '')}”</div>`);
  if (normalizeAttendanceStatusLabel(row.status) === 'Corrected' && row.last_correction) {
    const c = row.last_correction;
    parts.push(`<div>${attendanceStatusBadge('Corrected')} by ${escapeHtml(c.approved_by_name || 'HR / Admin')}${c.reason ? ` · ${escapeHtml(c.reason)}` : ''}</div>`);
  }
  const flag = attTapFlagNote(row);
  if (flag) parts.push(flag);
  const links = [];
  if ((row.corrections || []).length && attIsLogId(row.id)) {
    links.push(`<a href="#" class="att-emp-link" onclick="openAttendanceCorrectionHistory('${escapeJsArg(row.id)}');return false;">Correction History (${row.corrections.length})</a>`);
  }
  if (normalizeAttendanceStatusLabel(row.status) !== 'On Leave' || (row.taps || []).length) {
    links.push(`<a href="#" class="att-emp-link" onclick="openAttendanceTaps('${escapeJsArg(row.log_date)}');return false;">View Taps (${(row.taps || []).length})</a>`);
  }
  if (links.length) parts.push(`<div class="att-remark-links">${links.join('')}</div>`);
  return parts.length ? parts.join('') : '<span style="color:var(--t3);">—</span>';
}

/** "08:01:15 AM" -- taps can be seconds apart, so seconds are shown. */
function attFormatTapTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(date);
}

/**
 * Every raw RFID tap of one day (attendance_taps), oldest first. The first
 * tap is the Time In and the last the Time Out; on a Corrected day those are
 * what the taps said, and taps after the correction are marked.
 */
function openAttendanceTaps(logDate) {
  const data = attEmployeeView.data;
  const row = data?.logs?.find((r) => r.log_date === logDate);
  if (!row) return;
  const taps = [...(row.taps || [])].sort((a, b) => String(a.tapped_at).localeCompare(String(b.tapped_at)));
  const corrected = normalizeAttendanceStatusLabel(row.status) === 'Corrected';
  const correctedAt = corrected ? row.last_correction?.approved_at : null;

  const items = taps.map((tap, index) => {
    const role = index === 0 ? 'Time In' : (index === taps.length - 1 ? 'Time Out' : '');
    const late = correctedAt && String(tap.tapped_at) > String(correctedAt);
    return `
      <tr class="${role ? 'att-tap-key' : ''}">
        <td class="mn">${index + 1}</td>
        <td class="mn">${escapeHtml(attFormatTapTime(tap.tapped_at))}</td>
        <td>${role ? `<span class="badge ${role === 'Time In' ? 'bg' : 'bb'}">${role}</span>` : '<span style="color:var(--t3);">—</span>'}${late ? '<div class="att-row-note att-flag">After correction</div>' : ''}</td>
        <td>${escapeHtml(tap.branch_name || '—')}</td>
        <td>${escapeHtml(tap.device || (tap.source === 'manual_entry' ? 'Manual entry (portal)' : 'RFID Terminal'))}</td>
      </tr>`;
  }).join('');

  const note = !taps.length
    ? 'No taps were recorded for this day.'
    : taps.length === 1
      ? 'One tap only: it is the Time In. The day stays Incomplete until a later tap records the Time Out.'
      : `Time In is the first tap, Time Out the last of ${taps.length} taps.`;
  const correctedNote = corrected
    ? `<div style="margin-top:4px;">This day was corrected${row.last_correction?.approved_by_name ? ` by ${escapeHtml(row.last_correction.approved_by_name)}` : ''}: the record shows <span class="mn">${escapeHtml(attFormatTime(row.time_in))} – ${escapeHtml(attFormatTime(row.time_out))}</span>, not the taps below.</div>`
    : '';

  openAttendanceDialog({
    title: 'Tap History',
    summary: `<div><strong>${escapeHtml(row.employee_name || data?.employee?.full_name || 'Employee')}</strong> · ${escapeHtml(attFormatDate(row.log_date))} ${attendanceStatusBadge(row.status)}</div>
      <div>${escapeHtml(note)}</div>${correctedNote}`,
    fields: taps.length
      ? `<div class="tw att-taps-table"><table>
          <thead><tr><th>#</th><th>Time</th><th>Counts As</th><th>Branch</th><th>Reader</th></tr></thead>
          <tbody>${items}</tbody>
        </table></div>`
      : '',
    actions: [{ label: 'Close', className: 'btn-outline', handler: async () => {} }],
  });
}

function attCorrectionKind(c) {
  const labels = {
    time_in: 'Time in corrected',
    time_out: 'Time out corrected',
    both: 'Time in and time out corrected',
    present: 'Marked present (did not tap)',
  };
  if (c.correction_type && labels[c.correction_type]) return labels[c.correction_type];
  if (c.corrected_time_in) return 'Absence corrected';
  if (c.original_status === 'Incomplete' && c.status === 'approved' && c.reason && c.reason === c.review_note) return 'Incomplete record resolved';
  return 'Employee correction request';
}

function openAttendanceCorrectionHistory(logId) {
  const row = attEmployeeView.data?.logs?.find((r) => String(r.id) === String(logId));
  if (!row) return;
  const pair = (timeIn, timeOut) => `${attFormatTime(timeIn)} – ${attFormatTime(timeOut)}`;
  const items = [...(row.corrections || [])].reverse().map((c) => {
    const state = c.status === 'pending' ? 'Waiting for review' : c.status === 'approved' ? 'Applied' : 'Rejected';
    let after;
    if (c.status === 'pending') after = `Requested time out ${attFormatTime(c.corrected_time_out)}`;
    else if (c.resolution === 'absent') after = 'Marked Absent';
    else if (c.resolution === 'half_day') after = 'Marked Half Day';
    else if (c.status === 'rejected') after = 'Kept as recorded';
    else after = pair(c.corrected_time_in || c.original_time_in, c.corrected_time_out || c.original_time_out);
    const hasFacts = c.corrected_late_minutes !== null && c.corrected_late_minutes !== undefined;
    const before = attWorkedMinutes({ time_in: c.original_time_in, time_out: c.original_time_out });
    const afterMinutes = attWorkedMinutes({ time_in: c.corrected_time_in || c.original_time_in, time_out: c.corrected_time_out });
    const facts = hasFacts ? `
        <div class="att-history-facts">
          <span>Hours ${escapeHtml(before === null ? '—' : attHoursMinutes(before))} → ${escapeHtml(afterMinutes === null ? '—' : attHoursMinutes(afterMinutes))}</span>
          <span>Late ${escapeHtml(attMinutes(c.original_late_minutes))} → ${escapeHtml(attMinutes(c.corrected_late_minutes))}</span>
          <span>Undertime ${escapeHtml(attMinutes(c.original_undertime_minutes))} → ${escapeHtml(attMinutes(c.corrected_undertime_minutes))}</span>
        </div>` : '';
    const who = c.status === 'pending' ? (c.requested_by_name || 'Employee') : (c.approved_by_name || c.requested_by_name || 'HR / Admin');
    const when = c.status === 'pending' ? c.requested_at : (c.approved_at || c.requested_at);
    return `
      <div class="att-history-item">
        <div class="att-history-top"><strong>${escapeHtml(attCorrectionKind(c))}</strong><span>${escapeHtml(state)}</span></div>
        <div class="att-history-grid">
          <div><span class="att-history-label">Original taps</span><span class="mn">${escapeHtml(pair(c.original_time_in, c.original_time_out))}</span> ${c.original_status ? attendanceStatusBadge(c.original_status) : ''}</div>
          <div><span class="att-history-label">New values</span><span class="mn">${escapeHtml(after)}</span></div>
        </div>
        ${facts}
        <div class="att-history-reason">Reason: “${escapeHtml(c.reason || '')}”</div>
        ${c.review_note && c.review_note !== c.reason ? `<div class="att-history-reason">Note: ${escapeHtml(c.review_note)}</div>` : ''}
        <div class="att-history-by">${c.status === 'pending' ? 'Requested' : 'Changed'} by ${escapeHtml(who)} · ${escapeHtml(attFormatDateTime(when))}</div>
      </div>`;
  }).join('');

  openAttendanceDialog({
    title: 'Correction History',
    summary: `<div><strong>${escapeHtml(row.employee_name || attEmployeeView.data?.employee?.full_name || 'Employee')}</strong> · ${escapeHtml(attFormatDate(row.log_date))} ${attendanceStatusBadge(row.status)}</div>
      <div>Now: <span class="mn">${escapeHtml(pair(row.time_in, row.time_out))}</span></div>`,
    fields: `<div class="att-history">${items || '<div style="color:var(--t3);">No corrections for this day.</div>'}</div>`,
    actions: [{ label: 'Close', className: 'btn-outline', handler: async () => {} }],
  });
}

/* ── Review / resolve / request dialog (one, shared) ── */
function ensureAttendanceDialog() {
  let backdrop = document.getElementById('att-dialog');
  if (backdrop) return backdrop;
  backdrop = document.createElement('div');
  backdrop.id = 'att-dialog';
  backdrop.className = 'adm-modal-backdrop';
  backdrop.style.display = 'none';
  backdrop.innerHTML = `
    <div class="adm-modal-card" style="width:min(520px,100%);" role="dialog" aria-modal="true" aria-labelledby="att-dialog-title">
      <div class="adm-modal-head">
        <h3 id="att-dialog-title">Attendance</h3>
        <button class="btn btn-close-x" type="button" data-att-close title="Close">&#x2715;</button>
      </div>
      <form id="att-dialog-form" class="adm-modal-form" style="grid-template-columns:1fr;" novalidate>
        <div id="att-dialog-summary" style="font-size:13px;color:var(--t2);line-height:1.6;"></div>
        <div id="att-dialog-fields" style="display:grid;gap:12px;"></div>
        <p id="att-dialog-feedback" class="adm-feedback"></p>
        <div class="adm-modal-actions" id="att-dialog-actions" style="gap:8px;"></div>
      </form>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('[data-att-close]').addEventListener('click', closeAttendanceDialog);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeAttendanceDialog(); });
  backdrop.querySelector('form').addEventListener('submit', (event) => event.preventDefault());
  return backdrop;
}

function closeAttendanceDialog() {
  const backdrop = document.getElementById('att-dialog');
  if (backdrop) backdrop.style.display = 'none';
}

function openAttendanceDialog({ title, summary, fields, actions }) {
  const backdrop = ensureAttendanceDialog();
  backdrop.querySelector('#att-dialog-title').textContent = title;
  backdrop.querySelector('#att-dialog-summary').innerHTML = summary;
  backdrop.querySelector('#att-dialog-fields').innerHTML = fields;
  const feedback = backdrop.querySelector('#att-dialog-feedback');
  feedback.textContent = '';
  feedback.className = 'adm-feedback';
  const actionsEl = backdrop.querySelector('#att-dialog-actions');
  actionsEl.innerHTML = '';
  actions.forEach(({ label, className, handler }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn ${className}`;
    button.textContent = label;
    button.addEventListener('click', async () => {
      const buttons = Array.from(actionsEl.querySelectorAll('button'));
      buttons.forEach((b) => { b.disabled = true; });
      feedback.textContent = 'Saving...';
      feedback.className = 'adm-feedback';
      try {
        await handler();
        closeAttendanceDialog();
      } catch (error) {
        feedback.textContent = error.message;
        feedback.className = 'adm-feedback err';
      } finally {
        buttons.forEach((b) => { b.disabled = false; });
      }
    });
    actionsEl.appendChild(button);
  });
  backdrop.style.display = 'flex';
  setTimeout(() => backdrop.querySelector('#att-dialog-fields input, #att-dialog-fields textarea, #att-dialog-fields select')?.focus(), 30);
}

function attDialogValue(id) {
  return String(document.getElementById(id)?.value || '').trim();
}

// The server's rules for these dialogs (src/app/api/attendance/corrections),
// checked first so the field that is missing is the one marked.
const attReasonCheck = (value) => {
  if (!value) return 'Reason is required.';
  return value.length >= 5 ? '' : 'Give a little more detail (at least 5 characters).';
};

function attRequireFields(entries) {
  if (!requireFields(entries)) throw new Error('Fill in the highlighted fields.');
}

function openAttendanceReview(rootId, correctionId) {
  const board = attendanceBoards.get(rootId);
  const correction = board?.corrections.find((c) => String(c.id) === String(correctionId));
  if (!correction) return;

  openAttendanceDialog({
    title: 'Review Correction Request',
    summary: `
      <div><strong>${escapeHtml(correction.employee_name || 'Employee')}</strong> · ${escapeHtml(attFormatDate(correction.log_date))}</div>
      <div>Recorded: ${escapeHtml(attFormatTime(correction.original_time_in))} – ${escapeHtml(attFormatTime(correction.original_time_out))} ${attendanceStatusBadge(correction.original_status)}</div>
      <div>Requested time out: <strong class="mn">${escapeHtml(attFormatTime(correction.corrected_time_out))}</strong></div>
      <div style="margin-top:6px;color:var(--t1);">“${escapeHtml(correction.reason || '')}”</div>`,
    fields: `
      <div class="fg" style="margin:0;">
        <label for="att-review-resolution">If rejected, the record becomes</label>
        <select id="att-review-resolution" class="fc">
          <option value="incomplete">Keep as recorded (Incomplete stays out of payroll)</option>
          <option value="absent">Absent</option>
          <option value="half_day">Half Day</option>
        </select>
      </div>
      <div class="fg" style="margin:0;">
        <label for="att-review-note">Note (optional)</label>
        <textarea id="att-review-note" class="fc" rows="2" maxlength="500" placeholder="Shown with the decision in the audit trail"></textarea>
      </div>`,
    actions: [
      {
        label: 'Reject',
        className: 'btn-outline',
        handler: () => submitAttendanceReview(rootId, correction.id, 'reject'),
      },
      {
        label: 'Approve',
        className: 'btn-primary',
        handler: () => submitAttendanceReview(rootId, correction.id, 'approve'),
      },
    ],
  });
}

function openOvertimeReview(rootId, logId) {
  const board = attendanceBoards.get(rootId);
  const row = board?.overtime.find((r) => String(r.log_id) === String(logId));
  if (!row) return;
  const current = row.approval?.status === 'approved' ? row.approval.approved_minutes : row.overtime_minutes;

  openAttendanceDialog({
    title: 'Review Overtime',
    summary: `
      <div><strong>${escapeHtml(row.employee_name || 'Employee')}</strong> · ${escapeHtml(attFormatDate(row.log_date))}</div>
      <div>Time out <strong class="mn">${escapeHtml(attFormatTime(row.time_out))}</strong>, shift ends ${escapeHtml(row.work_end || '')}: <strong>${escapeHtml(attMinutes(row.overtime_minutes))}</strong> past schedule.</div>
      <div style="margin-top:6px;">Only the minutes approved here are paid as overtime.</div>`,
    fields: `
      <div class="fg" style="margin:0;">
        <label for="att-ot-minutes">Minutes to approve (1–${Number(row.overtime_minutes) || 0})</label>
        <input id="att-ot-minutes" class="fc" type="number" min="1" max="${Number(row.overtime_minutes) || 0}" step="1" inputmode="numeric" value="${Number(current) || 0}">
      </div>
      <div class="fg" style="margin:0;">
        <label for="att-ot-note">Note (optional)</label>
        <textarea id="att-ot-note" class="fc" rows="2" maxlength="300" placeholder="Shown with the decision in the audit trail">${escapeHtml(row.approval?.note || '')}</textarea>
      </div>`,
    actions: [
      {
        label: 'Reject',
        className: 'btn-outline',
        handler: () => submitOvertimeReview(rootId, row.log_id, 'reject'),
      },
      {
        label: 'Approve',
        className: 'btn-primary',
        handler: () => submitOvertimeReview(rootId, row.log_id, 'approve'),
      },
    ],
  });
}

async function submitOvertimeReview(rootId, logId, decision) {
  const minutes = Number(attDialogValue('att-ot-minutes'));
  if (decision === 'approve') {
    const max = Number(document.getElementById('att-ot-minutes')?.max) || 0;
    attRequireFields([{
      field: 'att-ot-minutes',
      check: (value) => {
        if (!value) return 'Minutes to approve is required.';
        const n = Number(value);
        return Number.isInteger(n) && n >= 1 && n <= max ? '' : `Enter a whole number from 1 to ${max}.`;
      },
    }]);
  }
  await attFetchJson('/api/attendance/overtime', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      log_id: logId,
      decision,
      approved_minutes: decision === 'approve' ? minutes : 0,
      note: attDialogValue('att-ot-note'),
    }),
  });
  window.pushNotification?.(
    decision === 'approve' ? 'Overtime Approved' : 'Overtime Rejected',
    decision === 'approve' ? `${minutes} minute${minutes === 1 ? '' : 's'} will be paid as overtime.` : 'No overtime will be paid for this day.',
    decision === 'approve' ? 'success' : 'info',
  );
  await refreshAttendanceBoard(rootId);
}

async function submitAttendanceReview(rootId, correctionId, decision) {
  const reviewed = await attFetchJson('/api/attendance/corrections', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correction_id: correctionId,
      decision,
      resolution: attDialogValue('att-review-resolution'),
      note: attDialogValue('att-review-note'),
    }),
  });
  window.pushNotification?.(
    decision === 'approve' ? 'Correction Approved' : 'Correction Rejected',
    decision === 'approve' ? 'The time out was updated and the day is marked Corrected.' : 'The request was rejected.',
    decision === 'approve' ? 'success' : 'info',
  );
  attPayrollNotice(reviewed);
  await refreshAttendanceBoard(rootId);
}

function openAttendanceResolve(rootId, logId) {
  const board = attendanceBoards.get(rootId);
  const row = board?.logs.find((r) => String(r.id) === String(logId));
  if (!row) return;

  openAttendanceDialog({
    title: 'Resolve Incomplete Record',
    summary: `
      <div><strong>${escapeHtml(row.employee_name || 'Employee')}</strong> · ${escapeHtml(attFormatDate(row.log_date))}</div>
      <div>Time in ${escapeHtml(attFormatTime(row.time_in))}, no time out recorded.</div>`,
    fields: `
      <div class="fg" style="margin:0;">
        <label for="att-resolve-resolution">Resolution</label>
        <select id="att-resolve-resolution" class="fc" onchange="document.getElementById('att-resolve-time-wrap').style.display = this.value === 'time_out' ? '' : 'none'">
          <option value="time_out">Record the time out</option>
          <option value="absent">Mark Absent</option>
          <option value="half_day">Mark Half Day</option>
        </select>
      </div>
      <div class="fg" style="margin:0;" id="att-resolve-time-wrap">
        <label for="att-resolve-time">Time out</label>
        <input id="att-resolve-time" class="fc" type="time" />
      </div>
      <div class="fg" style="margin:0;">
        <label for="att-resolve-note">Reason</label>
        <textarea id="att-resolve-note" class="fc" rows="2" maxlength="500" placeholder="e.g. Confirmed with the branch logbook"></textarea>
      </div>`,
    actions: [{
      label: 'Resolve',
      className: 'btn-primary',
      handler: async () => {
        attRequireFields([
          ...(attDialogValue('att-resolve-resolution') === 'time_out' ? [{ field: 'att-resolve-time', label: 'Time out' }] : []),
          { field: 'att-resolve-note', check: attReasonCheck },
        ]);
        const resolved = await attFetchJson('/api/attendance/corrections', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'resolve',
            log_id: row.id,
            resolution: attDialogValue('att-resolve-resolution'),
            time_out: attDialogValue('att-resolve-time'),
            note: attDialogValue('att-resolve-note'),
          }),
        });
        window.pushNotification?.('Record Resolved', 'The attendance record is resolved and can now be included in payroll.', 'success');
        attPayrollNotice(resolved);
        await refreshAttendanceBoard(rootId);
      },
    }],
  });
}

/** HR / Admin: record the real times of a day the employee worked but never tapped. */
function openAttendanceAbsenceCorrection(rootId, employeeId, logDate) {
  const board = attendanceBoards.get(rootId);
  const row = board?.logs.find((r) => String(r.employee_id) === String(employeeId) && r.log_date === logDate && r.status === 'Absent');
  if (!row) return;

  openAttendanceDialog({
    title: 'Correct Absence',
    summary: `
      <div><strong>${escapeHtml(row.employee_name || 'Employee')}</strong> · ${escapeHtml(attFormatDate(row.log_date))} ${attendanceStatusBadge('Absent')}</div>
      <div>For a day the employee worked but did not tap. The times you enter are recorded, lateness and undertime are worked out from them, and the day is marked Corrected.</div>`,
    fields: `
      <div class="fg" style="margin:0;">
        <label for="att-absence-in">Time in</label>
        <input id="att-absence-in" class="fc" type="time" />
      </div>
      <div class="fg" style="margin:0;">
        <label for="att-absence-out">Time out</label>
        <input id="att-absence-out" class="fc" type="time" />
      </div>
      <div class="fg" style="margin:0;">
        <label for="att-absence-note">Reason</label>
        <textarea id="att-absence-note" class="fc" rows="2" maxlength="500" placeholder="e.g. RFID reader was down; confirmed with the branch logbook"></textarea>
      </div>`,
    actions: [{
      label: 'Save Correction',
      className: 'btn-primary',
      handler: async () => {
        attRequireFields([
          { field: 'att-absence-in', label: 'Time in' },
          {
            field: 'att-absence-out',
            check: (value) => {
              if (!value) return 'Time out is required.';
              const timeIn = attDialogValue('att-absence-in');
              return timeIn && value <= timeIn ? 'The time out must be after the time in.' : '';
            },
          },
          { field: 'att-absence-note', check: attReasonCheck },
        ]);
        const absenceCorrected = await attFetchJson('/api/attendance/corrections', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'correct_absence',
            employee_id: row.employee_id,
            log_date: row.log_date,
            time_in: attDialogValue('att-absence-in'),
            time_out: attDialogValue('att-absence-out'),
            note: attDialogValue('att-absence-note'),
          }),
        });
        window.pushNotification?.('Absence Corrected', `${row.employee_name || 'The employee'}'s day is recorded and marked Corrected.`, 'success');
        attPayrollNotice(absenceCorrected);
        await refreshAttendanceBoard(rootId);
      },
    }],
  });
}

/* ── EMPLOYEE: THIS PAY PERIOD + REQUEST CORRECTION ── */
const myAttendanceState = { logs: [], period: '' };

async function loadMyAttendancePeriod(rootId = 'emp-att-period') {
  const root = document.getElementById(rootId);
  if (!root) return;

  if (!root.dataset.mounted) {
    root.dataset.mounted = '1';
    root.innerHTML = `
      <div class="sh" style="margin-bottom:10px;flex-wrap:wrap;gap:8px;">
        <span class="stitle">This Pay Period</span>
        <span class="sp"></span>
        <span style="font-size:11px;color:var(--t3);" id="${escapeHtml(rootId)}-label"></span>
      </div>
      ${attendanceStatusLegend()}
      <p style="font-size:12px;color:var(--t3);margin-bottom:10px;">Forgot to tap out, or think a day is wrong? Use <strong>Request Correction</strong> on an Incomplete, Undertime or Half Day record. HR or your Administrator will review it.</p>
      <div class="tw"><table>
        <thead><tr><th>Date</th><th>Time In</th><th>Time Out</th><th>Status</th><th></th></tr></thead>
        <tbody id="${escapeHtml(rootId)}-body">${skeletonRows(5, 3)}</tbody>
      </table></div>`;
  }

  const body = document.getElementById(`${rootId}-body`);
  const label = document.getElementById(`${rootId}-label`);
  try {
    const data = await attFetchJson('/api/attendance/logs');
    myAttendanceState.logs = data.logs || [];
    myAttendanceState.period = data.range?.label || '';
    if (label) label.textContent = myAttendanceState.period;
    if (!body) return;
    if (!myAttendanceState.logs.length) {
      body.innerHTML = '<tr><td colspan="5" style="color:var(--t3);">No attendance recorded yet this pay period.</td></tr>';
      return;
    }
    body.innerHTML = myAttendanceState.logs.map((row) => {
      let action = '';
      if (row.correction) action = '<span style="font-size:12px;color:var(--t3);">Awaiting review</span>';
      else if (row.can_request_correction) {
        action = `<button class="btn btn-outline" type="button" style="padding:5px 12px;font-size:12px;" onclick="openMyCorrectionRequest('${escapeJsArg(row.id)}','${escapeJsArg(rootId)}')">Request Correction</button>`;
      }
      return `
        <tr>
          <td>${escapeHtml(attFormatDate(row.log_date))}</td>
          <td class="mn">${escapeHtml(attFormatTime(row.time_in))}</td>
          <td class="mn">${escapeHtml(attFormatTime(row.time_out))}</td>
          <td>${attendanceStatusBadge(row.status)}${row.status === 'On Leave' ? `<div style="font-size:11px;color:var(--t3);margin-top:3px;white-space:normal;">${escapeHtml(attendanceLeaveSummary(row.leave))}</div>` : ''}</td>
          <td>${action}</td>
        </tr>`;
    }).join('');
  } catch (error) {
    if (body) body.innerHTML = `<tr><td colspan="5" style="color:var(--red);">${escapeHtml(error.message)}</td></tr>`;
  }
}

function openMyCorrectionRequest(logId, rootId) {
  const row = myAttendanceState.logs.find((r) => String(r.id) === String(logId));
  if (!row) return;

  openAttendanceDialog({
    title: 'Request Correction',
    summary: `
      <div><strong>${escapeHtml(attFormatDate(row.log_date))}</strong> ${attendanceStatusBadge(row.status)}</div>
      <div>Recorded: time in ${escapeHtml(attFormatTime(row.time_in))}, time out ${escapeHtml(attFormatTime(row.time_out))}</div>`,
    fields: `
      <div class="fg" style="margin:0;">
        <label for="att-request-time">Corrected time out</label>
        <input id="att-request-time" class="fc" type="time" value="${escapeHtml(attTimeInputValue(row.time_out))}" />
      </div>
      <div class="fg" style="margin:0;">
        <label for="att-request-reason">Reason</label>
        <textarea id="att-request-reason" class="fc" rows="3" maxlength="500" placeholder="e.g. The reader was offline when I left at 5:00 PM"></textarea>
      </div>`,
    actions: [{
      label: 'Submit Request',
      className: 'btn-primary',
      handler: async () => {
        attRequireFields([
          { field: 'att-request-time', label: 'Corrected time out' },
          { field: 'att-request-reason', check: attReasonCheck },
        ]);
        await attFetchJson('/api/attendance/corrections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            log_id: row.id,
            corrected_time: attDialogValue('att-request-time'),
            reason: attDialogValue('att-request-reason'),
          }),
        });
        window.pushNotification?.('Correction Requested', 'Your request was sent for review. The day shows Pending Correction until it is decided.', 'success');
        await loadMyAttendancePeriod(rootId);
      },
    }],
  });
}

window.attendanceStatusBadge = attendanceStatusBadge;
window.attendanceStatusColor = attendanceStatusColor;
window.attendanceCalendarClass = attendanceCalendarClass;
window.attendanceLeaveSummary = attendanceLeaveSummary;
window.holidayLineLabel = holidayLineLabel;
window.mountUpcomingHolidays = mountUpcomingHolidays;
window.normalizeAttendanceStatusLabel = normalizeAttendanceStatusLabel;
window.mountAttendanceBoard = mountAttendanceBoard;
window.openOvertimeReview = openOvertimeReview;
window.refreshAttendanceBoard = refreshAttendanceBoard;
window.openAttendanceReview = openAttendanceReview;
window.openAttendanceResolve = openAttendanceResolve;
window.openAttendanceAbsenceCorrection = openAttendanceAbsenceCorrection;
window.openAttendanceCorrection = openAttendanceCorrection;
window.openAttendanceCorrectionByKey = openAttendanceCorrectionByKey;
window.attSyncCorrectionFields = attSyncCorrectionFields;
window.toggleAttendanceBranch = toggleAttendanceBranch;
window.setAttendanceStatusChip = setAttendanceStatusChip;
window.attPrepareAttendanceLog = attPrepareAttendanceLog;
window.attRenderAttendanceLogPage = attRenderAttendanceLogPage;
window.openAttendanceEmployeePage = openAttendanceEmployeePage;
window.mountAttendanceEmployeePage = mountAttendanceEmployeePage;
window.openAttendanceCorrectionHistory = openAttendanceCorrectionHistory;
window.openAttendanceTaps = openAttendanceTaps;
window.attEmployeeBack = attEmployeeBack;
window.openAttendanceDialog = openAttendanceDialog;
window.closeAttendanceDialog = closeAttendanceDialog;
window.loadMyAttendancePeriod = loadMyAttendancePeriod;
window.openMyCorrectionRequest = openMyCorrectionRequest;

/* ── Keyboard access for clickable non-buttons ──
   The sidebar items, filter chips, employee tabs and cards are elements with
   an inline onclick, which a keyboard could not reach. Each one is made a tab
   stop (role="button" unless it already has a role, or is a table row/cell)
   and Enter / Space activate it like a click. Content the portals render
   later is picked up by the observer below. Visible focus: base.css. */
const KBD_NATIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'OPTION', 'SUMMARY']);

function enhanceKeyboardClickables(root) {
  if (!root || root.nodeType !== 1) return;
  const found = Array.from(root.querySelectorAll('[onclick]:not([data-kbd-click])'));
  if (root.matches('[onclick]:not([data-kbd-click])')) found.unshift(root);
  found.forEach((el) => {
    if (KBD_NATIVE_TAGS.has(el.tagName)) return;
    el.setAttribute('data-kbd-click', '');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.hasAttribute('role') && el.tagName !== 'TR' && el.tagName !== 'TD') el.setAttribute('role', 'button');
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const el = event.target;
  if (!(el instanceof Element) || !el.hasAttribute('data-kbd-click')) return;
  event.preventDefault();
  el.click();
});

(function watchKeyboardClickables() {
  const start = () => {
    enhanceKeyboardClickables(document.body);
    new MutationObserver((mutations) => {
      mutations.forEach((mutation) => mutation.addedNodes.forEach(enhanceKeyboardClickables));
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
