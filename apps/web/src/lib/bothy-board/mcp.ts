import { assertTaskAccess, resolveWriteProject } from "@bothy-board/core/access";
import { isBoardError } from "@bothy-board/core/errors";
import type { WriterKind } from "@bothy-board/core/factory";
import { corsHeaders, json } from "@bothy-board/core/http";
import {
  addComment,
  claimTask,
  createTask,
  decomposeTask,
  failTreatment,
  getTaskDetail,
  heartbeat,
  loadSnapshot,
  nextReady,
  plantTask,
  registerWorktree,
  releaseTask,
  setProofs,
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

const INSTRUCTIONS = `BothyBoard is the shared shelter — a logbook for humans and coding agents.

Install the skill: GET /skills/bothy-board/SKILL.md → .grok/skills/bothy-board/SKILL.md
Discovery: GET /api/mcp (no auth), /llms.txt, /mcp.json. Resource bothy://skill is the same markdown.

Orchestrator: tasks.next (Planted+ready only; {task:null} is success) → sessions.mint → grok -s <id> -w → sessions.bind → worktrees.register. Land only via tasks.proofs.set (factory:land). Workers set review, never done.

Worker: bind GROK_SESSION_ID, tasks.get (body is the contract), mailbox.poll {since}, heartbeat. Dead end: treatments.fail. Cannot continue: tasks.release. Do not rewrite done_when after Planted.

Owner plants with tasks.plant after TREE done_when. Create refuses title-only.
sync with cacheToken; unchanged=true means skip reload.`;

const SKILL_PATH = "/skills/bothy-board/SKILL.md";

const RESOURCES = [
  {
    uri: "bothy://skill",
    name: "bothy-board skill",
    mimeType: "text/markdown",
    description: "Install as .grok/skills/bothy-board/SKILL.md",
  },
  {
    uri: "bothy://llms",
    name: "llms.txt",
    mimeType: "text/plain",
    description: "Agent index of MCP, skill, and protocol",
  },
];

async function readPublic(request: Request, path: string): Promise<string> {
  const url = new URL(path, request.url);
  const res = await fetch(url.href);
  if (!res.ok) return INSTRUCTIONS;
  return res.text();
}

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
    description:
      "Next Planted+ready leaf. Pass machineName to prefer a reaped lease parked on this box. {task:null} is success. Refuses if the snapshot would be truncated.",
    inputSchema: {
      type: "object",
      properties: { machineName: { type: "string" } },
    },
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
    description:
      "Create an Idle+backlog card. Requires title + objective (body ## objective or objective field). Title-only is refused. Does not Plant.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        objective: { type: "string" },
        doneWhen: { type: "array", items: { type: "string" } },
        writeRoots: { type: "array", items: { type: "string" } },
        lane: { type: "string" },
        knownGood: { type: "string" },
        outOfScope: { type: "string" },
        notTested: { type: "string" },
        kind: { type: "string" },
        parentId: { type: "string" },
        projectId: {
          type: "string",
          description: "Required if the token covers more than one project.",
        },
        depIds: { type: "array", items: { type: "string" } },
        fields: {
          type: "object",
          additionalProperties: true,
          description: "Project-configured field values (see projects.fields.list).",
        },
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
      required: ["grokSessionId", "taskId"],
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
    description: "Post a steering note. Capped at 4000 chars. Other agents see it on mailbox.poll.",
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
      "CAS claim: Planted+ready+unassigned. Second claim returns already_claimed. Prefer mint then spawn then bind (bind auto-claims).",
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
    name: "bothy-board.tasks.release",
    description:
      "Hand back a claimed/in_progress lease to Planted+ready without waiting for heartbeat TTL.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, agentId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "bothy-board.tasks.treatments.fail",
    description:
      "Append-only memory: a treatment that did not work. Next workers read this instead of rediscovering it.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        name: { type: "string" },
        produced: { type: "string" },
      },
      required: ["taskId", "name"],
    },
  },
  {
    name: "bothy-board.tasks.update",
    description:
      "Patch. Workers may set review/blocked. They cannot set done, Planted, Landed, or Graded.",
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
        fields: { type: "object", additionalProperties: true },
      },
      required: ["taskId"],
    },
  },
  {
    name: "bothy-board.tasks.decompose",
    description:
      "Split into children. Parent becomes a container (not in next). Children do NOT depend on the parent; they stay Idle+backlog until planted themselves.",
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
    name: "bothy-board.tasks.plant",
    description:
      "Owner/PAT with factory:plant: Idle → Planted+ready after TREE done_when validates. Does not auto-plant on create.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "bothy-board.tasks.proofs.set",
    description:
      "Attestation after the consumer re-ran TREE proofs (exists:/run:/changed:/…). BothyBoard does not execute those commands. proofsOk+headSha → factory=Landed, status=integrating. Requires factory:land. Workers cannot Landed.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        proofsOk: { type: "boolean" },
        headSha: { type: "string" },
        reportPath: { type: "string" },
        proofsLines: { type: "array", items: { type: "string" } },
      },
      required: ["taskId", "proofsOk"],
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
      required: ["path", "branch", "taskId"],
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
    name: "bothy-board.projects.fields.list",
    description: "List configurable fields on a project (GitHub Projects-style schema).",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
    },
  },
  {
    name: "bothy-board.projects.fields.set",
    description: "Replace the field schema for a project. Owner only.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        fields: { type: "array", items: { type: "object" } },
      },
      required: ["projectId", "fields"],
    },
  },
  {
    name: "bothy-board.projects.fields.applyTemplate",
    description:
      "Apply a named field template. Currently: factory (step/lane/unblocks + clothing body gate).",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        template: { type: "string", enum: ["factory"] },
      },
      required: ["projectId", "template"],
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

