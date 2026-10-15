-- MCP Events subscriptions (poll delivery). Additive. Does not rewrite tasks.

create table if not exists mcp_event_subscriptions (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  actor_key text not null,
  name text not null,
  arguments jsonb not null default '{}'::jsonb,
  cursor text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists mcp_event_subs_key
  on mcp_event_subscriptions (workspace_id, actor_key, name, arguments);

create index if not exists mcp_event_subs_exp_idx
  on mcp_event_subscriptions (expires_at);

create index if not exists comments_ws_created_idx
  on comments (workspace_id, created_at, id);
