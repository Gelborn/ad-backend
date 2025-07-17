-- 0005_fix_release_donation_package_status.sql

BEGIN;

-- Recria a função release_donation usando awaiting_acceptance
CREATE OR REPLACE FUNCTION public.release_donation(
  in_restaurant_id UUID
)
RETURNS TABLE(donation_id UUID, security_code TEXT) AS
$$
DECLARE
  code TEXT := substring(gen_random_uuid()::text,1,6);
  pks UUID[];
  osc_pick UUID;
  r_lat FLOAT8;
  r_lng FLOAT8;
BEGIN
  -- 1) Coords do restaurante
  SELECT lat, lng INTO r_lat, r_lng
    FROM restaurants
   WHERE id = in_restaurant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESTAURANT_NOT_FOUND';
  END IF;

  -- 2) Seleção de pacotes em estoque
  SELECT array_agg(p.id) INTO pks
    FROM packages p
    JOIN items i ON p.item_id = i.id
   WHERE i.restaurant_id = in_restaurant_id
     AND p.status = 'in_stock';
  IF pks IS NULL THEN
    RAISE EXCEPTION 'NO_PACKAGES_IN_STOCK';
  END IF;

  -- 3) Escolha da OSC
  SELECT id INTO osc_pick
    FROM osc
   WHERE active = true
   ORDER BY
     haversine(r_lat, r_lng, lat, lng),
     last_received_at
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_OSC_AVAILABLE';
  END IF;

  -- 4) Inserção da doação
  INSERT INTO donations(restaurant_id, osc_id, status, security_code)
  VALUES (in_restaurant_id, osc_pick, 'pending', code)
  RETURNING id INTO donation_id;

  -- 5) Vincula pacotes
  INSERT INTO donation_packages(donation_id, package_id)
    SELECT donation_id, unnest(pks);

  -- 6) **Atualiza status** dos pacotes para awaiting_acceptance
  UPDATE packages
     SET status = 'awaiting_acceptance'
   WHERE id = ANY(pks);

  -- 7) Retorna
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql VOLATILE;

COMMIT;
