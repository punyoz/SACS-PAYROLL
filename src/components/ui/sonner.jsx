"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useUiTheme } from "@/components/theme"
import { Toaster as Sonner } from "sonner";

// Where every pop-up toast sits (2026-11-08), one place for every page and
// role: top right, just under the 56 px header (bell, theme, profile stay
// clear), stacked, auto-dismissed after a few seconds, with a close button.
// Phones: full width with side margins, under the status bar and header.
// The notification bell's dropdown is separate and unchanged.
export const TOAST_DEFAULTS = Object.freeze({
  position: "top-right",
  offset: { top: 64, right: 16 },
  mobileOffset: { top: 64, left: 12, right: 12 },
  closeButton: true,
  richColors: true,
  duration: 5000,
  visibleToasts: 4,
  gap: 8,
})

const Toaster = ({
  ...props
}) => {
  // Follows the screen's own light/dark choice (src/components/theme.jsx).
  const { resolved: theme } = useUiTheme()

  return (
    <Sonner
      theme={theme}
      {...TOAST_DEFAULTS}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)"
        }
      }
      {...props}
    />
  );
}

export { Toaster }
