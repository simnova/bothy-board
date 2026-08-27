-- Unique handles and time-limited, recipient-bound workspace invites

create table if not exists profiles (
  user_id text primary key,
  handle text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists profiles_handle_idx on profiles (handle);

create table if not exists user_prefs (
  user_id text primary key,
  active_workspace_id text references workspaces(id) on delete set null
);

create table if not exists workspace_invites (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  invited_by_user_id text not null,
  recipient_handle text not null,
  token text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  declined_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists workspace_invites_recipient_idx on workspace_invites (recipient_handle);
create index if not exists workspace_invites_ws_idx on workspace_invites (workspace_id);
