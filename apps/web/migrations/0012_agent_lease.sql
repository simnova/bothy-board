-- Agent-first lease, proofs, and per-project concurrency caps.

alter table projects add column if not exists max_in_flight integer not null default 2;
alter table projects add column if not exists max_integrating integer not null default 1;

alter table tasks add column if not exists proofs_lines jsonb not null default '[]'::jsonb;
