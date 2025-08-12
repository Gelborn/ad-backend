-- 0034_maintenance_jobs.sql
BEGIN;

-- Extensions we rely on
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid
CREATE EXTENSION IF NOT EXISTS pg_net;    -- net.http_post (notify from DB)

-- Helpful indexes (idempotent)
CREATE INDEX IF NOT EXISTS idx_donation_intents_status_expires
  ON public.donation_intents (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_donations_status_pickup_deadline
  ON public.donations (status, pickup_deadline_at);
CREATE INDEX IF NOT EXISTS idx_packages_status_expires
  ON public.packages (status, expires_at);

-- -----------------------------------------------------------------------------
-- Helper: fetch config from Vault if available, else DB setting (app.*)
-- Expects secrets named:
--   - functions_base_url
--   - functions_internal_key
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_get_setting(p_name text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_val text;
  has_vault boolean;
BEGIN
  -- Try Supabase Vault first (if available)
  has_vault := to_regproc('vault.get_secret(text)') IS NOT NULL;
  IF has_vault THEN
    BEGIN
      SELECT vault.get_secret(p_name) INTO v_val;
      IF v_val IS NOT NULL AND v_val <> '' THEN
        RETURN v_val;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- ignore and fall back
      v_val := NULL;
    END;
  END IF;

  -- Fallback: PostgreSQL setting e.g. ALTER DATABASE ... SET app.functions_base_url='...'
  BEGIN
    RETURN current_setting('app.' || p_name, true);
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
END;
$$;

COMMENT ON FUNCTION public.app_get_setting(text)
  IS 'Returns a secret/config by trying Supabase Vault (vault.get_secret) first, else current_setting(app.*).';


-- =============================================================================
-- A) RPC: expire a specific waiting intent, try plan‑B reroute, notify.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.expire_and_reroute(p_security_code text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now           timestamptz := now();
  v_donation_id   uuid;
  v_restaurant_id uuid;
  v_old_osc_id    uuid;
  v_new_osc_id    uuid;
  v_new_code      text;

  v_base_url   text := public.app_get_setting('functions_base_url');
  v_internal   text := public.app_get_setting('functions_internal_key');
  v_resp       record;
BEGIN
  -- 1) Locate open intent + pending donation
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

  -- 2) Expire the current intent
  UPDATE public.donation_intents
     SET status = 'expired', updated_at = v_now
   WHERE donation_id = v_donation_id
     AND security_code = p_security_code
     AND status = 'waiting_response';

  -- 3) Try to pick another active OSC (favorite first; skip ones that denied/expired)
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
    -- No OSC available → donation fails (DENIED) + unlink + safe restock
    UPDATE public.donations
       SET status = 'denied',
           updated_at = v_now
     WHERE id = v_donation_id
       AND status = 'pending';

    UPDATE public.donation_packages
       SET unlinked_at = v_now
     WHERE donation_id = v_donation_id
       AND unlinked_at IS NULL;

    UPDATE public.packages p
       SET status = 'in_stock',
           updated_at = v_now
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

    -- Close any remaining waiters defensively
    UPDATE public.donation_intents
       SET status = 're_routed', updated_at = v_now
     WHERE donation_id = v_donation_id
       AND status = 'waiting_response';

    RETURN;
  END IF;

  -- 4) Re-route: keep donation pending, switch OSC + new code; create fresh intent (SLA 2 days)
  v_new_code := substring(gen_random_uuid()::text, 1, 6);

  UPDATE public.donations
     SET osc_id = v_new_osc_id,
         security_code = v_new_code
   WHERE id = v_donation_id;

  INSERT INTO public.donation_intents
         (donation_id, osc_id, security_code, status, created_at, expires_at)
  VALUES (v_donation_id, v_new_osc_id, v_new_code, 'waiting_response', v_now, v_now + interval '2 days');

  -- 5) Notify new OSC (if config is present)
  IF coalesce(v_base_url, '') <> '' AND coalesce(v_internal, '') <> '' THEN
    SELECT *
      INTO v_resp
      FROM net.http_post(
        url     := v_base_url || '/functions/v1/util_send_notifications',
        headers := jsonb_build_object(
                     'Content-Type','application/json',
                     'x-internal-key', v_internal
                   ),
        body    := jsonb_build_object('security_code', v_new_code)::text
      );
    -- Ignore notify failures for now (keep flow robust)
  END IF;
END;
$$;

COMMENT ON FUNCTION public.expire_and_reroute(text)
  IS 'Expires a waiting intent, attempts Plan B and notifies. If none available → denies donation, unlinks, and restocks packages.';


