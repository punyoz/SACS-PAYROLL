import { cn } from "@/lib/utils";

/**
 * Label / value pairs for profile-style cards. `items` are
 * { label, value, wide? }; an empty value shows "—".
 */
export function InfoList({ items, className }) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-4 sm:grid-cols-2", className)}>
      {items.map((item) => (
        <div key={item.label} className={cn("min-w-0", item.wide && "sm:col-span-2")}>
          <dt className="text-xs font-medium text-muted-foreground">{item.label}</dt>
          <dd className="mt-0.5 break-words text-sm font-medium">{item.value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
