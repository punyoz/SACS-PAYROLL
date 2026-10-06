-- Position-scoped payroll rates now read profiles.position, which only the
-- server writes (src/app/api/accountant/payroll/route.js). user_metadata
-- .position is editable by the account holder, so an employee could relabel
-- themselves to pick up another position's rates.
--
-- Accounts created through /api/admin/employees never wrote profiles.position,
-- so they still carry the column default 'Staff'. Copy the position HR / the
-- Super Admin set at creation into it, once. From now on both routes keep
-- profiles.position up to date themselves.
--
-- Safe to run more than once: only rows still at the default are touched.

UPDATE public.profiles p
SET position = btrim(u.raw_user_meta_data->>'position')
FROM auth.users u
WHERE u.id = p.id
  AND p.position = 'Staff'
  AND COALESCE(btrim(u.raw_user_meta_data->>'position'), '') <> ''
  AND btrim(u.raw_user_meta_data->>'position') <> 'Staff';
