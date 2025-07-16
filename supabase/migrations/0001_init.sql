-- 0001_init.sql

-- 1) Extensões mínimas
create extension if not exists "pgcrypto";

-- 2) Enums
create type donation_status as enum (
  'pending',
  'accepted',
  'denied',
  'released',
  'picked_up'
);

create type package_status as enum (
  'in_stock',
  'awaiting_acceptance',
  'picked_up',
  'donated',
  'discarded'
);

create type unit_type as enum (
  'unit',
  'kg'
);

-- 3) Tabelas principais

-- Restaurantes (vinculados a auth.users)
create table restaurants (
  id        uuid             primary key default gen_random_uuid(),
  user_id   uuid             not null references auth.users(id) on delete cascade,
  name      text             not null,
  email     text             not null unique,
  phone     text,
  address   text,
  lat       double precision not null,
  lng       double precision not null
);

-- ativa RLS e policies em restaurants
alter table restaurants enable row level security;

-- só permite INSERT se user_id = auth.uid()
create policy restaurants_insert on restaurants
  for insert with check (
    user_id = auth.uid()
  );

-- só permite SELECT se user_id = auth.uid()
create policy restaurants_select on restaurants
  for select using (
    user_id = auth.uid()
  );

-- OSCs (sem auth própria)
create table osc (
  id               uuid             primary key default gen_random_uuid(),
  name             text             not null,
  phone            text             not null,
  address          text,
  lat              double precision not null,
  lng              double precision not null,
  active           boolean          not null default true,
  last_received_at timestamptz
);

-- Itens oferecidos pelo restaurante
create table items (
  id            uuid             primary key default gen_random_uuid(),
  restaurant_id uuid             not null references restaurants(id) on delete cascade,
  name          text             not null,
  description   text,
  unit          unit_type        not null,
  quantity      numeric          not null,
  created_at    timestamptz      not null default now()
);

-- Pacotes (vários itens)
create table packages (
  id         uuid             primary key default gen_random_uuid(),
  item_id    uuid             not null references items(id) on delete cascade,
  status     package_status   not null default 'in_stock',
  quantity   numeric          not null,
  created_at timestamptz      not null default now()
);

-- Doações (geradas via Edge Function)
create table donations (
  id             uuid             primary key default gen_random_uuid(),
  restaurant_id  uuid             not null references restaurants(id) on delete cascade,
  osc_id         uuid             not null references osc(id) on delete cascade,
  status         donation_status  not null default 'pending',
  security_code  text             unique not null,
  created_at     timestamptz      not null default now(),
  accepted_at    timestamptz,
  released_at    timestamptz,
  picked_up_at   timestamptz
);

-- Associação pacote ↔ doação
create table donation_packages (
  donation_id uuid not null references donations(id) on delete cascade,
  package_id  uuid not null references packages(id) on delete cascade,
  primary key(donation_id, package_id)
);

-- 4) Impede linkagem múltipla do mesmo pacote
alter table donation_packages
  add constraint unique_package_per_donation unique(package_id);

-- 5) RLS para restaurante

-- items
alter table items enable row level security;
create policy items_owner on items
  for all using (
    exists (
      select 1 from restaurants r
      where r.id = items.restaurant_id
        and r.user_id = auth.uid()
    )
  );

-- packages
alter table packages enable row level security;
create policy packages_owner on packages
  for all using (
    exists (
      select 1 from items i
      join restaurants r on i.restaurant_id = r.id
      where i.id = packages.item_id
        and r.user_id = auth.uid()
    )
  );

-- donations
alter table donations enable row level security;

-- SELECT
create policy donations_owner on donations
  for select using (
    exists (
      select 1 from restaurants r
      where r.id = donations.restaurant_id
        and r.user_id = auth.uid()
    )
  );

-- INSERT
create policy donations_insert on donations
  for insert with check (
    exists (
      select 1 from restaurants r
      where r.id = donations.restaurant_id
        and r.user_id = auth.uid()
    )
  );

-- UPDATE (todas as colunas) apenas pelo restaurante dono
create policy donations_update_owner on donations
  for update using (
    exists (
      select 1 from restaurants r
      where r.id = donations.restaurant_id
        and r.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from restaurants r
      where r.id = donations.restaurant_id
        and r.user_id = auth.uid()
    )
  );
