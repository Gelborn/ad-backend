-- 2025-08-07 · Add unit_to_kg to items + weight/restaurant to packages (idempotent)
BEGIN;

-- 1) ITEMS ────────────────────────────────────────────────────
ALTER TABLE public.items
  ADD COLUMN IF NOT EXISTS unit_to_kg NUMERIC(10,4);

-- backfill: unit-based items get factor 1 (ok for test data)
UPDATE public.items
SET    unit_to_kg = 1
WHERE  unit = 'unit'::unit_type
  AND  unit_to_kg IS NULL;

-- constraint: if unit='unit', must have factor > 0
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'items_unit_requires_factor'
       AND conrelid = 'public.items'::regclass
  ) THEN
    ALTER TABLE public.items
      ADD CONSTRAINT items_unit_requires_factor
      CHECK (unit <> 'unit'::unit_type OR (unit_to_kg IS NOT NULL AND unit_to_kg > 0));
  END IF;
END$$;

-- 2) PACKAGES ────────────────────────────────────────────────
ALTER TABLE public.packages
  ADD COLUMN IF NOT EXISTS restaurant_id uuid,
  ADD COLUMN IF NOT EXISTS total_kg      NUMERIC(10,4);

-- backfill: copy restaurant from item and compute total_kg
UPDATE public.packages AS p
SET    restaurant_id = i.restaurant_id,
       total_kg      = CASE
                         WHEN i.unit = 'unit'::unit_type
                           THEN p.quantity * COALESCE(i.unit_to_kg, 1)
                         ELSE p.quantity
                       END
FROM   public.items AS i
WHERE  i.id = p.item_id;

-- FK (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'packages_restaurant_fk'
       AND conrelid = 'public.packages'::regclass
  ) THEN
    ALTER TABLE public.packages
      ADD CONSTRAINT packages_restaurant_fk
      FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;
  END IF;
END$$;

-- SET NOT NULL only if safe (no nulls left after backfill)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.packages WHERE restaurant_id IS NULL) THEN
    ALTER TABLE public.packages ALTER COLUMN restaurant_id SET NOT NULL;
  ELSE
    RAISE NOTICE 'Skipped NOT NULL on packages.restaurant_id (nulls present)';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.packages WHERE total_kg IS NULL) THEN
    ALTER TABLE public.packages ALTER COLUMN total_kg SET NOT NULL;
  ELSE
    RAISE NOTICE 'Skipped NOT NULL on packages.total_kg (nulls present)';
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_packages_restaurant ON public.packages (restaurant_id);

COMMIT;
