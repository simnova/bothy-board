import {
  addComment,
  claimTask,
  createTask,
  decomposeTask,
  getTaskDetail,
  heartbeat,
  plantTask,
  snapshotForUser,
  updateTask,
} from "@bothy-board/core/queries";
import { mintSession, resumeSession } from "@bothy-board/core/sessions";
import {
  acceptInvite,
  declineInvite,
  inviteTeammate,
  loadPublicProfile,
  loadTeamState,
  lookupHandleForInvite,
  type MyProfile,
  revokeInvite,
  setHandle,
  switchWorkspace,
  updateProfile,
} from "@bothy-board/core/team";
import type { AgentKind, TaskKind, TaskStatus } from "@bothy-board/core/types";
import { workspaceForUser } from "@bothy-board/core/workspace";
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { publicRateLimitMiddleware, rateLimitMiddleware } from "./rate-guard";

export const getSnapshot = createServerFn({ method: "GET" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .handler(async ({ context }) => snapshotForUser(context.userId));

export const getTask = createServerFn({ method: "GET" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((taskId: string) => taskId)
  .handler(async ({ context, data: taskId }) => {
    const ws = await workspaceForUser(context.userId);
    return getTaskDetail(ws.id, taskId);
  });

export const postTask = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator(
    (input: {
      title: string;
      body?: string;
      objective?: string;
      doneWhen?: string[];
      kind?: TaskKind;
      parentId?: string | null;
      projectId?: string;
    }) => input,
  )
  .handler(async ({ context, data }) => {
    const ws = await workspaceForUser(context.userId);
    const id = await createTask(ws.id, data);
    return snapshotForUser(context.userId).then((s) => ({ id, snapshot: s }));
  });

export const patchTask = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator(
    (input: {
      taskId: string;
      status?: TaskStatus;
      title?: string;
      body?: string;
      blockedReason?: string | null;
      fields?: Record<string, string | number | string[] | null>;
    }) => input,
  )
  .handler(async ({ context, data }) => {
    const ws = await workspaceForUser(context.userId);
    if (data.status === "cancelled") {
      const { enforceActorUserLimit } = await import("@bothy-board/core/rate-limit");
      await enforceActorUserLimit(context.userId, "destructive");
    }
    await updateTask(ws.id, data.taskId, { ...data, writer: "owner" });
    return snapshotForUser(context.userId);
  });

export const postPlant = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { taskId: string }) => input)
  .handler(async ({ context, data }) => {
    const ws = await workspaceForUser(context.userId);
    await plantTask(ws.id, data.taskId);
    return snapshotForUser(context.userId);
  });

export const postComment = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { taskId: string; body: string; authorName: string }) => input)
  .handler(async ({ context, data }) => {
    const ws = await workspaceForUser(context.userId);
    await addComment(ws.id, data.taskId, {
      authorKind: "user",
      authorName: data.authorName,
      authorUserId: context.userId,
      body: data.body,
    });
    return getTaskDetail(ws.id, data.taskId);
  });

export const postDecompose = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { taskId: string; children: { title: string; body?: string }[] }) => input)
  .handler(async ({ context, data }) => {
    const ws = await workspaceForUser(context.userId);
    await decomposeTask(ws.id, data.taskId, data.children);
    return snapshotForUser(context.userId);
  });

export const postClaim = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator(
    (input: { taskId: string; name: string; kind?: AgentKind; machineName?: string }) => input,
  )
  .handler(async ({ context, data }) => {
    const ws = await workspaceForUser(context.userId);
    const claimed = await claimTask(ws.id, data.taskId, data);
    const snapshot = await snapshotForUser(context.userId);
    return { claimed, snapshot };
  });

export const postHeartbeat = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator(
    (input: {
      name: string;
      kind?: AgentKind;
      machineName?: string;
      continuationId?: string;
      currentTaskId?: string | null;
    }) => input,
  )
  .handler(async ({ context, data }) => {
    const ws = await workspaceForUser(context.userId);
    const beat = await heartbeat(ws.id, data);
    const snapshot = await snapshotForUser(context.userId);
    return { beat, snapshot };
  });

export const postMintSession = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { taskId: string; machineName: string }) => input)
  .handler(async ({ context, data }) => {
    const ws = await workspaceForUser(context.userId);
    const minted = await mintSession(ws.id, data.taskId, {
      machineName: data.machineName,
      userId: context.userId,
    });
    const snapshot = await snapshotForUser(context.userId);
    return { minted, snapshot };
  });

export const postResumeSession = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { taskId: string; machineName: string }) => input)
  .handler(async ({ context, data }) => {
    const ws = await workspaceForUser(context.userId);
    return resumeSession(ws.id, {
      taskId: data.taskId,
      machineName: data.machineName,
      userId: context.userId,
    });
  });

