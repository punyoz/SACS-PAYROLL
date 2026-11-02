"use client";

import * as React from "react";
import { CameraIcon, ImageUpIcon, Loader2Icon, Trash2Icon, ZoomInIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { usePortalSession } from "@/components/portal/session";
import { UserAvatar, refreshPhotos, usePhotoUrl } from "@/components/portal/user-avatar";
import { initialsOf } from "@/lib/portal/format";
import { cn } from "@/lib/utils";

/*
 * Your own profile picture (/api/profile-photo, 20261102020000): choose a
 * file or take a photo, crop it to a circle and zoom, then Save, Cancel or
 * Remove. The browser checks the file first (JPG / PNG / WebP by its first
 * bytes, 2 MB, 64-8,000 pixels a side); the server checks it all again,
 * re-encodes it (no EXIF / GPS) and stores it privately.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const VIEW = 240; // crop circle, CSS pixels
const ACCEPT = "image/jpeg,image/png,image/webp";

/** "jpeg" | "png" | "webp" from a file's first bytes (src/lib/profile-photo.js). */
async function sniff(file) {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return null;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The picture could not be read (it may be damaged)."));
    img.src = src;
  });
}

/** The clickable avatar of your own profile page, which opens the dialog. */
export function ProfilePhotoButton({ name, className, fallbackClassName }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn("group relative rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring", className)}
        aria-label="Change your profile picture"
      >
        <UserAvatar userId="me" size="full" name={name} className="size-full border-4 border-card shadow-md" fallbackClassName={cn("text-xl", fallbackClassName)} />
        <span className="absolute right-0 bottom-0 flex size-7 items-center justify-center rounded-full border-2 border-card bg-brand-gold text-brand-green-dark shadow-sm transition-transform group-hover:scale-105" aria-hidden="true">
          <CameraIcon className="size-3.5" />
        </span>
      </button>
      {open ? <ProfilePhotoDialog name={name} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function ProfilePhotoDialog({ name, onClose }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const current = usePhotoUrl("me", "full");
  const fileInput = React.useRef(null);
  const cameraInput = React.useRef(null);
  const [picked, setPicked] = React.useState(null); // { file, src, width, height }
  const [zoom, setZoom] = React.useState(1);
  const [offset, setOffset] = React.useState({ x: 0, y: 0 });
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState("");
  // While "Remove?" is asked, a click on that confirmation is not a click
  // outside this dialog.
  const [asking, setAsking] = React.useState(false);
  const drag = React.useRef(null);

  React.useEffect(() => () => { if (picked?.src) URL.revokeObjectURL(picked.src); }, [picked]);

  // Cover the circle at zoom 1; the image never leaves a gap in the circle.
  const base = picked ? VIEW / Math.min(picked.width, picked.height) : 1;
  const scale = base * zoom;
  const clamp = React.useCallback((x, y, s = scale) => {
    if (!picked) return { x: 0, y: 0 };
    const w = picked.width * s;
    const h = picked.height * s;
    return { x: Math.min(0, Math.max(VIEW - w, x)), y: Math.min(0, Math.max(VIEW - h, y)) };
  }, [picked, scale]);

  async function choose(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    if (file.size > MAX_BYTES) return setError(`The picture is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 2 MB.`);
    if (!(await sniff(file))) return setError("Only JPG, PNG or WebP pictures can be used.");
    const src = URL.createObjectURL(file);
    try {
      const img = await loadImage(src);
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      if (width < 64 || height < 64) throw new Error("The picture is too small (at least 64 pixels a side).");
      if (width > 8000 || height > 8000) throw new Error("The picture is too large (at most 8,000 pixels a side).");
      const s = VIEW / Math.min(width, height);
      setPicked({ file, src, width, height });
      setZoom(1);
      setOffset({ x: (VIEW - width * s) / 2, y: (VIEW - height * s) / 2 });
    } catch (err) {
      URL.revokeObjectURL(src);
      setError(err.message);
    }
  }

  function zoomTo(next) {
    if (!picked) return;
    // Keep the centre of the circle where it is.
    const cx = (VIEW / 2 - offset.x) / scale;
    const cy = (VIEW / 2 - offset.y) / scale;
    const s = base * next;
    setZoom(next);
    setOffset(clamp(VIEW / 2 - cx * s, VIEW / 2 - cy * s, s));
  }

  const onPointerDown = (event) => {
    if (!picked) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, start: offset };
  };
  const onPointerMove = (event) => {
    if (!drag.current) return;
    setOffset(clamp(drag.current.start.x + event.clientX - drag.current.x, drag.current.start.y + event.clientY - drag.current.y));
  };
  const onPointerUp = () => { drag.current = null; };
  const onKeyDown = (event) => {
    const step = event.shiftKey ? 20 : 5;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[event.key]) {
      event.preventDefault();
      setOffset((o) => clamp(o.x + moves[event.key][0], o.y + moves[event.key][1]));
    }
    if (event.key === "+" || event.key === "=") zoomTo(Math.min(4, zoom + 0.1));
    if (event.key === "-") zoomTo(Math.max(1, zoom - 0.1));
  };

  async function save() {
    if (!picked) return;
    setBusy("save");
    setError("");
    try {
      const body = new FormData();
      body.append("file", picked.file);
      body.append("crop", JSON.stringify({ x: -offset.x / scale, y: -offset.y / scale, size: VIEW / scale }));
      const res = await fetch("/api/profile-photo", { method: "POST", body, credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The picture was not saved.");
      refreshPhotos();
      notify("Profile picture saved", "It shows wherever your name appears.", "success");
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy("");
    }
  }

  async function remove() {
    setAsking(true);
    const ok = await confirm({ title: "Remove your profile picture?", description: "Your initials show instead.", confirmLabel: "Remove", destructive: true });
    setAsking(false);
    if (!ok) return;
    setBusy("remove");
    setError("");
    try {
      const res = await fetch("/api/profile-photo", { method: "DELETE", credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The picture was not removed.");
      refreshPhotos();
      notify("Profile picture removed", "Your initials show instead.", "info");
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy("");
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy && !asking) onClose(); }}>
      <DialogContent className="sm:max-w-md" onInteractOutside={(event) => { if (asking) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>Profile picture</DialogTitle>
          <DialogDescription>JPG, PNG or WebP, up to 2 MB. Only people who can see your record see it.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4">
          {picked ? (
            <div
              role="img"
              tabIndex={0}
              aria-label="Crop preview. Drag, or use the arrow keys, to move the picture; plus and minus to zoom."
              className="relative cursor-grab touch-none overflow-hidden rounded-full bg-muted ring-4 ring-brand-gold outline-none focus-visible:ring-ring active:cursor-grabbing"
              style={{ width: VIEW, height: VIEW }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onKeyDown}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a local preview (blob: URL) */}
              <img
                src={picked.src}
                alt=""
                draggable={false}
                className="pointer-events-none absolute top-0 left-0 max-w-none select-none"
                style={{ width: picked.width * scale, height: picked.height * scale, transform: `translate(${offset.x}px, ${offset.y}px)` }}
              />
            </div>
          ) : (
            <UserAvatar userId="me" size="full" name={name} className="size-40 text-4xl" fallbackClassName="text-4xl" fallbackText={initialsOf(name)} />
          )}

          {picked ? (
            <div className="flex w-full max-w-60 items-center gap-2">
              <ZoomInIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Label htmlFor="photo-zoom" className="sr-only">Zoom</Label>
              <input
                id="photo-zoom"
                type="range"
                min="1"
                max="4"
                step="0.05"
                value={zoom}
                onChange={(e) => zoomTo(Number(e.target.value))}
                className="w-full accent-[var(--primary)]"
              />
            </div>
          ) : null}

          <div className="flex flex-wrap justify-center gap-2">
            <input ref={fileInput} type="file" accept={ACCEPT} className="sr-only" tabIndex={-1} onChange={choose} aria-hidden="true" />
            {/* On a phone: the front camera. */}
            <input ref={cameraInput} type="file" accept={ACCEPT} capture="user" className="sr-only" tabIndex={-1} onChange={choose} aria-hidden="true" />
            <Button type="button" variant="outline" onClick={() => fileInput.current?.click()} disabled={Boolean(busy)}><ImageUpIcon aria-hidden="true" />Choose picture</Button>
            <Button type="button" variant="outline" className="sm:hidden" onClick={() => cameraInput.current?.click()} disabled={Boolean(busy)}><CameraIcon aria-hidden="true" />Take photo</Button>
          </div>
          {error ? <p role="alert" className="text-center text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {current && !picked ? (
            <Button type="button" variant="outline" className="text-destructive" onClick={remove} disabled={Boolean(busy)}>
              {busy === "remove" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <Trash2Icon aria-hidden="true" />}Remove photo
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={Boolean(busy)}>Cancel</Button>
            <Button type="button" onClick={save} disabled={!picked || Boolean(busy)}>
              {busy === "save" ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Saving…</> : "Save"}
            </Button>
          </div>
        </DialogFooter>
        {confirmDialog}
      </DialogContent>
    </Dialog>
  );
}
