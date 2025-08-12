-- 0012_partnership_distance.sql
-- Add distance_km to partnerships + backfill + keep in sync

BEGIN;

------------------------------------------------------------------
-- 0) Distance function (Haversine) — float8 overload
--    (keeps any existing numeric() version; no drops)
------------------------------------------------------------------
create or replace function public.calc_distance_km(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns double precision
language sql
stable
as $$
  select case
    when lat1 is null or lng1 is null or lat2 is null or lng2 is null then null
    else
      2*6371*asin(
        sqrt(
          power(sin(radians(lat2 - lat1)/2),2) +
          cos(radians(lat1)) * cos(radians(lat2)) *
          power(sin(radians(lng2 - lng1)/2),2)
        )
      )
  end
$$;

------------------------------------------------------------------
-- 1) New column + guardrails
------------------------------------------------------------------
alter table partnerships
  add column if not exists distance_km numeric(8,3);

-- add the non-negative check only if it doesn't exist yet
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'partnerships_distance_nonneg'
      and conrelid = 'public.partnerships'::regclass
  ) then
    alter table partnerships
      add constraint partnerships_distance_nonneg
      check (distance_km is null or distance_km >= 0);
  end if;
end$$;

create index if not exists partnerships_distance_idx
  on partnerships (distance_km);

------------------------------------------------------------------
-- 2) Backfill from current restaurant/osc coordinates
------------------------------------------------------------------
update partnerships p
set distance_km = public.calc_distance_km(r.lat, r.lng, o.lat, o.lng)
from restaurants r, osc o
where r.id = p.restaurant_id
  and o.id = p.osc_id;

------------------------------------------------------------------
-- 3) Trigger: set distance on INSERT/UPDATE to partnerships
------------------------------------------------------------------
create or replace function public.partnerships_set_distance()
returns trigger
language plpgsql
as $$
begin
  select public.calc_distance_km(r.lat, r.lng, o.lat, o.lng)
    into new.distance_km
  from restaurants r
  join osc o on o.id = new.osc_id
  where r.id = new.restaurant_id;

  return new;
end;
$$;

drop trigger if exists trg_partnerships_set_distance on partnerships;

create trigger trg_partnerships_set_distance
before insert or update of restaurant_id, osc_id
on partnerships
for each row
execute function public.partnerships_set_distance();

------------------------------------------------------------------
-- 4) Refresh distances when either side moves
------------------------------------------------------------------
create or replace function public.refresh_partnerships_distance_by_restaurant()
returns trigger
language plpgsql
as $$
begin
  if (coalesce(new.lat, old.lat) is distinct from old.lat)
     or (coalesce(new.lng, old.lng) is distinct from old.lng) then
    update partnerships p
       set distance_km = public.calc_distance_km(new.lat, new.lng, o.lat, o.lng)
      from osc o
     where p.restaurant_id = new.id
       and o.id = p.osc_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_refresh_partnerships_distance_restaurants on restaurants;

create trigger trg_refresh_partnerships_distance_restaurants
after update of lat, lng on restaurants
for each row
execute function public.refresh_partnerships_distance_by_restaurant();


create or replace function public.refresh_partnerships_distance_by_osc()
returns trigger
language plpgsql
as $$
begin
  if (coalesce(new.lat, old.lat) is distinct from old.lat)
     or (coalesce(new.lng, old.lng) is distinct from old.lng) then
    update partnerships p
       set distance_km = public.calc_distance_km(r.lat, r.lng, new.lat, new.lng)
      from restaurants r
     where p.osc_id = new.id
       and r.id = p.restaurant_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_refresh_partnerships_distance_osc on osc;

create trigger trg_refresh_partnerships_distance_osc
after update of lat, lng on osc
for each row
execute function public.refresh_partnerships_distance_by_osc();

COMMIT;
