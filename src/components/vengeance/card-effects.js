/*
 * Summary-card effects from VengeanceUI by Ashutoshx7
 * (https://github.com/Ashutoshx7/VengeanceUI, MIT License):
 * - "GlowBorderCard": a green/gold edge that turns while the pointer is over
 *   it (the v-glow-edge utility in src/styles/ui.css; the original's rainbow
 *   loops forever).
 * - "StaggeredGrid", idea only: cards fade up one after another, once. Opacity
 *   and transform only, so nothing shifts. Off with prefers-reduced-motion.
 */

export const vengeanceGlowCard = "v-glow-edge";

export const vengeanceStaggerCard =
  "motion-safe:animate-v-rise nth-2:[animation-delay:60ms] nth-3:[animation-delay:120ms] nth-4:[animation-delay:180ms] nth-5:[animation-delay:240ms] nth-6:[animation-delay:300ms]";
