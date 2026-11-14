// Field alignment (2026-11-14): measured in the page by 99-field-alignment.spec.mjs
// and its self-check. Pass it to page.evaluate(measureAlignment, { rootSelector, tolerance }).

/** In the page: rows of side-by-side field cells whose boxes start at different heights. */
export function measureAlignment({ rootSelector, tolerance }) {
  const roots = [...document.querySelectorAll(rootSelector)].filter((r) => r.offsetParent !== null || r.getClientRects().length);
  const CONTROL = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea, [data-slot=select-trigger], button[role=combobox], [aria-labelledby][class*='rounded-md'][class*='border']";
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    const controls = [...root.querySelectorAll(CONTROL)].filter((c) => visible(c) && !c.closest("table, [role=dialog] [role=dialog], [data-slot=popover-content], [data-slot=select-content]"));
    const byParent = new Map();
    for (const control of controls) {
      // The cell: the control's ancestor that is a direct child of a multi-column grid / row flex.
      let cell = control;
      while (cell.parentElement && cell.parentElement !== root.parentElement) {
        const p = cell.parentElement;
        const cs = getComputedStyle(p);
        const cols = cs.display.includes("grid") && cs.gridTemplateColumns.split(" ").filter(Boolean).length > 1;
        const row = cs.display.includes("flex") && !cs.flexDirection.startsWith("column") && p.children.length > 1;
        if (cols || row) break;
        cell = p;
      }
      if (!cell.parentElement || cell === control) continue; // a bare control in a row (toolbar): no label to differ
      const list = byParent.get(cell.parentElement) || [];
      if (!list.some((x) => x.cell === cell)) list.push({ cell, control });
      byParent.set(cell.parentElement, list);
    }
    for (const [parent, cells] of byParent) {
      if (cells.length < 2 || seen.has(parent)) continue;
      seen.add(parent);
      // Group into visual rows by the cell's top.
      const rows = [];
      for (const c of cells) {
        // A wrapper with no box of its own (display: contents) has no top: use the field's.
        const box = c.cell.getBoundingClientRect();
        const top = box.height ? box.top : c.control.getBoundingClientRect().top;
        const r = rows.find((x) => Math.abs(x.top - top) <= 2);
        if (r) r.items.push(c); else rows.push({ top, items: [c] });
      }
      for (const r of rows) {
        if (r.items.length < 2) continue;
        const tops = r.items.map((c) => c.control.getBoundingClientRect().top);
        const spread = Math.max(...tops) - Math.min(...tops);
        if (spread > tolerance) {
          const label = (c) => (c.cell.innerText || "").split("\n").map((s) => s.trim()).find(Boolean)?.slice(0, 50) || c.control.getAttribute("aria-label") || c.control.id || "?";
          parent.setAttribute("data-align-finding", String(out.length));
          out.push({ spread: Math.round(spread * 10) / 10, fields: r.items.map((c, i) => `${label(c)} (+${Math.round((tops[i] - Math.min(...tops)) * 10) / 10}px)`), index: out.length });
        }
      }
    }
  }
  return out;
}

