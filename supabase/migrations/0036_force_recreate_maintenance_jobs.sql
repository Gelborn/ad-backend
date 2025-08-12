-- 0036_force_recreate_maintenance_jobs.sql

-- Ensure required extensions are present (no-ops if already there)
create extension if not exists pgcrypto;
create extension if not exists pg_net;
create extension if not exists pg_cron with schema cron;

-- Drop first to force a net change
drop function if exists public.expire_and_reroute(text) cascade;
drop function if exists public.expire_waiting_donation_intents() cascade;
drop function if exists public.deny_donations_past_pickup_deadline() cascade;
drop function if exists public.discard_expired_instock_packages() cascade;
drop function if exists public.app_get_setting(text) cascade;

-- Recreate helper
create or replace function public.app_get_setting(p_name text)
returns text
language plpgsql
as $$
declare
  v_val text;
  has_vault boolean;
begin
  has_vault := to_regproc('vault.get_secret(text)') is not null;
  if has_vault then
    begin
      select vault.get_secret(p_name) into v_val;
      if v_val is not null and v_val <> '' then
        return v_val;
      end if;
    exception when others then
      v_val := null;
    end;
  end if;

  begin
    return current_setting('app.' || p_name, true);
  exception when others then
    return null;
  end;
end;
$$;

comment on function public.app_get_setting(text)
  is 'Returns a secret/config by trying Supabase Vault (vault.get_secret) first, else current_setting(app.*).';

-- A) expire_and_reroute
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
    update public.donations
       set status = 'denied',
           updated_at = v_now
     where id = v_donation_id
       and status = 'pending';

    update public.donation_packages
       set unlinked_at = v_now
     where donation_id = v_donation_id
       and unlinked_at is null;

    update public.packages p
       set status = 'in_stock',
           updated_at = v_now
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
end;
$$;

comment on function public.expire_and_reroute(text)
  is 'Expires a waiting intent, attempts Plan B and notifies. If none available → denies donation, unlinks, and restocks packages.';

-- B) batch
create or replace function public.expire_waiting_donation_intents()
returns integer
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_count integer := 0;
  r record;
begin
  for r in
    select di.security_code
      from public.donation_intents di
      join public.donations d on d.id = di.donation_id
     where di.status = 'waiting_response'
       and di.expires_at is not null
       and di.expires_at < v_now
       and d.status = 'pending'
  loop
    begin
      perform public.expire_and_reroute(r.security_code);
      v_count := v_count + 1;
    exception when others then
      continue;
    end;
  end loop;

  return v_count;
end;
$$;

comment on function public.expire_waiting_donation_intents()
  is 'Batch: finds overdue waiting intents and runs expire_and_reroute() for each. Returns count processed.';

-- C) deadlines
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
       set status = 'denied',
           updated_at = v_now
     where d.status = 'accepted'
       and d.pickup_deadline_at is not null
       and d.pickup_deadline_at < v_now
     returning d.id
  )
  select coalesce(array_agg(id), '{}') into v_ids from updated;

  donations_denied := coalesce(array_length(v_ids, 1), 0);

  if donations_denied = 0 then
    packages_released := 0;
    return next;
    return;
  end if;

  update public.donation_packages
     set unlinked_at = v_now
   where donation_id = any (v_ids)
     and unlinked_at is null;

  update public.packages p
     set status = 'in_stock',
         updated_at = v_now
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

  return next;
end;
$$;

comment on function public.deny_donations_past_pickup_deadline()
  is 'Sets donations to denied when past pickup_deadline_at; unlinks and safely restocks packages. Returns counts.';

-- D) discard expired in_stock packages
create or replace function public.discard_expired_instock_packages()
returns integer
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_count integer;
begin
  update public.packages p
     set status = 'discarded',
         updated_at = v_now
   where p.status = 'in_stock'
     and p.expires_at is not null
     and p.expires_at < v_now;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.discard_expired_instock_packages()
  is 'Marks packages as discarded when past expires_at AND status is in_stock. Returns rows affected.';

-- Explicit grants (safe even if redundant in your setup)
grant execute on function
  public.app_get_setting(text),
  public.expire_and_reroute(text),
  public.expire_waiting_donation_intents(),
  public.deny_donations_past_pickup_deadline(),
  public.discard_expired_instock_packages()
to anon, authenticated, service_role;

-- (Re)create helpful indexes (idempotent)
create index if not exists idx_donation_intents_status_expires
  on public.donation_intents (status, expires_at);
create index if not exists idx_donations_status_pickup_deadline
  on public.donations (status, pickup_deadline_at);
create index if not exists idx_packages_status_expires
  on public.packages (status, expires_at);

-- Set up cron jobs if extension is present; log what happened
do $$
declare
  has_cron boolean;
begin
  select exists (select 1 from pg_extension where extname='pg_cron') into has_cron;

  if not has_cron then
    raise notice 'pg_cron not available; skipping job setup.';
    return;
  end if;

  if not exists (select 1 from cron.job where jobname = 'expire-and-reroute-intents') then
    perform cron.schedule(
      'expire-and-reroute-intents',
      '*/5 * * * *',
      'select public.expire_waiting_donation_intents();'
    );
    raise notice 'Created cron job expire-and-reroute-intents.';
  else
    raise notice 'Cron job expire-and-reroute-intents already exists.';
  end if;

  if not exists (select 1 from cron.job where jobname = 'deny-pickup-deadlines') then
    perform cron.schedule(
      'deny-pickup-deadlines',
      '*/15 * * * *',
      'select * from public.deny_donations_past_pickup_deadline();'
    );
    raise notice 'Created cron job deny-pickup-deadlines.';
  else
    raise notice 'Cron job deny-pickup-deadlines already exists.';
  end if;

  if not exists (select 1 from cron.job where jobname = 'discard-expired-packages-hourly') then
    perform cron.schedule(
      'discard-expired-packages-hourly',
      '0 * * * *',
      'select public.discard_expired_instock_packages();'
    );
    raise notice 'Created cron job discard-expired-packages-hourly.';
  else
    raise notice 'Cron job discard-expired-packages-hourly already exists.';
  end if;
end
$$;
