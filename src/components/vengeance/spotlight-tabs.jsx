"use client";

/*
 * Tab-bar spotlight, adapted from "SpotlightNavbar" by Ashutoshx7
 * (VengeanceUI, https://github.com/Ashutoshx7/VengeanceUI, MIT License).
 * A soft gold glow follows the pointer and a gold line rests under the active
 * tab, sliding with CSS transitions instead of Framer Motion springs. Both
 * layers are decorative (aria-hidden, no pointer events); the tabs themselves
 * and their keyboard behavior are Radix's, unchanged.
 */

import * as React from "react";

/** Wire a tab list: returns its ref, its pointer handlers and the active tab's line box. */
export function useSpotlightTabs({ onPointerMove, onPointerLeave } = {}) {
  const ref = React.useRef(null);
  const [line, setLine] = React.useState(null);

  React.useEffect(() => {
    const list = ref.current;
    if (!list) return undefined;
    const place = () => {
      const active = list.querySelector('[role="tab"][data-state="active"]');
      setLine(active ? { left: active.offsetLeft, top: active.offsetTop + active.offsetHeight - 2, width: active.offsetWidth } : null);
    };
    place();
    const mutations = new MutationObserver(place);
    mutations.observe(list, { subtree: true, attributes: true, attributeFilter: ["data-state"] });
    const sizes = new ResizeObserver(place);
    sizes.observe(list);
    return () => {
      mutations.disconnect();
      sizes.disconnect();
    };
  }, []);

  const handlePointerMove = (event) => {
    const list = event.currentTarget;
    list.style.setProperty("--v-spot-x", `${event.clientX - list.getBoundingClientRect().left}px`);
    onPointerMove?.(event);
  };
  const handlePointerLeave = (event) => {
    event.currentTarget.style.removeProperty("--v-spot-x");
    onPointerLeave?.(event);
  };

  return { ref, line, handlePointerMove, handlePointerLeave };
}

/** The glow under the pointer and the line under the active tab. */
export function SpotlightLayers({ line }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[inherit] bg-[radial-gradient(90px_circle_at_var(--v-spot-x,-200px)_100%,color-mix(in_srgb,var(--brand-gold)_22%,transparent),transparent_60%)]"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute h-0.5 bg-[radial-gradient(closest-side,var(--brand-gold),transparent)] transition-[left,top,width,opacity] duration-300 motion-reduce:transition-none"
        style={line ? { left: line.left, top: line.top, width: line.width } : { opacity: 0 }}
      />
    </>
  );
}