function writerFor(actor: Actor, name: string): WriterKind {
  if (name === "bothy-board.tasks.proofs.set") return "orchestrator";
  if (actor.type === "agent") return "agent";
  if (
    actor.type === "pat" &&
    !hasScope(actor, "factory:plant") &&
    !hasScope(actor, "factory:land")
  ) {
    return "agent";
  }
  return "owner";
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
    case "bothy-board.tasks.next": {
      const next = await nextReady(workspaceId, filter, { machineName: str(args, "machineName") });
      return toolResult({ task: next.task });
    }
    case "bothy-board.tasks.get":
      return toolResult({ task: await getTaskDetail(workspaceId, taskId ?? "") });
    case "bothy-board.tasks.create": {
      const projectId = await resolveWriteProject(actor, workspaceId, str(args, "projectId"));
      return toolResult({
        id: await createTask(workspaceId, {
          title: str(args, "title") ?? "",
          body: str(args, "body") ?? "",
          objective: str(args, "objective"),
          doneWhen: Array.isArray(args["doneWhen"]) ? args["doneWhen"].map(String) : undefined,
          writeRoots: Array.isArray(args["writeRoots"])
            ? args["writeRoots"].map(String)
            : undefined,
          lane: str(args, "lane"),
          knownGood: str(args, "knownGood"),
          outOfScope: str(args, "outOfScope"),
          notTested: str(args, "notTested"),
          kind: args["kind"] as TaskKind | undefined,
          parentId: str(args, "parentId") ?? null,
          depIds: Array.isArray(args["depIds"]) ? args["depIds"].map(String) : [],
          projectId,
          fields:
            args["fields"] && typeof args["fields"] === "object" && !Array.isArray(args["fields"])
              ? (args["fields"] as Record<string, string | number | string[] | null>)
              : undefined,
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
    case "bothy-board.tasks.release":
      return toolResult({
        task: await releaseTask(workspaceId, taskId ?? "", str(args, "agentId")),
      });
    case "bothy-board.tasks.treatments.fail":
      return toolResult({
        task: await failTreatment(workspaceId, taskId ?? "", {
          name: str(args, "name") ?? "",
          produced: str(args, "produced") ?? "",
        }),
      });
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
          writer: writerFor(actor, name),
          fields:
            args["fields"] && typeof args["fields"] === "object" && !Array.isArray(args["fields"])
              ? (args["fields"] as Record<string, string | number | string[] | null>)
              : undefined,
        }),
      });
    case "bothy-board.tasks.plant":
      return toolResult({ task: await plantTask(workspaceId, taskId ?? "") });
    case "bothy-board.tasks.proofs.set":
      return toolResult({
        task: await setProofs(workspaceId, {
          taskId: taskId ?? "",
          proofsOk: Boolean(args["proofsOk"]),
          headSha: str(args, "headSha"),
          reportPath: str(args, "reportPath"),
          proofsLines: Array.isArray(args["proofsLines"])
            ? args["proofsLines"].map(String)
            : undefined,
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
      if (!str(args, "taskId")) throw new Error("taskId required");
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
      return toolResult({ members: await listMembers(workspaceId, filter) });
    case "bothy-board.projects.list": {
      const { listUserProjects } = await import("@bothy-board/core/projects");
      const listed = userId
        ? await listUserProjects(workspaceId, userId)
        : (await loadSnapshot(workspaceId, workspaceName, revision, filter)).projects.map((p) => ({
            ...p,
            workspaceId,
            role: "member" as const,
          }));
      const projects = filter ? listed.filter((p) => filter.includes(p.id)) : listed;
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
    case "bothy-board.projects.fields.list": {
      const projectId = str(args, "projectId") ?? "";
      if (filter && !filter.includes(projectId))
        throw new Error("This token is not scoped to that project.");
      const { listProjectFields } = await import("@bothy-board/core/project-fields");
      return toolResult({ fields: await listProjectFields(projectId) });
    }
    case "bothy-board.projects.fields.set": {
      if (!userId) throw new Error("Only a signed-in owner can edit fields.");
      const { replaceProjectFields } = await import("@bothy-board/core/project-fields");
      const raw = Array.isArray(args["fields"]) ? args["fields"] : [];
      return toolResult({
        fields: await replaceProjectFields(
          workspaceId,
          userId,
          str(args, "projectId") ?? "",
          raw as never,
        ),
      });
    }
    case "bothy-board.projects.fields.applyTemplate": {
      if (!userId) throw new Error("Only a signed-in owner can edit fields.");
      const { applyFieldTemplate } = await import("@bothy-board/core/project-fields");
      return toolResult({
        fields: await applyFieldTemplate(
          workspaceId,
          userId,
          str(args, "projectId") ?? "",
          (str(args, "template") ?? "factory") as "factory",
        ),
      });
    }
    default:
      return toolResult({ error: `unknown tool ${name}` }, true);
  }
}

export async function handleMcp(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  let rpcMethod = "";
  let rpcId: Rpc["id"] = null;
  try {
    if (request.method === "GET") {
      await enforceIpLimit(request);
      return json(
        {
          name: "bothy-board",
          protocolVersion: PROTOCOL,
          transport: "streamable-http",
          tools: TOOLS.map((t) => t.name),
          skill: SKILL_PATH,
          llms: "/llms.txt",
          mcpJson: "/mcp.json",
          auth: "Authorization: Bearer <PAT>",
        },
        200,
        request,
      );
    }
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405, request);

    const actor = await resolveActor(request);
    if (!actor) return json({ error: "Unauthorized" }, 401, request);

    const rpc = (await request.json().catch(() => ({}))) as Rpc;
    rpcId = rpc.id ?? null;
    rpcMethod = rpc.method ?? "";
    const id = rpcId;
    const method = rpcMethod;
    const params = rpc.params ?? {};
    const grokSessionHeader = request.headers.get("x-grok-session-id") ?? undefined;
    const toolName = method === "tools/call" ? String(params["name"] ?? "") : "";
    const kind = mcpKind(method, toolName);
    await enforceActorLimit(actor, kind);

    if (method === "initialize") {
      return json(
        ok(id, {
          protocolVersion: PROTOCOL,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: { name: "bothy-board", version: "0.4.1" },
          instructions: INSTRUCTIONS,
        }),
        200,
        request,
      );
    }
    if (method === "notifications/initialized" || method === "ping") {
      return json(ok(id, {}), 200, request);
    }
    if (method === "resources/list") {
      return json(ok(id, { resources: RESOURCES }), 200, request);
    }
    if (method === "resources/read") {
      const uri = String((params as { uri?: string }).uri ?? "");
      const path = uri === "bothy://llms" ? "/llms.txt" : SKILL_PATH;
      const text = await readPublic(request, path);
      return json(
        ok(id, {
          contents: [
            {
              uri: uri || "bothy://skill",
              mimeType: path.endsWith(".txt") ? "text/plain" : "text/markdown",
              text,
            },
          ],
        }),
        200,
        request,
      );
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
        const code = isBoardError(err) ? err.code : undefined;
        return json(ok(id, toolResult({ error: message, code }, true)), 200, request);
      }
    }
    return json(fail(id, -32601, `unknown method ${method}`), 200, request);
  } catch (err) {
    if (isRateLimited(err)) {
      const retry = { "Retry-After": String(err.retryAfterSec) };
      if (rpcMethod === "tools/call") {
        return json(
          ok(
            rpcId,
            toolResult(
              {
                error: "rate_limited",
                code: "rate_limited",
                retryAfterSec: err.retryAfterSec,
              },
              true,
            ),
          ),
          200,
          request,
          retry,
        );
      }
      return rateLimitedResponse(err, request);
    }
    throw err;
  }
}
