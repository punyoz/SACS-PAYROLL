// "My Account" (2026-11-09 Part E): the same handler as employee/bir-2316,
// pinned to the signed-in person by src/lib/rbac/guard.js (any /api/me/* call
// is the caller's OWN records only; Admin and Super Admin get 403).
export { GET } from "@/app/api/employee/bir-2316/route";
