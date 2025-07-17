-- 0003_release_donation.sql

BEGIN;

-- 1) Garantir extensão para gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2) Função auxiliar de Haversine
CREATE OR REPLACE FUNCTION public.haversine(
  lat1 FLOAT8, lon1 FLOAT8,
  lat2 FLOAT8, lon2 FLOAT8
) RETURNS FLOAT8 AS
$$
DECLARE
  R CONSTANT FLOAT8 := 6371e3;  -- raio da Terra em metros
  φ1 FLOAT8 := radians(lat1);
  φ2 FLOAT8 := radians(lat2);
  Δφ FLOAT8 := radians(lat2 - lat1);
  Δλ FLOAT8 := radians(lon2 - lon1);
  a FLOAT8;
  c FLOAT8;
BEGIN
  a := sin(Δφ/2)^2 + cos(φ1)*cos(φ2)*sin(Δλ/2)^2;
  c := 2 * atan2(sqrt(a), sqrt(1 - a));
  RETURN R * c;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 3) Função atômica de liberação de doação
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
  -- 3.1) Leitura de coordenadas do restaurante
  SELECT lat, lng INTO r_lat, r_lng
    FROM restaurants
   WHERE id = in_restaurant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESTAURANT_NOT_FOUND';
  END IF;

  -- 3.2) Seleção de pacotes em estoque
  SELECT array_agg(id) INTO pks
    FROM packages
   WHERE restaurant_id = in_restaurant_id
     AND status = 'in_stock';
  IF pks IS NULL THEN
    RAISE EXCEPTION 'NO_PACKAGES_IN_STOCK';
  END IF;

  -- 3.3) Escolha da OSC ativa mais próxima
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

  -- 3.4) Inserção da doação
  INSERT INTO donations(
    restaurant_id, osc_id, status, security_code
  ) VALUES (
    in_restaurant_id, osc_pick, 'pending', code
  )
  RETURNING id INTO donation_id;

  -- 3.5) Vincula todos os pacotes
  INSERT INTO donation_packages(donation_id, package_id)
    SELECT donation_id, unnest(pks);

  -- 3.6) Atualiza status dos pacotes
  UPDATE packages
     SET status = 'pending'
   WHERE id = ANY(pks);

  -- 3.7) Retorna ID e código
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql VOLATILE;

COMMIT;
