/**
 * The one font every PDF uses (2026-11-19): Noto Sans, embedded, regular and
 * bold (public/fonts, SIL Open Font License). It has ₱ (U+20B1), − (U+2212),
 * ñ and é, and its digits are all one width (572 units, regular and bold), so
 * amounts line up down a column on their own.
 *
 * The PDFs are laid out by @react-pdf/renderer (src/lib/export/pdf-doc.js);
 * this file registers the font with it and measures text with the SAME font
 * file (fontkit), for the report tables' column widths.
 */

import path from "node:path";
import * as fontkit from "fontkit";
import { Font } from "@react-pdf/renderer";

export const FONT = "Noto Sans";
const FILES = { 400: "NotoSans-Regular.ttf", 700: "NotoSans-Bold.ttf" };
const fontPath = (weight) => path.join(process.cwd(), "public", "fonts", FILES[weight]);

let registered = false;
/** Registers Noto Sans with @react-pdf once; words are never hyphenated. */
export function registerFonts() {
  if (registered) return;
  Font.register({ family: FONT, fonts: [{ src: fontPath(400), fontWeight: 400 }, { src: fontPath(700), fontWeight: 700 }] });
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}

const faces = {};
const face = (bold) => {
  const weight = bold ? 700 : 400;
  if (!faces[weight]) faces[weight] = fontkit.openSync(fontPath(weight));
  return faces[weight];
};

/** Width in points of `value` set in Noto Sans at `size` (kerning and all, as the PDF draws it). */
export function textWidth(value, size, bold = false) {
  const f = face(bold);
  return (f.layout(String(value ?? "")).advanceWidth * size) / f.unitsPerEm;
}

/** "₱1,475.00"; a negative "−₱1,475.00" (U+2212), one string per amount. */
export function pesoPdf(value) {
  const n = Math.round((Number(value) || 0) * 100) / 100;
  const digits = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "−" : ""}₱${digits}`;
}
