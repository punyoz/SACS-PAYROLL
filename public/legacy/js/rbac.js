/* ═══════════════════════════════════════════════════════════════════════════
   rbac.js — permission-driven sidebar rendering and page access.

   The portals used to ship a hardcoded sidebar per role in pages/<role>.html.
   This script replaces the nav rows of whichever portal is on screen with rows
   built from /api/rbac/me, which derives them from the permission matrix in
   src/lib/rbac/permissions.js. The matrix is now the only place a module's
   visibility is decided — nothing here has its own copy of the rules.

   Deliberately additive: it does not modify or replace any existing function in
   app.js or the per-role scripts. It only rewrites the nav rows inside
   <aside class="sidebar">, reusing the exact same markup (.sb-sec headings,
   .ni rows, the same inline SVGs and the same adminNav()/saNav()/hrNav()/
   acctNav() handlers), so the look, theme and responsive behaviour are
   untouched. The brand button and the sign-out footer are left alone.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var SCREEN_BY_ROLE = {
    super_admin: 's-super-admin',
    admin: 's-admin',
    hr: 's-hr',
    accountant: 's-accountant',
    employee: 's-emp'
  };

  var ROLE_ROUTES = {
    super_admin: '/super-admin',
    admin: '/admin',
    hr: '/hr',
    accountant: '/accountant',
    employee: '/employee'
  };

  var state = { me: null };

  /* ── Session expiry, replacement and the password gate ───────────────────
     Every API call runs against a signed session cookie. The server answers:
       401 "session_replaced"   the account signed in on another device or
                                browser — this one is signed out at once
       401 (anything else)      the session lapsed
       403 "password_change_required"
                                the account must replace its issued password
     Wrapping fetch keeps this in one place instead of touching each of the
     ~40 call sites.                                                          */
  var nativeFetch = window.fetch.bind(window);
  var redirecting = false;

  // Endpoints whose 401 means "wrong credentials", not "session over".
  var CREDENTIAL_ENDPOINTS = ['/api/legacy-auth/login', '/api/legacy-auth/reset-password'];

  var REASON_BY_CODE = {
    session_replaced: 'signed_in_elsewhere',
    account_archived: 'account_archived'
  };

  function signOutLocally(reason) {
    if (redirecting) return;
    redirecting = true;
    try {
      localStorage.removeItem('sacs-auth-context');
      ['super_admin', 'admin', 'accountant', 'employee', 'hr'].forEach(function (role) {
        localStorage.removeItem('sacs-active-page-' + role);
      });
    } catch (e) { /* private mode */ }
    (window.top || window).location.href = '/login' + (reason ? '?reason=' + encodeURIComponent(reason) : '');
  }

  function requirePasswordChange() {
    if (window._passwordGate || redirecting) return;
    redirecting = true;
    try {
      var ctx = JSON.parse(localStorage.getItem('sacs-auth-context') || 'null');
      if (ctx) {
        ctx.must_change_password = true;
        localStorage.setItem('sacs-auth-context', JSON.stringify(ctx));
      }
    } catch (e) { /* private mode */ }
    window.location.reload();
  }

  window.fetch = function (input, init) {
    return nativeFetch(input, init).then(function (response) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/') === -1) return response;

      var isCredentialCall = CREDENTIAL_ENDPOINTS.some(function (path) { return url.indexOf(path) !== -1; });

      if (response.status === 401 && !isCredentialCall && !redirecting) {
        return response.clone().json().catch(function () { return {}; }).then(function (body) {
          signOutLocally(REASON_BY_CODE[body && body.code] || 'session_expired');
          return response;
        });
      }

      if (response.status === 403 && !redirecting) {
        return response.clone().json().catch(function () { return {}; }).then(function (body) {
          if (body && body.code === 'password_change_required') requirePasswordChange();
          return response;
        });
      }

      return response;
    });
  };

  /* ── One active sign-in: heartbeat ───────────────────────────────────────
     A newer sign-in elsewhere invalidates this one server-side; the heartbeat
     notices within a few seconds even when nobody is clicking, and whenever
     the tab regains focus.                                                    */
  var HEARTBEAT_MS = 10000;
  var heartbeatTimer = null;
  var heartbeatInFlight = false;

  function checkSession() {
    if (heartbeatInFlight || redirecting) return;
    heartbeatInFlight = true;
    window.fetch('/api/legacy-auth/session', { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) return null;
        return response.json().catch(function () { return null; });
      })
      .then(function (body) {
        if (!body || redirecting) return;
        if (body.must_change_password && !window._passwordGate) requirePasswordChange();
      })
      .catch(function () { /* offline: try again on the next beat */ })
      .then(function () { heartbeatInFlight = false; });
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    // A background tab has nobody to warn, and visibilitychange below checks
    // the moment it comes back — so skip the beat while hidden instead of
    // polling the server every 10 seconds from every idle tab.
    heartbeatTimer = setInterval(function () {
      if (document.visibilityState === 'hidden') return;
      checkSession();
    }, HEARTBEAT_MS);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') checkSession();
    });
    window.addEventListener('focus', checkSession);
  }

  /* ── Sidebar rendering ─────────────────────────────────────────────────── */

  function navRow(item, isActive) {
    var row = document.createElement('div');
    row.className = isActive ? 'ni active' : 'ni';
    row.setAttribute('data-module', item.module);
    row.setAttribute('data-page', item.page);
    // Same inline onclick contract the hardcoded rows used, so the existing
    // per-portal nav functions keep working unchanged.
    row.setAttribute('onclick', item.handler + "('" + item.page + "',this)");
    row.innerHTML = item.icon + '\n      ' + item.label;
    return row;
  }

  function sectionHeading(label) {
    var heading = document.createElement('div');
    heading.className = 'sb-sec';
    heading.textContent = label;
    return heading;
  }

  function renderSidebar(role, menu) {
    var screen = document.getElementById(SCREEN_BY_ROLE[role]);
    if (!screen) return;

    var sidebar = screen.querySelector('.sidebar');
    if (!sidebar || !menu || !menu.length) return;

    var brand = sidebar.querySelector('.sb-brand');
    var foot = sidebar.querySelector('.sb-foot');

    // Drop only the nav rows and their headings. The brand button and the
    // sign-out footer are part of the layout, not the permission model.
    Array.prototype.slice
      .call(sidebar.querySelectorAll('.ni, .sb-sec'))
      .forEach(function (node) { node.remove(); });

    var fragment = document.createDocumentFragment();

    // Highlight the page the portal script already opened (a refresh restores
    // the last page), not simply the first row — otherwise the "all pages"
    // menu marked Dashboard as current while another page was on screen.
    var openPage = screen.querySelector('.page.active');
    var openId = openPage ? openPage.id : '';
    var hasOpenRow = menu.some(function (group) {
      return group.items.some(function (item) { return item.page === openId; });
    });
    var first = true;

    menu.forEach(function (group) {
      fragment.appendChild(sectionHeading(group.section));
      group.items.forEach(function (item) {
        fragment.appendChild(navRow(item, hasOpenRow ? item.page === openId : first));
        first = false;
      });
    });

    if (foot) {
      sidebar.insertBefore(fragment, foot);
    } else if (brand && brand.nextSibling) {
      sidebar.insertBefore(fragment, brand.nextSibling);
    } else {
      sidebar.appendChild(fragment);
    }
  }

  /* ── Page access ───────────────────────────────────────────────────────── */

  /**
   * Hide the page panels this role has no permission for. The panels stay in
   * the DOM (other scripts hold references to their ids); they are simply
   * never reachable, and are re-hidden if something makes one active.
   */
  function enforcePageAccess(role, allowedPages) {
    var screen = document.getElementById(SCREEN_BY_ROLE[role]);
    if (!screen) return;

    var allowed = {};
    (allowedPages || []).forEach(function (page) { allowed[page] = true; });

    Array.prototype.slice.call(screen.querySelectorAll('.page')).forEach(function (page) {
      if (!page.id || allowed[page.id]) return;
      page.classList.remove('active');
      page.setAttribute('data-rbac-blocked', 'true');
    });
  }

  /**
   * A blocked page can still be reached by a stale saved page id or by code
   * calling the portal's nav function directly, so re-check after navigation
   * and fall back to the role's first allowed page.
   */
  function watchForBlockedPages(role, allowedPages, defaultPage) {
    var screen = document.getElementById(SCREEN_BY_ROLE[role]);
    if (!screen) return;

    var allowed = {};
    (allowedPages || []).forEach(function (page) { allowed[page] = true; });

    var observer = new MutationObserver(function () {
      var active = screen.querySelector('.page.active');
      if (!active || !active.id || allowed[active.id]) return;

      active.classList.remove('active');
      var fallback = defaultPage && document.getElementById(defaultPage);
      if (fallback) fallback.classList.add('active');
    });

    observer.observe(screen, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  }

  /* ── Boot ──────────────────────────────────────────────────────────────── */

  function currentRoleFromUrl() {
    var params = new URLSearchParams(window.location.search);
    return String(params.get('role') || '').trim().toLowerCase();
  }

  async function init() {
    var role = currentRoleFromUrl();
    if (!role) return;

    startHeartbeat();

    var me;
    try {
      // Through the wrapped fetch, so a replaced or expired session on boot
      // signs out immediately instead of waiting for the first heartbeat.
      var response = await window.fetch('/api/rbac/me', { method: 'GET', cache: 'no-store' });
      me = response.ok ? await response.json() : null;
    } catch (error) {
      // Network trouble: leave the portal exactly as the server rendered it
      // rather than blanking the sidebar. The API guards still hold.
      return;
    }

    if (!me || !me.user) return;
    state.me = me;

    // The signed session is authoritative. If it disagrees with the portal the
    // browser opened, the browser is the one that is wrong.
    if (me.user.role !== role) {
      (window.top || window).location.href = ROLE_ROUTES[me.user.role] || '/login';
      return;
    }

    // Same for the password gate: the local flag only decides what loads
    // first. Reload into whichever screen the session actually allows.
    if (me.user.must_change_password && !window._passwordGate) {
      requirePasswordChange();
      return;
    }
    if (!me.user.must_change_password && window._passwordGate) {
      try {
        var stored = JSON.parse(localStorage.getItem('sacs-auth-context') || 'null');
        if (stored) {
          stored.must_change_password = false;
          localStorage.setItem('sacs-auth-context', JSON.stringify(stored));
        }
      } catch (e) { /* private mode */ }
      window.location.reload();
      return;
    }
    if (window._passwordGate) return;

    renderSidebar(me.user.role, me.menu);
    enforcePageAccess(me.user.role, me.allowed_pages);
    watchForBlockedPages(me.user.role, me.allowed_pages, me.default_page);
  }

  /* Expose the resolved permissions so portal scripts can ask before showing
     an edit control. Read-only: changing this changes nothing server-side. */
  window.sacsPermissions = {
    get: function () { return state.me; },
    can: function (module, action) {
      var perms = state.me && state.me.permissions && state.me.permissions[module];
      if (!perms || !perms.actions) return false;
      return perms.actions.indexOf(String(action || 'read').toLowerCase()) !== -1;
    },
    branchId: function () { return state.me && state.me.user ? state.me.user.branch_id : null; },
    isBranchExempt: function () {
      return Boolean(state.me && state.me.user && state.me.user.branch_exempt);
    }
  };

  /* Sign-out has to end the server session too, not just the local copy.
     keepalive lets the request survive the navigation logout() triggers. */
  window.sacsEndServerSession = function () {
    return nativeFetch('/api/legacy-auth/logout', {
      method: 'POST',
      keepalive: true
    }).catch(function () {
      // Never block sign-out on a network failure — the local context is
      // cleared by logout() either way, and the cookie expires on its own.
    });
  };

  /* Wrap the portal's existing logout() rather than editing app.js: clearing
     localStorage alone would leave the signed session cookie alive, so the
     API would still answer for a "signed out" browser. Inline onclick
     handlers resolve window.logout at call time, so they pick this up. */
  (function wrapLogout() {
    var original = window.logout;
    if (typeof original !== 'function' || original.__sacsRbacWrapped) return;

    var wrapped = function () {
      window.sacsEndServerSession();
      return original.apply(this, arguments);
    };
    wrapped.__sacsRbacWrapped = true;
    window.logout = wrapped;
  })();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
