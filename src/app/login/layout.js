import "@/styles/ui.css";
import { DM_Mono, DM_Sans } from "next/font/google";
import { ThemeScope } from "@/components/theme";
import { Toaster } from "@/components/ui/sonner";

// The portals' typefaces (public/legacy/index.html), self-hosted by Next.
const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-dm-sans", display: "swap" });
const dmMono = DM_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-dm-mono", display: "swap" });

export const metadata = {
  title: "Sign in · SACS Payroll",
  description: "Shepherd Angels Christian School Payroll Management System",
};

export default function LoginLayout({ children }) {
  const fonts = `${dmSans.variable} ${dmMono.variable}`;
  return (
    <ThemeScope className={`${fonts} min-h-dvh font-sans antialiased`} portalClassName={fonts}>
      {children}
      <Toaster position="top-center" richColors closeButton />
    </ThemeScope>
  );
}
