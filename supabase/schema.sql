create table if not exists public.rooms (
  code text primary key,
  status text not null check (status in ('waiting', 'ready', 'playing', 'finished')),
  mode text not null check (mode in ('easy', 'medium', 'hard')),
  host_id text not null,
  players jsonb not null default '[]'::jsonb,
  letters text[] not null default '{}'::text[],
  start_time bigint null,
  duration_sec integer not null default 60,
  all_valid_words text[] not null default '{}'::text[],
  found_global_words text[] not null default '{}'::text[],
  disconnect_grace_ends_at bigint null,
  last_end_reason text null check (last_end_reason in ('time_up', 'all_words_found', 'disconnect_timeout')),
  created_at bigint not null,
  updated_at bigint not null
);

create index if not exists rooms_updated_at_idx on public.rooms (updated_at);
