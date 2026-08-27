import { getSql } from "@bothy-board/db";
import type { Actor } from "./actor";
import { hasScope } from "./actor";
import { makeId } from "./ids";
import { projectRole, requireOwner } from "./projects";
import { bumpRevision } from "./workspace";

/** Recover for a week, then hard-delete. Preview DBs reset on process restart anyway. */
export const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type TrashItem = {
  kind: "task" | "project";
  id: string;
  title: string;
  deletedAt: string;
  purgeAfter: string;
  deletedBy: string | null;
};

export function canDeleteTasks(actor: Actor): boolean {
  if (actor.type === "user") return true;
  if (actor.type === "pat") return hasScope(actor, "tasks:delete");
  return false;
}

export function canDeleteProject(actor: Actor): boolean {
  return actor.type === "user";
}

export function assertCanDeleteTasks(actor: Actor): void {
  if (!canDeleteTasks(actor)) {
    throw new Error(
      "This credential cannot delete tasks. Grant tasks:delete on a PAT, or delete from the board while signed in.",
    );
  }
}

export function assertCanDeleteProject(actor: Actor): void {
  if (!canDeleteProject(actor)) {
    throw new Error("Only a signed-in owner can delete a project.");
  }
}

function ttlIso(now = Date.now()): { deletedAt: string; purgeAfter: string } {
  return {
    deletedAt: new Date(now).toISOString(),
    purgeAfter: new Date(now + TRASH_TTL_MS).toISOString(),
  };
}

export async function softDeleteTask(
  workspaceId: string,
  taskId: string,
  actor: Actor,
): Promise<{ id: string; purgeAfter: string }> {
  assertCanDeleteTasks(actor);
  const sql = await getSql();
  const ttl = ttlIso();
  const deletedBy = actor.type === "agent" ? actor.keyId : actor.userId;
  const rows = await sql<{ id: string }>`
    update tasks
    set deleted_at = ${ttl.deletedAt}, deleted_by = ${deletedBy}, purge_after = ${ttl.purgeAfter},
        updated_at = now()
    where workspace_id = ${workspaceId} and id = ${taskId} and deleted_at is null
    returning id`;
  if (!rows[0]) throw new Error("Task not found or already in trash.");
  await sql`insert into events (id, workspace_id, task_id, agent_id, kind, message)
    values (${makeId("evt")}, ${workspaceId}, ${taskId}, ${actor.type === "agent" ? actor.keyId : null},
      ${"trash"}, ${"Moved task to trash (recover within 7 days)"})`;
  await bumpRevision(sql, workspaceId);
  return { id: taskId, purgeAfter: ttl.purgeAfter };
}

export async function restoreTask(
  workspaceId: string,
  taskId: string,
  actor: Actor,
): Promise<{ id: string }> {
  assertCanDeleteTasks(actor);
  const sql = await getSql();
  const live = await sql<{ id: string }>`
    select p.id from tasks t
    join projects p on p.id = t.project_id
    where t.workspace_id = ${workspaceId} and t.id = ${taskId}
      and t.deleted_at is not null and p.deleted_at is null
    limit 1`;
  if (!live[0]) throw new Error("Task is not in trash, or its project is still deleted.");
  await sql`update tasks set deleted_at = null, deleted_by = null, purge_after = null, updated_at = now()
    where workspace_id = ${workspaceId} and id = ${taskId}`;
  await sql`insert into events (id, workspace_id, task_id, kind, message)
    values (${makeId("evt")}, ${workspaceId}, ${taskId}, ${"restore"}, ${"Restored task from trash"})`;
  await bumpRevision(sql, workspaceId);
  return { id: taskId };
}

export async function softDeleteProject(
  workspaceId: string,
  userId: string,
  projectId?: string | null,
): Promise<{ deletedId: string; purgeAfter: string }> {
  const project = await requireOwner(workspaceId, userId, projectId);
  const sql = await getSql();
  const ttl = ttlIso();
  await sql`update projects
    set deleted_at = ${ttl.deletedAt}, deleted_by = ${userId}, purge_after = ${ttl.purgeAfter}
    where id = ${project.id} and deleted_at is null`;
  await sql`update tasks
    set deleted_at = ${ttl.deletedAt}, deleted_by = ${userId}, purge_after = ${ttl.purgeAfter},
        updated_at = now()
    where project_id = ${project.id} and deleted_at is null`;
  await sql`insert into events (id, workspace_id, kind, message)
    values (${makeId("evt")}, ${workspaceId}, ${"trash"},
      ${`Moved project ${project.name} to trash (recover within 7 days)`})`;
  await bumpRevision(sql, workspaceId);
  return { deletedId: project.id, purgeAfter: ttl.purgeAfter };
}