export const getTeam = createServerFn({ method: "GET" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .handler(async ({ context }) => {
    const ws = await workspaceForUser(context.userId);
    return loadTeamState(context.userId, ws.id, ws.name);
  });

export const postHandle = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { handle: string }) => input)
  .handler(async ({ context, data }) => {
    const handle = await setHandle(context.userId, data.handle);
    const ws = await workspaceForUser(context.userId);
    return { handle, team: await loadTeamState(context.userId, ws.id, ws.name) };
  });

export const postInvite = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { handle: string }) => input)
  .handler(async ({ context, data }) => {
    const ws = await workspaceForUser(context.userId);
    const result = await inviteTeammate(ws.id, context.userId, data.handle);
    const team = await loadTeamState(context.userId, ws.id, ws.name);
    return { result, team };
  });

export const postAcceptInvite = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { inviteId: string }) => input)
  .handler(async ({ context, data }) => {
    await acceptInvite(context.userId, data.inviteId);
    const ws = await workspaceForUser(context.userId);
    return loadTeamState(context.userId, ws.id, ws.name);
  });

export const postDeclineInvite = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { inviteId: string }) => input)
  .handler(async ({ context, data }) => {
    await declineInvite(context.userId, data.inviteId);
    const ws = await workspaceForUser(context.userId);
    return loadTeamState(context.userId, ws.id, ws.name);
  });

export const postRevokeInvite = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { inviteId: string }) => input)
  .handler(async ({ context, data }) => {
    const ws = await workspaceForUser(context.userId);
    await revokeInvite(ws.id, context.userId, data.inviteId);
    return loadTeamState(context.userId, ws.id, ws.name);
  });

export const postSwitchWorkspace = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { workspaceId: string }) => input)
  .handler(async ({ context, data }) => {
    await switchWorkspace(context.userId, data.workspaceId);
    const ws = await workspaceForUser(context.userId);
    const team = await loadTeamState(context.userId, ws.id, ws.name);
    const snapshot = await snapshotForUser(context.userId);
    return { team, snapshot };
  });

export const getPublicProfile = createServerFn({ method: "GET" })
  .middleware([publicRateLimitMiddleware])
  .validator((handle: string) => handle)
  .handler(async ({ data }) => {
    const { getSessionUser } = await import("@/lib/auth/verify.server");
    const user = await getSessionUser();
    return loadPublicProfile(data, user?.id ?? null);
  });

export const lookupInviteHandle = createServerFn({ method: "GET" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((handle: string) => handle)
  .handler(async ({ data }) => lookupHandleForInvite(data));

export const postProfile = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: Partial<MyProfile>) => input)
  .handler(async ({ context, data }) => {
    const profile = await updateProfile(context.userId, data);
    const ws = await workspaceForUser(context.userId);
    const team = await loadTeamState(context.userId, ws.id, ws.name);
    return { profile, team };
  });

export const getTokens = createServerFn({ method: "GET" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .handler(async ({ context }) => {
    const { listPats } = await import("@bothy-board/core/pats");
    const { listUserProjects } = await import("@bothy-board/core/projects");
    const ws = await workspaceForUser(context.userId);
    const [tokens, projects] = await Promise.all([
      listPats(ws.id, context.userId),
      listUserProjects(ws.id, context.userId),
    ]);
    return { tokens, projects };
  });

export const postToken = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator(
    (input: { name: string; scopes: string[]; days: number | null; projectIds: string[] }) => input,
  )
  .handler(async ({ context, data }) => {
    const { mintPat } = await import("@bothy-board/core/pats");
    const ws = await workspaceForUser(context.userId);
    return mintPat(ws.id, context.userId, data);
  });

export const postRevokeToken = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { tokenId: string }) => input)
  .handler(async ({ context, data }) => {
    const { revokePat } = await import("@bothy-board/core/pats");
    const { primaryProject, projectRole } = await import("@bothy-board/core/projects");
    const ws = await workspaceForUser(context.userId);
    const project = await primaryProject(ws.id);
    const role = project ? await projectRole(project.id, context.userId) : null;
    await revokePat(ws.id, context.userId, data.tokenId, role === "owner");
    return { ok: true };
  });

export const postProjectVisibility = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { visibility: "public" | "private"; projectId?: string }) => input)
  .handler(async ({ context, data }) => {
    const { setProjectVisibility } = await import("@bothy-board/core/projects");
    const ws = await workspaceForUser(context.userId);
    await setProjectVisibility(ws.id, context.userId, data.visibility, data.projectId);
    return loadTeamState(context.userId, ws.id, ws.name);
  });

