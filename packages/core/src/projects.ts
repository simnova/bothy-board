import { getSql, type Sql } from "@bothy-board/db";
import { makeId } from "./ids";
import { bumpRevision } from "./workspace";

export type ProjectVisibility = "private" | "public";
export type ProjectRole = "owner" | "member";

export type ProjectInfo = {
  id: string;
  workspaceId: string;
  name: string;
  repo: string;
  defaultBranch: string;
  visibility: ProjectVisibility;
};

export async function primaryProject(workspaceId: string): Promise<ProjectInfo | null> {
  const sql = await getSql();
  return loadPrimary(sql, workspaceId);
}

async function loadPrimary(sql: Sql, workspaceId: string): Promise<ProjectInfo | null> {
  const rows = await sql<{
    id: string;
    workspace_id: string;
    name: string;
    repo: string;
    default_branch: string;
    visibility: string;
  }>`
    select id, workspace_id, name, repo, default_branch, visibility
    from projects where workspace_id = ${workspaceId} and deleted_at is null
    order by created_at asc limit 1`;
  const p = rows[0];
  if (!p) return null;
  return {
    id: p.id,
    workspaceId: p.workspace_id,
    name: p.name,
    repo: p.repo,
    defaultBranch: p.default_branch,
    visibility: p.visibility === "public" ? "public" : "private",
  };
}

export async function listUserProjects(
  workspaceId: string,
  userId: string,
): Promise<(ProjectInfo & { role: ProjectRole })[]> {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    workspace_id: string;
    name: string;
    repo: string;
    default_branch: string;
    visibility: string;
    role: string;
  }>`
    select p.id, p.workspace_id, p.name, p.repo, p.default_branch, p.visibility, m.role
    from project_members m
    join projects p on p.id = m.project_id
    where p.workspace_id = ${workspaceId} and m.user_id = ${userId} and p.deleted_at is null
    order by p.created_at asc`;
  return rows.map((p) => ({
    id: p.id,
    workspaceId: p.workspace_id,
    name: p.name,
    repo: p.repo,
    defaultBranch: p.default_branch,
    visibility: p.visibility === "public" ? "public" : "private",
    role: p.role === "owner" ? "owner" : "member",
  }));
}

export async function projectById(projectId: string): Promise<ProjectInfo | null> {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    workspace_id: string;
    name: string;
    repo: string;
    default_branch: string;
    visibility: string;
  }>`
    select id, workspace_id, name, repo, default_branch, visibility
    from projects where id = ${projectId} and deleted_at is null limit 1`;
  const p = rows[0];
  if (!p) return null;
  return {
    id: p.id,
    workspaceId: p.workspace_id,
    name: p.name,
    repo: p.repo,
    defaultBranch: p.default_branch,
    visibility: p.visibility === "public" ? "public" : "private",
  };
}

export async function projectRole(projectId: string, userId: string): Promise<ProjectRole | null> {
  const sql = await getSql();
  const rows = await sql<{ role: string }>`
    select role from project_members where project_id = ${projectId} and user_id = ${userId}`;
  const r = rows[0]?.role;
  return r === "owner" || r === "member" ? r : null;
}

export async function requireProjectRole(
  workspaceId: string,
  userId: string,
): Promise<{ project: ProjectInfo; role: ProjectRole }> {
  const project = await primaryProject(workspaceId);
  if (!project) throw new Error("This board has no project.");
  const role = await projectRole(project.id, userId);
  if (!role) throw new Error("You are not a member of this project.");
  return { project, role };
}

export async function requireOwner(workspaceId: string, userId: string): Promise<ProjectInfo> {
  const { project, role } = await requireProjectRole(workspaceId, userId);
  if (role !== "owner") throw new Error("Only a project owner can do that.");
  return project;
}

export async function addProjectMember(projectId: string, userId: string, role: ProjectRole) {
  const sql = await getSql();
  await sql`insert into project_members (project_id, user_id, role)
    values (${projectId}, ${userId}, ${role})
    on conflict (project_id, user_id) do nothing`;
}

export async function addMemberToWorkspaceProjects(
  sql: Sql,
  workspaceId: string,
  userId: string,
  role: ProjectRole,
) {
  const projects = await sql<{
    id: string;
  }>`select id from projects where workspace_id = ${workspaceId}`;
  for (const p of projects) {
    await sql`insert into project_members (project_id, user_id, role)
      values (${p.id}, ${userId}, ${role})
      on conflict (project_id, user_id) do nothing`;
  }
}

export async function setProjectVisibility(
  workspaceId: string,
  userId: string,
  visibility: ProjectVisibility,
) {
  if (visibility !== "public" && visibility !== "private")
    throw new Error("Visibility must be public or private.");
  const project = await requireOwner(workspaceId, userId);
  const sql = await getSql();
  await sql`update projects set visibility = ${visibility} where id = ${project.id}`;
  await bumpRevision(sql, workspaceId);
  return { ...project, visibility };
}

export async function deleteProject(workspaceId: string, userId: string) {
  const { softDeleteProject } = await import("./trash");
  return softDeleteProject(workspaceId, userId);
}

export async function createProject(
  workspaceId: string,
  userId: string,
  input: { name: string; repo?: string },
) {
  const existing = await primaryProject(workspaceId);
  if (existing)
    throw new Error(
      "This board already has a project. Move it to trash first if you want to replace it.",
    );
  const sql = await getSql();
  const member = await sql<{ role: string }>`
    select role from workspace_members where workspace_id = ${workspaceId} and user_id = ${userId}`;
  if (!member[0]) throw new Error("You are not a member of this workspace.");
  if (member[0].role !== "owner")
    throw new Error("Only a workspace owner can create a project on this board.");
  const name = input.name.trim();
  if (!name) throw new Error("Project name is required.");
  const id = makeId("prj");
  await sql`insert into projects (id, workspace_id, name, repo, default_branch, visibility)
    values (${id}, ${workspaceId}, ${name}, ${input.repo?.trim() ?? ""}, ${"main"}, ${"private"})`;
  await sql`insert into project_members (project_id, user_id, role)
    values (${id}, ${userId}, ${"owner"})`;
  const others = await sql<{ user_id: string }>`
    select user_id from workspace_members where workspace_id = ${workspaceId} and user_id <> ${userId}`;
  for (const o of others) {
    await sql`insert into project_members (project_id, user_id, role)
      values (${id}, ${o.user_id}, ${"member"})
      on conflict (project_id, user_id) do nothing`;
  }
  await bumpRevision(sql, workspaceId);
  return { id, name, visibility: "private" as const, myRole: "owner" as const };
}

export async function publicProjectCard(projectId: string, viewerUserId: string | null) {
  const project = await projectById(projectId);
  if (!project) return null;
  const sql = await getSql();
  const role = viewerUserId ? await projectRole(project.id, viewerUserId) : null;
  if (project.visibility === "private" && !role) return null;
  const owner = await sql<{ handle: string }>`
    select coalesce(p.handle, 'owner') as handle
    from project_members m
    left join profiles p on p.user_id = m.user_id
    where m.project_id = ${project.id} and m.role = 'owner'
    order by m.created_at asc limit 1`;
  return {
    id: project.id,
    name: project.name,
    repo: project.repo,
    visibility: project.visibility,
    ownerHandle: owner[0]?.handle ?? "owner",
    isMember: Boolean(role),
    myRole: role,
  };
}
