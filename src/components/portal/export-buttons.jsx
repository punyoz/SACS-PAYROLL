"use client";

import * as React from "react";
import { CheckIcon, FileSpreadsheetIcon, FileTextIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePortalSession } from "@/components/portal/session";
import { downloadFile } from "@/lib/portal/download";

/**
 * Excel and PDF buttons for a report (alpha test B6). `href` is the report's
 * API URL; the button adds format=xlsx or format=pdf. The server builds the
 * file (src/lib/export/report-file.js) and checks who may have it.
 *
 * A finished download is said next to the buttons ("Downloaded"), not in a
 * toast: the top-right toast sat over header buttons and stayed while the
 * pointer rested on it. A failure is still a red toast.
 */
export function ExportButtons({ href, label = "report", disabled = false, className }) {
  const { notify } = usePortalSession();
  const [busy, setBusy] = React.useState("");
  const [done, setDone] = React.useState("");
  React.useEffect(() => {
    if (!done) return undefined;
    const timer = setTimeout(() => setDone(""), 4000);
    return () => clearTimeout(timer);
  }, [done]);
  const go = async (format) => {
    setBusy(format);
    try {
      const url = `${href}${href.includes("?") ? "&" : "?"}format=${format}`;
      const result = await downloadFile(url, {}, { fallbackName: `${label}.${format}` });
      setDone(result.name);
    } catch (error) {
      notify("Export failed", error.message || "Try again.", "error");
    } finally {
      setBusy("");
    }
  };
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
      <Button type="button" variant="outline" size="sm" onClick={() => go("xlsx")} disabled={disabled || Boolean(busy)} aria-label={`Export ${label} to Excel`}>
        {busy === "xlsx" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <FileSpreadsheetIcon aria-hidden="true" />}Excel
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={() => go("pdf")} disabled={disabled || Boolean(busy)} aria-label={`Export ${label} to PDF`}>
        {busy === "pdf" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <FileTextIcon aria-hidden="true" />}PDF
      </Button>
      <span role="status" aria-live="polite" className="text-xs whitespace-nowrap text-success" title={done || undefined}>
        {done ? <><CheckIcon className="mr-0.5 inline size-3.5" aria-hidden="true" />Downloaded</> : null}
      </span>
    </span>
  );
}
