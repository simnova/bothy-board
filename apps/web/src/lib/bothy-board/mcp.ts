import { assertTaskAccess, resolveWriteProject } from "@bothy-board/core/access";
import { corsHeaders, json } from "@bothy-board/core/http";
import {
  addComment,
  claimTask,
  createTask,
  decomposeTask,
  getTaskDetail,
  heartbeat,
  loadSnapshot,
  nextReady,
  registerWorktree,
  updateTask,
} from "@bothy-board/core/queries";
import {
  enforceActorLimit,
  enforceIpLimit,
  isRateLimited,
  mcpKind,
  rateLimitedResponse,
} from "@bothy-board/core/rate-limit";
import { scopeForTool } from "@bothy-board/core/scopes";
import {
  bindSession,
  mintSession,
  pollMailbox,
  postMailbox,
  resumeSession,
} from "@bothy-board/core/sessions";
import { listMembers } from "@bothy-board/core/team";
import type { AgentKind, TaskKind, TaskStatus } from "@bothy-board/core/types";
import { type Actor, actorUserId, hasScope, projectFilter, resolveActor } from "./actor";

type Rpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const PROTOCOL = "2025-03-26";

const INSTRUCTIONS = `BothyBoard is the shared shelter — a logbook for humans and coding agents. Duck in, do the work, leave it ready. Grok sessions are local (~/.grok/sessions); BothyBoard is the ledger.

Orchestrator (before spawn):
1. bothy-board.sessions.mint { taskId, machineName } — mints a UUID, writes it on the task, returns spawnCommand.
2. Run: grok -s <grokSessionId> -w -p "…"  (do not resume with -s).
3. After spawn_subagent, bothy-board.sessions.bind { grokSessionId, grokSubagentId, taskId, machineName }.

Worker (inside the Grok session):
- Pass grokSessionId from GROK_SESSION_ID (env) or header X-Grok-Session-Id on every bind/heartbeat.
- bothy-board.tasks.get for the spec. Do not trust a stale spawn prompt.
- bothy-board.mailbox.poll { taskId, since } every few turns — this is how other agents talk to you. Grok cannot prompt a running subagent.
- bothy-board.agents.heartbeat with grokSessionId + machineName.
- On finish: bothy-board.tasks.update status=review. Leave the session parked for resume_from.

Corrections: bothy-board.sessions.resume { taskId, machineName }. If allowed, grok --resume <id> or spawn_subagent resume_from=<grokSubagentId> (in-place, same machine, child must be finished). If parkedOn another machine, comment on the mailbox instead.

bothy-board.sync with cacheToken; unchanged=true means skip reload.`;

