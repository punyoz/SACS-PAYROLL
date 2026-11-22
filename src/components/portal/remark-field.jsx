"use client";

import * as React from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { fetchJson } from "@/lib/portal/api";

/*
 * The remark of a decision (Part H, 2026-11-22): a preset for this decision
 * and type, or "Other (write your own)"; a preset may carry extra words.
 * value / onChange: { code, extra }. The server builds the text and audits
 * the code with the decision (src/lib/remarks/presets.js).
 */

export const OTHER = "other";
export const EMPTY_REMARK = Object.freeze({ code: "", extra: "" });
const REQUIRED = new Set(["reject", "revoke", "override", "object"]);
const cache = new Map();

/** Why the remark cannot be sent yet, or "". */
export function remarkProblem(value, decision, required = REQUIRED.has(decision)) {
  const code = value?.code || "";
  const extra = String(value?.extra || "").trim();
  if (!code) return required ? "Choose a remark (a reason is required)." : "";
  if (code === OTHER && extra.length < 3) return "Write the remark (at least 3 characters).";
  return "";
}

/** The presets for one decision and type (fetched once per page load). */
export function useRemarkPresets(decision, entityType) {
  const key = `${decision}|${entityType}`;
  const [state, setState] = React.useState(() => ({ presets: cache.get(key) || [], loading: !cache.has(key), error: "" }));
  React.useEffect(() => {
    let live = true;
    if (cache.has(key)) { setState({ presets: cache.get(key), loading: false, error: "" }); return undefined; }
    setState((s) => ({ ...s, loading: true }));
    fetchJson(`/api/remark-presets?decision=${encodeURIComponent(decision)}&entity_type=${encodeURIComponent(entityType)}`)
      .then((data) => { cache.set(key, data.presets || []); if (live) setState({ presets: data.presets || [], loading: false, error: "" }); })
      .catch((error) => { if (live) setState({ presets: [], loading: false, error: error.message || "Could not load the remarks." }); });
    return () => { live = false; };
  }, [key, decision, entityType]);
  return state;
}

/** Forget the cached presets (after Settings changes them). */
export function clearRemarkPresetCache() { cache.clear(); }

export function RemarkField({ decision, entityType, value = EMPTY_REMARK, onChange, required = REQUIRED.has(decision), id = "remark", label = "Remark", error = "", disabled = false }) {
  const { presets, loading, error: loadError } = useRemarkPresets(decision, entityType);
  const code = value?.code || "";
  const other = code === OTHER;
  const set = (patch) => onChange?.({ ...EMPTY_REMARK, ...value, ...patch });
  const shown = error || loadError;
  return (
    <div className="space-y-2" data-testid="remark-field">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-preset`}>{label}{required ? null : <span className="font-normal text-muted-foreground"> (optional)</span>}</Label>
        <Select value={code} onValueChange={(next) => set({ code: next })} disabled={disabled || loading}>
          <SelectTrigger id={`${id}-preset`} className="w-full" aria-invalid={Boolean(shown) || undefined}>
            <SelectValue placeholder={loading ? "Loading remarks…" : "Choose a remark"} />
          </SelectTrigger>
          <SelectContent>
            {presets.map((p) => <SelectItem key={p.code} value={p.code}>{p.label}</SelectItem>)}
            <SelectItem value={OTHER}>Other (write your own)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {code ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-extra`}>{other ? "Your remark" : <>Details <span className="font-normal text-muted-foreground">(optional)</span></>}</Label>
          <Textarea id={`${id}-extra`} rows={2} maxLength={400} value={value?.extra || ""} onChange={(e) => set({ extra: e.target.value })} disabled={disabled}
            placeholder={other ? "Write the remark" : "Add details if needed"} />
        </div>
      ) : null}
      {shown ? <p role="alert" className="text-sm text-destructive">{shown}</p> : null}
    </div>
  );
}

/**
 * A decision with its remark (Part H): approve / reject / resolve / … one
 * item, or several (bulk: one remark for all of them). onConfirm(remark)
 * sends it; a thrown error is shown in the dialog.
 */
export function DecisionRemarkDialog({ open, title, description, decision, entityType, confirmLabel, destructive = false, idPrefix = "decision", onClose, onConfirm, children = null }) {
  const [value, setValue] = React.useState(EMPTY_REMARK);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) { setValue(EMPTY_REMARK); setError(""); setBusy(false); } }, [open]);
  if (!open) return null;
  async function submit() {
    const problem = remarkProblem(value, decision);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError("");
    try {
      await onConfirm({ code: value.code || null, extra: String(value.extra || "").trim() });
    } catch (e) {
      setError(e?.message || "The decision could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) onClose?.(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        <RemarkField id={idPrefix} decision={decision} entityType={entityType} value={value} onChange={(v) => { setValue(v); setError(""); }} error={error} disabled={busy} />
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={submit} disabled={busy}>
            {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
