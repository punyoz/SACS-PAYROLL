import "./globals.css";

export const metadata = {
  title: "BNCS Payroll",
  description: "BNCS Payroll Management System",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
