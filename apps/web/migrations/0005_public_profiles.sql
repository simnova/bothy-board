-- Public profiles (user-controlled visibility) and recipient user id on invites

alter table profiles add column if not exists display_name text not null default '';
alter table profiles add column if not exists bio text not null default '';
alter table profiles add column if not exists avatar_url text not null default '';
alter table profiles add column if not exists email text not null default '';
alter table profiles add column if not exists location text not null default '';
alter table profiles add column if not exists pub_display_name boolean not null default true;
alter table profiles add column if not exists pub_bio boolean not null default true;
alter table profiles add column if not exists pub_avatar boolean not null default true;
alter table profiles add column if not exists pub_email boolean not null default false;
alter table profiles add column if not exists pub_location boolean not null default false;
alter table profiles add column if not exists pub_boards boolean not null default false;
alter table profiles add column if not exists discoverable boolean not null default true;

alter table workspace_invites add column if not exists recipient_user_id text;
update workspace_invites i
  set recipient_user_id = p.user_id
  from profiles p
  where p.handle = i.recipient_handle and i.recipient_user_id is null;
create index if not exists workspace_invites_recipient_user_idx on workspace_invites (recipient_user_id);
