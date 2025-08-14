-- 00xx_v_admin_donations_ongoing.sql
-- Ongoing donations for Admin (pending | accepted) with nested details.

BEGIN;

DROP VIEW IF EXISTS public.v_admin_donations_ongoing;

CREATE VIEW public.v_admin_donations_ongoing AS
SELECT
  /* donation (row identity) */
  d.id                     AS donation_id,
  d.status                 AS donation_status,
  d.created_at,
  d.pickup_deadline_at,
  d.accepted_at,
  d.released_at,
  d.picked_up_at,

  /* restaurant (flat) */
  r.id                     AS restaurant_id,
  r.name                   AS restaurant_name,
  r.email                  AS restaurant_email,
  r.phone                  AS restaurant_phone,

  /* osc (flat) */
  o.id                     AS osc_id,
  o.name                   AS osc_name,
  o.phone                  AS osc_phone,
  o.email                  AS osc_email,

  /* partnership (flat) */
  p.distance_km,

  /* donation_intents (array) */
  (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id',         di.id,
          'status',     di.status,
          'created_at', di.created_at,
          'updated_at', di.updated_at,
          'expires_at', di.expires_at
        )
        ORDER BY di.created_at DESC
      ),
      '[]'::jsonb
    )
    FROM public.donation_intents di
    WHERE di.donation_id = d.id
  ) AS donation_intents,

  /* packages (array) — only currently linked (unlinked_at IS NULL) */
  (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id',         pk.id,
          'quantity',   pk.quantity,
          'label_code', pk.label_code,
          'total_kg',   pk.total_kg,
          'expires_at', pk.expires_at,
          'status',     pk.status,
          'item', jsonb_build_object(
            'id',          it.id,
            'name',        it.name,
            'description', it.description
          )
        )
        ORDER BY pk.expires_at ASC, pk.created_at ASC
      ),
      '[]'::jsonb
    )
    FROM public.donation_packages dp
    JOIN public.packages pk ON pk.id = dp.package_id
    JOIN public.items    it ON it.id = pk.item_id
    WHERE dp.donation_id = d.id
      AND dp.unlinked_at IS NULL
  ) AS packages

FROM public.donations d
JOIN public.restaurants  r ON r.id = d.restaurant_id
JOIN public.osc          o ON o.id = d.osc_id
LEFT JOIN public.partnerships p
  ON p.restaurant_id = d.restaurant_id
 AND p.osc_id        = d.osc_id
WHERE d.status IN ('pending', 'accepted')
ORDER BY d.created_at DESC;

COMMIT;