export async function restoreProject(
  workspaceId: string,
  userId: string,
  projectId: string,
): Promise<{ id: string }> {
  const role = await projectRole(projectId, userId);
  if (role !== "owner") throw new Error("Only a project owner can restore that.");
  const sql = await getSql();
  const rows = await sql<{ id: string }>`
    update projects set deleted_at = null, deleted_by = null, purge_after = null
    where workspace_id = ${workspaceId} and id = ${projectId} and deleted_at is not null
    returning id`;
  if (!rows[0]) throw new Error("Project is not in trash.");
  await sql`update tasks set deleted_at = null, deleted_by = null, purge_after = null, updated_at = now()
    where project_id = ${projectId} and deleted_at is not null`;
  await sql`insert into events (id, workspace_id, kind, message)
    values (${makeId("evt")}, ${workspaceId}, ${"restore"}, ${"Restored project from trash"})`;
  await bumpRevision(sql, workspaceId);
  return { id: projectId };
}

export async function listTrash(workspaceId: string): Promise<TrashItem[]> {
  const sql = await getSql();
  const projects = await sql<{
    id: string;
    title: string;
    deleted_at: string;
    purge_after: string;
    deleted_by: string | null;
  }>`
    select id, name as title, deleted_at, purge_after, deleted_by
    from projects
    where workspace_id = ${workspaceId} and deleted_at is not null
    order by deleted_at desc`;
  const tasks = await sql<{
    id: string;
    title: string;
    deleted_at: string;
    purge_after: string;
    deleted_by: string | null;
  }>`
    select id, title, deleted_at, purge_after, deleted_by
    from tasks
    where workspace_id = ${workspaceId} and deleted_at is not null
    order by deleted_at desc`;
  return [
    ...projects.map((p) => ({
      kind: "project" as const,
      id: p.id,
      title: p.title,
      deletedAt: p.deleted_at,
      purgeAfter: p.purge_after,
      deletedBy: p.deleted_by,
    })),
    ...tasks.map((t) => ({
      kind: "task" as const,
      id: t.id,
      title: t.title,
      deletedAt: t.deleted_at,
      purgeAfter: t.purge_after,
      deletedBy: t.deleted_by,
    })),
  ];
}

async function hardPurgeTaskIds(workspaceId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const sql = await getSql();
  await sql`delete from comments where workspace_id = ${workspaceId} and task_id = any(${ids})`;
  await sql`delete from task_deps where workspace_id = ${workspaceId}
    and (task_id = any(${ids}) or depends_on_id = any(${ids}))`;
  await sql`delete from worktrees where workspace_id = ${workspaceId} and task_id = any(${ids})`;
  await sql`delete from tasks where workspace_id = ${workspaceId} and id = any(${ids})`;
}

export async function purgeExpiredTrash(workspaceId: string): Promise<number> {
  const sql = await getSql();
  const now = new Date().toISOString();
  const dueTasks = await sql<{ id: string }>`
    select id from tasks
    where workspace_id = ${workspaceId} and deleted_at is not null and purge_after <= ${now}`;
  const dueProjects = await sql<{ id: string }>`
    select id from projects
    where workspace_id = ${workspaceId} and deleted_at is not null and purge_after <= ${now}`;
  if (!dueTasks.length && !dueProjects.length) return 0;
  await hardPurgeTaskIds(
    workspaceId,
    dueTasks.map((t) => t.id),
  );
  for (const p of dueProjects) {
    const leftover = await sql<{ id: string }>`
      select id from tasks where project_id = ${p.id}`;
    await hardPurgeTaskIds(
      workspaceId,
      leftover.map((t) => t.id),
    );
    await sql`delete from worktrees where project_id = ${p.id}`;
    await sql`delete from project_members where project_id = ${p.id}`;
    await sql`delete from projects where id = ${p.id}`;
  }
  await bumpRevision(sql, workspaceId);
  return dueTasks.length + dueProjects.length;
}

/** Daily cron: hard-delete expired trash in every workspace. */
export async function purgeAllExpiredTrash(): Promise<{ workspaces: number; purged: number }> {
  const sql = await getSql();
  const now = new Date().toISOString();
  const rows = await sql<{ workspace_id: string }>`
    select workspace_id from tasks
    where deleted_at is not null and purge_after <= ${now}
    union
    select workspace_id from projects
    where deleted_at is not null and purge_after <= ${now}`;
  let purged = 0;
  for (const row of rows) {
    purged += await purgeExpiredTrash(row.workspace_id);
  }
  return { workspaces: rows.length, purged };
}
