import { ArrowRightIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { galaxyAccentCard } from "@/components/galaxy/accent-card";
import { AnimatedNumber } from "@/components/vengeance/animated-number";
import { vengeanceGlowCard, vengeanceStaggerCard } from "@/components/vengeance/card-effects";
import { followPortalLink, isPlainClick } from "@/lib/portal/navigate";

const ICON_TONE = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/12 text-success",
  warning: "bg-warning/12 text-warning",
  danger: "bg-destructive/10 text-destructive",
  info: "bg-info/10 text-info",
  gold: "bg-brand-gold/15 text-gold-text",
};

/**
 * A summary figure. `glow` adds the turning gold edge.
 *
 * href (2026-11-14): the whole card is a real link to the rows behind the
 * figure (portalHref(page, filters)), so Enter, middle click and "open in
 * new tab" work; a plain click opens it in place. With `onClick` too, the
 * rows are on this same page: the click sets that page's filter instead and
 * scrolls to `scrollTo` (an element id); the href still opens the same view
 * in a new tab. actionLabel is read out: "Present today: 3. View today's
 * attendance". No href, or still loading: a plain card, as before.
 */
export function StatCard({ label, value, hint, icon: Icon, tone = "primary", loading = false, glow = false, className, href, onClick, scrollTo, actionLabel }) {
  const link = Boolean(href) && !loading;
  const card = (
    <Card className={cn("gap-0 py-4 shadow-xs", galaxyAccentCard, vengeanceStaggerCard, glow && vengeanceGlowCard, link && "h-full transition group-hover:-translate-y-0.5 group-hover:border-brand-gold group-hover:shadow-md group-focus-visible:border-brand-gold", className)}>
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
        {link ? <ArrowRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-gold-text" aria-hidden="true" /> : null}
      </CardContent>
    </Card>
  );
  if (!link) return card;
  const handle = (event) => {
    if (!onClick) return followPortalLink(event);
    if (!isPlainClick(event)) return undefined;
    event.preventDefault();
    onClick();
    if (scrollTo) document.getElementById(scrollTo)?.scrollIntoView({ behavior: "smooth", block: "start" });
    return undefined;
  };
  return (
    <a href={href} onClick={handle} data-testid="stat-card-link"
      aria-label={`${label}: ${value ?? "—"}.${actionLabel ? ` ${actionLabel}` : ""}`}
      className="group block min-h-10 rounded-xl text-left text-inherit no-underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
      {card}
    </a>
  );
}
