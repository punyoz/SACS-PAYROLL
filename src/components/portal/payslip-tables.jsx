"use client";

import * as React from "react";
import { InfoTip } from "@/components/portal/info-tip";
import { holidayLineLabel } from "@/lib/portal/format";
import { money } from "@/lib/portal/payroll-preview";
import { DEDUCTION_GROUPS } from "@/lib/payroll/payslip-tables";
import { cn } from "@/lib/utils";

/*
 * The one payslip layout every role sees (2026-11-18): Earnings and
 * Incentives on the left, Deductions on the right, from payslipTables()
 * (src/lib/payroll/payslip-tables.js). How a line was computed is behind ⓘ.
 */

export function PayslipRow({ label, value, tone, strong, muted, indent, note, sub }) {
  return (
    <div role="row" className={cn("flex items-baseline justify-between gap-4 px-3 py-1.5 text-sm print:py-0.5", strong && "bg-muted/40 font-semibold", muted && "text-muted-foreground", indent && "py-1 pl-6 text-xs")}>
      <span role="cell" className="min-w-0 break-words">
        <span className="flex items-center gap-1.5">{label}{note && !sub ? <InfoTip label={`How ${label} was computed`}>{note}</InfoTip> : null}</span>
        {/* Small text under the line (a government loan's remaining balance and reference, 2026-11-25). */}
        {sub ? <span className="block text-xs text-muted-foreground" data-testid="payslip-row-sub">{sub}</span> : null}
      </span>
      <span role="cell" className={cn("shrink-0 text-right tabular-nums", tone === "plus" && "text-success", tone === "minus" && "text-destructive", tone === "gold" && "text-gold-text")}>{value}</span>
    </div>
  );
}

/** A payslip section as a table: its title and "Amount" over the rows. */
export function PayslipSection({ title, children }) {
  return (
    <div role="table" aria-label={title} className="overflow-hidden rounded-md border print:break-inside-avoid">
      <div role="row" className="flex items-baseline justify-between gap-4 bg-muted/60 px-3 py-1.5 text-xs font-semibold">
        <span role="columnheader" className="tracking-wide text-gold-text uppercase">{title}</span>
        <span role="columnheader" className="text-muted-foreground">Amount</span>
      </div>
      <div role="rowgroup" className="divide-y">{children}</div>
    </div>
  );
}

/** A deduction reads positive, as on the PDF (2026-11-22); a credit (a tax refund) reads "−₱…" against them. */
const deduction = (row) => (row.text ? row.text : row.credit ? `−${money(Math.abs(Number(row.amount)))}` : money(Math.abs(Number(row.amount) || 0)));

/** A group's name over its lines (attendance, government contributions, tax, loans and advances, other). */
function GroupLabel({ children }) {
  return <div role="row" className="px-3 pt-2 pb-0.5 text-[0.7rem] font-semibold tracking-wide text-muted-foreground uppercase"><span role="cell">{children}</span></div>;
}

export function PayslipTables({ tables }) {
  if (!tables) return null;
  return (
    <div className="@container space-y-4" data-testid="payslip-tables">
      {/* Side by side when the payslip is wide enough (a half-width column stacks them). */}
      <div className="grid gap-6 @2xl:grid-cols-2 print:grid-cols-2 print:gap-6">
        <div className="space-y-4 print:space-y-2">
          <PayslipSection title="Earnings">
            {tables.earnings.map((row) => (
              <React.Fragment key={`${row.key}-${row.label}`}>
                <PayslipRow label={row.label} value={row.text || money(row.amount)} note={row.note} />
                {row.key === "holiday" && Number(row.amount) > 0 ? tables.holiday_lines.map((line, i) => <PayslipRow key={`${line.date}-${i}`} indent muted label={holidayLineLabel(line)} value={money(line.amount)} />) : null}
              </React.Fragment>
            ))}
            <PayslipRow label="Gross pay" value={money(tables.gross)} strong tone="gold" />
          </PayslipSection>
          {tables.incentives.length ? (
            <PayslipSection title="Incentives">
              {tables.incentives.map((row) => <PayslipRow key={`${row.key}-${row.label}`} label={row.label} value={money(row.amount)} tone="plus" note={row.note} />)}
            </PayslipSection>
          ) : null}
        </div>
        <PayslipSection title="Deductions">
          {DEDUCTION_GROUPS.map(([key, label]) => {
            const rows = tables.deductions.filter((row) => row.group === key);
            return rows.length ? (
              <React.Fragment key={key}>
                <GroupLabel>{label}</GroupLabel>
                {rows.map((row) => <PayslipRow key={`${row.key}-${row.label}`} label={row.label} value={deduction(row)} tone={row.credit ? "plus" : undefined} note={row.note}
                  sub={/^Remaining balance/.test(String(row.formula || row.note || "")) ? row.formula || row.note : undefined} />)}
              </React.Fragment>
            ) : null;
          })}
          <PayslipRow label="Total deductions" value={deduction({ amount: tables.total_deductions })} strong tone="minus" />
        </PayslipSection>
      </div>
      {tables.notes.length ? (
        <div className="space-y-1 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground" data-testid="payslip-notes">
          {tables.notes.map((n) => <p key={n} data-testid={/2nd-half payslip/.test(n) ? "first-half-note" : undefined}>{n}</p>)}
        </div>
      ) : null}
      <LeaveBalanceBox box={tables.leave_balance} />
    </div>
  );
}

/** Leave balance at the payslip date (2026-11-25): for information only, never part of the pay. */
export function LeaveBalanceBox({ box }) {
  if (!box) return null;
  return (
    <section className="rounded-lg border border-brand-gold/50 print:break-inside-avoid" data-testid="payslip-leave-balance">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-brand-gold/40 bg-brand-green/5 px-3 py-1.5">
        <h3 className="text-sm font-semibold text-brand-green">{box.title}</h3>
        <p className="text-xs text-muted-foreground">{box.note}</p>
      </div>
      <div role="table" className="divide-y text-sm">
        {box.rows.map((row) => (
          <div role="row" key={row.key} className="flex justify-between gap-4 px-3 py-1">
            <span role="cell" className={row.strong ? "font-semibold" : undefined}>{row.label}</span>
            <span role="cell" className={`tabular-nums ${row.strong ? "font-semibold" : ""}`}>{row.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
