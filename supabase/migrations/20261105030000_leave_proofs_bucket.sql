-- Leave proof documents move out of the database (2026-11-05, Supabase Pro).
--
-- A proof (PDF, PNG or JPEG, at most 2 MB) used to be stored inside
-- leave_requests.proof_url as base64: 4 live rows held ~3 MB, and proofs were
-- ~80% of the expected database growth (docs/hosting-and-operations.md
-- section 6). New proofs go to a private Storage bucket instead (100 GB on
-- Pro) and the row keeps only the file's path.
--
-- 1. leave_requests.proof_path: "<employee id>/<random uuid>.<pdf|png|jpg>"
--    in the bucket below. A CHECK keeps every file in the filer's own folder.
--    proof_url stays for the requests filed before this change; nothing is
--    moved or deleted.
--
-- 2. Storage bucket "leave-proofs": PRIVATE (no public URL exists), PDF / PNG
--    / JPEG only, at most 2 MB, enforced by Storage itself as well as by the
--    API. Browsers never touch it: a RESTRICTIVE policy refuses the anon and
--    authenticated roles every row of this bucket, for every command (same as
--    profile-photos, 20261102020000). Only the API (service role) reads and
--    writes it, after the role and branch checks.
--
-- Safe to run more than once. No existing row is changed.

-- ── 1. Column ──────────────────────────────────────────────────────────────

ALTER TABLE public.leave_requests ADD COLUMN IF NOT EXISTS proof_path TEXT;

ALTER TABLE public.leave_requests DROP CONSTRAINT IF EXISTS leave_requests_proof_path_own_folder;
ALTER TABLE public.leave_requests ADD CONSTRAINT leave_requests_proof_path_own_folder CHECK (
  proof_path IS NULL
  OR proof_path ~ ('^' || employee_id::TEXT || '/[0-9a-f-]{36}\.(pdf|png|jpg)$')
);

COMMENT ON COLUMN public.leave_requests.proof_path IS
  'Proof document in the private leave-proofs bucket, "<employee_id>/<uuid>.<pdf|png|jpg>". Served only through GET /api/hr/leave-requests/proof after the role and branch checks. Requests filed before 2026-11-05 keep their proof in proof_url (base64).';

-- ── 2. The private bucket ──────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('leave-proofs', 'leave-proofs', FALSE, 2097152, ARRAY['application/pdf', 'image/png', 'image/jpeg'])
ON CONFLICT (id) DO UPDATE
  SET public = FALSE, file_size_limit = 2097152, allowed_mime_types = ARRAY['application/pdf', 'image/png', 'image/jpeg'];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'leave_proofs_no_client_access'
  ) THEN
    CREATE POLICY leave_proofs_no_client_access ON storage.objects
      AS RESTRICTIVE FOR ALL TO anon, authenticated
      USING (bucket_id <> 'leave-proofs')
      WITH CHECK (bucket_id <> 'leave-proofs');
  END IF;
END;
$$;
