import { cn } from "@/lib/utils";

/**
 * Three bouncing dots (green, gold, green) for a section that is loading.
 * Design from Uiverse.io by Javierrocadev ("new-sloth-45"), MIT license.
 * Recoloured with the theme tokens; still for reduced-motion users.
 */
export function DotLoader({ className }) {
  const dot = "inline-block size-1.5 rounded-full animate-bounce motion-reduce:animate-none";
  return (
    <span role="status" aria-busy="true" className={cn("inline-flex items-end gap-1 align-middle", className)}>
      <span className={cn(dot, "bg-primary")} />
      <span className={cn(dot, "bg-brand-gold [animation-delay:-0.3s]")} />
      <span className={cn(dot, "bg-primary [animation-delay:-0.5s]")} />
      <span className="sr-only">Loading</span>
    </span>
  );
}
