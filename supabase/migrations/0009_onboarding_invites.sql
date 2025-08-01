------------------------------------------------------------------
-- 0)  PRÉ-REQ.: já existe public.is_cf() e enum status_type
------------------------------------------------------------------

------------------------------------------------------------------
-- 1)  Enum status_type ganha o estágio “invite_sent”
------------------------------------------------------------------
alter type status_type add value if not exists 'invite_sent';

------------------------------------------------------------------
-- 2)  Pivôs de relacionamento (muitos donos se quiser)
------------------------------------------------------------------
create table restaurant_users (
  user_id       uuid references auth.users(id) on delete cascade,
  restaurant_id uuid references restaurants(id) on delete cascade,
  role          text not null default 'owner',
  added_at      timestamptz default now(),
  primary key (user_id, restaurant_id)
);

create table osc_users (
  user_id  uuid references auth.users(id) on delete cascade,
  osc_id   uuid references osc(id) on delete cascade,
  role     text not null default 'owner',
  added_at timestamptz default now(),
  primary key (user_id, osc_id)
);

------------------------------------------------------------------
-- 3)  RLS - donos veem só o que é deles (CF continua super-admin)
------------------------------------------------------------------
create policy sel_restaurants_owner on restaurants
for select using (
  public.is_cf() OR
  exists(select 1 from restaurant_users ru
         where ru.restaurant_id = id and ru.user_id = auth.uid())
);

create policy sel_osc_owner on osc
for select using (
  public.is_cf() OR
  exists(select 1 from osc_users ou
         where ou.osc_id = id and ou.user_id = auth.uid())
);

alter table restaurant_users enable row level security;
create policy own_ru on restaurant_users
  for all using (public.is_cf() OR user_id = auth.uid());

alter table osc_users enable row level security;
create policy own_ou on osc_users
  for all using (public.is_cf() OR user_id = auth.uid());

------------------------------------------------------------------
-- 4)  RPC que ativa restaurantes quando o dono confirma e-mail
------------------------------------------------------------------
create or replace function activate_restaurants_by_owner(p_user_id uuid)
returns json language plpgsql as $$
declare
  updated json;
begin
  update restaurants r
     set status = 'active'
   where status = 'invite_sent'
     and exists(select 1 from restaurant_users ru
                where ru.restaurant_id = r.id
                  and ru.user_id = p_user_id)
  returning json_agg(r.*) into updated;

  return coalesce(updated, '[]'::json);
end;
$$;
