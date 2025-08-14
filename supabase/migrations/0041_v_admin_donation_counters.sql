-- 0041_v_admin_donation_counters.sql
-- KPI counters for the admin dashboard.

BEGIN;

DROP VIEW IF EXISTS public.v_admin_donation_counters;

CREATE VIEW public.v_admin_donation_counters AS
WITH
  ongoing AS (
    SELECT id
    FROM public.donations
    WHERE status IN ('pending', 'accepted')
  ),
  picked AS (
    SELECT id
    FROM public.donations
    WHERE status = 'picked_up'
  )
SELECT
  /* 1) Total number of donations done (picked_up) */
  (SELECT COUNT(*) FROM picked) AS total_donations_done,

  /* 2) Total KG donated (sum pk.total_kg for packages linked to picked_up donations) */
  (
    SELECT COALESCE(SUM(pk.total_kg), 0)::numeric
    FROM picked d
    JOIN public.donation_packages dp ON dp.donation_id = d.id
    JOIN public.packages          pk ON pk.id = dp.package_id
    -- Note: no filter on dp.unlinked_at here; once picked_up, consider all linked packages as donated.
  ) AS total_kg_donated,

  /* 3) Total ongoing donations (pending | accepted) */
  (SELECT COUNT(*) FROM ongoing) AS total_ongoing_donations,

  /* 4) Total ongoing KGs (packages currently linked to ongoing donations) */
  (
    SELECT COALESCE(SUM(pk.total_kg), 0)::numeric
    FROM ongoing d
    JOIN public.donation_packages dp ON dp.donation_id = d.id
    JOIN public.packages          pk ON pk.id = dp.package_id
    WHERE dp.unlinked_at IS NULL
  ) AS total_ongoing_kgs,

  /* 5) Total discarded KGs (packages with status 'discarded') */
  (
    SELECT COALESCE(SUM(pk.total_kg), 0)::numeric
    FROM public.packages pk
    WHERE pk.status = 'discarded'
  ) AS total_discarded_kgs;

COMMIT;
