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

-- Persistent Voxely Groups and their forum conversations.
-- These tables are written by the game server with SUPABASE_SECRET_KEY only.
create table if not exists public.groups (
  id          text primary key,
  name        text not null,
  description text not null default '',
  color       text not null default '#1463ff',
  icon        text not null default '',
  owner_uid   text,
  owner_name  text,
  created_at  timestamptz not null default now()
);
create unique index if not exists groups_name_lower_unique on public.groups (lower(name));

create table if not exists public.group_members (
  group_id    text not null references public.groups(id) on delete cascade,
  user_uid    text not null,
  user_name   text not null,
  role        text not null check (role in ('owner', 'member')),
  joined_at   timestamptz not null default now(),
  primary key (group_id, user_uid)
);

create table if not exists public.group_threads (
  id          text primary key,
  group_id    text not null references public.groups(id) on delete cascade,
  title       text not null,
  body        text not null,
  author_uid  text not null,
  author_name text not null,
  views       integer not null default 0 check (views >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists group_threads_group_updated_idx on public.group_threads (group_id, updated_at desc);

create table if not exists public.group_posts (
  id          text primary key,
  thread_id   text not null references public.group_threads(id) on delete cascade,
  author_uid  text not null,
  author_name text not null,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists group_posts_thread_created_idx on public.group_posts (thread_id, created_at);

alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_threads enable row level security;
alter table public.group_posts enable row level security;

