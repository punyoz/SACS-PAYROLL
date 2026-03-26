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

function selRole(btn, role) {
  document.querySelectorAll('.rb').forEach(b => b.classList.remove('sel'));
  btn.classList.add('sel');
  currentRole = role;
}

/* ── LOGIN ── */
function login() {
  // In production: validate credentials with backend here
  const screens = ['s-login', 's-admin', 's-accountant', 's-emp'];
  screens.forEach(id => document.getElementById(id)?.classList.remove('active'));

  if (currentRole === 'admin') {
    document.getElementById('s-admin').classList.add('active');
  } else if (currentRole === 'accountant') {
    document.getElementById('s-accountant').classList.add('active');
  } else {
    document.getElementById('s-emp').classList.add('active');
  }
}

/* ── LOGOUT ── */
function logout() {
  ['s-admin', 's-accountant', 's-emp'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  document.getElementById('s-login').classList.add('active');
}

/* ── INIT ── */
document.addEventListener('DOMContentLoaded', () => {
  // Restore saved theme or default to dark
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved);
});
