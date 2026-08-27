import { getSql } from "@bothy-board/db";
import type { Actor } from "./actor";
import { projectFilter } from "./actor";

export async function taskProjectId(workspaceId: string, taskId: string): Promise<string | null> {
  const sql = await getSql();
  const rows = await sql<{ project_id: string }>`
    select project_id from tasks where workspace_id = ${workspaceId} and id = ${taskId} and deleted_at is null limit 1`;
  return rows[0]?.project_id ?? null;
}

export async function assertTaskAccess(actor: Actor, workspaceId: string, taskId: string) {
  const filter = projectFilter(actor);
  if (!filter) return;
  const projectId = await taskProjectId(workspaceId, taskId);
  if (!projectId || !filter.includes(projectId)) {
    throw new Error("This token is not scoped to that project.");
  }
}

export async function resolveWriteProject(
  actor: Actor,
  workspaceId: string,
  preferredId?: string | null,
): Promise<string> {
  const filter = projectFilter(actor);
  if (preferredId) {
    if (filter && !filter.includes(preferredId)) {
      throw new Error("This token is not scoped to that project.");
    }
    const sql = await getSql();
    const rows = await sql<{ id: string }>`
      select id from projects where workspace_id = ${workspaceId} and id = ${preferredId} and deleted_at is null limit 1`;
    if (!rows[0]) throw new Error("Project not found.");
    return preferredId;
  }
  if (filter?.length) {
    const first = filter[0];
    if (first) return first;
  }
  const sql = await getSql();
  const rows = await sql<{
    id: string;
  }>`select id from projects where workspace_id = ${workspaceId} and deleted_at is null order by created_at asc limit 1`;
  if (!rows[0]) throw new Error("This board has no project.");
  return rows[0].id;
}
