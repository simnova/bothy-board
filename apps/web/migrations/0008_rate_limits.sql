-- Shared request quotas across Vercel isolates (Neon) and the preview process.
-- window_start is the epoch-ms bucket so a single PK upsert is the hot path.

create table if not exists rate_limits (
  bucket text not null,
  window_start bigint not null,
  hits integer not null default 0,
  primary key (bucket, window_start)
);
create index if not exists rate_limits_window_idx on rate_limits (window_start);
