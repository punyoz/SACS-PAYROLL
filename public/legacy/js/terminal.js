/**
 * RFID Attendance Terminal — public/legacy/rfid-terminal.html
 *
 * A standalone kiosk page opened from Administration's Attendance panel
 * (openRfidTerminal() in admin.js), meant to sit next to the RFID reader.
 * It shares the signed-in Admin's session cookie (same browser, same
 * origin), but adds its own password lock on top: opening the terminal and
 * leaving it both require that same Admin to type their password again, so
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
    if (!user || user.role !== 'admin') {
      window.location.href = '/admin';
      return;
    }
    branchName = await fetchBranchName(user.branch_id);
    branchEl.textContent = branchName;
    lockSub.textContent = `Enter ${user.full_name || 'your'} Administration password to open the terminal.`;
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
      // admin.js navigates the tab to this page rather than opening a popup
      // (popups are too easily blocked), so window.close() has nothing to
      // close here — go back to Administration directly. The close() call is
      // kept only for the case this page was opened as a script-opened
      // window some other way.
      window.close();
      window.location.href = '/admin';
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
    setStatus('scanning', 'Reading card...');

    try {
      const res = await fetch(API_SCAN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rfid_code: code }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        resultEl.hidden = true;
        setStatus('error', data.error || 'RFID not matched to an active employee.');
        clearTimeout(resultTimer);
        resultTimer = setTimeout(() => setStatus('idle', 'Tap your RFID card'), 4000);
        return;
      }

      showResult(data.record, data.tap, data.message);
    } catch {
      resultEl.hidden = true;
      setStatus('error', 'Network error — try again.');
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

  let idleTimer = null;
  scanInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = scanInput.value.trim();
    if (value) submitScan(value);
  });

  // Some readers never send Enter after a tap — auto-submit once digits stop
  // arriving for a beat, restricted to numeric UIDs so a paused manual
  // employee-ID entry (e.g. "SACS-001") never auto-fires mid-typing.
  scanInput.addEventListener('input', () => {
    clearTimeout(idleTimer);
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

  tickClock();
  setInterval(tickClock, 1000);
  boot();
})();
