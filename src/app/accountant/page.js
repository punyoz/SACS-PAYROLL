import LegacyRoleFrame from "@/app/_components/LegacyRoleFrame";
import { AccountantPortal } from "./accountant-portal";

/**
 * The Accountant portal, rebuilt with shadcn/ui. /accountant?classic=1 still
 * opens the previous (legacy) portal, for comparison while the other portals
 * are rebuilt; both read and write the same data through the same API.
 */
export default async function AccountantPage({ searchParams }) {
  const params = await searchParams;
  if (params?.classic === "1") return <LegacyRoleFrame role="accountant" />;
  return <AccountantPortal />;
}
