-- 0014_admin_dashboard_views.sql
-- Views para o dashboard do Admin
--  - v_admin_counters          → números dos cards
--  - v_admin_recent_activity   → feed dos últimos 7 dias

/* ------------------------------------------------------------------
   View 1 — Contadores
------------------------------------------------------------------*/
create or replace view v_admin_counters as
select
  (select count(*) from restaurants)  as total_restaurants,
  (select count(*) from osc)          as total_oscs,
  (select count(*) from partnerships) as total_partnerships;

/* ------------------------------------------------------------------
   View 2 — Feed de atividades (últimos 7 dias)
------------------------------------------------------------------*/
create or replace view v_admin_recent_activity as

/* 1) Novas parcerias ------------------------------------------------ */
select
  p.created_at                                                 as event_at,
  'new_partnership'                                            as event_type,
  format(
    '🆕 Parceria criada: restaurante "%s" ↔ OSC "%s"',
    r.name, o.name
  )                                                            as description
from partnerships p
join restaurants r on r.id = p.restaurant_id
join osc         o on o.id = p.osc_id
where p.created_at >= now() - interval '7 days'

union all

/* 2) Doações aceitas ----------------------------------------------- */
select
  d.accepted_at                                                as event_at,
  'donation_accepted'                                          as event_type,
  format(
    '✅ Doação %s aceita pela OSC "%s"',
    left(d.id::text, 8), o.name
  )                                                            as description
from donations d
join osc o on o.id = d.osc_id
where d.status = 'accepted'
  and d.accepted_at >= now() - interval '7 days'

union all

/* 3) Doações negadas ----------------------------------------------- */
select
  d.accepted_at                                                as event_at,
  'donation_denied'                                            as event_type,
  format(
    '❌ Doação %s negada pela OSC "%s"',
    left(d.id::text, 8), o.name
  )                                                            as description
from donations d
join osc o on o.id = d.osc_id
where d.status = 'denied'
  and d.accepted_at >= now() - interval '7 days'

union all

/* 4) Doações entregues --------------------------------------------- */
select
  d.picked_up_at                                               as event_at,
  'donation_picked_up'                                         as event_type,
  format(
    '📦 Doação %s entregue à OSC "%s"',
    left(d.id::text, 8), o.name
  )                                                            as description
from donations d
join osc o on o.id = d.osc_id
where d.status = 'picked_up'
  and d.picked_up_at >= now() - interval '7 days'

order by event_at desc;