const TOOLS = [
  {
    name: "bothy-board.sync",
    description: "Compact workspace snapshot. Pass cacheToken to skip unchanged payloads.",
    inputSchema: {
      type: "object",
      properties: { cacheToken: { type: "string" } },
    },
  },
  {
    name: "bothy-board.tasks.next",
    description: "Return the highest-priority ready task whose dependencies are done.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bothy-board.tasks.get",
    description:
      "Full task with comments, children, grokSessionId, grokSubagentId, affinity, worktree.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "bothy-board.tasks.create",
    description: "Create a task. Optional parentId and depIds.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        kind: { type: "string" },
        parentId: { type: "string" },
        projectId: {
          type: "string",
          description: "Required if the token covers more than one project.",
        },
        depIds: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
    },
  },
  {
    name: "bothy-board.sessions.mint",
    description:
      "Mint a Grok Build session UUID onto a task BEFORE spawn. Returns spawnCommand (grok -s <uuid> -w). Idempotent if already minted.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        machineName: { type: "string" },
      },
      required: ["taskId", "machineName"],
    },
  },
  {
    name: "bothy-board.sessions.bind",
    description:
      "Bind GROK_SESSION_ID (and optional grokSubagentId) to a task after spawn. Call from the worker; pass the env session id.",
    inputSchema: {
      type: "object",
      properties: {
        grokSessionId: { type: "string" },
        taskId: { type: "string" },
        grokSubagentId: { type: "string" },
        machineName: { type: "string" },
        name: { type: "string" },
        kind: { type: "string" },
        agentId: { type: "string" },
      },
      required: ["grokSessionId"],
    },
  },
  {
    name: "bothy-board.sessions.resume",
    description:
      "Check whether THIS machine may resume a parked Grok session. Returns resumeCommand / resume_from hint, or parkedOn if affinity fails.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        machineName: { type: "string" },
        grokSessionId: { type: "string" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "bothy-board.mailbox.poll",
    description:
      "Agent-to-agent mailbox for a task. Pass since (ISO timestamp from last poll) to get only new comments. Use this instead of prompting a running Grok subagent.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, since: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "bothy-board.mailbox.post",
    description:
      "Post a note other agents will see on mailbox.poll. Works across users and machines.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        body: { type: "string" },
        authorName: { type: "string" },
        grokSessionId: { type: "string" },
      },
      required: ["taskId", "body"],
    },
  },
  {
    name: "bothy-board.tasks.claim",
    description:
      "Claim a task. Prefer bothy-board.sessions.mint then spawn, then bind. Accepts grokSessionId if already minted.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        name: { type: "string" },
        kind: { type: "string" },
        machineName: { type: "string" },
        continuationId: { type: "string" },
        grokSessionId: { type: "string" },
        grokSubagentId: { type: "string" },
        agentId: { type: "string" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "bothy-board.tasks.update",
    description:
      "Patch status, branch, worktree, continuation, Grok ids, integration, or blocked reason.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        status: { type: "string" },
        continuationId: { type: "string" },
        grokSessionId: { type: "string" },
        grokSubagentId: { type: "string" },
        affinityMachineName: { type: "string" },
        branch: { type: "string" },
        worktreePath: { type: "string" },
        integrationStatus: { type: "string" },
        blockedReason: { type: "string" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "bothy-board.tasks.decompose",
    description: "Split a task into children. Children depend on the parent remaining done.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        children: {
          type: "array",
          items: {
            type: "object",
            properties: { title: { type: "string" }, body: { type: "string" } },
          },
        },
      },
      required: ["taskId", "children"],
    },
  },
  {
    name: "bothy-board.tasks.comment",
    description: "Add a discussion note on a task (same store as mailbox.post).",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        body: { type: "string" },
        authorName: { type: "string" },
        grokSessionId: { type: "string" },
      },
      required: ["taskId", "body"],
    },
  },
  {
    name: "bothy-board.agents.heartbeat",
    description:
      "Register or resume an agent. Pass grokSessionId from GROK_SESSION_ID. Call every few minutes.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        name: { type: "string" },
        kind: { type: "string" },
        machineName: { type: "string" },
        continuationId: { type: "string" },
        grokSessionId: { type: "string" },
        currentTaskId: { type: "string" },
        status: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "bothy-board.worktrees.register",
    description: "Register a git worktree/branch/machine so other agents avoid that checkout.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        branch: { type: "string" },
        machineName: { type: "string" },
        agentId: { type: "string" },
        taskId: { type: "string" },
        status: { type: "string" },
      },
      required: ["path", "branch"],
    },
  },
  {
    name: "bothy-board.team.members",
    description: "List human teammates on this workspace (handle + role).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bothy-board.projects.list",
    description: "List projects this credential can see.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bothy-board.projects.create",
    description: "Create a project on this workspace. Owner only.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, repo: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "bothy-board.tasks.delete",
    description:
      "Soft-delete a task (hidden, recoverable for 7 days). Requires tasks:delete. Cannot wipe the board — tight per-agent quota.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "bothy-board.tasks.restore",
    description: "Restore a soft-deleted task from trash.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "bothy-board.trash.list",
    description: "List tasks and projects in trash and when they purge.",
    inputSchema: { type: "object", properties: {} },
  },
];

function ok(id: Rpc["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function fail(id: Rpc["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
function toolResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    isError,
  };
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length ? v : undefined;
}

