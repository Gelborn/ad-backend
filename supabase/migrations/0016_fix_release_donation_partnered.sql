-- 20250806_fix_release_donation_partnered.sql

create or replace function public.release_donation_partnered(
  p_restaurant_id uuid
)
returns table(
  donation_id    uuid,
  security_code  text
)
language plpgsql
security definer
as $$
declare
  v_pkg record;
  v_partnership record;
  v_code text;
begin
  -- 1. Valida restaurante
  perform 1
    from restaurants
   where id = p_restaurant_id;
  if not found then
    raise exception 'RESTAURANT_NOT_FOUND';
  end if;

  -- 2. Pega primeiro pacote em estoque
  select id
    into v_pkg
    from packages
   where restaurant_id = p_restaurant_id
     and stock > 0
   order by created_at
   limit 1;
  if not found then
    raise exception 'NO_PACKAGES_IN_STOCK';
  end if;

  -- 3. Escolhe parceria ativa (favorita primeiro;
  --    entre as demais, quem recebeu há mais tempo)
  with last_don as (
    select
      p.osc_id,
      p.is_favorite,
      coalesce(max(d.created_at), '1970-01-01'::timestamp) as last_received
    from partnerships p
    left join donations d
      on d.restaurant_id = p.restaurant_id
     and d.osc_id        = p.osc_id
    where p.restaurant_id = p_restaurant_id
      and p.is_active
    group by p.osc_id, p.is_favorite
  )
  select osc_id
    into v_partnership
    from last_don
   order by
     case when is_favorite then 0 else 1 end,
     last_received asc
   limit 1;
  if not found then
    raise exception 'NO_PARTNERSHIPS';
  end if;

  -- 4. Decrementa estoque
  update packages
     set stock = stock - 1
   where id = v_pkg.id;

  -- 5. Gera código curto e insere doação
  v_code := split_part(gen_random_uuid()::text, '-', 1);

  insert into donations (
    restaurant_id,
    osc_id,
    package_id,
    security_code,
    created_at
  ) values (
    p_restaurant_id,
    v_partnership.osc_id,
    v_pkg.id,
    v_code,
    now()
  )
  returning id, security_code
  into donation_id, security_code;

  return next;
end;
$$;

-- 6. Permissões
grant execute on function public.release_donation_partnered(uuid) to anon, authenticated;
