import { getSql, type Sql } from "@bothy-board/db";
import { cacheTokenFor, demoMcpKey, newApiKey } from "./hash";
import { makeId } from "./ids";
import { listMembers } from "./team";
import type {
  AgentKind,
  AgentRow,
  AgentStatus,
  CommentRow,
  CompactTask,
  EventRow,
  IntegrationStatus,
  Snapshot,
  TaskDetail,
  TaskKind,
  TaskStatus,
  WorktreeRow,
  WorktreeStatus,
} from "./types";
import { bumpRevision, workspaceForUser } from "./workspace";

type TaskRecord = {
  id: string;
  parent_id: string | null;
  title: string;
  body: string;
  kind: TaskKind;
  status: TaskStatus;
  priority: number;
  project_id: string;
  assignee_user_id: string | null;
  assignee_agent_id: string | null;
  continuation_id: string | null;
  grok_session_id: string | null;
  grok_subagent_id: string | null;
  affinity_user_id: string | null;
  affinity_machine_name: string | null;
  branch: string | null;
  worktree_path: string | null;
  integration_status: IntegrationStatus;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
};

function compact(t: TaskRecord, depIds: string[]): CompactTask {
  return {
    id: t.id,
    parentId: t.parent_id,
    projectId: t.project_id,
    title: t.title,
    kind: t.kind,
    status: t.status,
    priority: t.priority,
    assigneeAgentId: t.assignee_agent_id,
    continuationId: t.continuation_id,
    grokSessionId: t.grok_session_id,
    grokSubagentId: t.grok_subagent_id,
    affinityUserId: t.affinity_user_id,
    affinityMachineName: t.affinity_machine_name,
    branch: t.branch,
    worktreePath: t.worktree_path,
    integrationStatus: t.integration_status,
    blockedReason: t.blocked_reason,
    depIds,
    updatedAt: t.updated_at,
  };
}

async function depMap(sql: Sql, workspaceId: string): Promise<Map<string, string[]>> {
  const rows = await sql<{ task_id: string; depends_on_id: string }>`
    select task_id, depends_on_id from task_deps where workspace_id = ${workspaceId}`;
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.task_id) ?? [];
    list.push(r.depends_on_id);
    map.set(r.task_id, list);
  }
  return map;
}

async function loadTasks(
  sql: Sql,
  workspaceId: string,
  projectIds?: string[] | null,
): Promise<TaskRecord[]> {
  if (projectIds?.length) {
    return sql<TaskRecord>`
    select id, parent_id, title, body, kind, status, priority, project_id,
           assignee_user_id, assignee_agent_id, continuation_id, grok_session_id, grok_subagent_id,
           affinity_user_id, affinity_machine_name, branch, worktree_path,
           integration_status, blocked_reason, created_at, updated_at
    from tasks where workspace_id = ${workspaceId} and project_id = any(${projectIds})
    and deleted_at is null
    order by sort_order asc, created_at asc`;
  }
  if (projectIds && projectIds.length === 0) return [];
  return sql<TaskRecord>`
    select id, parent_id, title, body, kind, status, priority, project_id,
           assignee_user_id, assignee_agent_id, continuation_id, grok_session_id, grok_subagent_id,
           affinity_user_id, affinity_machine_name, branch, worktree_path,
           integration_status, blocked_reason, created_at, updated_at
    from tasks where workspace_id = ${workspaceId} and deleted_at is null
    order by sort_order asc, created_at asc`;
}

