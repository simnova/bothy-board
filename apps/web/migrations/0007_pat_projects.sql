-- PATs can be granted to one or many projects

create table if not exists personal_access_token_projects (
  token_id text not null references personal_access_tokens(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  primary key (token_id, project_id)
);
create index if not exists pat_projects_project_idx on personal_access_token_projects (project_id);

insert into personal_access_token_projects (token_id, project_id)
select id, project_id from personal_access_tokens
where project_id is not null
on conflict (token_id, project_id) do nothing;
