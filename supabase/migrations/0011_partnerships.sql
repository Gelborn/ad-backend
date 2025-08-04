-- 0011_partnerships.sql
-- Cria a relação de parcerias e a função de matching

------------------------------------------------------------------
-- 1)  Tabela de Parcerias  (um restaurante ↔ muitas OSCs)
------------------------------------------------------------------
create table partnerships (
  restaurant_id uuid references restaurants(id) on delete cascade,
  osc_id        uuid references osc(id)         on delete cascade,
  is_favorite   boolean default false,
  created_at    timestamptz default now(),
  primary key (restaurant_id, osc_id)
);

-- Só um favorito por restaurante
create unique index one_favorite_per_restaurant
  on partnerships (restaurant_id)
  where is_favorite;

------------------------------------------------------------------
-- 2)  Row-Level Security  (apenas CF Admin)
------------------------------------------------------------------
alter table partnerships enable row level security;

create policy cf_partnerships_full
  on partnerships
  for all
  using  (public.is_cf())
  with check (public.is_cf());

------------------------------------------------------------------
-- 3)  Função match_oscs  (retorna OSCs dentro do raio + score)
------------------------------------------------------------------
create or replace function match_oscs(
    p_restaurant   uuid,
    p_radius_km    numeric
)
returns table (
  osc_id      uuid,
  distance_km numeric,
  accepted_30 integer,
  denied_30   integer,
  score       numeric
)
language sql
stable
as $$
with r as (
  select lat, lng
  from   restaurants
  where  id = p_restaurant
),
cand as (
  /* Haversine distance (terra ~6371 km) */
  select
    o.id,
    2*6371*asin(
      sqrt(
        power(sin(radians(o.lat - r.lat)/2),2) +
        cos(radians(r.lat)) * cos(radians(o.lat)) *
        power(sin(radians(o.lng - r.lng)/2),2)
      )
    ) as dist_km
  from osc o, r
),
filt as (
  select *
  from   cand
  where  dist_km <= p_radius_km
),
stats as (
  select
    o.id                                               as osc_id,
    f.dist_km                                          as distance_km,
    count(*) filter (
      where d.status = 'accepted'
        and d.created_at >= now() - interval '30 days'
    )                                                  as accepted_30,
    count(*) filter (
      where d.status = 'denied'
        and d.created_at >= now() - interval '30 days'
    )                                                  as denied_30
  from filt f
  join osc o          on o.id = f.id
  left join donations d on d.osc_id = o.id
  group by o.id, f.dist_km
)
select *,
       -- Score: 0-100 (quanto +, melhor)
       greatest(
         0,
         100
         - (distance_km / p_radius_km) * 40        -- penaliza distância (máx-40)
         + least(accepted_30,10) * 4               -- recompensa atividade (+4 cada aceitação, máx-40)
         - least(denied_30,10)   * 2               -- penaliza negações (-2 cada, máx-20)
       )::numeric(5,1) as score
from stats
order by score desc;
$$;
