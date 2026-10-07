import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Join class names, letting later Tailwind classes override earlier ones (shadcn/ui). */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
