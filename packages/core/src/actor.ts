import type { PatScopeId } from "./scopes";

export type Actor =
  | { type: "user"; userId: string; workspaceId: string; workspaceName: string; revision: number }
  | {
      type: "agent";
      workspaceId: string;
      workspaceName: string;
      revision: number;
      keyId: string;
      keyName: string;
    }
  | {
      type: "pat";
      userId: string;
      workspaceId: string;
      workspaceName: string;
      revision: number;
      tokenId: string;
      scopes: PatScopeId[];
      projectIds: string[];
    };

export function actorUserId(actor: Actor): string | undefined {
  return actor.type === "agent" ? undefined : actor.userId;
}

export function hasScope(actor: Actor, scope: string): boolean {
  if (actor.type !== "pat") return true;
  return actor.scopes.includes(scope as PatScopeId);
}

/** null = unrestricted (session or shared workspace key). */
export function projectFilter(actor: Actor): string[] | null {
  if (actor.type !== "pat") return null;
  return actor.projectIds;
}

export function hasProject(actor: Actor, projectId: string): boolean {
  const filter = projectFilter(actor);
  return !filter || filter.includes(projectId);
}
