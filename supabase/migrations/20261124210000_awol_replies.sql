-- ═══════════════════════════════════════════════════════════════════════════
-- AWOL replies (2026-11-24 follow-up): the employee replies to a notice from
-- My Notices (an explanation, a preset reason, optional attachments, the date
-- they intend to return), or HR records a reply received offline (letter,
-- phone, in person). Either stops the case's automation ("Response received:
-- HR decides"). A reply is never edited or deleted; the employee may add a
-- follow-up message to the same thread. Attachments are kept in a private
-- bucket (the employee, HR and the Super Admin open them through the app).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.awol_replies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       UUID NOT NULL REFERENCES public.employee_awol_cases(id),
  employee_id   UUID NOT NULL REFERENCES public.profiles(id),
  kind          TEXT NOT NULL CHECK (kind IN ('reply', 'follow_up', 'hr_record')),
  reason_code   TEXT CHECK (reason_code IS NULL OR reason_code IN ('illness', 'family_emergency', 'accident', 'off_site', 'other')),
  explanation   TEXT NOT NULL CHECK (char_length(btrim(explanation)) BETWEEN 3 AND 2000),
  return_on     DATE,
  received_on   DATE NOT NULL,
  received_how  TEXT NOT NULL CHECK (received_how IN ('portal', 'letter', 'phone', 'in_person', 'email', 'other')),
  attachments   JSONB NOT NULL DEFAULT '[]'::JSONB,
  author_id     UUID REFERENCES public.profiles(id),
  author_name   TEXT NOT NULL,
  author_role   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS awol_replies_case_idx ON public.awol_replies (case_id, created_at);
ALTER TABLE public.awol_replies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.awol_replies FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.awol_replies_keep()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'A reply is never edited or deleted; add a follow-up instead.' USING ERRCODE = 'insufficient_privilege';
END;
$function$;
DROP TRIGGER IF EXISTS awol_replies_keep ON public.awol_replies;
CREATE TRIGGER awol_replies_keep BEFORE UPDATE OR DELETE ON public.awol_replies FOR EACH ROW EXECUTE FUNCTION public.awol_replies_keep();

INSERT INTO storage.buckets (id, name, public, file_size_limit) VALUES ('awol-replies', 'awol-replies', FALSE, 5242880) ON CONFLICT (id) DO NOTHING;
