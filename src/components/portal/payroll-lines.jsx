"use client";

import * as React from "react";
import { CalculatorIcon, InfoIcon, PencilLineIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LINE_TAGS, bracketRangeText, pesoText } from "@/lib/payroll/line-tags";
import { cn } from "@/lib/utils";

/*
 * Grouped, tagged payroll lines (src/lib/payroll/line-tags.js): the Process
 * Payroll summary, the payslip and HR's approval view draw them the same way.
 * Every line says whether it is added (+) or deducted (−), what kind of
 * computation it is, and how it was computed.
 */

const TAG_CLASS = {
  percentage: "border-brand-gold/40 bg-brand-gold/15 text-gold-text",
  bracket: "border-primary/30 bg-primary/10 text-primary",
  rate_units: "border-info/25 bg-info/10 text-info",
  fixed: "border-border bg-muted text-muted-foreground",
  not_charged: "border-dashed border-border bg-transparent text-muted-foreground",
};
const TAG_SHORT = { percentage: "%", bracket: "Bracket", rate_units: "Rate × units", fixed: "Fixed", not_charged: "Not charged" };

export function LineTag({ tag, className, note }) {
  if (!tag || !LINE_TAGS[tag]) return null;
  // A line's own note (e.g. why Late is not charged): the tag opens it on tap or Enter.
  if (note) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" data-tag={tag} aria-label={`${LINE_TAGS[tag].label}: details`} className="inline-flex shrink-0 cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <LineTag tag={tag} className={className} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 text-xs">{note}</PopoverContent>
      </Popover>
    );
  }
  return (
    <Badge variant="outline" title={`${LINE_TAGS[tag].label}: ${LINE_TAGS[tag].hint}`} data-tag={tag}
      className={cn("h-4.5 shrink-0 rounded px-1 py-0 text-[10px] font-semibold tracking-wide uppercase", TAG_CLASS[tag], className)}>
      {tag === "percentage" ? "%" : TAG_SHORT[tag]}
      <span className="sr-only"> ({LINE_TAGS[tag].label})</span>
    </Badge>
  );
}

