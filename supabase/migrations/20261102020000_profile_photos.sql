-- Profile pictures (2026-11-02), Data Privacy Act of 2012.
--
-- 1. profiles.photo_path / photo_thumb_path / photo_updated_at: the user's
--    own picture (512x512) and its thumbnail (96x96), as object paths in the
--    private bucket below. Both always live in the user's own folder
--    ("<user id>/<random uuid>.webp"): a CHECK makes any other path
--    impossible, so a profile can never point at someone else's file.
--
-- 2. Storage bucket "profile-photos": PRIVATE (no public URL exists), WebP
--    only (the server re-encodes every upload, which also strips EXIF/GPS),
--    at most 2 MB. Browsers never touch it: a RESTRICTIVE policy refuses the
--    anon and authenticated roles every row of this bucket, for every
--    command. Only the API (/api/profile-photo, service role) reads and
--    writes it: it takes the user from the signed session (never from the
--    request), checks the viewer may see that person, and hands out signed
--    URLs that expire.
--
-- Safe to run more than once.

-- ── 1. Columns ─────────────────────────────────────────────────────────────

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS photo_path TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS photo_thumb_path TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS photo_updated_at TIMESTAMPTZ;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_photo_own_folder;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_photo_own_folder CHECK (
  (photo_path IS NULL OR photo_path ~ ('^' || id::TEXT || '/[0-9a-f-]{36}\.webp$'))
  AND (photo_thumb_path IS NULL OR photo_thumb_path ~ ('^' || id::TEXT || '/[0-9a-f-]{36}-thumb\.webp$'))
);

COMMENT ON COLUMN public.profiles.photo_path IS
  'Own profile picture (512x512 WebP) in the private profile-photos bucket, "<id>/<uuid>.webp". Served only as a signed, expiring URL.';
COMMENT ON COLUMN public.profiles.photo_thumb_path IS
  'Own profile picture thumbnail (96x96 WebP), "<id>/<uuid>-thumb.webp".';

-- ── 2. The private bucket ──────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('profile-photos', 'profile-photos', FALSE, 2097152, ARRAY['image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = FALSE, file_size_limit = 2097152, allowed_mime_types = ARRAY['image/webp'];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'profile_photos_no_client_access'
  ) THEN
    CREATE POLICY profile_photos_no_client_access ON storage.objects
      AS RESTRICTIVE FOR ALL TO anon, authenticated
      USING (bucket_id <> 'profile-photos')
      WITH CHECK (bucket_id <> 'profile-photos');
  END IF;
END;
$$;
