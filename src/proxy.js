/**
 * RBAC proxy (Next.js 16's replacement for middleware.js) — the first thing
 * every request passes through.
 *
 * Two jobs:
 *
 *   1. API routes — map each /api/** path to a module, map the HTTP verb to an
 *      action, and reject the request with 401/403 before the handler runs if
 *      the caller's role has no such permission in the matrix.
 *
 *   2. Portal pages — keep a signed-in user out of another role's portal
 *      (/admin, /super-admin, ...). Until now this was enforced only in
 *      public/legacy/js/app.js from a localStorage value the user can edit.
 *
 * This is the coarse, uniform layer: "may this role touch this module at all".
 * Branch scoping and the User Management role ceiling need to look at the
 * request body or the rows involved, so they are enforced inside the handlers
 * via src/lib/rbac/guard.js. Both layers read the same matrix.
 *
 * Two account-wide rules sit in front of both:
 *
 *   - One sign-in per account. A cookie whose session id is no longer the
 *     account's active one (a newer login happened elsewhere) is rejected with
 *     code "session_replaced", which the portals turn into an automatic
 *     sign-out (src/lib/auth/active-session.js).
 *   - A password still at its issued default can reach nothing but the
 *     change-password flow (code "password_change_required").
 *
 * Session verification uses node:crypto, which needs the Node.js runtime —
 * that's the default for this file (Next.js's middleware/proxy layer runs on
 * Node.js unless told otherwise), so nothing has to opt into it. Setting
 * `runtime` explicitly in this config is invalid in Next.js 16 and throws on
 * every request, which is worse than not setting it at all: don't add it back.
 */

import { NextResponse } from "next/server";
import { readSession, clearSession } from "@/lib/rbac/session";
import { can, isKnownRole } from "@/lib/rbac/permissions";
import { checkActiveSession } from "@/lib/auth/active-session";

export const config = {
  matcher: [
    "/api/:path*",
    "/super-admin/:path*",
    "/admin/:path*",
    "/hr/:path*",
    "/accountant/:path*",
    "/employee/:path*",
    "/rfid-terminal/:path*",
  ],
};

/** Paths that must stay reachable without a session. */
const PUBLIC_PATHS = [
  "/api/legacy-auth/login",
  "/api/legacy-auth/logout",
  "/api/legacy-auth/reset-password",
  // Login's second factor. Neither route has a sacs-session cookie to check
  // yet — they authenticate the caller from the signed pending-login cookie
  // instead (src/lib/auth/pending-login.js), which is not this proxy's cookie
  // to read. Reaching either without a valid pending-login cookie is refused
  // inside the route itself, not here.
  "/api/legacy-auth/verify-login-otp",
  "/api/legacy-auth/resend-login-otp",
];

/**
 * API path prefix -> module. Longest prefix wins, so a more specific entry can
 * override a broader one.
 */
const API_MODULES = [
  ["/api/rbac/me", null],                                  // session-derived, self-guarding
  ["/api/legacy-auth/session", null],                      // session heartbeat
  ["/api/legacy-auth/change-password", "profile"],
  // Emails the OTP the change above now needs (Employee / Accountant).
  ["/api/legacy-auth/change-password-otp", "profile"],
  ["/api/legacy-auth/update-profile", "profile"],
  ["/api/admin/users", "user_management"],
  ["/api/admin/employees", "employee_information"],
  ["/api/admin/employee-info", "employee_info_readonly"],
  // Creating a Super Admin / Admin / HR account. The module check here is
  // the coarse gate; the route itself additionally requires the caller to
  // BE a super_admin, because HR also holds user_management.
  ["/api/admin/staff-accounts", "user_management"],
  ["/api/admin/transfer-requests", "transfer_requests"],
  ["/api/admin/attendance", "attendance"],
  ["/api/admin/audit-logs", "audit_logs"],
  ["/api/admin/branch-employees", "branch_assignment"],
  ["/api/admin/branch-reports", "branch_reports"],
  ["/api/admin/branches", "branch_management"],
  ["/api/admin/config", "system_configuration"],
  // Effective-dated payroll rates: Super Admin's System Configuration.
  ["/api/admin/payroll-rates", "system_configuration"],
  // Status board (every role that can see attendance; employees their own).
  ["/api/attendance/logs", "attendance"],
  ["/api/attendance/corrections", "attendance_corrections"],
  ["/api/admin/system", "system_maintenance"],
  ["/api/admin/dashboard", "dashboard"],
  ["/api/hr/employees", "employee_information"],
  ["/api/hr/attendance", "attendance"],
  ["/api/hr/leave-requests", "leave_approval"],
  ["/api/hr/reports", "hr_reports"],
  ["/api/hr/dashboard", "dashboard"],
  ["/api/accountant/payroll", "process_payroll"],
  ["/api/employee/payslips", "payslips"],
  ["/api/employee/timesheet", "timesheet"],
  ["/api/employee/leave-requests", "leave_approval"],
  ["/api/employee/stats", "dashboard"],
];

/**
 * Reads are reads; every mutation verb maps to a write action. PATCH is
 * treated as "update" here — an archive (which the matrix calls delete) is
 * sent as PATCH { action: 'archive' }, and the handler checks that separately,
 * because only the body says which it is.
 */
const METHOD_ACTIONS = {
  GET: "read",
  HEAD: "read",
  OPTIONS: "read",
  POST: "create",
  PUT: "update",
  PATCH: "update",
  DELETE: "delete",
};

/**
 * Routes whose POST is not a creation but an action on existing data, so the
 * matrix's "update" permission is the right one to require.
 */
const POST_IS_UPDATE = [
  "/api/admin/attendance",       // recording/correcting a scan
  "/api/admin/branch-employees", // assigning staff to a branch
];

