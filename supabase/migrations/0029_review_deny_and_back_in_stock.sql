BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 0) Safety: ensure 'denied' exists on donation_status (no-op if present)
-- ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'donation_status' AND e.enumlabel = 'denied'
  ) THEN
    ALTER TYPE donation_status ADD VALUE 'denied';
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────
-- 1) Option A infra (history on donation_packages)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.donation_packages
  ADD COLUMN IF NOT EXISTS unlinked_at timestamptz;

-- Old uniqueness (blocks reuse) → drop if exists
ALTER TABLE public.donation_packages
  DROP CONSTRAINT IF EXISTS unique_package_per_donation;

-- Only one *active* link per package (history allowed)
CREATE UNIQUE INDEX IF NOT EXISTS uq_donation_packages_active_package
  ON public.donation_packages (package_id)
  WHERE unlinked_at IS NULL;

-- Faster lookups of active links by donation
CREATE INDEX IF NOT EXISTS idx_donation_packages_donation_active
  ON public.donation_packages (donation_id)
  WHERE unlinked_at IS NULL;

-- ─────────────────────────────────────────────────────────────
-- 2) Perf indexes for deny + re-route path
-- ─────────────────────────────────────────────────────────────
-- Find intent by code fast (you likely already have a unique on security_code)
-- CREATE UNIQUE INDEX IF NOT EXISTS uq_donation_intents_security_code ON public.donation_intents(security_code);

-- Exclude OSCs that already denied/expired for this donation
CREATE INDEX IF NOT EXISTS idx_di_donation_osc_denexp
  ON public.donation_intents (donation_id, osc_id)
  WHERE status IN ('denied','expired');

-- Handy when checking/closing other waiters
CREATE INDEX IF NOT EXISTS idx_di_donation_waiting
  ON public.donation_intents (donation_id)
  WHERE status = 'waiting_response';

-- Partnerships lookup/order
CREATE INDEX IF NOT EXISTS idx_partnerships_restaurant_fav
  ON public.partnerships (restaurant_id, is_favorite, osc_id);

-- Active OSCs ordered by last_received_at
CREATE INDEX IF NOT EXISTS idx_osc_active_last
  ON public.osc (last_received_at)
  WHERE status = 'active';

-- (Optional) Donations status checks
CREATE INDEX IF NOT EXISTS idx_donations_status ON public.donations (status);

-- ─────────────────────────────────────────────────────────────
-- 3) RPC: deny the current intent; re-route if possible; otherwise
--        mark donation as denied, unlink packages (history), restock safely.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.osc_deny_and_reroute(p_security_code text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_donation_id    uuid;
  v_restaurant_id  uuid;
  v_old_osc_id     uuid;
  v_new_osc_id     uuid;
  v_new_code       text;
BEGIN
  -- 1) Find open intent + donation (must be pending)
  SELECT di.donation_id, d.restaurant_id, di.osc_id
    INTO v_donation_id, v_restaurant_id, v_old_osc_id
  FROM public.donation_intents di
  JOIN public.donations d ON d.id = di.donation_id
  WHERE di.security_code = p_security_code
    AND di.status = 'waiting_response'
    AND d.status = 'pending'
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DONATION_NOT_FOUND_OR_NOT_PENDING';
  END IF;

  -- 2) Deny current intent
  UPDATE public.donation_intents
     SET status = 'denied', updated_at = now()
   WHERE donation_id = v_donation_id
     AND security_code = p_security_code
     AND status = 'waiting_response';

  -- 3) Try another active OSC (favorite first, then oldest last_received_at),
  --    excluding the one that just denied AND any OSC that already denied/expired for this donation.
  SELECT o.id
    INTO v_new_osc_id
  FROM public.partnerships pr
  JOIN public.osc o ON o.id = pr.osc_id
  WHERE pr.restaurant_id = v_restaurant_id
    AND o.status = 'active'
    AND o.id <> v_old_osc_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.donation_intents di2
      WHERE di2.donation_id = v_donation_id
        AND di2.osc_id = o.id
        AND di2.status IN ('denied','expired')
    )
  ORDER BY pr.is_favorite DESC, o.last_received_at NULLS FIRST
  LIMIT 1;

  IF v_new_osc_id IS NULL THEN
    -- 3b) No OSC available → donation fails
    UPDATE public.donations
       SET status = 'denied'
     WHERE id = v_donation_id
       AND status = 'pending';

    -- Unlink active package associations (keep history)
    UPDATE public.donation_packages
       SET unlinked_at = now()
     WHERE donation_id = v_donation_id
       AND unlinked_at IS NULL;

    -- Restock packages that are no longer linked anywhere (race-safe)
    UPDATE public.packages p
       SET status = 'in_stock'
     WHERE EXISTS (
             SELECT 1
             FROM public.donation_packages dp
             WHERE dp.donation_id = v_donation_id
               AND dp.package_id = p.id
           )
       AND NOT EXISTS (
             SELECT 1
             FROM public.donation_packages dp2
             WHERE dp2.package_id = p.id
               AND dp2.unlinked_at IS NULL
           );

    -- Close any straggler waiting intents (should be none, but safe)
    UPDATE public.donation_intents
       SET status = 're_routed', updated_at = now()
     WHERE donation_id = v_donation_id
       AND status = 'waiting_response';

    RETURN;
  END IF;

  -- 4) Re-route: keep donation pending, switch OSC + code and create a fresh intent (SLA 2 days)
  v_new_code := substring(gen_random_uuid()::text, 1, 6);

  UPDATE public.donations
     SET osc_id = v_new_osc_id,
         security_code = v_new_code
   WHERE id = v_donation_id;

  INSERT INTO public.donation_intents
         (donation_id, osc_id, security_code, status, created_at, expires_at)
  VALUES (v_donation_id, v_new_osc_id, v_new_code, 'waiting_response', now(), now() + interval '2 days');

END;
$$;

COMMIT;
