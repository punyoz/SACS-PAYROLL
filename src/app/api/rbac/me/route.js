/**
 * GET /api/rbac/me
 *
 * The browser's view of the signed-in caller's permissions. The legacy portals
 * call this on boot (public/legacy/js/rbac.js) to render the sidebar and to
 * decide which pages may open, so the matrix in src/lib/rbac/permissions.js
 * stays the only definition of who can do what — the frontend holds no copy.
 *
 * Everything here is derived from the signed HttpOnly session cookie, never
 * from anything the browser sent, so a user editing localStorage cannot widen
 * their own menu.
 */

import { NextResponse } from "next/server";
import { readSession } from "@/lib/rbac/session";
import { buildMenu, allowedPagesFor, defaultPageFor } from "@/lib/rbac/menu";
import {
  ROLE_PERMISSIONS,
  MANAGEABLE_ROLES,
  isBranchExempt,
  isKnownRole,
} from "@/lib/rbac/permissions";

export async function GET(request) {
  const session = readSession(request);

  if (!session || !isKnownRole(session.role)) {
    return NextResponse.json(
      { error: "Your session has expired. Please sign in again." },
      { status: 401 },
    );
  }

  const role = String(session.role).toLowerCase();

  return NextResponse.json({
    user: {
      id: session.sub,
      role,
      email: session.email || "",
      full_name: session.full_name || "",
      branch_id: session.branch_id || null,
      branch_exempt: isBranchExempt(role),
    },
    permissions: ROLE_PERMISSIONS[role] || {},
    manageable_roles: MANAGEABLE_ROLES[role] || [],
    menu: buildMenu(role),
    allowed_pages: allowedPagesFor(role),
    default_page: defaultPageFor(role),
  });
}
