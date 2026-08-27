import { getSql } from "@bothy-board/db";
import { hashApiKey, newPat } from "./hash";
import { makeId } from "./ids";
import { listUserProjects } from "./projects";
import { ALL_SCOPE_IDS, type PatScopeId, parseScopes, serializeScopes } from "./scopes";

export type PatProject = { id: string; name: string };

export type PatRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: PatScopeId[];
  projects: PatProject[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

export async function mintPat(
  workspaceId: string,
  userId: string,
  input: {
    name: string;
    scopes?: string[] | undefined;
    days?: number | null | undefined;
    projectIds?: string[] | undefined;
  },
) {
  const sql = await getSql();
  const member = await sql<{ user_id: string }>`
    select user_id from workspace_members where workspace_id = ${workspaceId} and user_id = ${userId}`;
  if (!member[0]) throw new Error("You are not a member of this workspace.");
  const allowed = await listUserProjects(workspaceId, userId);
  const allowedIds = new Set(allowed.map((p) => p.id));
  const requested = [...new Set((input.projectIds ?? []).filter(Boolean))];
  if (!requested.length) throw new Error("Select at least one project for this token.");
  const missing = requested.filter((id) => !allowedIds.has(id));
  if (missing.length) throw new Error("You can only scope a token to projects you belong to.");
  const name = input.name.trim() || "MCP token";
  const scopes = parseScopes(input.scopes);
  const key = newPat();
  const id = makeId("pat");
  const expiresAt =
    input.days && input.days > 0
      ? new Date(Date.now() + input.days * 24 * 60 * 60 * 1000).toISOString()
      : null;
  const primary = requested[0];
  await sql`insert into personal_access_tokens
    (id, user_id, workspace_id, project_id, name, key_hash, key_prefix, scopes, expires_at)
    values (${id}, ${userId}, ${workspaceId}, ${primary}, ${name}, ${key.hash}, ${key.prefix}, ${serializeScopes(scopes)}, ${expiresAt})`;
  for (const projectId of requested) {
    await sql`insert into personal_access_token_projects (token_id, project_id)
      values (${id}, ${projectId})
      on conflict (token_id, project_id) do nothing`;
  }
  const projects = allowed
    .filter((p) => requested.includes(p.id))
    .map((p) => ({ id: p.id, name: p.name }));
  return {
    id,
    name,
    plaintext: key.plaintext,
    prefix: key.prefix,
    scopes,
    projects,
    expiresAt,
  };
}

export async function listPats(workspaceId: string, userId: string): Promise<PatRow[]> {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    name: string;
    key_prefix: string;
    scopes: string;
    expires_at: string | null;
    last_used_at: string | null;
    created_at: string;
  }>`
    select id, name, key_prefix, scopes, expires_at, last_used_at, created_at
    from personal_access_tokens
    where workspace_id = ${workspaceId} and user_id = ${userId} and revoked_at is null
    order by created_at desc`;
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const links = await sql<{ token_id: string; project_id: string; name: string }>`
    select l.token_id, l.project_id, p.name
    from personal_access_token_projects l
    join projects p on p.id = l.project_id
    where l.token_id = any(${ids})`;
  const byToken = new Map<string, PatProject[]>();
  for (const link of links) {
    const list = byToken.get(link.token_id) ?? [];
    list.push({ id: link.project_id, name: link.name });
    byToken.set(link.token_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.key_prefix,
    scopes: parseScopes(r.scopes),
    projects: byToken.get(r.id) ?? [],
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  }));
}

export async function revokePat(
  workspaceId: string,
  userId: string,
  tokenId: string,
  asOwner: boolean,
) {
  const sql = await getSql();
  const rows = await sql<{ id: string; user_id: string }>`
    select id, user_id from personal_access_tokens
    where id = ${tokenId} and workspace_id = ${workspaceId} and revoked_at is null`;
  const row = rows[0];
  if (!row) throw new Error("Token not found.");
  if (row.user_id !== userId && !asOwner) throw new Error("You can only revoke your own tokens.");
  await sql`update personal_access_tokens set revoked_at = now() where id = ${tokenId}`;
}

export async function lookupPat(plaintext: string) {
  const sql = await getSql();
  const hash = hashApiKey(plaintext);
  const rows = await sql<{
    id: string;
    user_id: string;
    workspace_id: string;
    scopes: string;
    expires_at: string | null;
    revoked_at: string | null;
  }>`
    select id, user_id, workspace_id, scopes, expires_at, revoked_at
    from personal_access_tokens where key_hash = ${hash} limit 1`;
  const row = rows[0];
  if (!row || row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
  const member = await sql<{ user_id: string }>`
    select user_id from workspace_members where workspace_id = ${row.workspace_id} and user_id = ${row.user_id}`;
  if (!member[0]) return null;
  const projects = await sql<{ project_id: string }>`
    select l.project_id
    from personal_access_token_projects l
    join project_members m on m.project_id = l.project_id and m.user_id = ${row.user_id}
    where l.token_id = ${row.id}`;
  const projectIds = projects.map((p) => p.project_id);
  if (!projectIds.length) return null;
  await sql`update personal_access_tokens set last_used_at = now() where id = ${row.id}`;
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    scopes: parseScopes(row.scopes),
    projectIds,
  };
}

export { ALL_SCOPE_IDS };
