/* ═══════════════════════════════════════
   app.js — core application logic
   Handles: login, logout, theme toggle
   Edit this file for auth and routing init
   ═══════════════════════════════════════ */

'use strict';

/* ── THEME ── */
const THEME_KEY = 'bncs-theme';

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
const AUTH_CONTEXT_KEY = 'bncs-auth-context';
const AUTH_CONTEXT_EVENT = 'bncs-auth-context-changed';
const ROLE_PAGE_STATE_PREFIX = 'bncs-active-page-';

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
  };

  localStorage.setItem(AUTH_CONTEXT_KEY, JSON.stringify(context));
  dispatchAuthContextChanged(context);
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
  ['admin', 'accountant', 'employee'].forEach((role) => {
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
    <p>You are about to <strong style="color:var(--t1);">${action}</strong>.</p>
    ${detail ? `<p>${detail}</p>` : ''}
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
  if (id === 's-admin') return 'Administrator';
  if (id === 's-accountant') return 'Accountant';
  if (id === 's-emp') return 'Employee';
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

function getRoleNotifications() {
  const screenId = getActiveScreen()?.id;

  if (screenId === 's-admin') {
    const pending = Number(document.getElementById('adm-panel-pending-approvals')?.textContent || 0);
    const totalEmployees = Number(document.getElementById('adm-panel-total-employees')?.textContent || 0);

    return [
      {
        title: pending > 0 ? `${pending} salary approvals are waiting` : 'No pending salary approvals',
        desc: pending > 0
          ? 'Open Salary Approvals to review pending salary changes.'
          : 'All submitted salary changes have been processed.',
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

  if (screenId === 's-emp') {
    const netPay = String(document.getElementById('ps-net-amount')?.textContent || '').trim() || 'N/A';
    const periodLabel = String(document.getElementById('ps-period-label')?.textContent || '').trim() || 'Current Period';

    return [
      {
        title: 'Latest payslip is available',
        desc: `${periodLabel} · Net pay ${netPay}`,
      },
      {
        title: 'Attendance summary is view-only',
        desc: 'Use this page to review attendance and payroll records.',
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

  const items = getRoleNotifications();
  list.innerHTML = items.map((item) => `
    <div class="notif-item">
      <div class="notif-item-title">${item.title}</div>
      <div class="notif-item-desc">${item.desc}</div>
    </div>
  `).join('');
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

  const dot = trigger.querySelector('.nd');
  if (dot) dot.style.display = 'none';
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
let observedScrollTarget = null;

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

function attachScrollListeners() {
  const target = getActiveScrollContainer();
  if (!target) return;

  if (observedScrollTarget && observedScrollTarget !== target) {
    observedScrollTarget.removeEventListener('scroll', handleActiveScreenWheelRelay);
  }

  observedScrollTarget = target;
  target.addEventListener('scroll', handleActiveScreenWheelRelay, { passive: true });
}

function handleActiveScreenWheelRelay() {
  // Scroll handler placeholder to keep a stable listener reference.
}

function handleGlobalMouseWheel(event) {
  // Keep the handler for compatibility, but rely on native browser scrolling.
  if (event.ctrlKey) return;
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
async function login() {
  const fields = document.querySelectorAll('#s-login .fi');
  const usernameInput = fields[0]?.value?.trim();
  const password = fields[1]?.value?.trim();

  if (!usernameInput || !password) {
    window.alert(`Enter your username or email and password to sign in.`);
    return;
  }

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

  window.top.location.href = result.redirectTo;
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

  ['s-admin', 's-accountant', 's-emp'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  document.getElementById('s-login').classList.add('active');
}

function showRoleScreen(role) {
  const screens = ['s-login', 's-admin', 's-accountant', 's-emp'];
  screens.forEach(id => document.getElementById(id)?.classList.remove('active'));

  if (role === 'admin') {
    document.getElementById('s-admin')?.classList.add('active');
  } else if (role === 'accountant') {
    document.getElementById('s-accountant')?.classList.add('active');
  } else if (role === 'employee') {
    document.getElementById('s-emp')?.classList.add('active');
  } else {
    document.getElementById('s-login')?.classList.add('active');
  }

  // Wait for active screen transition then sync scroll controls.
  setTimeout(() => {
    attachScrollListeners();
  }, 0);
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

/* ── INIT ── */
function initApp() {
  // Restore saved theme or default to dark
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved);

  const role = new URLSearchParams(window.location.search).get('role');
  if (role) {
    showRoleScreen(role);
  } else {
    showRoleScreen(''); // Show login screen
  }

  // Rebind listeners whenever role/page classes change.
  const appRoot = document.getElementById('app-root');
  if (appRoot) {
    const observer = new MutationObserver(() => {
      attachScrollListeners();
    });

    observer.observe(appRoot, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'PageDown') {
      event.preventDefault();
      scrollWebsite('down');
    }

    if (event.key === 'PageUp') {
      event.preventDefault();
      scrollWebsite('up');
    }
  });

  // Native mouse-wheel scrolling is more reliable across browsers and devices.
  // Do not intercept wheel events globally.

  // Expose helpers for manual usage when needed.
  window.scrollWebsite = scrollWebsite;
  window.scrollWebsiteTo = scrollWebsiteTo;
  window.getLegacyAuthContext = getAuthContext;
  window.confirmDestructiveAction = confirmDestructiveAction;
  window.persistRolePageState = persistRolePageState;
  window.getPersistedRolePageState = getPersistedRolePageState;
  window.refreshCurrentPortal = refreshCurrentPortal;
  window.openProofDocument = openProofDocument;
  window.openResetPasswordModal = openResetPasswordModal;
  window.closeResetPasswordModal = closeResetPasswordModal;
  window.submitResetPassword = submitResetPassword;
  window.createPaginator = createPaginator;
  window.paginatorGoTo = paginatorGoTo;

  // Sync auth context across tabs/windows without requiring refresh.
  window.addEventListener('storage', (event) => {
    if (event && event.key === AUTH_CONTEXT_KEY) {
      dispatchAuthContextChanged(getAuthContext());
    }
  });

  attachGlobalSearchHandlers();
  attachNotificationHandlers();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
