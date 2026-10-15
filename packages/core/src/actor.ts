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

export type ProjectScope =
  | { ok: true; projectIds: string[] | null }
  | {
      ok: false;
      code: "project_forbidden" | "project_required";
      message: string;
      projects: string[];
    };

/**
 * A PAT that can see several projects must name one. Otherwise sync headers
 * the oldest project and the task list is a mix — absence is not evidence.
 * A single-project PAT is already scoped. Session actors stay unrestricted.
 */
export function resolveProjectScope(
  requested: string | undefined,
  patFilter: string[] | null,
): ProjectScope {
  const asked = requested?.trim() ?? "";
  if (asked) {
    if (patFilter && !patFilter.includes(asked)) {
      return {
        ok: false,
        code: "project_forbidden",
        message: "PAT cannot see this project.",
        projects: patFilter,
      };
    }
    return { ok: true, projectIds: [asked] };
  }
  if (patFilter && patFilter.length === 1) return { ok: true, projectIds: patFilter };
  if (patFilter && patFilter.length > 1) {
    return {
      ok: false,
      code: "project_required",
      message:
        "Pass projectId. This token can see more than one project; an unscoped read is not a roster.",
      projects: patFilter,
    };
  }
  return { ok: true, projectIds: null };
}

export function hasProject(actor: Actor, projectId: string): boolean {
  const filter = projectFilter(actor);
  return !filter || filter.includes(projectId);
}