function readyIds(tasks: CompactTask[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks
    .filter((t) => {
      if (t.status !== "ready" && t.status !== "backlog") return false;
      if (t.status === "backlog") return false;
      return t.depIds.every((id) => byId.get(id)?.status === "done");
    })
    .map((t) => t.id);
}

export async function loadSnapshot(
  workspaceId: string,
  workspaceName: string,
  revision: number,
  projectIds?: string[] | null,
): Promise<Snapshot> {
  const { purgeExpiredTrash } = await import("./trash");
  const purged = await purgeExpiredTrash(workspaceId);
  const effectiveRevision = purged > 0 ? revision + 1 : revision;
  const sql = await getSql();
  const filter = projectIds?.length ? projectIds : null;
  const [taskRows, agents, worktrees, events, projects, members] = await Promise.all([
    loadTasks(sql, workspaceId, filter ?? undefined),
    sql<AgentRow>`
      select id, name, kind,
        machine_name as "machineName",
        continuation_id as "continuationId",
        current_task_id as "currentTaskId",
        status,
        last_heartbeat as "lastHeartbeat"
      from agents where workspace_id = ${workspaceId} order by name`,
    filter
      ? sql<WorktreeRow>`
      select id,
        task_id as "taskId",
        agent_id as "agentId",
        path, branch,
        machine_name as "machineName",
        status,
        updated_at as "updatedAt"
      from worktrees where workspace_id = ${workspaceId} and project_id = any(${filter}) order by updated_at desc`
      : sql<WorktreeRow>`
      select id,
        task_id as "taskId",
        agent_id as "agentId",
        path, branch,
        machine_name as "machineName",
        status,
        updated_at as "updatedAt"
      from worktrees where workspace_id = ${workspaceId} order by updated_at desc`,
    sql<EventRow>`
      select id,
        task_id as "taskId",
        agent_id as "agentId",
        kind, message,
        created_at as "createdAt"
      from events where workspace_id = ${workspaceId} order by created_at desc limit 20`,
    filter
      ? sql<{ id: string; name: string; repo: string; defaultBranch: string; visibility: string }>`
      select id, name, repo, default_branch as "defaultBranch", visibility
      from projects where workspace_id = ${workspaceId} and id = any(${filter}) and deleted_at is null order by created_at asc`
      : sql<{ id: string; name: string; repo: string; defaultBranch: string; visibility: string }>`
      select id, name, repo, default_branch as "defaultBranch", visibility
      from projects where workspace_id = ${workspaceId} and deleted_at is null order by created_at asc`,
    listMembers(workspaceId),
  ]);
  const deps = await depMap(sql, workspaceId);
  const tasks = taskRows.map((t) => compact(t, deps.get(t.id) ?? []));
  const mapped = projects.map((p) => ({
    ...p,
    visibility: (p.visibility === "public" ? "public" : "private") as "public" | "private",
  }));
  const project = mapped[0] ?? {
    id: "",
    name: "Harbor",
    repo: "",
    defaultBranch: "main",
    visibility: "private" as const,
  };
  const projectKey = filter ? [...filter].sort().join(",") : "";
  const token = cacheTokenFor(workspaceId, effectiveRevision, projectKey);
  return {
    workspace: {
      id: workspaceId,
      name: workspaceName,
      revision: effectiveRevision,
      cacheToken: token,
    },
    project,
    projects: mapped,
    cacheToken: token,
    revision: effectiveRevision,
    tasks,
    agents,
    worktrees,
    events,
    members,
    readyIds: readyIds(tasks),
    mcpKey: demoMcpKey(workspaceId),
    myRole: null,
  };
}

export async function snapshotForUser(userId: string): Promise<Snapshot> {
  const ws = await workspaceForUser(userId);
  const snap = await loadSnapshot(ws.id, ws.name, ws.revision);
  const { projectRole, primaryProject } = await import("./projects");
  const project = snap.project.id ? snap.project : await primaryProject(ws.id);
  const role = project?.id ? await projectRole(project.id, userId) : null;
  return { ...snap, myRole: role };
}

export async function getTaskDetail(
  workspaceId: string,
  taskId: string,
): Promise<TaskDetail | null> {
  const sql = await getSql();
  const rows = await sql<TaskRecord>`
    select id, parent_id, title, body, kind, status, priority, project_id,
           assignee_user_id, assignee_agent_id, continuation_id, grok_session_id, grok_subagent_id,
           affinity_user_id, affinity_machine_name, branch, worktree_path,
           integration_status, blocked_reason, created_at, updated_at
    from tasks where workspace_id = ${workspaceId} and id = ${taskId} and deleted_at is null`;
  const t = rows[0];
  if (!t) return null;
  const deps = await sql<{ depends_on_id: string }>`
    select depends_on_id from task_deps where workspace_id = ${workspaceId} and task_id = ${taskId}`;
  const comments = await sql<CommentRow>`
    select id,
      task_id as "taskId",
      author_kind as "authorKind",
      author_name as "authorName",
      body,
      grok_session_id as "grokSessionId",
      created_at as "createdAt"
    from comments where workspace_id = ${workspaceId} and task_id = ${taskId}
    order by created_at asc`;
  const childRows = await sql<TaskRecord>`
    select id, parent_id, title, body, kind, status, priority, project_id,
           assignee_user_id, assignee_agent_id, continuation_id, grok_session_id, grok_subagent_id,
           affinity_user_id, affinity_machine_name, branch, worktree_path,
           integration_status, blocked_reason, created_at, updated_at
    from tasks where workspace_id = ${workspaceId} and parent_id = ${taskId} and deleted_at is null
    order by sort_order`;
  const childDeps = await depMap(sql, workspaceId);
  return {
    ...compact(
      t,
      deps.map((d) => d.depends_on_id),
    ),
    body: t.body,
    projectId: t.project_id,
    assigneeUserId: t.assignee_user_id,
    createdAt: t.created_at,
    comments,
    children: childRows.map((c) => compact(c, childDeps.get(c.id) ?? [])),
  };
}

async function recordEvent(
  sql: Sql,
  workspaceId: string,
  kind: string,
  message: string,
  taskId?: string | null,
  agentId?: string | null,
) {
  await sql`insert into events (id, workspace_id, task_id, agent_id, kind, message)
    values (${makeId("evt")}, ${workspaceId}, ${taskId ?? null}, ${agentId ?? null}, ${kind}, ${message})`;
}

export async function createTask(
  workspaceId: string,
  input: {
    title: string;
    body?: string | undefined;
    kind?: TaskKind | undefined;
    parentId?: string | null | undefined;
    depIds?: string[] | undefined;
    priority?: number | undefined;
    projectId?: string | undefined;
  },
) {
  const sql = await getSql();
  const projectId =
    input.projectId ||
    (
      await sql<{
        id: string;
      }>`select id from projects where workspace_id = ${workspaceId} and deleted_at is null order by created_at asc limit 1`
    )[0]?.id;
  if (!projectId) throw new Error("This board has no project.");
  const id = makeId("tsk");
  await sql`insert into tasks (id, workspace_id, project_id, parent_id, title, body, kind, status, priority)
    values (${id}, ${workspaceId}, ${projectId}, ${input.parentId ?? null}, ${input.title.trim()},
      ${input.body ?? ""}, ${input.kind ?? "feature"}, ${"backlog"}, ${input.priority ?? 1})`;
  for (const dep of input.depIds ?? []) {
    await sql`insert into task_deps (workspace_id, task_id, depends_on_id)
      values (${workspaceId}, ${id}, ${dep})`;
  }
  await recordEvent(sql, workspaceId, "create", `Created ${input.title.trim()}`, id);
  await bumpRevision(sql, workspaceId);
  return id;
}

export async function updateTask(
  workspaceId: string,
  taskId: string,
  patch: {
    title?: string | undefined;
    body?: string | undefined;
    status?: TaskStatus | undefined;
    kind?: TaskKind | undefined;
    priority?: number | undefined;
    continuationId?: string | null | undefined;
    grokSessionId?: string | null | undefined;
    grokSubagentId?: string | null | undefined;
    affinityMachineName?: string | null | undefined;
    affinityUserId?: string | null | undefined;
    branch?: string | null | undefined;
    worktreePath?: string | null | undefined;
    integrationStatus?: IntegrationStatus | undefined;
    blockedReason?: string | null | undefined;
    assigneeAgentId?: string | null | undefined;
  },
) {
  const sql = await getSql();
  const current = await sql<TaskRecord>`
    select id, parent_id, title, body, kind, status, priority, project_id,
           assignee_user_id, assignee_agent_id, continuation_id, grok_session_id, grok_subagent_id,
           affinity_user_id, affinity_machine_name, branch, worktree_path,
           integration_status, blocked_reason, created_at, updated_at
    from tasks where workspace_id = ${workspaceId} and id = ${taskId} and deleted_at is null`;
  const t = current[0];
  if (!t) return null;
  const next = {
    title: patch.title ?? t.title,
    body: patch.body ?? t.body,
    status: patch.status ?? t.status,
    kind: patch.kind ?? t.kind,
    priority: patch.priority ?? t.priority,
    continuationId: patch.continuationId === undefined ? t.continuation_id : patch.continuationId,
    grokSessionId: patch.grokSessionId === undefined ? t.grok_session_id : patch.grokSessionId,
    grokSubagentId: patch.grokSubagentId === undefined ? t.grok_subagent_id : patch.grokSubagentId,
    affinityMachineName:
      patch.affinityMachineName === undefined ? t.affinity_machine_name : patch.affinityMachineName,
    affinityUserId: patch.affinityUserId === undefined ? t.affinity_user_id : patch.affinityUserId,
    branch: patch.branch === undefined ? t.branch : patch.branch,
    worktreePath: patch.worktreePath === undefined ? t.worktree_path : patch.worktreePath,
    integrationStatus: patch.integrationStatus ?? t.integration_status,
    blockedReason: patch.blockedReason === undefined ? t.blocked_reason : patch.blockedReason,
    assigneeAgentId:
      patch.assigneeAgentId === undefined ? t.assignee_agent_id : patch.assigneeAgentId,
  };
  await sql`update tasks set
      title = ${next.title}, body = ${next.body}, status = ${next.status}, kind = ${next.kind},
      priority = ${next.priority}, continuation_id = ${next.continuationId},
      grok_session_id = ${next.grokSessionId}, grok_subagent_id = ${next.grokSubagentId},
      affinity_machine_name = ${next.affinityMachineName}, affinity_user_id = ${next.affinityUserId},
      branch = ${next.branch}, worktree_path = ${next.worktreePath}, integration_status = ${next.integrationStatus},
      blocked_reason = ${next.blockedReason}, assignee_agent_id = ${next.assigneeAgentId},
      updated_at = now()
    where workspace_id = ${workspaceId} and id = ${taskId}`;
  if (patch.status && patch.status !== t.status) {
    await recordEvent(
      sql,
      workspaceId,
      "status",
      `${t.title} → ${patch.status}`,
      taskId,
      next.assigneeAgentId,
    );
  }
  await bumpRevision(sql, workspaceId);
  return getTaskDetail(workspaceId, taskId);
}

export async function claimTask(
  workspaceId: string,
  taskId: string,
  agent: {
    id?: string | undefined;
    name: string;
    kind?: AgentKind | undefined;
    machineName?: string | undefined;
    continuationId?: string | undefined;
    grokSessionId?: string | undefined;
    grokSubagentId?: string | undefined;
  },
) {
  const sql = await getSql();
  let agentId = agent.id;
  if (agentId) {
    const found = await sql<{
      id: string;
    }>`select id from agents where workspace_id = ${workspaceId} and id = ${agentId}`;
    if (!found[0]) agentId = undefined;
  }
  const grokSessionId = agent.grokSessionId ?? null;
  const continuationId = agent.continuationId ?? grokSessionId ?? makeId("cont");
  if (!agentId) {
    agentId = makeId("agt");
    await sql`insert into agents (id, workspace_id, name, kind, machine_name, continuation_id, current_task_id, status, last_heartbeat)
      values (${agentId}, ${workspaceId}, ${agent.name}, ${agent.kind ?? "other"}, ${agent.machineName ?? ""},
        ${continuationId}, ${taskId}, ${"working"}, now())`;
  } else {
    await sql`update agents set continuation_id = ${continuationId}, current_task_id = ${taskId},
      status = ${"working"}, last_heartbeat = now(), machine_name = coalesce(nullif(${agent.machineName ?? ""}, ''), machine_name)
      where workspace_id = ${workspaceId} and id = ${agentId}`;
  }
  await sql`update tasks set status = ${"claimed"}, assignee_agent_id = ${agentId},
    continuation_id = ${continuationId},
    grok_session_id = coalesce(${grokSessionId}, grok_session_id),
    grok_subagent_id = coalesce(${agent.grokSubagentId ?? null}, grok_subagent_id),
    affinity_machine_name = coalesce(nullif(${agent.machineName ?? ""}, ''), affinity_machine_name),
    updated_at = now()
    where workspace_id = ${workspaceId} and id = ${taskId}`;
  await recordEvent(sql, workspaceId, "claim", `${agent.name} claimed task`, taskId, agentId);
  await bumpRevision(sql, workspaceId);
  return {
    taskId,
    agentId,
    continuationId,
    grokSessionId,
    grokSubagentId: agent.grokSubagentId ?? null,
  };
}

export async function decomposeTask(
  workspaceId: string,
  taskId: string,
  children: { title: string; body?: string | undefined; kind?: TaskKind | undefined }[],
) {
  const sql = await getSql();
  const parent = await sql<{ id: string; project_id: string; title: string }>`
    select id, project_id, title from tasks where workspace_id = ${workspaceId} and id = ${taskId} and deleted_at is null`;
  if (!parent[0]) return [];
  const ids: string[] = [];
  for (const child of children) {
    const id = makeId("tsk");
    await sql`insert into tasks (id, workspace_id, project_id, parent_id, title, body, kind, status, priority)
      values (${id}, ${workspaceId}, ${parent[0].project_id}, ${taskId}, ${child.title},
        ${child.body ?? ""}, ${child.kind ?? "feature"}, ${"backlog"}, 1)`;
    await sql`insert into task_deps (workspace_id, task_id, depends_on_id)
      values (${workspaceId}, ${id}, ${taskId})`;
    ids.push(id);
  }
  await recordEvent(
    sql,
    workspaceId,
    "decompose",
    `Split ${parent[0].title} into ${ids.length} tasks`,
    taskId,
  );
  await bumpRevision(sql, workspaceId);
  return ids;
}

export async function addComment(
  workspaceId: string,
  taskId: string,
  input: {
    authorKind: "user" | "agent";
    authorName: string;
    authorUserId?: string | undefined;
    authorAgentId?: string | undefined;
    body: string;
    grokSessionId?: string | undefined;
  },
) {
  const sql = await getSql();
  const id = makeId("cmt");
  await sql`insert into comments (id, workspace_id, task_id, author_kind, author_user_id, author_agent_id, author_name, body, grok_session_id)
    values (${id}, ${workspaceId}, ${taskId}, ${input.authorKind}, ${input.authorUserId ?? null},
      ${input.authorAgentId ?? null}, ${input.authorName}, ${input.body.trim()}, ${input.grokSessionId ?? null})`;
  await recordEvent(
    sql,
    workspaceId,
    "comment",
    input.body.trim().slice(0, 140),
    taskId,
    input.authorAgentId,
  );
  await bumpRevision(sql, workspaceId);
  return id;
}

export async function heartbeat(
  workspaceId: string,
  input: {
    agentId?: string | undefined;
    name: string;
    kind?: AgentKind | undefined;
    machineName?: string | undefined;
    continuationId?: string | undefined;
    grokSessionId?: string | undefined;
    currentTaskId?: string | null | undefined;
    status?: AgentStatus | undefined;
  },
) {
  const sql = await getSql();
  const continuationId = input.continuationId ?? input.grokSessionId ?? makeId("cont");
  let agentId = input.agentId;
  if (agentId) {
    const found = await sql<{
      id: string;
    }>`select id from agents where workspace_id = ${workspaceId} and id = ${agentId}`;
    if (!found[0]) agentId = undefined;
  }
  if (!agentId && input.continuationId) {
    const byCont = await sql<{ id: string }>`
      select id from agents where workspace_id = ${workspaceId} and continuation_id = ${input.continuationId} limit 1`;
    agentId = byCont[0]?.id;
  }
  if (!agentId && input.grokSessionId) {
    const bySess = await sql<{ id: string }>`
      select assignee_agent_id as id from tasks
      where workspace_id = ${workspaceId} and grok_session_id = ${input.grokSessionId} and deleted_at is null limit 1`;
    agentId = bySess[0]?.id ?? undefined;
  }
  if (!agentId) {
    agentId = makeId("agt");
    await sql`insert into agents (id, workspace_id, name, kind, machine_name, continuation_id, current_task_id, status, last_heartbeat)
      values (${agentId}, ${workspaceId}, ${input.name}, ${input.kind ?? "other"}, ${input.machineName ?? ""},
        ${continuationId}, ${input.currentTaskId ?? null}, ${input.status ?? "working"}, now())`;
  } else {
    await sql`update agents set
      name = ${input.name},
      kind = ${input.kind ?? "other"},
      machine_name = coalesce(nullif(${input.machineName ?? ""}, ''), machine_name),
      continuation_id = ${continuationId},
      current_task_id = ${input.currentTaskId ?? null},
      status = ${input.status ?? "working"},
      last_heartbeat = now()
      where workspace_id = ${workspaceId} and id = ${agentId}`;
  }
  if (input.currentTaskId) {
    await sql`update tasks set
      continuation_id = ${continuationId},
      grok_session_id = coalesce(${input.grokSessionId ?? null}, grok_session_id),
      assignee_agent_id = ${agentId},
      affinity_machine_name = coalesce(nullif(${input.machineName ?? ""}, ''), affinity_machine_name),
      updated_at = now()
      where workspace_id = ${workspaceId} and id = ${input.currentTaskId}`;
  }
  await bumpRevision(sql, workspaceId);
  return { agentId, continuationId, grokSessionId: input.grokSessionId ?? null };
}

export async function registerWorktree(
  workspaceId: string,
  input: {
    path: string;
    branch: string;
    machineName?: string | undefined;
    agentId?: string | undefined;
    taskId?: string | undefined;
    status?: WorktreeStatus | undefined;
  },
) {
  const sql = await getSql();
  let projectId = "";
  if (input.taskId) {
    const task = await sql<{ project_id: string }>`
      select project_id from tasks where workspace_id = ${workspaceId} and id = ${input.taskId} and deleted_at is null limit 1`;
    projectId = task[0]?.project_id ?? "";
  }
  if (!projectId) {
    const projects = await sql<{
      id: string;
    }>`select id from projects where workspace_id = ${workspaceId} and deleted_at is null order by created_at asc limit 1`;
    projectId = projects[0]?.id ?? "";
  }
  const existing = await sql<{ id: string }>`
    select id from worktrees
    where workspace_id = ${workspaceId} and path = ${input.path} and machine_name = ${input.machineName ?? ""}
    limit 1`;
  const id = existing[0]?.id ?? makeId("wt");
  if (existing[0]) {
    await sql`update worktrees set branch = ${input.branch}, agent_id = ${input.agentId ?? null},
      task_id = ${input.taskId ?? null}, status = ${input.status ?? "active"}, updated_at = now()
      where id = ${id} and workspace_id = ${workspaceId}`;
  } else {
    await sql`insert into worktrees (id, workspace_id, project_id, agent_id, task_id, path, branch, machine_name, status)
      values (${id}, ${workspaceId}, ${projectId}, ${input.agentId ?? null}, ${input.taskId ?? null},
        ${input.path}, ${input.branch}, ${input.machineName ?? ""}, ${input.status ?? "active"})`;
  }
  if (input.taskId) {
    await sql`update tasks set branch = ${input.branch}, worktree_path = ${input.path}, updated_at = now()
      where workspace_id = ${workspaceId} and id = ${input.taskId}`;
  }
  await recordEvent(
    sql,
    workspaceId,
    "worktree",
    `${input.path} @ ${input.branch}`,
    input.taskId,
    input.agentId,
  );
  await bumpRevision(sql, workspaceId);
  return id;
}

export async function nextReady(workspaceId: string, projectIds?: string[] | null) {
  const sql = await getSql();
  const ws = await sql<{
    name: string;
    revision: number;
  }>`select name, revision from workspaces where id = ${workspaceId}`;
  if (!ws[0]) return null;
  const snap = await loadSnapshot(workspaceId, ws[0].name, ws[0].revision, projectIds);
  const next = snap.tasks.find((t) => snap.readyIds.includes(t.id));
  return next ?? null;
}

export async function mintApiKey(workspaceId: string, userId: string, name: string) {
  const sql = await getSql();
  const key = newApiKey();
  const id = makeId("key");
  await sql`insert into api_keys (id, workspace_id, name, key_hash, key_prefix, created_by_user_id)
    values (${id}, ${workspaceId}, ${name.trim() || "Agent key"}, ${key.hash}, ${key.prefix}, ${userId})`;
  await bumpRevision(sql, workspaceId);
  return { id, plaintext: key.plaintext, prefix: key.prefix, name: name.trim() || "Agent key" };
}

export async function listApiKeys(workspaceId: string) {
  const sql = await getSql();
  return sql<{
    id: string;
    name: string;
    key_prefix: string;
    last_used_at: string | null;
    created_at: string;
  }>`
    select id, name, key_prefix, last_used_at, created_at from api_keys
    where workspace_id = ${workspaceId} order by created_at desc`;
}

export async function touchApiKey(keyHash: string) {
  const sql = await getSql();
  await sql`update api_keys set last_used_at = now() where key_hash = ${keyHash}`;
}
