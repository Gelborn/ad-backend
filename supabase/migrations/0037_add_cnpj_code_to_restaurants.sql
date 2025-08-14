-- 0037_add_cnpj_code_to_restaurants.sql
-- Adds nullable, unique fields for CNPJ and internal code on restaurants.

-- 1) Add columns (idempotent)
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS cnpj TEXT,
  ADD COLUMN IF NOT EXISTS code TEXT;

-- 2) Normalize any pre-existing values (empty string -> NULL)
UPDATE public.restaurants SET cnpj = NULL WHERE cnpj IS NOT NULL AND btrim(cnpj) = '';
UPDATE public.restaurants SET code = NULL WHERE code IS NOT NULL AND btrim(code) = '';

-- 3) Enforce uniqueness (allows multiple NULLs by Postgres semantics)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'restaurants_cnpj_key'
      AND conrelid = 'public.restaurants'::regclass
  ) THEN
    ALTER TABLE public.restaurants
      ADD CONSTRAINT restaurants_cnpj_key UNIQUE (cnpj);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'restaurants_code_key'
      AND conrelid = 'public.restaurants'::regclass
  ) THEN
    ALTER TABLE public.restaurants
      ADD CONSTRAINT restaurants_code_key UNIQUE (code);
  END IF;
END$$;
