-- supabase/migrations/20250801_unique_osc_email_cnpj.sql
------------------------------------------------------------------
-- 1)  E-mail opcional na tabela OSC
------------------------------------------------------------------
alter table osc
  add column email text;

------------------------------------------------------------------
-- 2)  Unicidade de CNPJ
------------------------------------------------------------------
alter table osc
  add constraint osc_cnpj_unique unique (cnpj);

------------------------------------------------------------------
-- 3)  Unicidade de e-mail (quando não-nulo)
--    PostgreSQL permite vários NULLs em UNIQUE; criamos índice parcial
------------------------------------------------------------------
create unique index if not exists osc_email_unique_idx
  on osc (lower(email))
  where email is not null;