/** "Overridden" with the reason on hover (title) or tap (popover). */
function OverriddenMarker({ overridden }) {
  if (!overridden) return null;
  const text = `Overridden${overridden.from !== undefined ? ` (computed ${String(overridden.from)} → ${String(overridden.to)})` : ""}: ${overridden.reason || "no reason recorded"}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" title={text} data-testid="line-overridden"
          className="inline-flex shrink-0 items-center gap-0.5 rounded border border-warning/40 bg-warning/12 px-1 text-[10px] font-semibold tracking-wide text-warning uppercase">
          <PencilLineIcon className="size-2.5" aria-hidden="true" />Overridden
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 text-sm">{text}</PopoverContent>
    </Popover>
  );
}

function SignedAmount({ line }) {
  const tone = line.sign === "+" ? "text-success" : line.sign === "-" ? "text-destructive" : "text-muted-foreground";
  const sign = line.sign === "+" ? "+" : line.sign === "-" ? "−" : "";
  return <span className={cn("shrink-0 tabular-nums", tone)}>{sign ? `${sign} ` : ""}{pesoText(line.amount)}</span>;
}

/** The tax table with one bracket highlighted. */
export function TaxBracketTable({ rows, index, className }) {
  if (!rows?.length) return null;
  return (
    <div className={cn("overflow-x-auto rounded-md border", className)}>
      <table className="w-full min-w-72 text-xs">
        <thead className="bg-muted/60 text-muted-foreground">
          <tr><th className="px-2 py-1 text-left font-medium">Monthly taxable income</th><th className="px-2 py-1 text-right font-medium">Base tax</th><th className="px-2 py-1 text-right font-medium">Rate on the excess</th></tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.over} data-active={i === index || undefined} className={cn("border-t", i === index && "bg-brand-gold/15 font-semibold text-foreground")}>
              <td className="px-2 py-1 tabular-nums">{bracketRangeText(rows, i)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{pesoText(row.base)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{row.rate_pct ? `${row.rate_pct}% over ${pesoText(row.over).replace(/\.00$/, "")}` : "exempt"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "How was this tax computed?" (expandable). */
export function TaxHowDetails({ explanation, showTable = true, className }) {
  if (!explanation) return null;
  const e = explanation;
  return (
    <details className={cn("group rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs", className)} data-testid="tax-how">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-primary select-none">
        <CalculatorIcon className="size-3.5" aria-hidden="true" />How was this tax computed?
      </summary>
      <div className="mt-2 space-y-2">
        {e.deferred ? <p className="text-muted-foreground">{e.reason}</p> : (
          <>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5">
              <dt className="text-muted-foreground">Taxable income (monthly)</dt><dd className="text-right tabular-nums">{pesoText(e.taxable)}</dd>
              <dt className="text-muted-foreground">Bracket</dt><dd className="text-right">{e.range || "—"}</dd>
              <dt className="text-muted-foreground">Base tax</dt><dd className="text-right tabular-nums">{pesoText(e.base_tax)}</dd>
              <dt className="text-muted-foreground">Rate on the excess</dt><dd className="text-right tabular-nums">{e.rate_pct}%</dd>
              <dt className="text-muted-foreground">Excess over {e.bracket ? pesoText(e.bracket.over) : "the lower limit"}</dt><dd className="text-right tabular-nums">{pesoText(e.excess)}</dd>
              <dt className="font-semibold">Withholding tax</dt><dd className="text-right font-semibold tabular-nums">{pesoText(e.tax)}</dd>
              <dt className="text-muted-foreground">Effective rate on taxable income</dt><dd className="text-right tabular-nums">{e.effective_pct}%</dd>
            </dl>
            {e.formula_text ? <p className="font-mono text-[11px] break-words text-muted-foreground">{e.formula_text}</p> : null}
            {e.reason ? <p className="flex items-start gap-1 text-success"><InfoIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />{e.reason}</p> : null}
            {showTable ? <TaxBracketTable rows={e.rows} index={e.index} /> : null}
          </>
        )}
      </div>
    </details>
  );
}

function LineRow({ line }) {
  return (
    <li className="space-y-0.5" data-line={line.key} data-tag={line.tag}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 break-words">{line.label}</span>
          <LineTag tag={line.tag} note={line.tip} />
          <OverriddenMarker overridden={line.overridden} />
        </span>
        <SignedAmount line={line} />
      </div>
      {line.how ? <p className="text-xs break-words text-muted-foreground">{line.how}</p> : null}
    </li>
  );
}

/**
 * @param {{ result: object, netLabel?: string, net?: number, gross?: number, showTaxHow?: boolean, children?: React.ReactNode }} props
 *   result: buildLineGroups() / payrollLineGroups(); children render before the net (settlement notes).
 */
export function PayrollLineGroups({ result, netLabel, net, showTaxHow = true, taxTable = true, hideEmpty = true, children, className }) {
  if (!result) return null;
  return (
    <div className={cn("space-y-3 text-sm", className)} data-testid="payroll-line-groups">
      {result.groups.map((group) => {
        if (hideEmpty && !group.lines.length && !group.note && group.key !== "additions") return null;
        const showTaxable = group.key === "tax" && result.taxable;
        return (
          <React.Fragment key={group.key}>
            {showTaxable ? (
              <div className="flex items-baseline justify-between gap-3 rounded-md border border-dashed border-primary/30 bg-primary/5 px-2.5 py-1.5" data-testid="taxable-income">
                <span className="min-w-0"><span className="font-medium">Taxable income</span><span className="block text-xs text-muted-foreground">{result.taxable.how}</span></span>
                <span className="shrink-0 font-medium tabular-nums">{pesoText(result.taxable.amount)}</span>
              </div>
            ) : null}
            <section className="space-y-1.5" data-group={group.key}>
              <p className="text-xs font-semibold tracking-wide text-gold-text uppercase">{group.title}</p>
              {group.note && !group.lines.length ? <p className="text-xs text-muted-foreground">{group.note}</p> : null}
              {group.lines.length ? <ul className="space-y-1.5">{group.lines.map((l) => <LineRow key={l.key} line={l} />)}</ul> : null}
              {group.key === "tax" && showTaxHow && !group.note ? <TaxHowDetails explanation={result.tax} showTable={taxTable} /> : null}
              {group.lines.length ? (
                <div className="flex items-baseline justify-between gap-3 border-t border-dashed pt-1 text-xs font-semibold">
                  <span>{group.key === "additions" ? "Total additions" : `Subtotal: ${group.title.replace(/ \(.*\)$/, "").toLowerCase()}`}</span>
                  <span className={cn("tabular-nums", group.sign === "+" ? "text-success" : "text-destructive")}>{group.sign === "+" ? "+" : "−"} {pesoText(group.subtotal)}</span>
                </div>
              ) : null}
            </section>
          </React.Fragment>
        );
      })}
      {result.leave_with_pay_days > 0 ? (
        <div className="flex items-baseline justify-between gap-3 text-sm"><span>Leave with pay ({result.leave_with_pay_days} day{result.leave_with_pay_days === 1 ? "" : "s"})</span><span className="text-muted-foreground">No deduction</span></div>
      ) : null}
      {result.carry_over_out > 0 ? (
        <div className="flex items-baseline justify-between gap-3 text-sm text-warning"><span>Carried to next month (deductions above this payslip&apos;s pay)</span><span className="tabular-nums">{pesoText(result.carry_over_out)}</span></div>
      ) : null}
      {children}
      {net !== undefined && net !== null ? (
        <div className="flex items-baseline justify-between gap-4 rounded-lg bg-primary/8 px-3 py-3">
          <span className="font-semibold">{netLabel || "Net pay"}</span>
          <span className="text-xl font-semibold text-primary tabular-nums">{pesoText(net)}</span>
        </div>
      ) : null}
    </div>
  );
}

/** What the tags mean. */
export function LineTagLegend({ className }) {
  return (
    <details className={cn("rounded-md border px-2.5 py-1.5 text-xs", className)} data-testid="tag-legend">
      <summary className="cursor-pointer font-medium text-muted-foreground select-none">What the tags mean</summary>
      <ul className="mt-1.5 space-y-1">
        {Object.entries(LINE_TAGS).map(([key, tag]) => (
          <li key={key} className="flex items-start gap-2"><LineTag tag={key} className="mt-0.5" /><span><strong className="font-medium text-foreground">{tag.label}.</strong> <span className="text-muted-foreground">{tag.hint}</span></span></li>
        ))}
        <li className="flex items-start gap-2"><span className="mt-0.5 w-10 shrink-0 text-center font-semibold text-success">+</span><span className="text-muted-foreground">Added to pay</span></li>
        <li className="flex items-start gap-2"><span className="mt-0.5 w-10 shrink-0 text-center font-semibold text-destructive">−</span><span className="text-muted-foreground">Deducted from pay</span></li>
      </ul>
    </details>
  );
}

/** The short employee-facing explanation of withholding tax and contributions. */
export function WhyTaxNote({ className }) {
  return (
    <details className={cn("rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs", className)} data-testid="why-tax">
      <summary className="cursor-pointer font-medium text-primary select-none">Why is there a withholding tax?</summary>
      <div className="mt-1.5 space-y-1.5 text-muted-foreground">
        <p><strong className="text-foreground">Government contributions</strong> (SSS, PhilHealth, Pag-IBIG) are social insurance. You pay a share, the school pays its own share on top, and the money comes back to you as benefits: pension and sickness (SSS), health insurance (PhilHealth) and housing savings (Pag-IBIG).</p>
        <p><strong className="text-foreground">Withholding tax</strong> is income tax under the TRAIN Law (RA 10963). The school withholds it as an advance payment of your yearly income tax and remits it to the BIR. There is no employer share and no benefit paid back.</p>
        <p>Contributions come off first; the tax is computed on what remains (your taxable income). Below the exempt bracket, no tax is withheld.</p>
      </div>
    </details>
  );
}
