-- Grok Build session binding: dual IDs, machine affinity, mailbox is comments.since

alter table tasks add column if not exists grok_session_id text;
alter table tasks add column if not exists grok_subagent_id text;
alter table tasks add column if not exists affinity_user_id text;
alter table tasks add column if not exists affinity_machine_name text;

create index if not exists tasks_grok_session_idx
  on tasks (workspace_id, grok_session_id);

alter table comments add column if not exists grok_session_id text;