/**
 * Appending to your own activity trail is not a privileged write — every role
 * that can see the Audit Logs module also records into it as it navigates
 * (public/legacy/js/admin.js). Requiring "read" keeps that working while the
 * matrix still decides who has the module at all.
 */
const POST_IS_READ = [
  "/api/admin/audit-logs",
];

/** Portal path -> the role allowed to open it. */
const PORTAL_ROLES = {
  "/super-admin": "super_admin",
  "/admin": "admin",
  "/hr": "hr",
  "/accountant": "accountant",
  "/employee": "employee",
};

const ROLE_HOME = {
  super_admin: "/super-admin",
  admin: "/admin",
  hr: "/hr",
  accountant: "/accountant",
  employee: "/employee",
};

function moduleForPath(pathname) {
  let match = null;
  let matchedPrefix = "";

  for (const [prefix, module] of API_MODULES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      if (prefix.length > matchedPrefix.length) {
        matchedPrefix = prefix;
        match = module;
      }
    }
  }

  return { module: match, matched: Boolean(matchedPrefix) };
}

function actionForRequest(pathname, method) {
  const action = METHOD_ACTIONS[method] || "update";
  if (action === "create" && POST_IS_READ.some((p) => pathname.startsWith(p))) {
    return "read";
  }
  if (action === "create" && POST_IS_UPDATE.some((p) => pathname.startsWith(p))) {
    return "update";
  }
  return action;
}

/**
 * Reading the branch list is a label lookup every portal needs — Admin and HR
 * both render branch names on their Branch Assignment screens. Only creating,
 * editing and closing branch records is Branch Management, and that stays
 * Super Admin exclusive through the normal matrix check below.
 */
function isBranchLabelRead(pathname, method) {
  return pathname.startsWith("/api/admin/branches") && METHOD_ACTIONS[method] === "read";
}

/**
 * What an account that still has to replace its issued password may call:
 * the change itself, the session/permission lookups the change-password screen
 * makes, and nothing else. (Logout is public and never reaches this check.)
 */
const PASSWORD_CHANGE_ALLOWED = [
  "/api/legacy-auth/change-password",
  "/api/legacy-auth/change-password-otp",
  "/api/legacy-auth/session",
  "/api/rbac/me",
];

const SESSION_REJECTIONS = {
  expired: {
    code: "session_expired",
    reason: "session_expired",
    message: "Your session has expired. Please sign in again.",
  },
  replaced: {
    code: "session_replaced",
    reason: "signed_in_elsewhere",
    message: "You were signed out because your account signed in on another device or browser.",
  },
  archived: {
    code: "account_archived",
    reason: "account_archived",
    message: "This account has been archived and can no longer sign in.",
  },
};

/**
 * A signed cookie is only half the story: it must also still be the account's
 * active sign-in. Cookies minted before session ids existed carry none and are
 * treated as expired, so every browser signs in once more under the new rules.
 */
async function sessionRejection(session) {
  if (!session.sid) return SESSION_REJECTIONS.expired;
  const state = await checkActiveSession(session.sub, session.sid);
  return SESSION_REJECTIONS[state] || null;
}

export async function proxy(request) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const session = readSession(request);

  // ── RFID Terminal (Admin-only kiosk page) ──
  if (pathname === "/rfid-terminal" || pathname.startsWith("/rfid-terminal/")) {
    if (!session || !isKnownRole(session.role)) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
    const rejection = await sessionRejection(session);
    if (rejection) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("reason", rejection.reason);
      return clearSession(NextResponse.redirect(loginUrl));
    }
    if (session.role !== "admin") {
      return NextResponse.redirect(new URL(ROLE_HOME[session.role] || "/login", request.url));
    }
    return NextResponse.next();
  }

  // ── Portal pages ──
  const portal = Object.keys(PORTAL_ROLES).find(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (portal) {
    if (!session || !isKnownRole(session.role)) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
    const rejection = await sessionRejection(session);
    if (rejection) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("reason", rejection.reason);
      return clearSession(NextResponse.redirect(loginUrl));
    }
    if (session.role !== PORTAL_ROLES[portal]) {
      // Signed in, but this is not their portal — send them to their own.
      return NextResponse.redirect(new URL(ROLE_HOME[session.role] || "/login", request.url));
    }
    return NextResponse.next();
  }

  // ── API routes ──
  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  if (!session || !isKnownRole(session.role)) {
    return NextResponse.json(
      { error: "Your session has expired. Please sign in again." },
      { status: 401 },
    );
  }

  const rejection = await sessionRejection(session);
  if (rejection) {
    return clearSession(
      NextResponse.json({ error: rejection.message, code: rejection.code }, { status: 401 }),
    );
  }

  if (session.pwd && !PASSWORD_CHANGE_ALLOWED.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.json(
      {
        error: "Change your default password before using the system.",
        code: "password_change_required",
      },
      { status: 403 },
    );
  }

  const { module, matched } = moduleForPath(pathname);

  // An unmapped /api path is a mistake, not a free pass: fail closed so a new
  // route cannot ship unguarded by accident.
  if (!matched) {
    return NextResponse.json(
      { error: "You do not have permission to perform this action." },
      { status: 403 },
    );
  }

  // module === null means "authenticated session is the whole requirement"
  // (currently just /api/rbac/me, which derives everything from the cookie).
  if (module === null) {
    return NextResponse.next();
  }

  if (isBranchLabelRead(pathname, request.method)) {
    return NextResponse.next();
  }

  const action = actionForRequest(pathname, request.method);

  if (!can(session.role, module, action)) {
    return NextResponse.json(
      { error: "You do not have permission to perform this action." },
      { status: 403 },
    );
  }

  return NextResponse.next();
}
