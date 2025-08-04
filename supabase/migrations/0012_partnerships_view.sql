-- 0012_partnerships_view.sql
-- Índice extra + view resumida com lista de OSCs

------------------------------------------------------------------
-- 1)  Índice para acelerar look-ups por restaurante
------------------------------------------------------------------
create index if not exists partnerships_restaurant_idx
  on partnerships (restaurant_id);

------------------------------------------------------------------
-- 2)  View  v_restaurants_partners
--     • 1 linha por restaurante
--     • partners_list  = array JSON com id+name de todas as OSCs
--     • favorite_osc   = objeto JSON da favorita (ou NULL)
------------------------------------------------------------------
create or replace view v_restaurants_partners as
select
  r.*,

  /* JSON array: [{id,name}, …]  */
  (
    select jsonb_agg(
             jsonb_build_object('id', o.id, 'name', o.name)
             order by p.is_favorite desc               -- favorita vem 1ª
           )
    from partnerships p
    join osc o on o.id = p.osc_id
    where p.restaurant_id = r.id
  ) as partners_list,

  /* objeto da favorita ou NULL */
  (
    select jsonb_build_object('id', o.id, 'name', o.name)
    from partnerships p
    join osc o on o.id = p.osc_id
    where p.restaurant_id = r.id
      and p.is_favorite
    limit 1
  ) as favorite_osc

from restaurants r;