async function callTool(
  actor: Actor,
  name: string,
  args: Record<string, unknown>,
  grokSessionHeader?: string,
) {
  const workspaceId = actor.workspaceId;
  const workspaceName = actor.workspaceName;
  const revision = actor.revision;
  const filter = projectFilter(actor);
  const userId = actorUserId(actor);
  const sessionFromEnv = str(args, "grokSessionId") ?? grokSessionHeader;
  const taskId = str(args, "taskId");
  if (
    taskId &&
    name !== "bothy-board.sync" &&
    name !== "bothy-board.tasks.next" &&
    name !== "bothy-board.tasks.create"
  ) {
    await assertTaskAccess(actor, workspaceId, taskId);
  }
  switch (name) {
    case "bothy-board.sync": {
      const snap = await loadSnapshot(workspaceId, workspaceName, revision, filter);
      const cacheToken = str(args, "cacheToken");
      if (cacheToken && cacheToken === snap.cacheToken) {
        return toolResult({
          unchanged: true,
          cacheToken: snap.cacheToken,
          revision: snap.revision,
        });
      }
      return toolResult({
        cacheToken: snap.cacheToken,
        revision: snap.revision,
        project: snap.project,
        projects: snap.projects,
        tasks: snap.tasks,
        agents: snap.agents,
        worktrees: snap.worktrees,
        readyIds: snap.readyIds,
        members: snap.members,
      });
    }
    case "bothy-board.tasks.next":
      return toolResult({ task: await nextReady(workspaceId, filter) });
    case "bothy-board.tasks.get":
      return toolResult({ task: await getTaskDetail(workspaceId, taskId ?? "") });
    case "bothy-board.tasks.create": {
      const projectId = await resolveWriteProject(actor, workspaceId, str(args, "projectId"));
      return toolResult({
        id: await createTask(workspaceId, {
          title: str(args, "title") ?? "",
          body: str(args, "body") ?? "",
          kind: args["kind"] as TaskKind | undefined,
          parentId: str(args, "parentId") ?? null,
          depIds: Array.isArray(args["depIds"]) ? args["depIds"].map(String) : [],
          projectId,
        }),
      });
    }
    case "bothy-board.sessions.mint": {
      const minted = await mintSession(workspaceId, taskId ?? "", {
        machineName: str(args, "machineName") ?? "",
        userId,
      });
      return toolResult(minted ?? { error: "task not found" }, !minted);
    }
    case "bothy-board.sessions.bind":
      return toolResult(
        await bindSession(workspaceId, {
          grokSessionId: sessionFromEnv ?? "",
          taskId: str(args, "taskId"),
          grokSubagentId: str(args, "grokSubagentId"),
          machineName: str(args, "machineName"),
          name: str(args, "name"),
          kind: args["kind"] as never,
          agentId: str(args, "agentId"),
          userId,
        }),
      );
    case "bothy-board.sessions.resume":
      return toolResult(
        await resumeSession(workspaceId, {
          taskId: taskId ?? "",
          machineName: str(args, "machineName"),
          grokSessionId: sessionFromEnv,
          userId,
        }),
      );
    case "bothy-board.mailbox.poll":
      return toolResult(await pollMailbox(workspaceId, taskId ?? "", str(args, "since")));
    case "bothy-board.mailbox.post":
      return toolResult(
        await postMailbox(workspaceId, taskId ?? "", {
          body: str(args, "body") ?? "",
          authorName:
            str(args, "authorName") ?? (actor.type === "agent" ? actor.keyName : "member"),
          authorKind: actor.type === "agent" ? "agent" : "user",
          authorUserId: userId,
          grokSessionId: sessionFromEnv,
        }),
      );
    case "bothy-board.tasks.claim":
      return toolResult(
        await claimTask(workspaceId, taskId ?? "", {
          id: str(args, "agentId"),
          name: str(args, "name") ?? "agent",
          kind: args["kind"] as AgentKind | undefined,
          machineName: str(args, "machineName"),
          continuationId: str(args, "continuationId"),
          grokSessionId: sessionFromEnv,
          grokSubagentId: str(args, "grokSubagentId"),
        }),
      );
    case "bothy-board.tasks.update":
      return toolResult({
        task: await updateTask(workspaceId, taskId ?? "", {
          status: args["status"] as TaskStatus | undefined,
          continuationId: str(args, "continuationId"),
          grokSessionId: str(args, "grokSessionId") ?? grokSessionHeader,
          grokSubagentId: str(args, "grokSubagentId"),
          affinityMachineName: str(args, "affinityMachineName"),
          branch: str(args, "branch"),
          worktreePath: str(args, "worktreePath"),
          integrationStatus: args["integrationStatus"] as never,
          blockedReason: str(args, "blockedReason"),
        }),
      });
    case "bothy-board.tasks.delete": {
      const { assertCanDeleteTasks, softDeleteTask } = await import("@bothy-board/core/trash");
      assertCanDeleteTasks(actor);
      return toolResult(await softDeleteTask(workspaceId, taskId ?? "", actor));
    }
    case "bothy-board.tasks.restore": {
      const { assertCanDeleteTasks, restoreTask } = await import("@bothy-board/core/trash");
      assertCanDeleteTasks(actor);
      return toolResult(await restoreTask(workspaceId, taskId ?? "", actor));
    }
    case "bothy-board.trash.list": {
      const { assertCanDeleteTasks, listTrash } = await import("@bothy-board/core/trash");
      assertCanDeleteTasks(actor);
      return toolResult({ items: await listTrash(workspaceId) });
    }
    case "bothy-board.tasks.decompose":
      return toolResult({
        ids: await decomposeTask(
          workspaceId,
          taskId ?? "",
          (Array.isArray(args["children"]) ? args["children"] : []).map((c) => {
            const row = c as { title?: string; body?: string };
            return { title: String(row.title ?? "child"), body: row.body };
          }),
        ),
      });
    case "bothy-board.tasks.comment":
      return toolResult({
        id: await addComment(workspaceId, taskId ?? "", {
          authorKind: actor.type === "agent" ? "agent" : "user",
          authorName:
            str(args, "authorName") ?? (actor.type === "agent" ? actor.keyName : "member"),
          authorUserId: userId,
          body: str(args, "body") ?? "",
          grokSessionId: sessionFromEnv,
        }),
      });
    case "bothy-board.agents.heartbeat":
      if (str(args, "currentTaskId"))
        await assertTaskAccess(actor, workspaceId, str(args, "currentTaskId") ?? "");
      return toolResult(
        await heartbeat(workspaceId, {
          agentId: str(args, "agentId"),
          name: str(args, "name") ?? "agent",
          kind: args["kind"] as AgentKind | undefined,
          machineName: str(args, "machineName"),
          continuationId: str(args, "continuationId"),
          grokSessionId: sessionFromEnv,
          currentTaskId: str(args, "currentTaskId") ?? null,
        }),
      );
    case "bothy-board.worktrees.register":
      if (str(args, "taskId"))
        await assertTaskAccess(actor, workspaceId, str(args, "taskId") ?? "");
      return toolResult({
        id: await registerWorktree(workspaceId, {
          path: str(args, "path") ?? "",
          branch: str(args, "branch") ?? "",
          machineName: str(args, "machineName"),
          agentId: str(args, "agentId"),
          taskId: str(args, "taskId"),
        }),
      });
    case "bothy-board.team.members":
      return toolResult({ members: await listMembers(workspaceId) });
    case "bothy-board.projects.list": {
      const { listUserProjects } = await import("@bothy-board/core/projects");
      const projects = userId
        ? await listUserProjects(workspaceId, userId)
        : (await loadSnapshot(workspaceId, workspaceName, revision, filter)).projects.map((p) => ({
            ...p,
            role: "member" as const,
          }));
      return toolResult({ projects });
    }
    case "bothy-board.projects.create": {
      if (!userId) throw new Error("Only a signed-in owner can create a project.");
      const { createProject } = await import("@bothy-board/core/projects");
      const repo = str(args, "repo");
      return toolResult(
        await createProject(
          workspaceId,
          userId,
          repo ? { name: str(args, "name") ?? "", repo } : { name: str(args, "name") ?? "" },
        ),
      );
    }
    default:
      return toolResult({ error: `unknown tool ${name}` }, true);
  }
}

