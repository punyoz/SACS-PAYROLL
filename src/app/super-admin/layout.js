import "@/styles/ui.css";
import { PortalLayout } from "@/components/portal/portal-layout";

export const metadata = {
  title: "Super Admin · SACS Payroll",
  description: "Shepherd Angels Christian School Payroll Management System",
};

export default function SuperAdminLayout({ children }) {
  return <PortalLayout>{children}</PortalLayout>;
}
