"use client";

import * as React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initialsOf } from "@/lib/portal/format";
import { cn } from "@/lib/utils";

/*
 * Profile pictures in the portals (20261102020000). <UserAvatar> shows a
 * person's picture with a gold ring, or their initials on green when there is
 * none, it is not theirs to see, or it fails to load.
 *
 * Pictures are signed URLs that expire after an hour (/api/profile-photo).
 * Every avatar on a screen asks in one batched request, and the answers are
 * kept for 50 minutes; changing your own picture refreshes it everywhere.
 */

const CACHE_MS = 50 * 60 * 1000;
const cache = new Map(); // `${size}:${id}` -> { url, at }
const waiting = new Map(); // size -> Map(id -> [resolve])
const listeners = new Set();
let timer = null;

function flush() {
  timer = null;
  const batches = [...waiting.entries()];
  waiting.clear();
  batches.forEach(async ([size, byId]) => {
    const ids = [...byId.keys()];
    let photos = {};
    try {
      const res = await fetch(`/api/profile-photo?size=${size}&ids=${ids.map(encodeURIComponent).join(",")}`, { credentials: "same-origin", cache: "no-store", headers: { "x-sacs-background": "1" } });
      if (res.ok) photos = (await res.json()).photos || {};
    } catch {
      // Initials stay.
    }
    ids.forEach((id) => {
      const url = photos[id]?.url || null;
      cache.set(`${size}:${id}`, { url, at: Date.now() });
      byId.get(id).forEach((resolve) => resolve(url));
    });
  });
}

function load(id, size) {
  const hit = cache.get(`${size}:${id}`);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.url);
  return new Promise((resolve) => {
    if (!waiting.has(size)) waiting.set(size, new Map());
    const byId = waiting.get(size);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(resolve);
    if (!timer) timer = setTimeout(flush, 30);
  });
}

/** Forget cached pictures (your own after a change) and redraw every avatar. */
export function refreshPhotos() {
  cache.clear();
  listeners.forEach((fn) => fn());
}

/** The signed URL of a person's picture ("me" = yourself), or null. */
export function usePhotoUrl(id, size = "thumb") {
  const [url, setUrl] = React.useState(null);
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    listeners.add(bump);
    return () => { listeners.delete(bump); };
  }, []);
  React.useEffect(() => {
    let live = true;
    if (!id) {
      setUrl(null);
      return undefined;
    }
    load(String(id), size).then((next) => { if (live) setUrl(next); });
    return () => { live = false; };
  }, [id, size, version]);
  return url;
}

/**
 * @param {string} [userId]  whose picture ("me" for yourself); none = initials only
 * @param {string} name      for the initials and the alt text
 * @param {"thumb"|"full"} [size]
 */
export function UserAvatar({ userId, name, size = "thumb", className, fallbackClassName, imageClassName, ring = true, fallbackText }) {
  const url = usePhotoUrl(userId, size);
  return (
    <Avatar className={cn(url && ring && "ring-2 ring-brand-gold", className)}>
      {url ? (
        <AvatarImage
          src={url}
          alt={`${name || "User"}'s profile picture`}
          loading="lazy"
          decoding="async"
          className={cn("object-cover", imageClassName)}
        />
      ) : null}
      <AvatarFallback className={cn("bg-primary font-semibold text-primary-foreground", fallbackClassName)}>
        {fallbackText || initialsOf(name)}
      </AvatarFallback>
    </Avatar>
  );
}
