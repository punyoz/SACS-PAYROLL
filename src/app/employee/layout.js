import "@/styles/ui.css";
import { PortalLayout } from "@/components/portal/portal-layout";

export const metadata = {
  title: "Employee · SACS Payroll",
  description: "Shepherd Angels Christian School Payroll Management System",
};

export default function EmployeeLayout({ children }) {
  return <PortalLayout>{children}</PortalLayout>;
}
