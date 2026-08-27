import { assertTaskAccess, resolveWriteProject } from "@bothy-board/core/access";
import { corsHeaders, json, readJson, withCache } from "@bothy-board/core/http";
import { listPats, mintPat, revokePat } from "@bothy-board/core/pats";
import { deleteProject, setProjectVisibility } from "@bothy-board/core/projects";
import {
  addComment,
  claimTask,
  createTask,
  decomposeTask,
  failTreatment,
  getTaskDetail,
  heartbeat,
  listApiKeys,
  loadSnapshot,
  mintApiKey,
  nextReady,
  plantTask,
  registerWorktree,
  releaseTask,
  setProofs,
  updateTask,
} from "@bothy-board/core/queries";
import {
  enforceActorLimit,
  enforceDestructiveLimit,
  isRateLimited,
  rateLimitedResponse,
  restKind,
} from "@bothy-board/core/rate-limit";
import {
  bindSession,
  mintSession,
  pollMailbox,
  postMailbox,
  resumeSession,
} from "@bothy-board/core/sessions";
import { acceptInvite, inviteTeammate, listMembers, loadTeamState } from "@bothy-board/core/team";
import type { AgentKind, AgentStatus, TaskKind, WorktreeStatus } from "@bothy-board/core/types";
import { actorUserId, hasScope, projectFilter, resolveActor } from "./actor";