export async function handleMcp(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  try {
    if (request.method === "GET") {
      await enforceIpLimit(request);
      return json(
        {
          name: "bothy-board",
          protocolVersion: PROTOCOL,
          transport: "streamable-http",
          tools: TOOLS.map((t) => t.name),
        },
        200,
        request,
      );
    }
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405, request);

    const actor = await resolveActor(request);
    if (!actor) return json({ error: "Unauthorized" }, 401, request);

    const rpc = (await request.json().catch(() => ({}))) as Rpc;
    const id = rpc.id ?? null;
    const method = rpc.method ?? "";
    const params = rpc.params ?? {};
    const grokSessionHeader = request.headers.get("x-grok-session-id") ?? undefined;
    const toolName = method === "tools/call" ? String(params["name"] ?? "") : "";
    const toolArgs = (params["arguments"] as Record<string, unknown> | undefined) ?? {};
    let kind = mcpKind(method, toolName);
    if (toolName === "bothy-board.tasks.update" && toolArgs["status"] === "cancelled") {
      kind = "destructive";
    }
    await enforceActorLimit(actor, kind);

    if (method === "initialize") {
      return json(
        ok(id, {
          protocolVersion: PROTOCOL,
          capabilities: { tools: { listChanged: false }, resources: {} },
          serverInfo: { name: "bothy-board", version: "0.2.0" },
          instructions: INSTRUCTIONS,
        }),
        200,
        request,
      );
    }
    if (method === "notifications/initialized" || method === "ping") {
      return json(ok(id, {}), 200, request);
    }
    if (method === "tools/list") {
      const tools = TOOLS.filter((t) => {
        const scope = scopeForTool(t.name);
        if (scope && !hasScope(actor, scope)) return false;
        if (
          t.name === "bothy-board.tasks.delete" ||
          t.name === "bothy-board.tasks.restore" ||
          t.name === "bothy-board.trash.list"
        ) {
          return actor.type === "user" || (actor.type === "pat" && hasScope(actor, "tasks:delete"));
        }
        return true;
      });
      return json(ok(id, { tools }), 200, request);
    }
    if (method === "tools/call") {
      const name = String(params["name"] ?? "");
      const args = (params["arguments"] as Record<string, unknown>) ?? {};
      const needed = scopeForTool(name);
      if (needed && !hasScope(actor, needed)) {
        return json(ok(id, toolResult({ error: `missing scope ${needed}` }, true)), 200, request);
      }
      try {
        const result = await callTool(actor, name, args, grokSessionHeader);
        return json(ok(id, result), 200, request);
      } catch (err) {
        const message = err instanceof Error ? err.message : "tool error";
        return json(ok(id, toolResult({ error: message }, true)), 200, request);
      }
    }
    return json(fail(id, -32601, `unknown method ${method}`), 200, request);
  } catch (err) {
    if (isRateLimited(err)) return rateLimitedResponse(err, request);
    throw err;
  }
}
