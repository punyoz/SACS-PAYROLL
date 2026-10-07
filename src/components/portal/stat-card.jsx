import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const ICON_TONE = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/12 text-success",
  warning: "bg-warning/12 text-warning",
  danger: "bg-destructive/10 text-destructive",
  info: "bg-info/10 text-info",
  gold: "bg-brand-gold/15 text-gold-text",
};

/** A summary figure for the top of a dashboard. */
export function StatCard({ label, value, hint, icon: Icon, tone = "primary", loading = false, className }) {
  return (
    <Card className={cn("gap-0 py-4 shadow-xs", className)}>
      <CardContent className="flex items-start gap-3 px-4">
        {Icon ? (
          <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", ICON_TONE[tone] || ICON_TONE.primary)}>
            <Icon className="size-4" aria-hidden="true" />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          {loading ? (
            <Skeleton className="mt-1.5 h-6 w-16" />
          ) : (
            <p className="mt-0.5 truncate text-xl font-semibold tabular-nums tracking-tight">{value ?? "—"}</p>
          )}
          {hint ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
