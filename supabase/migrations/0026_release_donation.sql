-- RPC: donation_mark_picked_up(p_security_code)
-- Atomically marks donation as picked_up, delivers packages, bumps OSC last_received_at.
-- Preconditions:
--   - donation_intent.status = 'accepted'
--   - donations.status       = 'accepted'
-- Errors:
--   - INTENT_NOT_FOUND
--   - WRONG_STATUS

create or replace function public.donation_mark_picked_up(p_security_code text)
returns table (
  donation_id   uuid,
  restaurant_id uuid,
  osc_id        uuid,
  created_at    timestamptz,
  released_at   timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_donation_id   uuid;
  v_restaurant_id uuid;
  v_osc_id        uuid;
  v_created_at    timestamptz;
  v_released_at   timestamptz;
begin
  -- 1) Lock the accepted intent + donation
  --    We require the pair (intent.accepted + donation.accepted) before pickup.
  with x as (
    select di.id as intent_id,
           di.osc_id,
           d.id  as donation_id,
           d.restaurant_id,
           d.created_at,
           d.released_at
    from public.donation_intents di
    join public.donations d on d.id = di.donation_id
    where di.security_code = p_security_code
    for update of di, d
  )
  select donation_id, restaurant_id, osc_id, created_at, released_at
    into v_donation_id, v_restaurant_id, v_osc_id, v_created_at, v_released_at
  from x;

  if not found then
    raise exception 'INTENT_NOT_FOUND';
  end if;

  -- Verify statuses atomically
  perform 1
    from public.donation_intents di
    join public.donations d on d.id = di.donation_id
   where di.security_code = p_security_code
     and di.status  = 'accepted'
     and d.status   = 'accepted';

  if not found then
    raise exception 'WRONG_STATUS';
  end if;

  -- 2) Update donation → picked_up (+timestamp)
  update public.donations
     set status = 'picked_up',
         picked_up_at = now()
   where id = v_donation_id
     and status = 'accepted';

  if not found then
    -- Someone changed state under our feet
    raise exception 'WRONG_STATUS';
  end if;

  -- 3) Packages → donated (final)
  update public.packages p
     set status = 'donated'
    from public.donation_packages dp
   where dp.donation_id = v_donation_id
     and dp.package_id = p.id;

  -- 4) Touch intent.updated_at (status already 'accepted' by flow)
  update public.donation_intents
     set updated_at = now()
   where donation_id = v_donation_id
     and security_code = p_security_code;

  -- 5) OSC last_received_at → now (keeps prioritization fresh)
  update public.osc
     set last_received_at = now()
   where id = v_osc_id;

  -- 6) Return the core identifiers for the API to enrich response
  return query
    select v_donation_id, v_restaurant_id, v_osc_id, v_created_at, v_released_at;
end;
$$;