export async function handleRest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  try {
    const actor = await resolveActor(request);
    if (!actor) return json({ error: "Unauthorized" }, 401, request);

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v1\/?/, "").replace(/\/$/, "");
    const parts = path.split("/").filter(Boolean);
    const method = request.method.toUpperCase();
    await enforceActorLimit(actor, restKind(method, path));
    const ws = actor.workspaceId;
    const grokHeader = request.headers.get("x-grok-session-id") ?? undefined;
    const userId = actorUserId(actor);
    const filter = projectFilter(actor);

    const deny = (scope: string) =>
      hasScope(actor, scope) ? null : json({ error: `missing scope ${scope}` }, 403, request);

    const taskId = parts[1];
    if (parts[0] === "tasks" && taskId) {
      await assertTaskAccess(actor, ws, taskId);
    }
    if (method === "GET" && (path === "snapshot" || path === "")) {
      const blocked = deny("board:read");
      if (blocked) return blocked;
      const snap = await loadSnapshot(ws, actor.workspaceName, actor.revision, filter);
      const projectKey = filter?.length ? [...filter].sort().join(",") : "";
      return withCache(snap, ws, snap.revision, request, undefined, projectKey);
    }
    if (method === "GET" && path === "ready") {
      const blocked = deny("board:read");
      if (blocked) return blocked;
      const next = await nextReady(ws, filter, {
        machineName: url.searchParams.get("machineName"),
      });
      const projectKey = filter?.length ? [...filter].sort().join(",") : "";
      return withCache({ task: next.task }, ws, actor.revision, request, undefined, projectKey);
    }
    if (method === "GET" && path === "tasks") {
      const blocked = deny("board:read");
      if (blocked) return blocked;
      const snap = await loadSnapshot(ws, actor.workspaceName, actor.revision, filter);
      return withCache({ tasks: snap.tasks, readyIds: snap.readyIds }, ws, snap.revision, request);
    }
    if (method === "POST" && path === "tasks") {
      const blocked = deny("tasks:write");
      if (blocked) return blocked;
      const body = await readJson<{
        title: string;
        body?: string;
        objective?: string;
        doneWhen?: string[];
        writeRoots?: string[];
        lane?: string;
        kind?: TaskKind;
        parentId?: string;
        depIds?: string[];
        priority?: number;
        projectId?: string;
      }>(request);
      if (!body.title?.trim()) return json({ error: "title required" }, 400, request);
      const projectId = await resolveWriteProject(actor, ws, body.projectId);
      const id = await createTask(ws, { ...body, projectId });
      return json({ id }, 201, request);
    }
    if (parts[0] === "tasks" && parts[1] && parts.length === 2 && method === "GET") {
      const blocked = deny("board:read");
      if (blocked) return blocked;
      const task = await getTaskDetail(ws, parts[1]);
      if (!task) return json({ error: "not found" }, 404, request);
      return withCache(task, ws, actor.revision, request);
    }
    if (parts[0] === "tasks" && parts[1] && parts.length === 2 && method === "PATCH") {
      const blocked = deny("tasks:write");
      if (blocked) return blocked;
      const patch = await readJson<Parameters<typeof updateTask>[2]>(request);
      patch.writer =
        actor.type === "agent" || (actor.type === "pat" && !hasScope(actor, "factory:plant"))
          ? "agent"
          : "owner";
      if (patch.status === "cancelled") await enforceDestructiveLimit(actor);
      const task = await updateTask(ws, parts[1], patch);
      if (!task) return json({ error: "not found" }, 404, request);
      return json({ task }, 200, request);
    }
    if (parts[0] === "tasks" && parts[1] && parts.length === 2 && method === "DELETE") {
      const { assertCanDeleteTasks, softDeleteTask } = await import("@bothy-board/core/trash");
      assertCanDeleteTasks(actor);
      const blocked = deny("tasks:delete");
      if (blocked) return blocked;
      return json(await softDeleteTask(ws, parts[1], actor), 200, request);
    }
    if (parts[0] === "tasks" && taskId && parts[2] === "claim" && method === "POST") {
      const body = await readJson<{
        agentId?: string;
        name?: string;
        kind?: AgentKind;
        machineName?: string;
        continuationId?: string;
        grokSessionId?: string;
        grokSubagentId?: string;
      }>(request);
      const claimed = await claimTask(ws, taskId, {
        id: body.agentId,
        name: body.name || (actor.type === "agent" ? actor.keyName : "agent"),
        kind: body.kind,
        machineName: body.machineName,
        continuationId: body.continuationId,
        grokSessionId: body.grokSessionId ?? grokHeader,
        grokSubagentId: body.grokSubagentId,
      });
      return json(claimed, 200, request);
    }
    if (parts[0] === "tasks" && taskId && parts[2] === "plant" && method === "POST") {
      const blocked = deny("factory:plant");
      if (blocked && actor.type !== "user") return blocked;
      return json({ task: await plantTask(ws, taskId) }, 200, request);
    }
    if (parts[0] === "tasks" && taskId && parts[2] === "proofs" && method === "POST") {
      const blocked = deny("factory:land");
      if (blocked) return blocked;
      const body = await readJson<{
        proofsOk?: boolean;
        headSha?: string;
        reportPath?: string;
        proofsLines?: string[];
      }>(request);
      return json(
        {
          task: await setProofs(ws, {
            taskId,
            proofsOk: Boolean(body.proofsOk),
            headSha: body.headSha,
            reportPath: body.reportPath,
            proofsLines: body.proofsLines,
          }),
        },
        200,
        request,
      );
    }
    if (parts[0] === "tasks" && taskId && parts[2] === "release" && method === "POST") {
      const blocked = deny("tasks:write");
      if (blocked) return blocked;
      const body = await readJson<{ agentId?: string }>(request);
      return json({ task: await releaseTask(ws, taskId, body.agentId) }, 200, request);
    }
    if (parts[0] === "tasks" && taskId && parts[2] === "treatments" && method === "POST") {
      const blocked = deny("tasks:write");
      if (blocked) return blocked;
      const body = await readJson<{ name?: string; produced?: string }>(request);
      return json(
        {
          task: await failTreatment(ws, taskId, {
            name: body.name ?? "",
            produced: body.produced ?? "",
          }),
        },
        200,
        request,
      );
    }
    if (
      parts[0] === "tasks" &&
      taskId &&
      parts[2] === "session" &&
      parts[3] === "mint" &&
      method === "POST"
    ) {
      const blocked = deny("sessions");
      if (blocked) return blocked;
      const body = await readJson<{ machineName?: string }>(request);
      const minted = await mintSession(ws, taskId, {
        machineName: body.machineName || "unknown",
        userId,
      });
      if (!minted) return json({ error: "not found" }, 404, request);
      return json(minted, 200, request);
    }
    if (parts[0] === "tasks" && taskId && parts[2] === "mailbox" && method === "GET") {
      const blocked = deny("mailbox");
      if (blocked) return blocked;
      const since = url.searchParams.get("since") ?? undefined;
      return json(await pollMailbox(ws, taskId, since), 200, request);
    }
    if (parts[0] === "tasks" && taskId && parts[2] === "mailbox" && method === "POST") {
      const blocked = deny("mailbox");
      if (blocked) return blocked;
      const body = await readJson<{ body: string; authorName?: string; grokSessionId?: string }>(
        request,
      );
      if (!body.body?.trim()) return json({ error: "body required" }, 400, request);
      const posted = await postMailbox(ws, taskId, {
        body: body.body,
        authorName: body.authorName || (actor.type === "agent" ? actor.keyName : "member"),
        authorKind: actor.type === "agent" ? "agent" : "user",
        authorUserId: userId,
        grokSessionId: body.grokSessionId ?? grokHeader,
      });
      return json(posted, 201, request);
    }
    if (parts[0] === "tasks" && taskId && parts[2] === "decompose" && method === "POST") {
      const blocked = deny("tasks:write");
      if (blocked) return blocked;
      const body = await readJson<{
        children: { title: string; body?: string; kind?: TaskKind }[];
      }>(request);
      const ids = await decomposeTask(ws, taskId, body.children ?? []);
      return json({ ids }, 200, request);
    }
    if (parts[0] === "tasks" && taskId && parts[2] === "comments" && method === "POST") {
      const blocked = deny("tasks:write");
      if (blocked) return blocked;
      const body = await readJson<{ body: string; authorName?: string; grokSessionId?: string }>(
        request,
      );
      if (!body.body?.trim()) return json({ error: "body required" }, 400, request);
      const id = await addComment(ws, taskId, {
        authorKind: actor.type === "agent" ? "agent" : "user",
        authorName: body.authorName || (actor.type === "agent" ? actor.keyName : "member"),
        authorUserId: userId,
        body: body.body,
        grokSessionId: body.grokSessionId ?? grokHeader,
      });
      return json({ id }, 201, request);
    }
    if (method === "POST" && path === "sessions/bind") {
      const blocked = deny("sessions");
      if (blocked) return blocked;
      const body = await readJson<{
        grokSessionId?: string;
        taskId?: string;
        grokSubagentId?: string;
        machineName?: string;
        name?: string;
        kind?: AgentKind;
        agentId?: string;
      }>(request);
      if (body.taskId) await assertTaskAccess(actor, ws, body.taskId);
      const result = await bindSession(ws, {
        grokSessionId: body.grokSessionId ?? grokHeader ?? "",
        taskId: body.taskId,
        grokSubagentId: body.grokSubagentId,
        machineName: body.machineName,
        name: body.name,
        kind: body.kind,
        agentId: body.agentId,
        userId,
      });
      return json(result, 200, request);
    }
    if (method === "POST" && path === "sessions/resume") {
      const blocked = deny("sessions");
      if (blocked) return blocked;
      const body = await readJson<{ taskId: string; machineName?: string; grokSessionId?: string }>(
        request,
      );
      if (!body.taskId) return json({ error: "taskId required" }, 400, request);
      await assertTaskAccess(actor, ws, body.taskId);
      return json(
        await resumeSession(ws, {
          taskId: body.taskId,
          machineName: body.machineName,
          grokSessionId: body.grokSessionId ?? grokHeader,
          userId,
        }),
        200,
        request,
      );
    }
    if (method === "GET" && path === "team") {
      const blocked = deny("board:read");
      if (blocked) return blocked;
      if (actor.type !== "user") {
        const members = await listMembers(ws);
        return withCache({ members }, ws, actor.revision, request);
      }
      return json(await loadTeamState(actor.userId, ws, actor.workspaceName), 200, request);
    }
    if (method === "POST" && path === "team/invite" && actor.type === "user") {
      const body = await readJson<{ handle: string }>(request);
      if (!body.handle) return json({ error: "handle required" }, 400, request);
      const result = await inviteTeammate(ws, actor.userId, body.handle);
      return json(result, 201, request);
    }
    if (method === "POST" && path === "team/accept" && actor.type === "user") {
      const body = await readJson<{ inviteId: string }>(request);
      if (!body.inviteId) return json({ error: "inviteId required" }, 400, request);
      return json(await acceptInvite(actor.userId, body.inviteId), 200, request);
    }
    if (method === "GET" && path === "agents") {
      const snap = await loadSnapshot(ws, actor.workspaceName, actor.revision, filter);
      return withCache({ agents: snap.agents }, ws, snap.revision, request);
    }
    if (method === "POST" && path === "agents/heartbeat") {
      const blocked = deny("agents");
      if (blocked) return blocked;
      const body = await readJson<{
        agentId?: string;
        name?: string;
        kind?: AgentKind;
        machineName?: string;
        continuationId?: string;
        grokSessionId?: string;
        currentTaskId?: string | null;
        status?: AgentStatus;
      }>(request);
      if (body.currentTaskId) await assertTaskAccess(actor, ws, body.currentTaskId);
      const result = await heartbeat(ws, {
        agentId: body.agentId,
        name: body.name || (actor.type === "agent" ? actor.keyName : "agent"),
        kind: body.kind,
        machineName: body.machineName,
        continuationId: body.continuationId,
        grokSessionId: body.grokSessionId ?? grokHeader,
        currentTaskId: body.currentTaskId,
        status: body.status,
      });
      return json(result, 200, request);
    }
    if (method === "GET" && path === "worktrees") {
      const snap = await loadSnapshot(ws, actor.workspaceName, actor.revision, filter);
      return withCache({ worktrees: snap.worktrees }, ws, snap.revision, request);
    }
    if (method === "POST" && path === "worktrees") {
      const blocked = deny("worktrees");
      if (blocked) return blocked;
      const body = await readJson<{
        path: string;
        branch: string;
        machineName?: string;
        agentId?: string;
        taskId?: string;
        status?: WorktreeStatus;
      }>(request);
      if (!body.path || !body.branch)
        return json({ error: "path and branch required" }, 400, request);
      if (!body.taskId) return json({ error: "taskId required" }, 400, request);
      if (body.taskId) await assertTaskAccess(actor, ws, body.taskId);
      const id = await registerWorktree(ws, body);
      return json({ id }, 201, request);
    }
    if (parts[0] === "projects" && parts[1] && parts[2] === "fields") {
      const projectId = parts[1];
      if (filter && !filter.includes(projectId)) {
        return json({ error: "This token is not scoped to that project." }, 403, request);
      }
      if (method === "GET") {
        const blocked = deny("board:read");
        if (blocked) return blocked;
        const { listProjectFields } = await import("@bothy-board/core/project-fields");
        return json({ fields: await listProjectFields(projectId) }, 200, request);
      }
      if (method === "PUT") {
        if (!userId) return json({ error: "owner required" }, 403, request);
        const blocked = deny("tasks:write");
        if (blocked) return blocked;
        const body = await readJson<{ fields: never[] }>(request);
        const { replaceProjectFields } = await import("@bothy-board/core/project-fields");
        return json(
          { fields: await replaceProjectFields(ws, userId, projectId, body.fields ?? []) },
          200,
          request,
        );
      }
      if (method === "POST" && parts[3] === "template") {
        if (!userId) return json({ error: "owner required" }, 403, request);
        const blocked = deny("tasks:write");
        if (blocked) return blocked;
        const body = await readJson<{ template?: "factory" }>(request);
        const { applyFieldTemplate } = await import("@bothy-board/core/project-fields");
        return json(
          {
            fields: await applyFieldTemplate(ws, userId, projectId, body.template ?? "factory"),
          },
          200,
          request,
        );
      }
    }
    if (method === "GET" && path === "keys" && actor.type === "user") {
      const keys = await listApiKeys(ws);
      return json({ keys }, 200, request);
    }
    if (method === "POST" && path === "keys" && actor.type === "user") {
      const body = await readJson<{ name?: string }>(request);
      const key = await mintApiKey(ws, actor.userId, body.name || "Agent key");
      return json(key, 201, request);
    }
    if ((method === "GET" || method === "POST") && path === "tokens" && userId) {
      if (method === "GET") {
        const { listUserProjects } = await import("@bothy-board/core/projects");
        return json(
          { tokens: await listPats(ws, userId), projects: await listUserProjects(ws, userId) },
          200,
          request,
        );
      }
      const body = await readJson<{
        name?: string;
        scopes?: string[];
        days?: number | null;
        projectIds?: string[];
      }>(request);
      const token = await mintPat(ws, userId, {
        name: body.name || "MCP token",
        scopes: body.scopes,
        days: body.days,
        projectIds: body.projectIds,
      });
      return json(token, 201, request);
    }
    if (method === "DELETE" && parts[0] === "tokens" && parts[1] && userId) {
      const { projectRole, primaryProject } = await import("@bothy-board/core/projects");
      const project = await primaryProject(ws);
      const role = project ? await projectRole(project.id, userId) : null;
      await revokePat(ws, userId, parts[1], role === "owner");
      return json({ ok: true }, 200, request);
    }
    if (method === "POST" && path === "project/visibility" && userId) {
      const body = await readJson<{ visibility: "public" | "private" }>(request);
      return json(await setProjectVisibility(ws, userId, body.visibility), 200, request);
    }
    if (method === "DELETE" && path === "project" && userId) {
      const { assertCanDeleteProject } = await import("@bothy-board/core/trash");
      assertCanDeleteProject(actor);
      return json(await deleteProject(ws, userId), 200, request);
    }
    if (method === "GET" && path === "trash" && userId) {
      const { listTrash } = await import("@bothy-board/core/trash");
      return json({ items: await listTrash(ws) }, 200, request);
    }
    if (method === "POST" && path === "trash/restore" && userId) {
      const body = await readJson<{ kind?: string; id?: string }>(request);
      const { restoreProject, restoreTask } = await import("@bothy-board/core/trash");
      if (body.kind === "project" && body.id) {
        return json(await restoreProject(ws, userId, body.id), 200, request);
      }
      if (body.kind === "task" && body.id) {
        return json(await restoreTask(ws, body.id, actor), 200, request);
      }
      return json({ error: "kind and id required" }, 400, request);
    }
    if (method === "PATCH" && parts[0] === "tasks") {
      return json({ error: "not found" }, 404, request);
    }
    return json({ error: `no route for ${method} /api/v1/${path}` }, 404, request);
  } catch (err) {
    if (isRateLimited(err)) return rateLimitedResponse(err, request);
    const message = err instanceof Error ? err.message : "server error";
    return json({ error: message }, 500, request);
  }
}
