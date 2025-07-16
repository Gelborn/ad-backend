-- 0002_update_items_and_packages.sql

-- 1) Itens: virar só catálogo
ALTER TABLE items
  -- adiciona categoria e validade
  ADD COLUMN category      text    NOT NULL DEFAULT '',
  ADD COLUMN validity_days integer NOT NULL DEFAULT 0,
  -- remove quantidade do catálogo
  DROP COLUMN quantity;

-- 2) Pacotes: campos de expiração e código de etiqueta
ALTER TABLE packages
  -- data de expiração calculada a partir de created_at + validade do item
  ADD COLUMN expires_at  timestamptz NOT NULL DEFAULT now(),
  -- label_code único para conferir no pickup
  ADD COLUMN label_code  text         NOT NULL DEFAULT '';

-- 3) Popula expires_at para pacotes existentes
UPDATE packages p
SET    expires_at = p.created_at + (i.validity_days || ' days')::interval
FROM   items i
WHERE  p.item_id = i.id;