import LegacyRoleFrame from "@/app/_components/LegacyRoleFrame";
import { HrPortal } from "./hr-portal";

/**
 * The HR portal, rebuilt with shadcn/ui. /hr?classic=1 still opens the
 * previous (legacy) portal, for comparison while the other portals are
 * rebuilt; both read and write the same data through the same API.
 */
export default async function HrPage({ searchParams }) {
  const params = await searchParams;
  if (params?.classic === "1") return <LegacyRoleFrame role="hr" />;
  return <HrPortal />;
}
