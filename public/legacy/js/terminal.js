/**
 * RFID Attendance Terminal — public/legacy/rfid-terminal.html
 *
 * A standalone kiosk page opened from the Attendance panel of Administration
 * (openRfidTerminal() in admin.js) or Super Admin (openSARfidTerminal() in
 * super-admin.js), meant to sit next to the RFID reader. It shares the
 * signed-in user's session cookie (same browser, same origin), but adds its
 * own password lock on top: opening the terminal and leaving it both require
 * that same user to type their password again, so
 * it can be left running unattended without becoming a way for anyone else
 * at the desk to touch attendance records or wander off with it open.
 *
 * RFID readers plug in as HID keyboards — a tap types the card's UID into
 * whatever has focus, then sends Enter. #rt-scan-input stays focused
 * whenever the kiosk screen is showing so a tap always lands there.
 */

(function () {
  const API_ME = '/api/rbac/me';
  const API_BRANCHES = '/api/admin/branches';
  const API_VERIFY = '/api/admin/attendance/verify-password';
  const API_SCAN = '/api/admin/attendance';

  const lockScreen = document.getElementById('rt-lock');
  const mainScreen = document.getElementById('rt-main');
  const lockForm = document.getElementById('rt-lock-form');
  const lockPassword = document.getElementById('rt-lock-password');
  const lockFeedback = document.getElementById('rt-lock-feedback');
  const lockSubmit = document.getElementById('rt-lock-submit');
  const lockSub = document.getElementById('rt-lock-sub');
  const lockBack = document.getElementById('rt-lock-back');
  const exitSub = document.getElementById('rt-exit-sub');

  const branchEl = document.getElementById('rt-branch');
  const clockEl = document.getElementById('rt-clock');
  const exitBtn = document.getElementById('rt-exit-btn');
  const exitModal = document.getElementById('rt-exit-modal');
  const exitPassword = document.getElementById('rt-exit-password');
  const exitFeedback = document.getElementById('rt-exit-feedback');
  const exitCancel = document.getElementById('rt-exit-cancel');
  const exitConfirm = document.getElementById('rt-exit-confirm');

  const statusEl = document.getElementById('rt-status');
  const statusText = document.getElementById('rt-status-text');
  const resultEl = document.getElementById('rt-result');
  const resultName = document.getElementById('rt-result-name');
  const resultBranch = document.getElementById('rt-result-branch');
  const resultTimeIn = document.getElementById('rt-result-timein');
  const resultTimeOut = document.getElementById('rt-result-timeout');
  const resultBadge = document.getElementById('rt-result-badge');
  const scanInput = document.getElementById('rt-scan-input');

  let branchName = '—';
  // Where Exit Terminal and the lock screen's back link return to. Set in
  // boot() from the signed-in role.
  let homePath = '/admin';
  let scanInFlight = false;
  let queuedCode = null;
  let resultTimer = null;

  function formatTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-PH', { hour: '2-digit', minute: '2-digit', hour12: true }).format(date);
  }

  function tickClock() {
    clockEl.textContent = new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
    }).format(new Date());
  }

  function showLockFeedback(message, isError) {
    lockFeedback.textContent = message || '';
    lockFeedback.className = `rt-feedback${isError ? ' err' : ''}`;
  }

  function showExitFeedback(message, isError) {
    exitFeedback.textContent = message || '';
    exitFeedback.className = `rt-feedback${isError ? ' err' : ''}`;
  }

  async function fetchIdentity() {
    const res = await fetch(API_ME);
    if (!res.ok) throw new Error('session');
    const data = await res.json();
    return data.user;
  }

  async function fetchBranchName(branchId) {
    if (!branchId) return '—';
    try {
      const res = await fetch(API_BRANCHES);
      if (!res.ok) return '—';
      const data = await res.json();
      const match = (data.branches || []).find((b) => String(b.id) === String(branchId));
      return match?.name || '—';
    } catch {
      return '—';
    }
  }

  async function boot() {
    let user;
    try {
      user = await fetchIdentity();
    } catch {
      window.location.href = '/login';
      return;
    }
    const isSuperAdmin = user?.role === 'super_admin';
    if (!user || (user.role !== 'admin' && !isSuperAdmin)) {
      window.location.href = '/admin';
      return;
    }
    homePath = isSuperAdmin ? '/super-admin' : '/admin';
    const portalLabel = isSuperAdmin ? 'Super Admin' : 'Administration';
    lockBack.href = homePath;
    lockBack.textContent = `\u2190 Back to ${portalLabel}`;
    exitSub.textContent = `Enter your ${portalLabel} password to close the terminal.`;
    // A Super Admin is not tied to one branch, and the scan API accepts any
    // branch's cards from them, so the kiosk says so instead of one name.
    branchName = isSuperAdmin ? 'All branches' : await fetchBranchName(user.branch_id);
    branchEl.textContent = branchName;
    lockSub.textContent = `Enter ${user.full_name || 'your'} ${portalLabel} password to open the terminal.`;
    lockPassword.focus();
  }

  function focusScanInput() {
    if (!mainScreen.hidden) scanInput.focus({ preventScroll: true });
  }

  function unlockScreen() {
    lockScreen.hidden = true;
    mainScreen.hidden = false;
    scanInput.value = '';
    focusScanInput();
  }

  async function verifyPassword(password) {
    const res = await fetch(API_VERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not verify password.');
    return Boolean(data.valid);
  }

  lockForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = lockPassword.value.trim();
    if (!password) { showLockFeedback('Enter your password.', true); return; }

    lockSubmit.disabled = true;
    lockSubmit.textContent = 'Checking...';
    showLockFeedback('', false);
    try {
      const valid = await verifyPassword(password);
      if (!valid) { showLockFeedback('Incorrect password.', true); return; }
      lockPassword.value = '';
      unlockScreen();
    } catch (err) {
      showLockFeedback(err.message, true);
    } finally {
      lockSubmit.disabled = false;
      lockSubmit.textContent = 'Unlock Terminal';
    }
  });

  function openExitModal() {
    exitModal.classList.add('active');
    exitModal.setAttribute('aria-hidden', 'false');
    exitPassword.value = '';
    showExitFeedback('', false);
    setTimeout(() => exitPassword.focus(), 30);
  }

  function closeExitModal() {
    exitModal.classList.remove('active');
    exitModal.setAttribute('aria-hidden', 'true');
    focusScanInput();
  }

  exitBtn.addEventListener('click', openExitModal);
  exitCancel.addEventListener('click', closeExitModal);
  exitModal.addEventListener('click', (event) => {
    if (event.target === exitModal) closeExitModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && exitModal.classList.contains('active')) closeExitModal();
  });

  exitConfirm.addEventListener('click', async () => {
    const password = exitPassword.value.trim();
    if (!password) { showExitFeedback('Enter your password.', true); return; }

    exitConfirm.disabled = true;
    exitConfirm.textContent = 'Checking...';
    try {
      const valid = await verifyPassword(password);
      if (!valid) { showExitFeedback('Incorrect password.', true); return; }
      // admin.js / super-admin.js navigate the tab to this page rather than
      // opening a popup (popups are too easily blocked), so window.close()
      // has nothing to close here — go back to the opener's portal directly.
      // The close() call is kept only for the case this page was opened as a
      // script-opened window some other way.
      window.close();
      window.location.href = homePath;
    } catch (err) {
      showExitFeedback(err.message, true);
    } finally {
      exitConfirm.disabled = false;
      exitConfirm.textContent = 'Exit';
    }
  });

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('.rt-eye');
    if (!btn) return;
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    btn.textContent = reveal ? 'Hide' : 'Show';
  });

  function setStatus(state, text) {
    statusEl.dataset.state = state;
    statusText.textContent = text;
  }

  // The kiosk only signals whether a tap worked: a green light for an
  // accepted tap (time in, time out, or a repeat of either), a red light for
  // anything refused. No name or times are shown -- the reader's user only
  // needs to know whether to walk on or tap again. The one message shown is
  // the server's refusal for someone on approved leave, since tapping again
  // would not help them.
  const LIGHT_MS = 2500;
  const MESSAGE_MS = 5000;
  const IDLE_TEXT = 'Tap your RFID card';

  function showLight(ok, message = '') {
    clearTimeout(resultTimer);
    resultEl.hidden = true;
    setStatus(ok ? 'in' : 'error', message);
    resultTimer = setTimeout(() => setStatus('idle', IDLE_TEXT), message ? MESSAGE_MS : LIGHT_MS);
  }

  // Detailed card, kept for reference; the kiosk now uses showLight().
  function showResult(record, tap, message) {
    clearTimeout(resultTimer);
    resultEl.hidden = false;
    resultName.textContent = record?.employee_name || 'Unknown';
    resultBranch.textContent = branchName;
    resultTimeIn.textContent = formatTime(record?.time_in);
    resultTimeOut.textContent = record?.time_out ? formatTime(record.time_out) : 'Still clocked in';

    const status = String(record?.status || '').toLowerCase();
    resultBadge.textContent = tap === 'duplicate' ? 'Repeated tap ignored' : (record?.status || '—');
    resultBadge.dataset.tone = status === 'present' ? 'green' : status === 'late' ? 'amber' : 'red';

    setStatus(tap === 'time_out' ? 'out' : tap === 'duplicate' ? 'duplicate' : 'in', message);
    resultTimer = setTimeout(() => {
      resultEl.hidden = true;
      setStatus('idle', 'Tap your RFID card');
    }, 8000);
  }

  async function submitScan(code) {
    if (!code) return;

    if (scanInFlight) {
      // A tap that arrives while another is still being processed used to
      // type its digits into the input on top of the first tap's leftover
      // value (not cleared until the first request's `finally`), producing a
      // mangled concatenated code that then got silently wiped — losing this
      // tap entirely with no feedback. Queuing it instead runs it right after
      // the in-flight one finishes.
      queuedCode = code;
      return;
    }

    scanInFlight = true;
    // Clear immediately, before awaiting the fetch, so a second tap's
    // keystrokes land in an empty field instead of appending to this one's.
    scanInput.value = '';

    try {
      const res = await fetch(API_SCAN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rfid_code: code }),
      });
      const data = await res.json().catch(() => ({}));

      showLight(res.ok && Boolean(data.record), !res.ok && data.on_leave ? data.error : '');
    } catch {
      showLight(false);
    } finally {
      scanInFlight = false;
      scanInput.value = '';
      focusScanInput();

      if (queuedCode) {
        const next = queuedCode;
        queuedCode = null;
        submitScan(next);
      }
    }
  }

  // #rt-scan-input starts `readonly` (see rfid-terminal.html) purely so
  // Chrome's password manager never treats it as a candidate to autofill —
  // it sits right below the password field the Admin just typed a real
  // password into on the lock screen, and once that field becomes visible
  // Chrome will otherwise fill it with the account's saved email as a
  // "username" guess, racing (and beating) any value we clear in JS.
  // Readonly fields are never autofill candidates, so dropping readonly on
  // the very first real keystroke — before the browser applies it to
  // .value — keeps that protection until actual use starts, with no effect
  // on typing or on the RFID reader's own keystrokes.
  scanInput.addEventListener('keydown', () => {
    if (scanInput.readOnly) scanInput.readOnly = false;
  });

  let idleTimer = null;
  scanInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = scanInput.value.trim();
    if (value) submitScan(value);
  });

  // Card UIDs are numbers only, and the kiosk no longer accepts employee IDs
  // (see resolveEmployeeByRfid in /api/admin/attendance), so anything else
  // typed or pasted is dropped as it arrives.
  // Some readers never send Enter after a tap — auto-submit once digits stop
  // arriving for a beat.
  scanInput.addEventListener('input', () => {
    clearTimeout(idleTimer);
    const digits = scanInput.value.replace(/\D/g, '');
    if (digits !== scanInput.value) scanInput.value = digits;
    const value = scanInput.value.trim();
    if (!/^\d{6,}$/.test(value)) return;
    idleTimer = setTimeout(() => {
      if (/^\d{6,}$/.test(scanInput.value.trim())) submitScan(scanInput.value.trim());
    }, 400);
  });

  document.addEventListener('click', (event) => {
    if (mainScreen.hidden) return;
    if (exitModal.classList.contains('active')) return;
    if (event.target.closest('#rt-exit-btn')) return;
    focusScanInput();
  });

  setInterval(() => {
    if (mainScreen.hidden) return;
    if (exitModal.classList.contains('active')) return;
    if (document.activeElement !== scanInput) focusScanInput();
  }, 1500);

  // The kiosk can go a long time between taps. While it is unlocked (the
  // Administrator's password opened it), keep its session alive against the
  // idle timeout; a locked kiosk is left to time out.
  setInterval(() => {
    if (mainScreen.hidden) return;
    fetch('/api/legacy-auth/session', { headers: { 'x-sacs-activity': '1' }, cache: 'no-store' }).catch(() => {});
  }, 4 * 60 * 1000);

  tickClock();
  setInterval(tickClock, 1000);
  boot();
})();
