-- 0013_match_oscs_add_name.sql
-- Adiciona osc_name ao retorno da função match_oscs

--------------------------------------------------------------
-- 1) Remove a versão antiga
--------------------------------------------------------------
drop function if exists match_oscs(uuid, numeric);

--------------------------------------------------------------
-- 2) Cria a nova versão (com osc_name)
--------------------------------------------------------------
create function match_oscs(
    p_restaurant uuid,
    p_radius_km  numeric
)
returns table (
  osc_id      uuid,
  osc_name    text,
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
  select
    o.id,
    o.name,
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
    o.id   as osc_id,
    o.name as osc_name,
    f.dist_km  as distance_km,          -- 🆕 alias correto
    count(*) filter (
      where d.status = 'accepted'
        and d.created_at >= now() - interval '30 days'
    ) as accepted_30,
    count(*) filter (
      where d.status = 'denied'
        and d.created_at >= now() - interval '30 days'
    ) as denied_30
  from filt f
  join osc o          on o.id = f.id
  left join donations d on d.osc_id = o.id
  group by o.id, o.name, f.dist_km
)
select *,
       greatest(
         0,
         100
         - (distance_km / p_radius_km) * 40
         + least(accepted_30,10) * 4
         - least(denied_30,10)   * 2
       )::numeric(5,1) as score
from stats
order by score desc;
$$;
