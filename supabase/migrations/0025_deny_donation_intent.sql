-- RPC: osc_deny_and_reroute(p_security_code)
-- Denies the current intent and (if possible) re-routes to another OSC with a new code.
create or replace function public.osc_deny_and_reroute(p_security_code text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_donation_id   uuid;
  v_restaurant_id uuid;
  v_old_osc_id    uuid;
  v_new_osc_id    uuid;
  v_new_code      text;
begin
  -- 1) Find the open intent by code and its donation (must be pending)
  select di.donation_id, d.restaurant_id, di.osc_id
    into v_donation_id, v_restaurant_id, v_old_osc_id
  from public.donation_intents di
  join public.donations d on d.id = di.donation_id
  where di.security_code = p_security_code
    and di.status = 'waiting_response'
    and d.status = 'pending'
  limit 1;

  if not found then
    raise exception 'DONATION_NOT_FOUND_OR_NOT_PENDING';
  end if;

  -- 2) Deny current intent
  update public.donation_intents
     set status = 'denied', updated_at = now()
   where donation_id = v_donation_id
     and security_code = p_security_code
     and status = 'waiting_response';

  -- 3) Try to choose another OSC for the same restaurant, skipping those that already denied/expired
  select o.id
    into v_new_osc_id
  from public.partnerships pr
  join public.osc o on o.id = pr.osc_id
  where pr.restaurant_id = v_restaurant_id
    and o.status = 'active'
    and o.id <> v_old_osc_id
    and o.id not in (
      select di2.osc_id
      from public.donation_intents di2
      where di2.donation_id = v_donation_id
        and di2.status in ('denied','expired')
    )
  order by pr.is_favorite desc, o.last_received_at nulls first
  limit 1;

  if v_new_osc_id is null then
    -- 3b) No OSC available → donation fails and packages back to stock
    update public.donations
       set status = 'denied'
     where id = v_donation_id;

    update public.packages p
       set status = 'in_stock'
      from public.donation_packages dp
     where dp.donation_id = v_donation_id
       and dp.package_id = p.id;

    return;
  end if;

  -- 4) Re-route:
  v_new_code := substring(gen_random_uuid()::text, 1, 6);

  -- 4a) Update legacy fields on donations (back-compat for existing UI)
  update public.donations
     set osc_id = v_new_osc_id,
         security_code = v_new_code
   where id = v_donation_id;

  -- 4b) Insert new intent with SLA 2 days
  insert into public.donation_intents (donation_id, osc_id, security_code, status, created_at, expires_at)
  values (v_donation_id, v_new_osc_id, v_new_code, 'waiting_response', now(), now() + interval '2 days');

end;
$$;
