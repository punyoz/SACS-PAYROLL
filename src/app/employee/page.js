import LegacyRoleFrame from "@/app/_components/LegacyRoleFrame";
import { EmployeePortal } from "./employee-portal";

/**
 * The Employee portal, rebuilt with shadcn/ui. /employee?classic=1 still
 * opens the previous (legacy) portal, for comparison while the other portals
 * are rebuilt; both read and write the same data through the same API.
 */
export default async function EmployeePage({ searchParams }) {
  const params = await searchParams;
  if (params?.classic === "1") return <LegacyRoleFrame role="employee" />;
  return <EmployeePortal />;
}
