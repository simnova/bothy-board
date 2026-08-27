import { getSql, type Sql } from "@bothy-board/db";
import { cacheTokenFor, demoMcpKey, hashApiKey } from "./hash";
import { makeId } from "./ids";
import { ensureBothyBoardProject, seedNorthline } from "./seed";
import type { WorkspaceRow } from "./types";

export async function bumpRevision(sql: Sql, workspaceId: string): Promise<number> {
  const rows = await sql<{ revision: number }>`
    update workspaces set revision = revision + 1, updated_at = now()
    where id = ${workspaceId}
    returning revision`;
  return rows[0]?.revision ?? 1;
}

export function toWorkspaceRow(id: string, name: string, revision: number): WorkspaceRow {
  return { id, name, revision, cacheToken: cacheTokenFor(id, revision) };
}

async function withBothyBoard(
  sql: Sql,
  workspace: { id: string; name: string; revision: number },
  userId: string,
): Promise<WorkspaceRow> {
  const owner = await sql<{ owner_user_id: string }>`
    select owner_user_id from workspaces where id = ${workspace.id}`;
  await ensureBothyBoardProject(sql, workspace.id, owner[0]?.owner_user_id ?? userId);
  const next = await sql<{ id: string; name: string; revision: number }>`
    select id, name, revision from workspaces where id = ${workspace.id}`;
  const row = next[0] ?? workspace;
  return toWorkspaceRow(row.id, row.name, row.revision);
}

export async function workspaceForUser(userId: string): Promise<WorkspaceRow> {
  const sql = await getSql();
  const { ensureProfile } = await import("./team");
  await ensureProfile(sql, userId);

  const pref = await sql<{ active_workspace_id: string | null }>`
    select active_workspace_id from user_prefs where user_id = ${userId}`;
  if (pref[0]?.active_workspace_id) {
    const chosen = await sql<{ id: string; name: string; revision: number }>`
      select w.id, w.name, w.revision
      from workspace_members m
      join workspaces w on w.id = m.workspace_id
      where m.user_id = ${userId} and w.id = ${pref[0].active_workspace_id}
      limit 1`;
    if (chosen[0]) return withBothyBoard(sql, chosen[0], userId);
  }

  const existing = await sql<{ id: string; name: string; revision: number }>`
    select w.id, w.name, w.revision
    from workspace_members m
    join workspaces w on w.id = m.workspace_id
    where m.user_id = ${userId}
    order by m.created_at asc
    limit 1`;
  if (existing[0]) {
    await sql`insert into user_prefs (user_id, active_workspace_id)
      values (${userId}, ${existing[0].id})
      on conflict (user_id) do update set active_workspace_id = excluded.active_workspace_id`;
    return withBothyBoard(sql, existing[0], userId);
  }

  const id = makeId("ws");
  await sql`insert into workspaces (id, name, owner_user_id) values (${id}, ${"Northline"}, ${userId})`;
  await sql`insert into workspace_members (workspace_id, user_id, role) values (${id}, ${userId}, ${"owner"})`;
  await sql`insert into user_prefs (user_id, active_workspace_id)
    values (${userId}, ${id})
    on conflict (user_id) do update set active_workspace_id = excluded.active_workspace_id`;
  await seedNorthline(sql, id, userId);
  await ensureBothyBoardProject(sql, id, userId);
  const key = demoMcpKey(id);
  const keys = await sql<{
    id: string;
  }>`select id from api_keys where workspace_id = ${id} limit 1`;
  if (!keys[0]) {
    await sql`insert into api_keys (id, workspace_id, name, key_hash, key_prefix, created_by_user_id)
      values (${makeId("key")}, ${id}, ${"Workspace MCP key"}, ${hashApiKey(key)}, ${key.slice(0, 18)}, ${userId})`;
  }
  const created = await sql<{ id: string; name: string; revision: number }>`
    select id, name, revision from workspaces where id = ${id}`;
  const row = created[0];
  if (!row) throw new Error("Workspace insert failed.");
  return toWorkspaceRow(row.id, row.name, row.revision);
}

export async function workspaceById(workspaceId: string): Promise<WorkspaceRow | null> {
  const sql = await getSql();
  const rows = await sql<{ id: string; name: string; revision: number }>`
    select id, name, revision from workspaces where id = ${workspaceId}`;
  const w = rows[0];
  return w ? toWorkspaceRow(w.id, w.name, w.revision) : null;
}
