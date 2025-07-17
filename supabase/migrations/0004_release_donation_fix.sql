-- 20250718T123456_release_donation_fix.sql

BEGIN;

-- Substitui a função release_donation para usar JOIN em items
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

  -- 2) Seleciona pacotes em estoque via join em items
  SELECT array_agg(p.id) INTO pks
    FROM packages p
    JOIN items i ON p.item_id = i.id
   WHERE i.restaurant_id = in_restaurant_id
     AND p.status = 'in_stock';
  IF pks IS NULL THEN
    RAISE EXCEPTION 'NO_PACKAGES_IN_STOCK';
  END IF;

  -- 3) Escolhe OSC ativa mais próxima
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

  -- 4) Insere doação
  INSERT INTO donations(restaurant_id, osc_id, status, security_code)
  VALUES (in_restaurant_id, osc_pick, 'pending', code)
  RETURNING id INTO donation_id;

  -- 5) Vincula pacotes
  INSERT INTO donation_packages(donation_id, package_id)
    SELECT donation_id, unnest(pks);

  -- 6) Atualiza status dos pacotes
  UPDATE packages
     SET status = 'pending'
   WHERE id = ANY(pks);

  -- 7) Retorna
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql VOLATILE;

COMMIT;
