import LegacyRoleFrame from "@/app/_components/LegacyRoleFrame";
import { SuperAdminPortal } from "./super-admin-portal";

/**
 * The Super Admin portal, rebuilt with shadcn/ui. /super-admin?classic=1
 * still opens the previous (legacy) portal, for comparison; both read and
 * write the same data through the same API.
 */
export default async function SuperAdminPage({ searchParams }) {
  const params = await searchParams;
  if (params?.classic === "1") return <LegacyRoleFrame role="super_admin" />;
  return <SuperAdminPortal />;
}
