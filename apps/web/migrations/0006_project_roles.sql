-- Per-project roles, visibility, and personal access tokens

alter table projects add column if not exists visibility text not null default 'private';

create table if not exists project_members (
  project_id text not null references projects(id) on delete cascade,
  user_id text not null,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index if not exists project_members_user_idx on project_members (user_id);

insert into project_members (project_id, user_id, role)
select p.id, w.owner_user_id, 'owner'
from projects p
join workspaces w on w.id = p.workspace_id
on conflict (project_id, user_id) do nothing;

insert into project_members (project_id, user_id, role)
select p.id, m.user_id,
  case when m.role = 'owner' then 'owner' else 'member' end
from projects p
join workspace_members m on m.workspace_id = p.workspace_id
on conflict (project_id, user_id) do nothing;

create table if not exists personal_access_tokens (
  id text primary key,
  user_id text not null,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text references projects(id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  key_prefix text not null,
  scopes text not null,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists pats_user_idx on personal_access_tokens (user_id);
create index if not exists pats_ws_idx on personal_access_tokens (workspace_id);
