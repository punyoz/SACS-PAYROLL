/**
 * Download a file the server streams (an export, a backup), reporting bytes
 * received; throws the server's message when it refuses. Shared by Backup &
 * Recovery and every report's Excel / PDF button.
 */

import { apiFetch } from "@/lib/portal/api";

function fileNameOf(response, fallback) {
  const header = response.headers.get("Content-Disposition") || "";
  const match = /filename="?([^";]+)"?/i.exec(header);
  return match ? match[1] : fallback;
}

/** Stream a download, reporting bytes received; throws the server's message on failure. */
export async function downloadFile(url, init = {}, { onProgress, signal, fallbackName = "download" } = {}) {
  const response = await apiFetch(url, { ...init, signal });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || `The download failed (${response.status}).`);
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received);
  }
  const blob = new Blob(chunks, { type: response.headers.get("Content-Type") || "application/octet-stream" });
  const name = fileNameOf(response, fallbackName);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  return { name, bytes: received };
}

