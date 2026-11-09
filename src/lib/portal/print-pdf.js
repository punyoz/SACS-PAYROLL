"use client";

import { apiFetch } from "@/lib/portal/api";

/**
 * Print the clean PDF the server builds (the same file as Download), never
 * the web page with its menus (alpha test B4). The PDF loads in a hidden
 * frame and the browser's print dialog opens on it. If the browser cannot
 * print a framed PDF, it opens in a new tab instead, ready to print.
 */
export async function printPdf(url) {
  const response = await apiFetch(url);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "The file could not be made for printing.");
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  frame.src = objectUrl;
  const cleanup = () => setTimeout(() => { frame.remove(); URL.revokeObjectURL(objectUrl); }, 60000);
  frame.onload = () => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch {
      window.open(objectUrl, "_blank", "noopener");
    }
    cleanup();
  };
  document.body.appendChild(frame);
}
