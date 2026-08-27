-- Soft-delete with timed purge. Live queries filter deleted_at is null.

alter table tasks add column if not exists deleted_at timestamptz;
alter table tasks add column if not exists deleted_by text;
alter table tasks add column if not exists purge_after timestamptz;
create index if not exists tasks_deleted_idx on tasks (workspace_id, deleted_at);
create index if not exists tasks_purge_idx on tasks (purge_after);

alter table projects add column if not exists deleted_at timestamptz;
alter table projects add column if not exists deleted_by text;
alter table projects add column if not exists purge_after timestamptz;
create index if not exists projects_deleted_idx on projects (workspace_id, deleted_at);
