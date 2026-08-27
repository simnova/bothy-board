-- Lattice: team coordination for parallel coding agents

create table if not exists workspaces (
  id text primary key,
  name text not null,
  owner_user_id text not null,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workspace_members (
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists workspace_members_user_idx on workspace_members (user_id);

create table if not exists projects (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  repo text not null default '',
  default_branch text not null default 'main',
  created_at timestamptz not null default now()
);
create index if not exists projects_ws_idx on projects (workspace_id);

create table if not exists agents (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  kind text not null default 'other',
  machine_name text not null default '',
  continuation_id text,
  current_task_id text,
  status text not null default 'idle',
  last_heartbeat timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists agents_ws_idx on agents (workspace_id);

create table if not exists tasks (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text not null,
  parent_id text,
  title text not null,
  body text not null default '',
  kind text not null default 'feature',
  status text not null default 'backlog',
  priority integer not null default 1,
  assignee_user_id text,
  assignee_agent_id text,
  continuation_id text,
  branch text,
  worktree_path text,
  integration_status text not null default 'none',
  blocked_reason text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tasks_ws_idx on tasks (workspace_id);
create index if not exists tasks_ws_status_idx on tasks (workspace_id, status);
create index if not exists tasks_parent_idx on tasks (parent_id);

create table if not exists worktrees (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text not null,
  agent_id text,
  task_id text,
  path text not null,
  branch text not null,
  machine_name text not null default '',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists worktrees_ws_idx on worktrees (workspace_id);

create table if not exists task_deps (
  workspace_id text not null,
  task_id text not null,
  depends_on_id text not null,
  primary key (task_id, depends_on_id)
);
create index if not exists task_deps_ws_idx on task_deps (workspace_id);
create index if not exists task_deps_on_idx on task_deps (depends_on_id);

create table if not exists comments (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  task_id text not null,
  author_kind text not null default 'user',
  author_user_id text,
  author_agent_id text,
  author_name text not null default '',
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists comments_task_idx on comments (task_id, created_at);

create table if not exists api_keys (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  key_prefix text not null,
  created_by_user_id text not null,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists api_keys_ws_idx on api_keys (workspace_id);

create table if not exists events (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  task_id text,
  agent_id text,
  kind text not null,
  message text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists events_ws_idx on events (workspace_id, created_at desc);
