-- 0031_release_donation_partnered_use_cached_distance.sql
-- Use partnerships.distance_km instead of recalculating

BEGIN;

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

  -- H) return payload with cached distance (fallback to haversine if null)
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
    ROUND(
      COALESCE(
        pr.distance_km,                                   -- cached value
        public.haversine_km(v_lat, v_lng, o.lat, o.lng)   -- rare fallback
      )::numeric,
      2
    ) AS distance_km
  FROM public.osc o
  JOIN public.partnerships pr
    ON pr.osc_id = o.id
   AND pr.restaurant_id = p_restaurant_id
  WHERE o.id = v_osc_id;
END;
$$ LANGUAGE plpgsql VOLATILE;

COMMIT;
