-- 0038_refresh_v_restaurants_partners.sql
-- Re-expand r.* so new columns (cnpj, code) appear in the view.

create or replace view v_restaurants_partners as
select
  r.*,

  /* JSON array: [{id,name}, …]  */
  (
    select jsonb_agg(
             jsonb_build_object('id', o.id, 'name', o.name)
             order by p.is_favorite desc
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

from public.restaurants r;
