/*
 * Underline that slides in on hover or keyboard focus, adapted from
 * "LineHoverLink" (slide variant) by Ashutoshx7 (VengeanceUI,
 * https://github.com/Ashutoshx7/VengeanceUI, MIT License). The line sits
 * inside the label because sidebar labels truncate (overflow hidden).
 * Put vengeanceLineHoverHost on the link and vengeanceLineHover on its label.
 */

export const vengeanceLineHoverHost = "group/line-hover";

export const vengeanceLineHover =
  "relative after:absolute after:bottom-0 after:left-0 after:h-px after:w-full after:origin-right after:scale-x-0 after:bg-sidebar-primary after:transition-transform after:duration-300 group-hover/line-hover:after:origin-left group-hover/line-hover:after:scale-x-100 group-focus-visible/line-hover:after:origin-left group-focus-visible/line-hover:after:scale-x-100 motion-reduce:after:transition-none";
