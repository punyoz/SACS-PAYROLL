"use client";

import * as React from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/portal/date-picker";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { manilaDateKey } from "@/lib/payroll/periods";
import { SEPARATION_REASONS } from "@/lib/employees/separation-rules";

/*
 * HR → User Management → Edit → Separate (PATCH /api/hr/employees
 * { action: "separate" }; scenarios EM-08 / HR-03). Resigned, end of
 * contract, retired, terminated or deceased: status Separated from the last
 * day, pay held and settled through Final Pay, RFID card deactivated.
 */
export function SeparateEmployeeDialog({ employee, onClose, onDone }) {
  const { notify } = usePortalSession();
  const [input, setInput] = React.useState({ effective: manilaDateKey(), reason: "Resigned", note: "" });
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { setInput({ effective: manilaDateKey(), reason: "Resigned", note: "" }); setError(""); }, [employee]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/hr/employees", jsonBody("PATCH", { id: employee.id, action: "separate", ...input }));
      notify("Employee Separated", `${employee.full_name}: last day ${input.effective}. The Accountant settles the pay through Final Pay.`, "success");
      onDone?.();
      onClose();
    } catch (err) {
      setError(err.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(employee)} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Separate {employee?.full_name || "employee"}?</DialogTitle>
          <DialogDescription>From the last day, the status is Separated: no more taps or regular payslips, the RFID card is deactivated, and the pay is settled through Final Pay. The account stays open for the final payslip; archive it after Final Pay is released.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sep-effective">Last day of employment</Label>
              <DatePicker id="sep-effective" value={input.effective} onChange={(effective) => setInput((c) => ({ ...c, effective }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sep-reason">Reason</Label>
              <Select value={input.reason} onValueChange={(reason) => setInput((c) => ({ ...c, reason }))}>
                <SelectTrigger id="sep-reason" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{SEPARATION_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sep-note">{input.reason === "Terminated" || input.reason === "Other" ? "Grounds (required)" : "Note (optional)"}</Label>
            <Input id="sep-note" maxLength={1000} placeholder="e.g. Resignation letter dated Oct 1, accepted Oct 5" value={input.note} onChange={(e) => setInput((c) => ({ ...c, note: e.target.value }))} />
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={save} disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Separate</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
