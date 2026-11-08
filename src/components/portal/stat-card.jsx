import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { galaxyAccentCard } from "@/components/galaxy/accent-card";
import { AnimatedNumber } from "@/components/vengeance/animated-number";
import { vengeanceGlowCard, vengeanceStaggerCard } from "@/components/vengeance/card-effects";

const ICON_TONE = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/12 text-success",
  warning: "bg-warning/12 text-warning",
  danger: "bg-destructive/10 text-destructive",
  info: "bg-info/10 text-info",
  gold: "bg-brand-gold/15 text-gold-text",
};

/** A summary figure for the top of a dashboard. `glow` adds the turning gold edge. */
/**
 * onClick (alpha test B1): the whole card opens the page behind the figure,
 * as a real button (keyboard and screen reader), with actionLabel read out.
 */
export function StatCard({ label, value, hint, icon: Icon, tone = "primary", loading = false, glow = false, className, onClick, actionLabel }) {
  const card = (
    <Card className={cn("gap-0 py-4 shadow-xs", galaxyAccentCard, vengeanceStaggerCard, glow && vengeanceGlowCard, onClick && "h-full transition-colors group-hover:border-primary/40 group-hover:bg-accent/40", className)}>
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
            <p className="mt-0.5 truncate text-xl font-semibold tabular-nums tracking-tight">{typeof value === "number" || typeof value === "string" ? <AnimatedNumber value={value} /> : (value ?? "—")}</p>
          )}
          {hint ? <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{hint}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
  if (!onClick) return card;
  return (
    <button type="button" onClick={onClick} aria-label={actionLabel ? `${label}: ${actionLabel}` : undefined}
      className="group block w-full rounded-xl text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
      {card}
    </button>
  );
}
