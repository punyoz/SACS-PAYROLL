import LegacyRoleFrame from "@/app/_components/LegacyRoleFrame";
import { AdminPortal } from "./admin-portal";

/**
 * The Administrator portal, rebuilt with shadcn/ui. /admin?classic=1 still
 * opens the previous (legacy) portal, for comparison while the other portals
 * are rebuilt; both read and write the same data through the same API.
 */
export default async function AdminPage({ searchParams }) {
  const params = await searchParams;
  if (params?.classic === "1") return <LegacyRoleFrame role="admin" />;
  return <AdminPortal />;
}