export const postDeleteProject = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { projectId?: string } = {}) => input)
  .handler(async ({ context, data }) => {
    const { enforceActorUserLimit } = await import("@bothy-board/core/rate-limit");
    await enforceActorUserLimit(context.userId, "destructive");
    const { deleteProject } = await import("@bothy-board/core/projects");
    const ws = await workspaceForUser(context.userId);
    await deleteProject(ws.id, context.userId, data.projectId);
    const team = await loadTeamState(context.userId, ws.id, ws.name);
    const snapshot = await snapshotForUser(context.userId);
    return { team, snapshot };
  });

export const postDeleteTask = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { taskId: string }) => input)
  .handler(async ({ context, data }) => {
    const { enforceActorUserLimit } = await import("@bothy-board/core/rate-limit");
    await enforceActorUserLimit(context.userId, "destructive");
    const { softDeleteTask } = await import("@bothy-board/core/trash");
    const ws = await workspaceForUser(context.userId);
    await softDeleteTask(ws.id, data.taskId, {
      type: "user",
      userId: context.userId,
      workspaceId: ws.id,
      workspaceName: ws.name,
      revision: ws.revision,
    });
    return snapshotForUser(context.userId);
  });

export const getTrash = createServerFn({ method: "GET" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .handler(async ({ context }) => {
    const { listTrash } = await import("@bothy-board/core/trash");
    const ws = await workspaceForUser(context.userId);
    return listTrash(ws.id);
  });

export const postRestoreTrash = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { kind: "task" | "project"; id: string }) => input)
  .handler(async ({ context, data }) => {
    const { restoreProject, restoreTask } = await import("@bothy-board/core/trash");
    const ws = await workspaceForUser(context.userId);
    if (data.kind === "project") await restoreProject(ws.id, context.userId, data.id);
    else {
      await restoreTask(ws.id, data.id, {
        type: "user",
        userId: context.userId,
        workspaceId: ws.id,
        workspaceName: ws.name,
        revision: ws.revision,
      });
    }
    const team = await loadTeamState(context.userId, ws.id, ws.name);
    const snapshot = await snapshotForUser(context.userId);
    return { team, snapshot };
  });

export const postCreateProject = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { name: string; repo?: string }) => input)
  .handler(async ({ context, data }) => {
    const { createProject } = await import("@bothy-board/core/projects");
    const ws = await workspaceForUser(context.userId);
    await createProject(ws.id, context.userId, data);
    const team = await loadTeamState(context.userId, ws.id, ws.name);
    const snapshot = await snapshotForUser(context.userId);
    return { team, snapshot };
  });

export const postProjectFields = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator(
    (input: {
      projectId: string;
      fields: Array<{
        key: string;
        name: string;
        type: "text" | "number" | "date" | "select" | "list";
        description?: string;
        required?: boolean;
        plantRequired?: boolean;
        dumpInBody?: boolean;
        source?: "value" | "title_or_body";
        pattern?: string | null;
        requiredWhen?: { field: string; equals?: string; in?: string[] } | null;
        options?: { id: string; name: string }[];
      }>;
    }) => input,
  )
  .handler(async ({ context, data }) => {
    const { replaceProjectFields } = await import("@bothy-board/core/project-fields");
    const ws = await workspaceForUser(context.userId);
    await replaceProjectFields(ws.id, context.userId, data.projectId, data.fields);
    const team = await loadTeamState(context.userId, ws.id, ws.name);
    const snapshot = await snapshotForUser(context.userId);
    return { team, snapshot };
  });

export const postFieldTemplate = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { projectId: string; template: "factory" }) => input)
  .handler(async ({ context, data }) => {
    const { applyFieldTemplate } = await import("@bothy-board/core/project-fields");
    const ws = await workspaceForUser(context.userId);
    await applyFieldTemplate(ws.id, context.userId, data.projectId, data.template);
    const team = await loadTeamState(context.userId, ws.id, ws.name);
    const snapshot = await snapshotForUser(context.userId);
    return { team, snapshot };
  });

export const postProjectConcurrency = createServerFn({ method: "POST" })
  .middleware([authMiddleware, rateLimitMiddleware])
  .validator((input: { projectId: string; maxInFlight: number; maxIntegrating: number }) => input)
  .handler(async ({ context, data }) => {
    const { setProjectConcurrency } = await import("@bothy-board/core/projects");
    const ws = await workspaceForUser(context.userId);
    await setProjectConcurrency(ws.id, context.userId, data.projectId, data);
    const team = await loadTeamState(context.userId, ws.id, ws.name);
    const snapshot = await snapshotForUser(context.userId);
    return { team, snapshot };
  });

export const getPublicProject = createServerFn({ method: "GET" })
  .middleware([publicRateLimitMiddleware])
  .validator((projectId: string) => projectId)
  .handler(async ({ data }) => {
    const { publicProjectCard } = await import("@bothy-board/core/projects");
    const { getSessionUser } = await import("@/lib/auth/verify.server");
    const user = await getSessionUser();
    return publicProjectCard(data, user?.id ?? null);
  });
