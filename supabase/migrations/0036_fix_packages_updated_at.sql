-- 0036_fix_packages_updated_at.sql
-- Remove writes to packages.updated_at (column does not exist)

-- Recreate only the affected functions
drop function if exists public.discard_expired_instock_packages() cascade;
drop function if exists public.deny_donations_past_pickup_deadline() cascade;
drop function if exists public.expire_and_reroute(text) cascade;

-- A) expire_and_reroute (no write to packages.updated_at)
create or replace function public.expire_and_reroute(p_security_code text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now           timestamptz := now();
  v_donation_id   uuid;
  v_restaurant_id uuid;
  v_old_osc_id    uuid;
  v_new_osc_id    uuid;
  v_new_code      text;

  v_base_url   text := public.app_get_setting('functions_base_url');
  v_internal   text := public.app_get_setting('functions_internal_key');
  v_resp       record;
begin
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

  update public.donation_intents
     set status = 'expired', updated_at = v_now
   where donation_id = v_donation_id
     and security_code = p_security_code
     and status = 'waiting_response';

  select o.id
    into v_new_osc_id
  from public.partnerships pr
  join public.osc o on o.id = pr.osc_id
  where pr.restaurant_id = v_restaurant_id
    and o.status = 'active'
    and o.id <> v_old_osc_id
    and not exists (
      select 1
      from public.donation_intents di2
      where di2.donation_id = v_donation_id
        and di2.osc_id = o.id
        and di2.status in ('denied','expired')
    )
  order by pr.is_favorite desc, o.last_received_at nulls first
  limit 1;

  if v_new_osc_id is null then
    -- No candidates → deny donation and safely release packages
    update public.donations
       set status = 'denied'
     where id = v_donation_id
       and status = 'pending';

    update public.donation_packages
       set unlinked_at = v_now
     where donation_id = v_donation_id
       and unlinked_at is null;

    -- Restock only if package is no longer linked anywhere; do NOT touch updated_at
    update public.packages p
       set status = 'in_stock'
     where exists (
             select 1
               from public.donation_packages dp
              where dp.donation_id = v_donation_id
                and dp.package_id = p.id
           )
       and not exists (
             select 1
               from public.donation_packages dp2
              where dp2.package_id = p.id
                and dp2.unlinked_at is null
           );

    update public.donation_intents
       set status = 're_routed', updated_at = v_now
     where donation_id = v_donation_id
       and status = 'waiting_response';

    raise notice 'expire_and_reroute: donation % denied (no alternate OSC).', v_donation_id;
    return;
  end if;

  v_new_code := substring(gen_random_uuid()::text, 1, 6);

  update public.donations
     set osc_id = v_new_osc_id,
         security_code = v_new_code
   where id = v_donation_id;

  insert into public.donation_intents
         (donation_id, osc_id, security_code, status, created_at, expires_at)
  values (v_donation_id, v_new_osc_id, v_new_code, 'waiting_response', v_now, v_now + interval '2 days');

  if coalesce(v_base_url, '') <> '' and coalesce(v_internal, '') <> '' then
    select *
      into v_resp
      from net.http_post(
        url     := v_base_url || '/functions/v1/util_send_notifications',
        headers := jsonb_build_object(
                     'Content-Type','application/json',
                     'x-internal-key', v_internal
                   ),
        body    := jsonb_build_object('security_code', v_new_code)::text
      );
  end if;

  raise notice 'expire_and_reroute: donation % re-routed to OSC %, new code %.', v_donation_id, v_new_osc_id, v_new_code;
end;
$$;

comment on function public.expire_and_reroute(text)
  is 'Expires a waiting intent, attempts Plan B; if none, denies donation and restocks packages.';

-- B) deny_donations_past_pickup_deadline (no write to packages.updated_at)
create or replace function public.deny_donations_past_pickup_deadline()
returns table(donations_denied integer, packages_released integer)
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_ids uuid[];
  v_released integer := 0;
begin
  with updated as (
    update public.donations d
       set status = 'denied'
     where d.status = 'accepted'
       and d.pickup_deadline_at is not null
       and d.pickup_deadline_at < v_now
     returning d.id
  )
  select coalesce(array_agg(id), '{}') into v_ids from updated;

  donations_denied := coalesce(array_length(v_ids, 1), 0);

  if donations_denied = 0 then
    packages_released := 0;
    raise notice 'Cron deny-pickup-deadlines: 0 denied / 0 released.';
    return next;
    return;
  end if;

  update public.donation_packages
     set unlinked_at = v_now
   where donation_id = any (v_ids)
     and unlinked_at is null;

  update public.packages p
     set status = 'in_stock'
   where exists (
           select 1
             from public.donation_packages dp
            where dp.donation_id = any (v_ids)
              and dp.package_id = p.id
         )
     and not exists (
           select 1
             from public.donation_packages dp2
            where dp2.package_id = p.id
              and dp2.unlinked_at is null
         );

  get diagnostics v_released = row_count;
  packages_released := v_released;

  raise notice 'Cron deny-pickup-deadlines: % denied / % packages released.', donations_denied, packages_released;
  return next;
end;
$$;

comment on function public.deny_donations_past_pickup_deadline()
  is 'Denies donations past pickup_deadline_at; unlinks and restocks packages.';

-- C) discard_expired_instock_packages (no write to packages.updated_at)
create or replace function public.discard_expired_instock_packages()
returns integer
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_count integer;
begin
  update public.packages p
     set status = 'discarded'
   where p.status = 'in_stock'
     and p.expires_at is not null
     and p.expires_at < v_now;

  get diagnostics v_count = row_count;
  raise notice 'Cron discard-expired-packages: % packages discarded.', v_count;
  return v_count;
end;
$$;

comment on function public.discard_expired_instock_packages()
  is 'Marks packages discarded when past expires_at and status is in_stock.';

-- Re-grant executes
grant execute on function
  public.expire_and_reroute(text),
  public.deny_donations_past_pickup_deadline(),
  public.discard_expired_instock_packages()
to anon, authenticated, service_role;
