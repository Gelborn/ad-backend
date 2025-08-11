BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1) Enum + Table + Trigger + Indexes + Backfill (donation_intents)
-- ─────────────────────────────────────────────────────────────

-- 1.1 Enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'donation_intent_status') THEN
    CREATE TYPE donation_intent_status AS ENUM
      ('waiting_response', 'accepted', 'denied', 'expired', 're_routed');
  END IF;
END$$;

-- 1.2 Table
CREATE TABLE IF NOT EXISTS public.donation_intents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  donation_id   uuid NOT NULL REFERENCES public.donations(id) ON DELETE CASCADE,
  osc_id        uuid NOT NULL REFERENCES public.osc(id)        ON DELETE CASCADE,
  security_code text NOT NULL,
  status        donation_intent_status NOT NULL DEFAULT 'waiting_response',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz
);

-- 1.3 Trigger helper
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_donation_intents_updated ON public.donation_intents;
CREATE TRIGGER trg_donation_intents_updated
BEFORE UPDATE ON public.donation_intents
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- 1.4 Indexes / constraints
CREATE UNIQUE INDEX IF NOT EXISTS uq_donation_intents_security_code
  ON public.donation_intents (security_code);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_open_intent_per_donation
  ON public.donation_intents (donation_id)
  WHERE status = 'waiting_response';

CREATE INDEX IF NOT EXISTS idx_donation_intents_donation_id
  ON public.donation_intents (donation_id);

CREATE INDEX IF NOT EXISTS idx_donations_restaurant_id
  ON public.donations (restaurant_id);

-- 1.5 Backfill from existing donations
INSERT INTO public.donation_intents (donation_id, osc_id, security_code, status, created_at, expires_at)
SELECT
  d.id,
  d.osc_id,
  d.security_code,
  CASE d.status
    WHEN 'pending'::donation_status THEN 'waiting_response'::donation_intent_status
    ELSE 'accepted'::donation_intent_status
  END,
  d.created_at,
  d.created_at + INTERVAL '2 days'
FROM public.donations d
WHERE d.osc_id IS NOT NULL
  AND d.security_code IS NOT NULL
  AND NOT EXISTS (
        SELECT 1 FROM public.donation_intents di WHERE di.donation_id = d.id
      );

-- ─────────────────────────────────────────────────────────────
-- 2) Helper: Haversine (no DO wrapper → no nested $$ issues)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.haversine_km(
  lat1 float8, lon1 float8, lat2 float8, lon2 float8
) RETURNS float8 AS $f$
DECLARE
  r  constant float8 := 6371.0; -- km
  dlat float8 := radians(lat2 - lat1);
  dlon float8 := radians(lon2 - lon1);
  a float8 := sin(dlat/2)^2
              + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon/2)^2;
BEGIN
  RETURN 2 * r * atan2(sqrt(a), sqrt(1 - a));
END;
$f$ LANGUAGE plpgsql IMMUTABLE;

-- ─────────────────────────────────────────────────────────────
-- 3) RPC: release_donation_partnered (favorite → else oldest last_received_at)
--    Returns OSC info + computed distance
-- ─────────────────────────────────────────────────────────────

-- Drop old signature if it exists (required if return type changed previously)
DROP FUNCTION IF EXISTS public.release_donation_partnered(uuid);

CREATE OR REPLACE FUNCTION public.release_donation_partnered(
  p_restaurant_id uuid
)
RETURNS TABLE(
  donation_id   uuid,
  security_code text,
  osc_id        uuid,
  osc_name      text,
  osc_address   text,
  distance_km   numeric
) AS $$
DECLARE
  v_pkg_ids     uuid[];
  v_code        text := substring(gen_random_uuid()::text, 1, 6);
  v_osc_id      uuid;
  v_donation_id uuid;
  v_lat         float8;
  v_lng         float8;
BEGIN
  -- A) ensure restaurant exists + coords
  SELECT lat, lng INTO v_lat, v_lng
  FROM public.restaurants
  WHERE id = p_restaurant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESTAURANT_NOT_FOUND';
  END IF;

  -- B) gather in_stock packages from this restaurant
  SELECT array_agg(p.id) INTO v_pkg_ids
  FROM public.packages p
  JOIN public.items i ON i.id = p.item_id
  WHERE i.restaurant_id = p_restaurant_id
    AND p.status = 'in_stock';
  IF v_pkg_ids IS NULL THEN
    RAISE EXCEPTION 'NO_PACKAGES_IN_STOCK';
  END IF;

  -- C) choose OSC
  -- C1) favorite first
  SELECT o.id
    INTO v_osc_id
  FROM public.partnerships pr
  JOIN public.osc o ON o.id = pr.osc_id
  WHERE pr.restaurant_id = p_restaurant_id
    AND pr.is_favorite = true
    AND o.status = 'active'
  ORDER BY o.last_received_at NULLS FIRST
  LIMIT 1;

  -- C2) else oldest last_received_at
  IF v_osc_id IS NULL THEN
    SELECT o.id
      INTO v_osc_id
    FROM public.partnerships pr
    JOIN public.osc o ON o.id = pr.osc_id
    WHERE pr.restaurant_id = p_restaurant_id
      AND o.status = 'active'
    ORDER BY o.last_received_at NULLS FIRST
    LIMIT 1;
  END IF;

  IF v_osc_id IS NULL THEN
    RAISE EXCEPTION 'NO_OSC_AVAILABLE';
  END IF;

  -- D) create donation (legacy fill: osc_id + security_code)
  INSERT INTO public.donations (restaurant_id, osc_id, status, security_code)
  VALUES (p_restaurant_id, v_osc_id, 'pending', v_code)
  RETURNING id INTO v_donation_id;

  -- E) link packages
  INSERT INTO public.donation_packages (donation_id, package_id)
  SELECT v_donation_id, unnest(v_pkg_ids);

  -- F) move packages to awaiting_acceptance
  UPDATE public.packages
  SET status = 'awaiting_acceptance'
  WHERE id = ANY (v_pkg_ids);

  -- G) create intent (SLA 2 days)
  INSERT INTO public.donation_intents (donation_id, osc_id, security_code, status, created_at, expires_at)
  VALUES (v_donation_id, v_osc_id, v_code, 'waiting_response', now(), now() + interval '2 days');

  -- H) return payload with computed distance
  RETURN QUERY
  SELECT
    v_donation_id,
    v_code,
    o.id,
    o.name,
    NULLIF(TRIM(
      COALESCE(o.street,'') || ' ' || COALESCE(o.number,'') || ', ' ||
      COALESCE(o.city,'')   || ' - ' || COALESCE(o.uf::text,'') || ' ' ||
      COALESCE(o.cep,'')
    ), '') AS osc_address,
    ROUND(public.haversine_km(v_lat, v_lng, o.lat, o.lng)::numeric, 2) AS distance_km
  FROM public.osc o
  WHERE o.id = v_osc_id;
END;
$$ LANGUAGE plpgsql VOLATILE;

COMMIT;
