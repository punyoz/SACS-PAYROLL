import { DM_Mono, DM_Sans } from "next/font/google";

// The portals' typefaces, self-hosted by Next.
// Same settings as src/app/login/layout.js, for the React portals' layouts.
const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-dm-sans", display: "swap" });
const dmMono = DM_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-dm-mono", display: "swap" });

export const fontVariables = `${dmSans.variable} ${dmMono.variable}`;
