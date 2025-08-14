-- 0039_refresh_v_restaurants_partners_drop_recreate.sql
-- Recreate the view to expose full Restaurant (r.*) + Partnerships (array with nested OSC).

BEGIN;

DROP VIEW IF EXISTS public.v_restaurants_partners;

CREATE VIEW public.v_restaurants_partners AS
SELECT
  r.*,

  /* Full partnerships payload — favorite first, then by distance/name.
     Always returns [] (never NULL) for easier frontend handling. */
  (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'created_at',   p.created_at,
          'is_favorite',  p.is_favorite,
          'distance_km',  p.distance_km,
          'osc', jsonb_build_object(
            'id',     o.id,
            'name',   o.name,
            'street', o.street,
            'number', o.number,
            'city',   o.city,
            'uf',     o.uf
          )
        )
        ORDER BY p.is_favorite DESC, p.distance_km NULLS LAST, o.name
      ),
      '[]'::jsonb
    )
    FROM public.partnerships p
    JOIN public.osc o ON o.id = p.osc_id
    WHERE p.restaurant_id = r.id
  ) AS partnerships

FROM public.restaurants r;

COMMIT;
