-- 0037_debug_install.sql  — diagnostic + force install (no BEGIN/COMMIT)

-- 0) Who/where am I? (shows in migration output)
DO $$ BEGIN
  RAISE NOTICE 'db=% current_user=% session_user=% schemas=%',
    current_database(), current_user, session_user, current_schemas(true);
END $$;

-- 1) Make sure we can CREATE in public (idempotent, safe)
DO $$ BEGIN
  -- grant create on schema public to common roles if needed
  BEGIN
    EXECUTE 'GRANT USAGE, CREATE ON SCHEMA public TO postgres, anon, authenticated, service_role';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'grant on schema public failed: [%] %', SQLSTATE, SQLERRM;
  END;
END $$;

-- 2) Quick probe: can we create any function at all?
DO $$ BEGIN RAISE NOTICE 'creating probe function...'; END $$;
CREATE OR REPLACE FUNCTION public.__mig_probe__()
RETURNS int
LANGUAGE sql
AS $$ SELECT 1 $$
;
GRANT EXECUTE ON FUNCTION public.__mig_probe__() TO anon, authenticated, service_role;
DO $$ BEGIN
  PERFORM public.__mig_probe__();
  RAISE NOTICE 'probe ok.';
END $$;
DROP FUNCTION public.__mig_probe__();

-- 3) Ensure extensions exist (idempotent)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA cron;

-- 4) FORCE drop then recreate our functions (so there is a guaranteed diff)
DO $$ BEGIN RAISE NOTICE 'dropping old functions (if any)...'; END $$;
DROP FUNCTION IF EXISTS public.expire_and_reroute(text)                CASCADE;
DROP FUNCTION IF EXISTS public.expire_waiting_donation_intents()       CASCADE;
DROP FUNCTION IF EXISTS public.deny_donations_past_pickup_deadline()   CASCADE;
DROP FUNCTION IF EXISTS public.discard_expired_instock_packages()      CASCADE;
DROP FUNCTION IF EXISTS public.app_get_setting(text)                   CASCADE;

DO $$ BEGIN RAISE NOTICE 'creating app_get_setting...'; END $$;
CREATE OR REPLACE FUNCTION public.app_get_setting(p_name text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_val text;
  has_vault boolean;
BEGIN
  has_vault := to_regproc('vault.get_secret(text)') IS NOT NULL;
  IF has_vault THEN
    BEGIN
      SELECT vault.get_secret(p_name) INTO v_val;
      IF v_val IS NOT NULL AND v_val <> '' THEN
        RETURN v_val;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_val := NULL;
    END;
  END IF;

  BEGIN
    RETURN current_setting('app.' || p_name, true);
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
END;
$$;
COMMENT ON FUNCTION public.app_get_setting(text)
  IS 'Returns a secret/config by trying Supabase Vault first, else current_setting(app.*).';

DO $$ BEGIN RAISE NOTICE 'creating expire_and_reroute...'; END $$;
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

  UPDATE public.donation_intents
     SET status = 'expired', updated_at = v_now
   WHERE donation_id = v_donation_id
     AND security_code = p_security_code
     AND status = 'waiting_response';

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

    UPDATE public.donation_intents
       SET status = 're_routed', updated_at = v_now
     WHERE donation_id = v_donation_id
       AND status = 'waiting_response';
    RETURN;
  END IF;

  v_new_code := substring(gen_random_uuid()::text, 1, 6);

  UPDATE public.donations
     SET osc_id = v_new_osc_id,
         security_code = v_new_code
   WHERE id = v_donation_id;

  INSERT INTO public.donation_intents
         (donation_id, osc_id, security_code, status, created_at, expires_at)
  VALUES (v_donation_id, v_new_osc_id, v_new_code, 'waiting_response', v_now, v_now + interval '2 days');

  IF coalesce(v_base_url, '') <> '' AND coalesce(v_internal, '') <> '' THEN
    SELECT *
      INTO v_resp
      FROM net.http_post(
        url     := v_base_url || '/functions/v1/util_send_notifications',
        headers := jsonb_build_object('Content-Type','application/json','x-internal-key', v_internal),
        body    := jsonb_build_object('security_code', v_new_code)::text
      );
  END IF;
END;
$$;

DO $$ BEGIN RAISE NOTICE 'creating expire_waiting_donation_intents...'; END $$;
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
      CONTINUE;
    END;
  END LOOP;
  RETURN v_count;
END;
$$;

DO $$ BEGIN RAISE NOTICE 'creating deny_donations_past_pickup_deadline...'; END $$;
CREATE OR REPLACE FUNCTION public.deny_donations_past_pickup_deadline()
RETURNS TABLE(donations_denied integer, packages_released integer)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := now();
  v_ids uuid[];
  v_released integer := 0;
BEGIN
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

  UPDATE public.donation_packages
     SET unlinked_at = v_now
   WHERE donation_id = ANY (v_ids)
     AND unlinked_at IS NULL;

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

DO $$ BEGIN RAISE NOTICE 'creating discard_expired_instock_packages...'; END $$;
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

-- 5) Grants (explicit)
GRANT EXECUTE ON FUNCTION
  public.app_get_setting(text),
  public.expire_and_reroute(text),
  public.expire_waiting_donation_intents(),
  public.deny_donations_past_pickup_deadline(),
  public.discard_expired_instock_packages()
TO anon, authenticated, service_role;

-- 6) Idempotent indexes (no-ops if present)
CREATE INDEX IF NOT EXISTS idx_donation_intents_status_expires
  ON public.donation_intents (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_donations_status_pickup_deadline
  ON public.donations (status, pickup_deadline_at);
CREATE INDEX IF NOT EXISTS idx_packages_status_expires
  ON public.packages (status, expires_at);

-- 7) Cron jobs (with notices)
DO $$ DECLARE has_cron boolean; BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') INTO has_cron;
  IF NOT has_cron THEN
    RAISE NOTICE 'pg_cron not available; skipping job setup.';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='expire-and-reroute-intents') THEN
    PERFORM cron.schedule('expire-and-reroute-intents','*/5 * * * *','SELECT public.expire_waiting_donation_intents();');
    RAISE NOTICE 'Created cron job expire-and-reroute-intents.';
  ELSE
    RAISE NOTICE 'Cron job expire-and-reroute-intents already exists.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='deny-pickup-deadlines') THEN
    PERFORM cron.schedule('deny-pickup-deadlines','*/15 * * * *','SELECT * FROM public.deny_donations_past_pickup_deadline();');
    RAISE NOTICE 'Created cron job deny-pickup-deadlines.';
  ELSE
    RAISE NOTICE 'Cron job deny-pickup-deadlines already exists.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='discard-expired-packages-hourly') THEN
    PERFORM cron.schedule('discard-expired-packages-hourly','0 * * * *','SELECT public.discard_expired_instock_packages();');
    RAISE NOTICE 'Created cron job discard-expired-packages-hourly.';
  ELSE
    RAISE NOTICE 'Cron job discard-expired-packages-hourly already exists.';
  END IF;
END $$;

-- 8) Final: list what exists (appears in output)
SELECT p.proname AS created_function, n.nspname AS schema
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public'
  AND p.proname IN (
    'app_get_setting',
    'expire_and_reroute',
    'expire_waiting_donation_intents',
    'deny_donations_past_pickup_deadline',
    'discard_expired_instock_packages'
  )
ORDER BY 1;
