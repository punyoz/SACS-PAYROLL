-- Decision 2026-11-06: an Admin always belongs to one branch. Enforced here,
-- not only in the form: the role-change API (PATCH /api/admin/users) saves an
-- Admin together with its branch, Branch Assignment refuses to unassign an
-- Admin, and the seeder gives a new Admin a branch in the same write.
-- Before this, changing an Admin to HR and back left it with no branch, and
-- every branch-scoped page refused it.
--
-- Checked first: live had 0 Admins without a branch (2 Admins). No data is
-- changed; the constraint is validated against the existing rows.

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_admin_has_branch;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_admin_has_branch
  CHECK (role::text <> 'admin' OR branch_id IS NOT NULL);
