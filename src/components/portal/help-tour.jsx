"use client";

import * as React from "react";
import { CircleHelpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { helpFor, helpSeenKey } from "@/lib/portal/help";

/**
 * The first-time tour (alpha test B6): a few short steps per role. It opens
 * once per role in this browser (remembered locally; nothing is stored on the
 * server), can be skipped, and reopens from the avatar menu → Help. It never
 * opens by itself in an automated browser (navigator.webdriver).
 */
export function useFirstTimeHelp(role) {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (!role || typeof window === "undefined" || navigator.webdriver) return;
    try {
      if (!window.localStorage.getItem(helpSeenKey(role))) setOpen(true);
    } catch { /* storage blocked: no automatic tour */ }
  }, [role]);
  const close = React.useCallback(() => {
    setOpen(false);
    try { window.localStorage.setItem(helpSeenKey(role), new Date().toISOString()); } catch { /* storage blocked */ }
  }, [role]);
  return { open, setOpen, close };
}

export function HelpTour({ role, open, onClose }) {
  const steps = helpFor(role);
  const [step, setStep] = React.useState(0);
  React.useEffect(() => { if (open) setStep(0); }, [open]);
  const last = step >= steps.length - 1;
  const current = steps[Math.min(step, steps.length - 1)];
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-md" data-testid="help-tour">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><CircleHelpIcon className="size-4 text-gold-text" aria-hidden="true" />{current.title}</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">{current.body}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-center gap-1.5" aria-label={`Step ${step + 1} of ${steps.length}`}>
          {steps.map((s, i) => <span key={s.title} className={`size-1.5 rounded-full ${i === step ? "bg-primary" : "bg-muted-foreground/30"}`} aria-hidden="true" />)}
        </div>
        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <Button variant="ghost" size="sm" onClick={onClose}>{last ? "Close" : "Skip"}</Button>
          <div className="flex gap-2">
            {step > 0 ? <Button variant="outline" size="sm" onClick={() => setStep((s) => s - 1)}>Back</Button> : null}
            <Button size="sm" onClick={() => (last ? onClose() : setStep((s) => s + 1))}>{last ? "Done" : "Next"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
