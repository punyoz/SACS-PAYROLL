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
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

/* ── ROLE SELECTION (login) ── */
let currentRole = 'admin';

function updateLoginIdentityField() {
  const label = document.getElementById('login-identity-label');
  const input = document.getElementById('login-identity-input');
  const hint = document.getElementById('login-identity-hint');
  if (!label || !input) return;

  if (currentRole === 'admin') {
    label.textContent = 'Username';
    input.placeholder = 'Enter admin username';
    if (hint) hint.textContent = '';
    return;
  }

  label.textContent = 'Email';
  input.placeholder = 'e.g. accountant@gmail.com';
  if (hint) hint.textContent = '';
}

function selRole(btn, role) {
  document.querySelectorAll('.rb').forEach(b => b.classList.remove('sel'));
  btn.classList.add('sel');
  currentRole = role;
  updateLoginIdentityField();
}

/* ── LOGIN ── */
async function login() {
  const fields = document.querySelectorAll('#s-login .fi');
  const usernameInput = fields[0]?.value?.trim();
  const password = fields[1]?.value?.trim();

  if (!usernameInput || !password) {
    const identityName = currentRole === 'admin' ? 'username' : 'email';
    window.alert(`Enter your ${identityName} and password to sign in.`);
    return;
  }

  const response = await fetch('/api/legacy-auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: currentRole, employeeId: usernameInput, password }),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.redirectTo) {
    window.alert(result.error || 'Unable to sign in.');
    return;
  }

  window.top.location.href = result.redirectTo;
}

/* ── LOGOUT ── */
function logout() {
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
    return;
  }

  if (role === 'accountant') {
    document.getElementById('s-accountant')?.classList.add('active');
    return;
  }

  if (role === 'employee') {
    document.getElementById('s-emp')?.classList.add('active');
    return;
  }

  document.getElementById('s-login')?.classList.add('active');
}

/* ── INIT ── */
function initApp() {
  // Restore saved theme or default to dark
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved);

  const role = new URLSearchParams(window.location.search).get('role');
  if (role) {
    showRoleScreen(role);
    return;
  }

  updateLoginIdentityField();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
