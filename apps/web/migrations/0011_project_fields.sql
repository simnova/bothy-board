-- Per-project configurable fields (GitHub Projects-style).
-- Values live on the task; schema lives on the project.

alter table tasks add column if not exists fields jsonb not null default '{}'::jsonb;

create table if not exists project_fields (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  key text not null,
  name text not null,
  type text not null default 'text',
  description text not null default '',
  required boolean not null default false,
  plant_required boolean not null default false,
  dump_in_body boolean not null default true,
  source text not null default 'value',
  pattern text,
  required_when jsonb,
  options jsonb not null default '[]'::jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (project_id, key)
);
create index if not exists project_fields_prj_idx on project_fields (project_id, sort_order);
