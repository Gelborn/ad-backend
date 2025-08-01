------------------------------------------------------------------
-- 0)  CABEÇALHO OPCIONAL
------------------------------------------------------------------
-- \echo '=== 0008_cf_role_and_schema.sql ==='

------------------------------------------------------------------
-- 1)  TIPOS
------------------------------------------------------------------
create type status_type as enum ('active','inactive');

------------------------------------------------------------------
-- 2)  TABELA RESTAURANTS
------------------------------------------------------------------
alter table restaurants
    rename column address to address_full;

alter table restaurants
    add column street      text,
    add column number      text,
    add column city        text,
    add column uf          char(2),
    add column cep         text,
    add column status      status_type not null default 'active',
    add column added_at    timestamptz not null default now(),
    add column updated_at  timestamptz not null default now();

------------------------------------------------------------------
-- 3)  TABELA OSC
------------------------------------------------------------------
alter table osc
    rename column active to active_bool;         -- backup temporário

alter table osc
    add column responsible_name text,
    add column street           text,
    add column number           text,
    add column city             text,
    add column uf               char(2),
    add column cep              text,
    add column cnpj             text,
    add column observation      text,
    add column status           status_type not null default 'active',
    add column added_at         timestamptz not null default now(),
    add column updated_at       timestamptz not null default now();

-- converte flag antiga → enum e remove a coluna boolean
update osc
set status = (
  case
    when active_bool then 'active'
    else 'inactive'
  end
)::status_type;

alter table osc drop column active_bool;

------------------------------------------------------------------
-- 4)  TRIGGER genérico de updated_at
------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_restaurants_updated
before update on restaurants
for each row execute procedure public.set_updated_at();

create trigger trg_osc_updated
before update on osc
for each row execute procedure public.set_updated_at();

------------------------------------------------------------------
-- 5)  TABELA DE PAPÉIS CF
------------------------------------------------------------------
create table cf_users (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

------------------------------------------------------------------
-- 6)  FUNÇÃO utilitária para RLS
------------------------------------------------------------------
create or replace function public.is_cf()
returns boolean
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select exists
         (select 1 from public.cf_users
          where user_id = auth.uid());
$$;

------------------------------------------------------------------
-- 7)  POLÍTICAS RLS (CF = super-admin)
------------------------------------------------------------------
-- 7.1  RESTAURANTS
alter table restaurants enable row level security;

create policy p_restaurants_cf_full
  on restaurants for all
  using (public.is_cf()) with check (public.is_cf());

-- 7.2  OSC
alter table osc enable row level security;

create policy p_osc_cf_full
  on osc for all
  using (public.is_cf()) with check (public.is_cf());

------------------------------------------------------------------
-- 7.3  ITENS, PACKAGES, DONATIONS, DONATION_PACKAGES
------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array
    '{items,packages,donations,donation_packages}'::text[]
  loop
    execute format('alter table %I enable row level security;', t);

    execute format(
      'create policy p_%s_cf_full on %I for all
       using (public.is_cf()) with check (public.is_cf());',
      t, t
    );
  end loop;
end$$;

-- \echo '=== migration 0008 ok ==='
