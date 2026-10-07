import "@/styles/ui.css";
import { PortalLayout } from "@/components/portal/portal-layout";

export const metadata = {
  title: "RFID Terminal · SACS Payroll",
  description: "Shepherd Angels Christian School Payroll Management System",
};

export default function RfidTerminalLayout({ children }) {
  return <PortalLayout>{children}</PortalLayout>;
}
