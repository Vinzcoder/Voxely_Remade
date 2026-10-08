-- Voxely: persistent user-made games (run once in Supabase -> SQL Editor)
create table if not exists public.games (
  id          text primary key,
  owner_uid   text not null,
  owner_name  text,
  data        jsonb not null,          -- title, tagline, desc, tags, sky, art, spawn, boxes
  thumb_type  text,
  thumb_b64   text,
  thumb_v     bigint not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- Only the game server (secret key) may touch this table: RLS on, no public policies.
alter table public.games enable row level security;
