-- Factory dequeue: orthogonal factory lifecycle + card contract fields.
-- Destructive-ok: no customer data to preserve.

alter table tasks add column if not exists factory text not null default 'Idle';
alter table tasks add column if not exists lane text;
alter table tasks add column if not exists write_roots jsonb not null default '[]'::jsonb;
alter table tasks add column if not exists objective text not null default '';
alter table tasks add column if not exists done_when jsonb not null default '[]'::jsonb;
alter table tasks add column if not exists out_of_scope text not null default '';
alter table tasks add column if not exists known_good text not null default '';
alter table tasks add column if not exists failed_treatments jsonb not null default '[]'::jsonb;
alter table tasks add column if not exists not_tested text not null default '';
alter table tasks add column if not exists no_grade boolean not null default false;
alter table tasks add column if not exists proofs_ok boolean;
alter table tasks add column if not exists proofs_head_sha text;
alter table tasks add column if not exists proofs_report_path text;

create index if not exists tasks_factory_ready_idx
  on tasks (workspace_id, factory, status, priority, id)
  where deleted_at is null;

create index if not exists worktrees_path_machine_idx
  on worktrees (workspace_id, path, machine_name)
  where status = 'active';
