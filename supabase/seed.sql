-- supabase/seed/seed.sql

delete from donation_packages;
delete from donations;
delete from packages;
delete from items;
delete from restaurants;
delete from osc;

insert into osc(id, name, phone, address, lat, lng, active) values
  (
    '22222222-2222-2222-2222-222222222222',
    'OSC Demo',
    '+55 11 90000‑0000',
    'Rua das Flores, 123, Centro',
    -23.5895,
    -46.6168,
    true
  );