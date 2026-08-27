import type { Actor } from "@bothy-board/core/actor";
import { hashApiKey } from "@bothy-board/core/hash";
import { lookupPat } from "@bothy-board/core/pats";
import { touchApiKey } from "@bothy-board/core/queries";
import { enforceIpLimit, noteFailedAuth } from "@bothy-board/core/rate-limit";
import { workspaceById, workspaceForUser } from "@bothy-board/core/workspace";
import { getSql } from "@bothy-board/db";
import { getSessionUser } from "@/lib/auth/verify.server";

export type { Actor } from "@bothy-board/core/actor";
export { actorUserId, hasScope, projectFilter } from "@bothy-board/core/actor";

export async function resolveActor(request: Request): Promise<Actor | null> {
  await enforceIpLimit(request);
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (bearer.startsWith("bb_pat_")) {
    const pat = await lookupPat(bearer);
    if (!pat) {
      await noteFailedAuth(request);
      return null;
    }
    const ws = await workspaceById(pat.workspaceId);
    if (!ws) return null;
    return {
      type: "pat",
      userId: pat.userId,
      workspaceId: ws.id,
      workspaceName: ws.name,
      revision: ws.revision,
      tokenId: pat.id,
      scopes: pat.scopes,
      projectIds: pat.projectIds,
    };
  }
  if (bearer.startsWith("bb_live_") || bearer.startsWith("bb_")) {
    const sql = await getSql();
    const hash = hashApiKey(bearer);
    const rows = await sql<{ id: string; name: string; workspace_id: string }>`
      select id, name, workspace_id from api_keys where key_hash = ${hash} limit 1`;
    const key = rows[0];
    if (!key) {
      await noteFailedAuth(request);
      return null;
    }
    const ws = await workspaceById(key.workspace_id);
    if (!ws) return null;
    void touchApiKey(hash);
    return {
      type: "agent",
      workspaceId: ws.id,
      workspaceName: ws.name,
      revision: ws.revision,
      keyId: key.id,
      keyName: key.name,
    };
  }
  const user = await getSessionUser(bearer || undefined);
  if (!user) return null;
  const ws = await workspaceForUser(user.id);
  return {
    type: "user",
    userId: user.id,
    workspaceId: ws.id,
    workspaceName: ws.name,
    revision: ws.revision,
  };
}