-- =============================================================================
-- B) Batch: expire all overdue intents (calls A)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.expire_waiting_donation_intents()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := now();
  v_count integer := 0;
  r record;
BEGIN
  FOR r IN
    SELECT di.security_code
      FROM public.donation_intents di
      JOIN public.donations d ON d.id = di.donation_id
     WHERE di.status = 'waiting_response'
       AND di.expires_at IS NOT NULL
       AND di.expires_at < v_now
       AND d.status = 'pending'
  LOOP
    BEGIN
      PERFORM public.expire_and_reroute(r.security_code);
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE; -- keep batch resilient
    END;
  END LOOP;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.expire_waiting_donation_intents()
  IS 'Batch: finds overdue waiting intents and runs expire_and_reroute() for each. Returns count processed.';


-- =============================================================================
-- C) Deny donations that crossed pickup deadline + release packages  (FIXED VIA CTE)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.deny_donations_past_pickup_deadline()
RETURNS TABLE(donations_denied integer, packages_released integer)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := now();
  v_ids uuid[];
  v_released integer := 0;
BEGIN
  -- Flip donations to 'denied' and collect their ids (use CTE, not UPDATE-in-FROM)
  WITH updated AS (
    UPDATE public.donations d
       SET status = 'denied',
           updated_at = v_now
     WHERE d.status = 'accepted'
       AND d.pickup_deadline_at IS NOT NULL
       AND d.pickup_deadline_at < v_now
     RETURNING d.id
  )
  SELECT coalesce(array_agg(id), '{}') INTO v_ids FROM updated;

  donations_denied := coalesce(array_length(v_ids, 1), 0);

  IF donations_denied = 0 THEN
    packages_released := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Unlink active package associations (keep history)
  UPDATE public.donation_packages
     SET unlinked_at = v_now
   WHERE donation_id = ANY (v_ids)
     AND unlinked_at IS NULL;

  -- Restock packages that are no longer linked anywhere (race-safe)
  UPDATE public.packages p
     SET status = 'in_stock',
         updated_at = v_now
   WHERE EXISTS (
           SELECT 1
             FROM public.donation_packages dp
            WHERE dp.donation_id = ANY (v_ids)
              AND dp.package_id = p.id
         )
     AND NOT EXISTS (
           SELECT 1
             FROM public.donation_packages dp2
            WHERE dp2.package_id = p.id
              AND dp2.unlinked_at IS NULL
         );

  GET DIAGNOSTICS v_released = ROW_COUNT;
  packages_released := v_released;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.deny_donations_past_pickup_deadline()
  IS 'Sets donations to denied when past pickup_deadline_at; unlinks and safely restocks packages. Returns counts.';


-- =============================================================================
-- D) Discard packages that expired (only if currently in_stock)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.discard_expired_instock_packages()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := now();
  v_count integer;
BEGIN
  UPDATE public.packages p
     SET status = 'discarded',
         updated_at = v_now
   WHERE p.status = 'in_stock'
     AND p.expires_at IS NOT NULL
     AND p.expires_at < v_now;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.discard_expired_instock_packages()
  IS 'Marks packages as discarded when past expires_at AND status is in_stock. Returns rows affected.';


-- =============================================================================
-- E) pg_cron schedules (idempotent; no-ops if pg_cron is missing)
-- =============================================================================

-- Try to enable pg_cron (safe if already present; installed under schema "cron")
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA cron;

DO $$
DECLARE
  has_cron boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
    INTO has_cron;

  IF NOT has_cron THEN
    RAISE NOTICE 'pg_cron not available on this instance; skipping cron setup.';
    RETURN;
  END IF;

  -- Overdue intents: every 5 minutes → calls the BATCH function
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-and-reroute-intents') THEN
    PERFORM cron.schedule(
      'expire-and-reroute-intents',
      '*/5 * * * *',
      'SELECT public.expire_waiting_donation_intents();'
    );
  END IF;

  -- Donations past pickup deadline: every 15 minutes
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'deny-pickup-deadlines') THEN
    PERFORM cron.schedule(
      'deny-pickup-deadlines',
      '*/15 * * * *',
      'SELECT * FROM public.deny_donations_past_pickup_deadline();'
    );
  END IF;

  -- Discard expired packages: HOURLY (as you asked)
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'discard-expired-packages-hourly') THEN
    PERFORM cron.schedule(
      'discard-expired-packages-hourly',
      '0 * * * *',
      'SELECT public.discard_expired_instock_packages();'
    );
  END IF;
END
$$;
