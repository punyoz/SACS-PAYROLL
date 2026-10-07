import "@/styles/ui.css";
import { PortalLayout } from "@/components/portal/portal-layout";

export const metadata = {
  title: "Administrator · SACS Payroll",
  description: "Shepherd Angels Christian School Payroll Management System",
};

export default function AdminLayout({ children }) {
  return <PortalLayout>{children}</PortalLayout>;
}
