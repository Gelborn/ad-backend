BEGIN;

-- ─────────────────────────────────────────────
-- Partnerships → restaurant owner can READ only
-- ─────────────────────────────────────────────
ALTER TABLE public.partnerships ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.partnerships TO authenticated;

DROP POLICY IF EXISTS "r_partnerships_by_owner" ON public.partnerships;
CREATE POLICY "r_partnerships_by_owner"
ON public.partnerships
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.restaurants r
    WHERE r.id = partnerships.restaurant_id
      AND r.user_id = auth.uid()
  )
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_partnerships_restaurant_id ON public.partnerships (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_partnerships_osc_id        ON public.partnerships (osc_id);

-- ─────────────────────────────────────────────
-- OSC → readable only if ACTIVE and linked via my partnerships
-- ─────────────────────────────────────────────
ALTER TABLE public.osc ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.osc TO authenticated;

DROP POLICY IF EXISTS "r_osc_active_via_my_partnership" ON public.osc;
CREATE POLICY "r_osc_active_via_my_partnership"
ON public.osc
FOR SELECT
TO authenticated
USING (
  status = 'active'
  AND EXISTS (
    SELECT 1
    FROM public.partnerships pr
    JOIN public.restaurants r ON r.id = pr.restaurant_id
    WHERE pr.osc_id = osc.id
      AND r.user_id = auth.uid()
  )
);

-- ─────────────────────────────────────────────
-- (Optional but recommended) Restaurants → owner can READ own row
-- ─────────────────────────────────────────────
ALTER TABLE public.restaurants ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.restaurants TO authenticated;

DROP POLICY IF EXISTS "r_restaurants_owner_can_select" ON public.restaurants;
CREATE POLICY "r_restaurants_owner_can_select"
ON public.restaurants
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

COMMIT;
