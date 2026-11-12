"use client";

import * as React from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * The ONE password box (2026-11-12): masked by default, the app's own
 * show/hide button (type="button", never submits; aria-pressed), and the
 * browser's own reveal / clear buttons hidden in globals.css so Edge never
 * shows a second eye. Masked again whenever the value is cleared (after a
 * submit) and when it unmounts (a dialog or page closing).
 *
 *   label        optional: without it, give the box an aria-label or an outside <Label htmlFor>
 *   icon         optional leading icon (the sign-in page's lock)
 *   autoComplete "current-password" to sign in / confirm, "new-password" to set one
 */
export function PasswordInput({
  id, label, value, onChange, autoComplete = "new-password", placeholder, readOnly, autoFocus, invalid,
  icon: Icon = null, className, disabled, ...rest
}) {
  const [show, setShow] = React.useState(false);
  React.useEffect(() => { if (!value) setShow(false); }, [value]);
  const box = (
    <div className="relative">
      {Icon ? <Icon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-gold-text" aria-hidden="true" /> : null}
      <Input
        id={id}
        type={show ? "text" : "password"}
        autoComplete={autoComplete}
        maxLength={72}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        className={cn("pr-12", Icon && "pl-9", className)}
        data-password-input=""
        {...rest}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute top-1/2 right-0.5 size-10 -translate-y-1/2 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:size-9"
        onClick={() => setShow((v) => !v)}
        disabled={disabled}
        aria-label={show ? "Hide password" : "Show password"}
        aria-pressed={show}
        aria-controls={id}
        data-password-toggle=""
      >
        {show ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
      </Button>
    </div>
  );
  if (!label) return box;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {box}
    </div>
  );
}
