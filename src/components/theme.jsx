"use client";

import * as React from "react";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Light / dark mode for the shadcn/ui screens.
 *
 * <ThemeScope> renders the `.sacs-ui` root (src/styles/ui.css) and adds
 * `.dark` to it. The choice ("light", "dark" or "system") is remembered per
 * browser in localStorage; "system" follows the device setting live. The same
 * classes are mirrored onto <body> while the scope is mounted, because
 * dialogs and toasts render in a portal outside it.
 *
 * The inline script sets `.dark` before the first paint, so a dark-mode
 * device never flashes the light theme.
 */

const STORAGE_KEY = "sacs-ui-theme";
const ThemeContext = React.createContext({ theme: "system", resolved: "light", setTheme: () => {} });

function readStoredTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

const NO_FLASH_SCRIPT = `(function(){try{var t=localStorage.getItem("${STORAGE_KEY}");var d=t==="dark"||(t!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d)document.currentScript.parentElement.classList.add("dark");}catch(e){}})();`;

export function ThemeScope({ className = "", portalClassName = "", children }) {
  const [theme, setThemeState] = React.useState("system");
  const [systemDark, setSystemDark] = React.useState(false);

  React.useEffect(() => {
    setThemeState(readStoredTheme());
    setSystemDark(systemPrefersDark());
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = (event) => setSystemDark(event.matches);
    media?.addEventListener?.("change", onChange);
    return () => media?.removeEventListener?.("change", onChange);
  }, []);

  const resolved = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  React.useEffect(() => {
    const body = document.body;
    const extra = portalClassName.split(/\s+/).filter(Boolean);
    body.classList.add("sacs-ui-portal", ...extra);
    body.classList.toggle("dark", resolved === "dark");
    return () => body.classList.remove("sacs-ui-portal", "dark", ...extra);
  }, [resolved, portalClassName]);

  const setTheme = React.useCallback((next) => {
    setThemeState(next);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage blocked: the choice lasts for this page only
    }
  }, []);

  const value = React.useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);

  return (
    <ThemeContext.Provider value={value}>
      <div
        className={`sacs-ui ${resolved === "dark" ? "dark" : ""} ${className}`.trim()}
        suppressHydrationWarning
      >
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

export function useUiTheme() {
  return React.useContext(ThemeContext);
}

const NEXT = { light: "dark", dark: "system", system: "light" };
const LABEL = { light: "Light", dark: "Dark", system: "Device setting" };

/** One button that cycles Light -> Dark -> Device setting. */
export function ThemeToggle({ className }) {
  const { theme, setTheme } = useUiTheme();
  const Icon = theme === "light" ? SunIcon : theme === "dark" ? MoonIcon : MonitorIcon;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className}
      onClick={() => setTheme(NEXT[theme])}
      aria-label={`Appearance: ${LABEL[theme]}. Switch to ${LABEL[NEXT[theme]]}.`}
      title={`Appearance: ${LABEL[theme]}`}
    >
      <Icon aria-hidden="true" />
      <span>{LABEL[theme]}</span>
    </Button>
  );
}
