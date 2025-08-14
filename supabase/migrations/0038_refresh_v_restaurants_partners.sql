-- 0038_refresh_v_restaurants_partners_drop_recreate.sql
-- Recreate the view so r.* includes the new columns (cnpj, code).

BEGIN;

DROP VIEW IF EXISTS public.v_restaurants_partners;

CREATE VIEW public.v_restaurants_partners AS
SELECT
  r.*,

  /* JSON array: [{id,name}, …] — favorita primeiro */
  (
    SELECT jsonb_agg(
             jsonb_build_object('id', o.id, 'name', o.name)
             ORDER BY p.is_favorite DESC
           )
    FROM partnerships p
    JOIN osc o ON o.id = p.osc_id
    WHERE p.restaurant_id = r.id
  ) AS partners_list,

  /* objeto da favorita ou NULL */
  (
    SELECT jsonb_build_object('id', o.id, 'name', o.name)
    FROM partnerships p
    JOIN osc o ON o.id = p.osc_id
    WHERE p.restaurant_id = r.id
      AND p.is_favorite
    LIMIT 1
  ) AS favorite_osc

FROM public.restaurants r;

-- Optional: re-grant if your roles rely on direct view grants
-- GRANT SELECT ON public.v_restaurants_partners TO anon, authenticated;

COMMIT;
