import "@/styles/ui.css";
import { PortalLayout } from "@/components/portal/portal-layout";

export const metadata = {
  title: "HR · SACS Payroll",
  description: "Shepherd Angels Christian School Payroll Management System",
};

export default function HrLayout({ children }) {
  return <PortalLayout>{children}</PortalLayout>;
}
