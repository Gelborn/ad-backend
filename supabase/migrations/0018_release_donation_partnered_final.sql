-- 0018_release_donation_partnered_final.sql

CREATE OR REPLACE FUNCTION public.release_donation_partnered(
  p_restaurant_id UUID
)
RETURNS TABLE(
  donation_id   UUID,
  security_code TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pkgs       UUID[];
  v_partnership RECORD;
  v_code       TEXT := substring(gen_random_uuid()::text, 1, 6);
BEGIN
  -- 1) Valida restaurante
  PERFORM 1
    FROM restaurants
   WHERE id = p_restaurant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESTAURANT_NOT_FOUND';
  END IF;

  -- 2) Agrupa todos os pacotes IN_STOCK via items → restaurant
  SELECT array_agg(p.id)
    INTO v_pkgs
    FROM packages p
    JOIN items    i ON p.item_id = i.id
   WHERE i.restaurant_id = p_restaurant_id
     AND p.status        = 'in_stock';
  IF v_pkgs IS NULL OR array_length(v_pkgs,1) = 0 THEN
    RAISE EXCEPTION 'NO_PACKAGES_IN_STOCK';
  END IF;

  -- 3) Escolhe OSC parceira (favorita primeiro; depois quem recebeu há mais tempo)
  WITH last_don AS (
    SELECT
      pt.osc_id,
      pt.is_favorite,
      COALESCE(MAX(d.created_at), '1970-01-01'::timestamp) AS last_received
    FROM partnerships pt
    LEFT JOIN donations d
      ON d.restaurant_id = pt.restaurant_id
     AND d.osc_id        = pt.osc_id
    WHERE pt.restaurant_id = p_restaurant_id
      AND pt.is_active
    GROUP BY pt.osc_id, pt.is_favorite
  )
  SELECT osc_id
    INTO v_partnership
    FROM last_don
   ORDER BY
     CASE WHEN is_favorite THEN 0 ELSE 1 END,
     last_received ASC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_PARTNERSHIPS';
  END IF;

  -- 4) Marca todos os pacotes como aguardando aceitação
  UPDATE packages
     SET status = 'awaiting_acceptance'
   WHERE id = ANY(v_pkgs);

  -- 5) Insere a doação (mantendo status 'pending')
  INSERT INTO donations (
    restaurant_id,
    osc_id,
    status,
    security_code,
    created_at
  ) VALUES (
    p_restaurant_id,
    v_partnership.osc_id,
    'pending',
    v_code,
    now()
  )
  RETURNING id, security_code
  INTO donation_id, security_code;

  -- 6) Vínculo dos pacotes na doação
  INSERT INTO donation_packages (donation_id, package_id)
    SELECT donation_id, unnest(v_pkgs);

  -- 7) Retorna result
  RETURN NEXT;
END;
$$;

GRANT EXECUTE
  ON FUNCTION public.release_donation_partnered(UUID)
  TO anon, authenticated;
