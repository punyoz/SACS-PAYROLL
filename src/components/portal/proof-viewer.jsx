"use client";

import * as React from "react";
import { DownloadIcon, PaperclipIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePortalSession } from "@/components/portal/session";

/*
 * A leave request's proof document (openProofDocument, public/legacy/js/
 * app.js). Only the shapes a proof can legitimately take are opened: a
 * base64 data URL of a PDF / PNG / JPEG, an https:// link, or a same-origin
 * path. The URL is only ever set through element properties, never markup.
 */

const DATA_URL = /^data:(application\/pdf|image\/png|image\/jpeg);base64,[A-Za-z0-9+/]+={0,2}$/i;

function classify(url) {
  const dataMatch = DATA_URL.exec(url);
  const isDataUrl = Boolean(dataMatch);
  const ok = isDataUrl || /^https:\/\//i.test(url) || (url.startsWith("/") && !url.startsWith("//"));
  if (!ok) return null;
  const mime = isDataUrl ? dataMatch[1].toLowerCase() : "";
  const isImage = isDataUrl ? mime.startsWith("image/") : /\.(png|jpe?g|gif|webp|bmp)$/i.test(url);
  const isPdf = (isDataUrl && mime === "application/pdf") || /\.pdf$/i.test(url);
  return { isImage, isPdf, isDataUrl };
}

export function useProofViewer() {
  const { notify } = usePortalSession();
  const [url, setUrl] = React.useState(null);

  const open = React.useCallback((proofUrl) => {
    const value = String(proofUrl || "").trim();
    if (!value) { notify("No proof document", "No proof document attached to this request.", "error"); return; }
    if (!classify(value)) { notify("Cannot open proof", "This proof document cannot be opened.", "error"); return; }
    setUrl(value);
  }, [notify]);

  const kind = url ? classify(url) : null;

  const viewer = (
    <Dialog open={Boolean(url)} onOpenChange={(isOpen) => { if (!isOpen) setUrl(null); }}>
      <DialogContent className="flex h-[90dvh] max-w-[min(1000px,calc(100%-2rem))] flex-col gap-3 sm:max-w-[min(1000px,calc(100%-2rem))]">
        <DialogHeader className="flex-row items-center justify-between gap-3 pr-8">
          <div>
            <DialogTitle>Proof document</DialogTitle>
            <DialogDescription className="sr-only">The file attached to this leave request.</DialogDescription>
          </div>
          {url ? (
            <Button asChild variant="outline" size="sm">
              <a href={url} download="proof-document"><DownloadIcon aria-hidden="true" />Download</a>
            </Button>
          ) : null}
        </DialogHeader>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg border bg-muted/40">
          {kind?.isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt="Proof document" className="max-h-full max-w-full rounded-md object-contain" />
          ) : kind && (kind.isPdf || kind.isDataUrl) ? (
            <iframe src={url} title="Proof document" className="h-full w-full border-0" />
          ) : url ? (
            <div className="space-y-3 p-8 text-center">
              <PaperclipIcon className="mx-auto size-10 text-muted-foreground" aria-hidden="true" />
              <p>This file type cannot be previewed inline.</p>
              <Button asChild variant="outline"><a href={url} download>Download the file</a></Button>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );

  return [viewer, open];
}
