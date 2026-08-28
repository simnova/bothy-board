import { getSql, type Sql } from "@bothy-board/db";
import { assertCard, cardFromInput, type FailedTreatment, serializeCard } from "./card";
import { BoardError } from "./errors";
import {
  assertChangedUnderRoots,
  assertClaimable,
  assertContractPatch,
  assertMailboxBody,
  assertWorkerPatch,
  clampCap,
  dequeueIds,
  MAX_IN_FLIGHT_PER_PROJECT,
  MAX_INTEGRATING_PER_PROJECT,
  parseFactory,
  parsePriority,
  SNAPSHOT_TASK_CAP,
  type WriterKind,
  writeRootsOverlap,
} from "./factory";
import { assertFields, dumpFields, type FieldMap, parseFieldMap, valuesFromBody } from "./fields";
import { cacheTokenFor, newApiKey } from "./hash";
import { makeId } from "./ids";
import { listMembers } from "./team";
import type {
  AgentKind,
  AgentRow,
  AgentStatus,
  CommentRow,
  CompactTask,
  EventRow,
  FactoryState,
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
  factory: string;
  lane: string | null;
  write_roots: unknown;
  objective: string;
  done_when: unknown;
  out_of_scope: string;
  known_good: string;
  not_tested: string;
  failed_treatments: unknown;
  no_grade: boolean;
  proofs_lines: unknown;
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
  fields: unknown;
  created_at: string;
  updated_at: string;
};

function asTreatments(value: unknown): FailedTreatment[] {
  if (!Array.isArray(value)) return [];
  const out: FailedTreatment[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const name = String(rec["name"] ?? "").trim();
    if (!name) continue;
    out.push({ name, produced: String(rec["produced"] ?? "") });
  }
  return out;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function jsonb(value: unknown): string {
  return JSON.stringify(value ?? []);
}

function compact(t: TaskRecord, depIds: string[], childCount: number): CompactTask {
  return {
    id: t.id,
    parentId: t.parent_id,
    projectId: t.project_id,
    title: t.title,
    kind: t.kind,
    status: t.status,
    factory: parseFactory(t.factory),
    lane: t.lane,
    writeRoots: asStringArray(t.write_roots),
    objective: t.objective ?? "",
    doneWhen: asStringArray(t.done_when),
    knownGood: t.known_good ?? "",
    failedTreatments: asTreatments(t.failed_treatments),
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
    childCount,
    fields: parseFieldMap(t.fields),
    updatedAt: t.updated_at,
  };
}

const TASK_SELECT = `id, parent_id, title, body, kind, status, factory, lane, write_roots, objective, done_when,
  out_of_scope, known_good, not_tested, failed_treatments, no_grade, proofs_lines, priority, project_id,
  assignee_user_id, assignee_agent_id, continuation_id, grok_session_id, grok_subagent_id,
  affinity_user_id, affinity_machine_name, branch, worktree_path,
  integration_status, blocked_reason, fields, created_at, updated_at`;

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

async function loadTasksSafe(
  sql: Sql,
  workspaceId: string,
  projectIds?: string[] | null,
): Promise<TaskRecord[]> {
  if (projectIds && projectIds.length === 0) return [];
  if (projectIds?.length) {
    return sql.query<TaskRecord>(
      `select ${TASK_SELECT} from tasks where workspace_id = $1 and project_id = any($2) and deleted_at is null order by sort_order asc, created_at asc`,
      [workspaceId, projectIds],
    );
  }
  return sql.query<TaskRecord>(
    `select ${TASK_SELECT} from tasks where workspace_id = $1 and deleted_at is null order by sort_order asc, created_at asc`,
    [workspaceId],
  );
}

function childCounts(tasks: { id: string; parentId: string | null }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tasks) {
    if (!t.parentId) continue;
    map.set(t.parentId, (map.get(t.parentId) ?? 0) + 1);
  }
  return map;
}

export async function reapStaleAgents(workspaceId: string): Promise<number> {
  const sql = await getSql();
  const stale = await sql<{ id: string }>`
    select id from agents
    where workspace_id = ${workspaceId}
      and status <> ${"offline"}
      and last_heartbeat is not null
      and last_heartbeat < now() - interval '10 minutes'`;
  if (!stale.length) return 0;
  const ids = stale.map((r) => r.id);
  await sql.query(`update agents set status = 'offline' where workspace_id = $1 and id = any($2)`, [
    workspaceId,
    ids,
  ]);
  const released = await sql.query<{ id: string }>(
    `update tasks set status = 'ready', factory = 'Planted', assignee_agent_id = null, updated_at = now()
     where workspace_id = $1 and assignee_agent_id = any($2)
       and status in ('claimed','in_progress')
       and factory in ('Planted','Dispatched')
       and deleted_at is null
     returning id`,
    [workspaceId, ids],
  );
  for (const row of released) {
    await recordEvent(sql, workspaceId, "reaped", "Claim reaped after heartbeat TTL", row.id);
  }
  if (released.length) await bumpRevision(sql, workspaceId);
  return released.length;
}

export async function loadSnapshot(
  workspaceId: string,
  workspaceName: string,
  revision: number,
  projectIds?: string[] | null,
): Promise<Snapshot> {
  const { purgeExpiredTrash } = await import("./trash");
  const purged = await purgeExpiredTrash(workspaceId);
  const reaped = await reapStaleAgents(workspaceId);
  const effectiveRevision = purged > 0 || reaped > 0 ? revision + 1 : revision;
  const sql = await getSql();
  const filter = projectIds?.length ? projectIds : null;
  const taskRows = await loadTasksSafe(sql, workspaceId, filter);
  const incomplete = taskRows.length >= SNAPSHOT_TASK_CAP;
  const visibleIds = taskRows.map((t) => t.id);

  const [agents, worktrees, events, projects, members] = await Promise.all([
    filter
      ? sql.query<AgentRow>(
          `select id, name, kind,
            machine_name as "machineName",
            continuation_id as "continuationId",
            current_task_id as "currentTaskId",
            status, last_heartbeat as "lastHeartbeat"
           from agents
           where workspace_id = $1
             and (
               current_task_id = any($2)
               or id in (select agent_id from worktrees where workspace_id = $1 and project_id = any($3) and agent_id is not null)
             )
           order by name`,
          [workspaceId, visibleIds.length ? visibleIds : [""], filter],
        )
      : sql<AgentRow>`
      select id, name, kind,
        machine_name as "machineName",
        continuation_id as "continuationId",
        current_task_id as "currentTaskId",
        status, last_heartbeat as "lastHeartbeat"
      from agents where workspace_id = ${workspaceId} order by name`,
    filter
      ? sql<WorktreeRow>`
      select id, task_id as "taskId", agent_id as "agentId", path, branch,
        machine_name as "machineName", status, updated_at as "updatedAt"
      from worktrees where workspace_id = ${workspaceId} and project_id = any(${filter}) order by updated_at desc`
      : sql<WorktreeRow>`
      select id, task_id as "taskId", agent_id as "agentId", path, branch,
        machine_name as "machineName", status, updated_at as "updatedAt"
      from worktrees where workspace_id = ${workspaceId} order by updated_at desc`,
    filter
      ? sql<EventRow>`
      select e.id, e.task_id as "taskId", e.agent_id as "agentId", e.kind, e.message, e.created_at as "createdAt"
      from events e
      join tasks t on t.id = e.task_id
      where e.workspace_id = ${workspaceId} and t.project_id = any(${filter})
      order by e.created_at desc limit 20`
      : sql<EventRow>`
      select id, task_id as "taskId", agent_id as "agentId", kind, message, created_at as "createdAt"
      from events where workspace_id = ${workspaceId} order by created_at desc limit 20`,
    filter
      ? sql<{
          id: string;
          name: string;
          repo: string;
          defaultBranch: string;
          visibility: string;
          maxInFlight: number;
          maxIntegrating: number;
        }>`
      select id, name, repo, default_branch as "defaultBranch", visibility,
        coalesce(max_in_flight, 2) as "maxInFlight",
        coalesce(max_integrating, 1) as "maxIntegrating"
      from projects where workspace_id = ${workspaceId} and id = any(${filter}) and deleted_at is null order by created_at asc`
      : sql<{
          id: string;
          name: string;
          repo: string;
          defaultBranch: string;
          visibility: string;
          maxInFlight: number;
          maxIntegrating: number;
        }>`
      select id, name, repo, default_branch as "defaultBranch", visibility,
        coalesce(max_in_flight, 2) as "maxInFlight",
        coalesce(max_integrating, 1) as "maxIntegrating"
      from projects where workspace_id = ${workspaceId} and deleted_at is null order by created_at asc`,
    listMembers(workspaceId, filter),
  ]);

  const deps = await depMap(sql, workspaceId);
  const counts = childCounts(taskRows.map((t) => ({ id: t.id, parentId: t.parent_id })));
  const tasks = taskRows.map((t) => compact(t, deps.get(t.id) ?? [], counts.get(t.id) ?? 0));
  const visible = new Set(tasks.map((t) => t.id));
  const scopedAgents = agents.map((a) =>
    a.currentTaskId && !visible.has(a.currentTaskId) ? { ...a, currentTaskId: null } : a,
  );
  const { listFieldsForProjects } = await import("./project-fields");
  const schemaByProject = await listFieldsForProjects(projects.map((p) => p.id));
  const mapped = projects.map((p) => ({
    ...p,
    visibility: (p.visibility === "public" ? "public" : "private") as "public" | "private",
    fields: schemaByProject.get(p.id) ?? [],
    maxInFlight: clampCap(p.maxInFlight, MAX_IN_FLIGHT_PER_PROJECT),
    maxIntegrating: clampCap(p.maxIntegrating, MAX_INTEGRATING_PER_PROJECT),
  }));
  const project = mapped[0] ?? {
    id: "",
    name: "Harbor",
    repo: "",
    defaultBranch: "main",
    visibility: "private" as const,
    fields: [],
    maxInFlight: MAX_IN_FLIGHT_PER_PROJECT,
    maxIntegrating: MAX_INTEGRATING_PER_PROJECT,
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
    agents: scopedAgents,
    worktrees,
    events,
    members,
    readyIds: dequeueIds(tasks),
    incomplete,
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
  const rows = await sql.query<TaskRecord>(
    `select ${TASK_SELECT} from tasks where workspace_id = $1 and id = $2 and deleted_at is null`,
    [workspaceId, taskId],
  );
  const t = rows[0];
  if (!t) return null;
  const deps = await sql<{ depends_on_id: string }>`
    select depends_on_id from task_deps where workspace_id = ${workspaceId} and task_id = ${taskId}`;
  const comments = await sql<CommentRow>`
    select id, task_id as "taskId", author_kind as "authorKind", author_name as "authorName",
      body, grok_session_id as "grokSessionId", created_at as "createdAt"
    from comments where workspace_id = ${workspaceId} and task_id = ${taskId}
    order by created_at asc`;
  const childRows = await sql.query<TaskRecord>(
    `select ${TASK_SELECT} from tasks where workspace_id = $1 and parent_id = $2 and deleted_at is null order by sort_order`,
    [workspaceId, taskId],
  );
  const childDeps = await depMap(sql, workspaceId);
  const counts = childCounts([
    { id: t.id, parentId: t.parent_id },
    ...childRows.map((c) => ({ id: c.id, parentId: c.parent_id })),
  ]);
  return {
    ...compact(
      t,
      deps.map((d) => d.depends_on_id),
      counts.get(t.id) ?? childRows.length,
    ),
    body: t.body,
    projectId: t.project_id,
    assigneeUserId: t.assignee_user_id,
    outOfScope: t.out_of_scope ?? "",
    knownGood: t.known_good ?? "",
    notTested: t.not_tested ?? "",
    noGrade: Boolean(t.no_grade),
    proofsLines: asStringArray(t.proofs_lines),
    createdAt: t.created_at,
    comments,
    children: childRows.map((c) => compact(c, childDeps.get(c.id) ?? [], counts.get(c.id) ?? 0)),
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

async function assertDepsExist(sql: Sql, workspaceId: string, depIds: string[]) {
  if (!depIds.length) return;
  const rows = await sql.query<{ id: string }>(
    `select id from tasks where workspace_id = $1 and id = any($2) and deleted_at is null`,
    [workspaceId, depIds],
  );
  if (rows.length !== depIds.length) {
    throw new BoardError("dep_missing", "Dependency is missing or in trash.");
  }
}

async function wouldCycle(
  sql: Sql,
  workspaceId: string,
  taskId: string,
  dependsOnId: string,
): Promise<boolean> {
  if (taskId === dependsOnId) return true;
  const rows = await sql<{ task_id: string; depends_on_id: string }>`
    select task_id, depends_on_id from task_deps where workspace_id = ${workspaceId}`;
  const adj = new Map<string, string[]>();
  for (const r of rows) {
    const list = adj.get(r.task_id) ?? [];
    list.push(r.depends_on_id);
    adj.set(r.task_id, list);
  }
  const stack = [...(adj.get(dependsOnId) ?? [])];
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop();
    if (!n || seen.has(n)) continue;
    if (n === taskId) return true;
    seen.add(n);
    stack.push(...(adj.get(n) ?? []));
  }
  return false;
}

export type CreateTaskInput = {
  title: string;
  body?: string | undefined;
  kind?: TaskKind | undefined;
  parentId?: string | null | undefined;
  depIds?: string[] | undefined;
  priority?: number | string | undefined;
  projectId?: string | undefined;
  objective?: string | undefined;
  doneWhen?: string[] | undefined;
  writeRoots?: string[] | undefined;
  lane?: string | null | undefined;
  knownGood?: string | undefined;
  outOfScope?: string | undefined;
  notTested?: string | undefined;
  extra?: Record<string, string> | undefined;
  fields?: FieldMap | undefined;
};

export async function createTask(workspaceId: string, input: CreateTaskInput) {
  const sql = await getSql();
  const projectId =
    input.projectId ||
    (
      await sql<{ id: string }>`
        select id from projects where workspace_id = ${workspaceId} and deleted_at is null order by created_at asc limit 1`
    )[0]?.id;
  if (!projectId) throw new BoardError("no_project", "This board has no project.");
  const title = input.title.trim();
  const { listProjectFields } = await import("./project-fields");
  const schema = await listProjectFields(projectId);
  const card = cardFromInput({ ...input, title });
  const mergedFields = {
    ...valuesFromBody(schema, card.extra),
    ...(input.fields ?? {}),
  };
  if (typeof mergedFields["lane"] === "string") card.lane = mergedFields["lane"];
  const roots = mergedFields["write-roots"] ?? mergedFields["write_roots"];
  if (Array.isArray(roots)) card.writeRoots = roots.map(String);
  else if (typeof roots === "string") card.writeRoots = roots.split(/[,\s]+/).filter(Boolean);
  assertCard(card, "create", title);
  const fields = assertFields(schema, mergedFields, {
    title,
    body: `${title}\n${input.body ?? card.objective}`,
    gate: "create",
  });
  card.extra = { ...card.extra, ...dumpFields(schema, fields) };
  const body = serializeCard(card);
  await assertDepsExist(sql, workspaceId, input.depIds ?? []);
  for (const dep of input.depIds ?? []) {
    const id = makeId("tsk");
    if (await wouldCycle(sql, workspaceId, id, dep)) {
      throw new BoardError("cycle", "Dependency cycle refused.");
    }
  }
  const id = makeId("tsk");
  await sql.query(
    `insert into tasks (
       id, workspace_id, project_id, parent_id, title, body, kind, status, factory, priority,
       lane, write_roots, objective, done_when, out_of_scope, known_good, not_tested, fields
     ) values ($1,$2,$3,$4,$5,$6,$7,'backlog','Idle',$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14,$15,$16::jsonb)`,
    [
      id,
      workspaceId,
      projectId,
      input.parentId ?? null,
      title,
      body,
      input.kind ?? "feature",
      input.priority !== undefined ? parsePriority(input.priority) : 1,
      card.lane,
      jsonb(card.writeRoots),
      card.objective,
      jsonb(card.doneWhen),
      card.outOfScope,
      card.knownGood,
      card.notTested,
      JSON.stringify(fields),
    ],
  );
  for (const dep of input.depIds ?? []) {
    await sql`insert into task_deps (workspace_id, task_id, depends_on_id)
      values (${workspaceId}, ${id}, ${dep})`;
  }
  await recordEvent(sql, workspaceId, "create", `Created ${title}`, id);
  await bumpRevision(sql, workspaceId);
  return id;
}

export const IMPORT_MAX = 200;

export async function importTasks(
  workspaceId: string,
  projectId: string,
  cards: CreateTaskInput[],
) {
  if (cards.length > IMPORT_MAX) {
    throw new BoardError("too_large", `Import is capped at ${IMPORT_MAX} cards per call.`);
  }
  const created: string[] = [];
  const errors: { index: number; error: string; code?: string | undefined }[] = [];
  for (const [index, card] of cards.entries()) {
    try {
      const id = await createTask(workspaceId, { ...card, projectId });
      created.push(id);
    } catch (err) {
      const item: { index: number; error: string; code?: string } = {
        index,
        error: err instanceof Error ? err.message : "import failed",
      };
      if (err instanceof BoardError) item.code = err.code;
      errors.push(item);
    }
  }
  return { created, errors, imported: created.length, refused: errors.length };
}

export async function plantTask(workspaceId: string, taskId: string) {
  const sql = await getSql();
  const rows = await sql.query<TaskRecord>(
    `select ${TASK_SELECT} from tasks where workspace_id = $1 and id = $2 and deleted_at is null`,
    [workspaceId, taskId],
  );
  const t = rows[0];
  if (!t) throw new BoardError("not_found", "Task not found.");
  if (parseFactory(t.factory) !== "Idle") {
    throw new BoardError("forbidden", "Only Idle tasks can be Planted.");
  }
  const card = cardFromInput({
    title: t.title,
    body: t.body,
    objective: t.objective,
    doneWhen: asStringArray(t.done_when),
    writeRoots: asStringArray(t.write_roots),
    lane: t.lane,
    knownGood: t.known_good,
    outOfScope: t.out_of_scope,
    notTested: t.not_tested,
  });
  const { listProjectFields } = await import("./project-fields");
  const schema = await listProjectFields(t.project_id);
  const stored = {
    ...valuesFromBody(schema, card.extra),
    ...parseFieldMap(t.fields),
  };
  const fields = assertFields(schema, stored, {
    title: t.title,
    body: `${t.title}\n${t.body}`,
    gate: "plant",
  });
  assertCard(card, "plant", t.title);
  assertChangedUnderRoots(card.doneWhen, card.writeRoots);
  card.extra = { ...card.extra, ...dumpFields(schema, fields) };
  const body = serializeCard(card);
  await sql.query(
    `update tasks set factory = 'Planted', status = 'ready', body = $3,
      objective = $4, done_when = $5::jsonb, write_roots = $6::jsonb, lane = $7,
      fields = $8::jsonb, updated_at = now()
     where workspace_id = $1 and id = $2 and factory = 'Idle'`,
    [
      workspaceId,
      taskId,
      body,
      card.objective,
      jsonb(card.doneWhen),
      jsonb(card.writeRoots),
      (typeof fields["lane"] === "string" ? fields["lane"] : card.lane) ?? null,
      JSON.stringify(fields),
    ],
  );
  await recordEvent(sql, workspaceId, "plant", `${t.title} Planted`, taskId);
  await bumpRevision(sql, workspaceId);
  return getTaskDetail(workspaceId, taskId);
}

export async function setProofs(
  workspaceId: string,
  input: {
    taskId: string;
    proofsOk: boolean;
    headSha?: string | undefined;
    reportPath?: string | undefined;
    reportSha256?: string | undefined;
    proofsLines?: string[] | undefined;
  },
) {
  const sql = await getSql();
  const rows = await sql.query<TaskRecord>(
    `select ${TASK_SELECT} from tasks where workspace_id = $1 and id = $2 and deleted_at is null`,
    [workspaceId, input.taskId],
  );
  const t = rows[0];
  if (!t) throw new BoardError("not_found", "Task not found.");
  if (!input.proofsOk) {
    await sql`update tasks set proofs_ok = false, blocked_reason = ${"proofs failed"},
      status = ${"blocked"}, updated_at = now()
      where workspace_id = ${workspaceId} and id = ${input.taskId}`;
    await recordEvent(sql, workspaceId, "proofs", "proofsOk=false", input.taskId);
    await bumpRevision(sql, workspaceId);
    return getTaskDetail(workspaceId, input.taskId);
  }
  if (t.status !== "review" && t.status !== "integrating") {
    throw new BoardError("forbidden", "proofs.set requires status=review.");
  }
  const doneWhen = asStringArray(t.done_when);
  const writeRoots = asStringArray(t.write_roots);
  assertChangedUnderRoots(doneWhen, writeRoots);
  const treeLines = doneWhen.filter((line) =>
    /^(exists:|min-bytes:|run:|changed:|measured-before:|live:)/.test(
      line.replace(/^\s*-\s+/, "").trim(),
    ),
  );
  const proofsLines = (input.proofsLines?.length ? input.proofsLines : treeLines).map((s) =>
    s.replace(/^\s*-\s+/, "").trim(),
  );
  const caps = await sql<{ max_integrating: number }>`
    select coalesce(max_integrating, 1)::int as max_integrating from projects where id = ${t.project_id}`;
  const cap = clampCap(caps[0]?.max_integrating, MAX_INTEGRATING_PER_PROJECT);
  const integrating = await sql<{ n: number }>`
    select count(*)::int as n from tasks
    where project_id = ${t.project_id} and deleted_at is null
      and status = ${"integrating"} and id <> ${t.id}`;
  if ((integrating[0]?.n ?? 0) >= cap) {
    throw new BoardError("lane_busy", "Serial integrate: another card is already integrating.");
  }
  const reportPath = input.reportPath?.trim() || null;
  const reportSha = input.reportSha256?.trim().toLowerCase() || null;
  if (reportPath && !/^[a-f0-9]{64}$/.test(reportSha ?? "")) {
    throw new BoardError(
      "invalid_card",
      "reportPath requires reportSha256 (64-char hex of the verify JSON).",
    );
  }
  await sql.query(
    `update tasks set factory = 'Landed', status = 'integrating', proofs_ok = true,
      proofs_head_sha = $3, proofs_report_path = $4, proofs_report_sha256 = $5, proofs_lines = $6::jsonb, updated_at = now()
     where workspace_id = $1 and id = $2`,
    [workspaceId, input.taskId, input.headSha ?? null, reportPath, reportSha, jsonb(proofsLines)],
  );
  await recordEvent(sql, workspaceId, "landed", `${t.title} Landed`, input.taskId);
  await bumpRevision(sql, workspaceId);
  return getTaskDetail(workspaceId, input.taskId);
}

export async function updateTask(
  workspaceId: string,
  taskId: string,
  patch: {
    title?: string | undefined;
    body?: string | undefined;
    status?: TaskStatus | undefined;
    factory?: FactoryState | undefined;
    kind?: TaskKind | undefined;
    priority?: number | string | undefined;
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
    writer?: WriterKind | undefined;
    fields?: FieldMap | undefined;
    objective?: string | undefined;
    doneWhen?: string[] | undefined;
    writeRoots?: string[] | undefined;
    knownGood?: string | undefined;
    outOfScope?: string | undefined;
    notTested?: string | undefined;
  },
) {
  const sql = await getSql();
  const current = await sql.query<TaskRecord>(
    `select ${TASK_SELECT} from tasks where workspace_id = $1 and id = $2 and deleted_at is null`,
    [workspaceId, taskId],
  );
  const t = current[0];
  if (!t) return null;
  const writer = patch.writer ?? "owner";
  if (writer === "agent") assertWorkerPatch({ status: patch.status, factory: patch.factory });
  assertContractPatch(writer, parseFactory(t.factory), {
    title: patch.title,
    body: patch.body,
    objective: patch.objective,
    doneWhen: patch.doneWhen,
    writeRoots: patch.writeRoots,
    knownGood: patch.knownGood,
    outOfScope: patch.outOfScope,
    notTested: patch.notTested,
  });
  if (writer !== "orchestrator" && writer !== "owner" && patch.factory === "Landed") {
    throw new BoardError("forbidden", "Only proofs.set lands a task.");
  }
  if (patch.status === "done" && parseFactory(t.factory) !== "Landed" && !t.no_grade) {
    throw new BoardError("forbidden", "done requires factory=Landed.");
  }
  if (patch.factory === "Graded" && parseFactory(t.factory) !== "Landed") {
    throw new BoardError("forbidden", "Grade requires Landed.");
  }
  let fields = parseFieldMap(t.fields);
  let lane = t.lane;
  if (patch.fields && writer !== "agent") {
    const { listProjectFields } = await import("./project-fields");
    const schema = await listProjectFields(t.project_id);
    fields = assertFields(
      schema,
      { ...fields, ...patch.fields },
      {
        title: patch.title ?? t.title,
        body: patch.body ?? t.body,
        gate: parseFactory(t.factory) === "Idle" ? "create" : "plant",
      },
    );
    if (typeof fields["lane"] === "string") lane = fields["lane"];
  }
  const next = {
    title: patch.title ?? t.title,
    body: patch.body ?? t.body,
    status: patch.status ?? t.status,
    kind: patch.kind ?? t.kind,
    factory:
      patch.status === "cancelled" ? ("Idle" as const) : (patch.factory ?? parseFactory(t.factory)),
    priority: patch.priority !== undefined ? parsePriority(patch.priority) : t.priority,
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
      factory = ${next.factory},
      priority = ${next.priority}, continuation_id = ${next.continuationId},
      grok_session_id = ${next.grokSessionId}, grok_subagent_id = ${next.grokSubagentId},
      affinity_machine_name = ${next.affinityMachineName}, affinity_user_id = ${next.affinityUserId},
      branch = ${next.branch}, worktree_path = ${next.worktreePath}, integration_status = ${next.integrationStatus},
      blocked_reason = ${next.blockedReason}, assignee_agent_id = ${next.assigneeAgentId},
      lane = ${lane}, fields = ${JSON.stringify(fields)}::jsonb,
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

async function ensureAgent(
  sql: Sql,
  workspaceId: string,
  agent: {
    id?: string | undefined;
    name: string;
    kind?: AgentKind | undefined;
    machineName?: string | undefined;
    continuationId: string;
    taskId?: string | null;
  },
): Promise<string> {
  let agentId = agent.id;
  if (agentId) {
    const found = await sql<{ id: string }>`
      select id from agents where workspace_id = ${workspaceId} and id = ${agentId}`;
    if (!found[0]) agentId = undefined;
  }
  if (!agentId) {
    agentId = makeId("agt");
    await sql`insert into agents (id, workspace_id, name, kind, machine_name, continuation_id, current_task_id, status, last_heartbeat)
      values (${agentId}, ${workspaceId}, ${agent.name}, ${agent.kind ?? "other"}, ${agent.machineName ?? ""},
        ${agent.continuationId}, ${agent.taskId ?? null}, ${"working"}, now())`;
  } else {
    await sql`update agents set continuation_id = ${agent.continuationId}, current_task_id = ${agent.taskId ?? null},
      status = ${"working"}, last_heartbeat = now(),
      machine_name = coalesce(nullif(${agent.machineName ?? ""}, ''), machine_name)
      where workspace_id = ${workspaceId} and id = ${agentId}`;
  }
  return agentId;
}

async function assertLaneFree(sql: Sql, workspaceId: string, task: TaskRecord) {
  const inflight = await sql.query<{
    id: string;
    write_roots: unknown;
    status: string;
    factory: string;
  }>(
    `select id, write_roots, status, factory from tasks
     where workspace_id = $1 and project_id = $2 and deleted_at is null
       and id <> $3
       and status in ('claimed','in_progress','review')
       and factory in ('Planted','Dispatched')`,
    [workspaceId, task.project_id, task.id],
  );
  const capRow = await sql<{ max_in_flight: number }>`
    select coalesce(max_in_flight, 2)::int as max_in_flight from projects where id = ${task.project_id}`;
  const cap = clampCap(capRow[0]?.max_in_flight, MAX_IN_FLIGHT_PER_PROJECT);
  const mine = asStringArray(task.write_roots);
  const overlapping = inflight.filter((row) =>
    writeRootsOverlap(mine, asStringArray(row.write_roots)),
  );
  if (inflight.length >= cap) {
    throw new BoardError("lane_busy", `In-flight cap (${cap}) for this project.`);
  }
  if (overlapping.length && mine.length) {
    throw new BoardError("lane_busy", "write_roots overlap an in-flight task.");
  }
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
  await reapStaleAgents(workspaceId);
  const sql = await getSql();
  const grokSessionId = agent.grokSessionId ?? null;
  const continuationId = agent.continuationId ?? grokSessionId ?? makeId("cont");
  const current = await sql.query<TaskRecord>(
    `select ${TASK_SELECT} from tasks where workspace_id = $1 and id = $2 and deleted_at is null`,
    [workspaceId, taskId],
  );
  const t = current[0];
  if (!t) throw new BoardError("not_found", "Task not found.");
  if (!agent.machineName?.trim()) {
    throw new BoardError("not_ready", "machineName required to claim.");
  }
  const kids = await sql<{ n: number }>`
    select count(*)::int as n from tasks where workspace_id = ${workspaceId} and parent_id = ${taskId} and deleted_at is null`;
  assertClaimable({
    status: t.status,
    factory: parseFactory(t.factory),
    assigneeAgentId: t.assignee_agent_id,
    childCount: kids[0]?.n ?? 0,
  });
  await assertLaneFree(sql, workspaceId, t);
  const agentId = await ensureAgent(sql, workspaceId, {
    ...agent,
    continuationId,
    taskId,
  });
  const held = await sql<{ id: string; status: string }>`
    select id, status from tasks
    where workspace_id = ${workspaceId} and assignee_agent_id = ${agentId}
      and id <> ${taskId} and deleted_at is null
      and status in ('claimed', 'in_progress')`;
  if (held.some((row) => row.status === "in_progress")) {
    throw new BoardError("lane_busy", "This agent already has in-progress work; release first.");
  }
  await sql.query(
    `update tasks set status = 'ready', factory = 'Planted', assignee_agent_id = null, updated_at = now()
     where workspace_id = $1 and assignee_agent_id = $2 and id <> $3
       and status = 'claimed' and deleted_at is null`,
    [workspaceId, agentId, taskId],
  );
  const won = await sql.query<{ id: string }>(
    `update tasks set status = 'claimed', assignee_agent_id = $3, continuation_id = $4,
      grok_session_id = coalesce($5, grok_session_id),
      grok_subagent_id = coalesce($6, grok_subagent_id),
      affinity_machine_name = coalesce(nullif($7, ''), affinity_machine_name),
      updated_at = now()
     where workspace_id = $1 and id = $2
       and status = 'ready' and factory = 'Planted'
       and assignee_agent_id is null and deleted_at is null
     returning id`,
    [
      workspaceId,
      taskId,
      agentId,
      continuationId,
      grokSessionId,
      agent.grokSubagentId ?? null,
      agent.machineName ?? "",
    ],
  );
  if (!won[0]) throw new BoardError("already_claimed", "Task already claimed.");
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
  children: {
    title: string;
    body?: string | undefined;
    kind?: TaskKind | undefined;
    depIds?: string[];
  }[],
) {
  const sql = await getSql();
  const parent = await sql.query<TaskRecord>(
    `select ${TASK_SELECT} from tasks where workspace_id = $1 and id = $2 and deleted_at is null`,
    [workspaceId, taskId],
  );
  if (!parent[0]) return [];
  const p = parent[0];
  const ids: string[] = [];
  for (const child of children) {
    const card = cardFromInput({
      title: child.title,
      body: child.body ?? p.body,
      objective: p.objective,
      doneWhen: asStringArray(p.done_when),
      writeRoots: asStringArray(p.write_roots),
      lane: p.lane,
    });
    assertCard(card, "create", child.title);
    const id = makeId("tsk");
    await sql.query(
      `insert into tasks (
         id, workspace_id, project_id, parent_id, title, body, kind, status, factory, priority,
         lane, write_roots, objective, done_when, out_of_scope, known_good, not_tested, fields,
         failed_treatments
       ) values ($1,$2,$3,$4,$5,$6,$7,'backlog','Idle',1,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15::jsonb,$16::jsonb)`,
      [
        id,
        workspaceId,
        p.project_id,
        taskId,
        child.title.trim(),
        serializeCard(card),
        child.kind ?? p.kind,
        card.lane,
        jsonb(card.writeRoots),
        card.objective,
        jsonb(card.doneWhen),
        card.outOfScope || p.out_of_scope,
        card.knownGood || p.known_good,
        card.notTested || p.not_tested,
        JSON.stringify(parseFieldMap(p.fields)),
        jsonb(asTreatments(p.failed_treatments)),
      ],
    );
    for (const dep of child.depIds ?? []) {
      if (dep === taskId) continue;
      await assertDepsExist(sql, workspaceId, [dep]);
      if (await wouldCycle(sql, workspaceId, id, dep)) {
        throw new BoardError("cycle", "Dependency cycle refused.");
      }
      await sql`insert into task_deps (workspace_id, task_id, depends_on_id)
        values (${workspaceId}, ${id}, ${dep})`;
    }
    ids.push(id);
  }
  await recordEvent(
    sql,
    workspaceId,
    "decompose",
    `Split ${p.title} into ${ids.length} tasks`,
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
  assertMailboxBody(input.body);
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
  await reapStaleAgents(workspaceId);
  const sql = await getSql();
  const continuationId = input.continuationId ?? input.grokSessionId ?? makeId("cont");
  let agentId = input.agentId;
  if (agentId) {
    const found = await sql<{ id: string }>`
      select id from agents where workspace_id = ${workspaceId} and id = ${agentId}`;
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
    const owned = await sql<{ id: string }>`
      select id from tasks
      where workspace_id = ${workspaceId} and id = ${input.currentTaskId ?? ""}
        and assignee_agent_id = ${agentId} and deleted_at is null`;
    const taskId = owned[0]?.id ?? null;
    await sql`update agents set
      name = ${input.name},
      kind = ${input.kind ?? "other"},
      machine_name = coalesce(nullif(${input.machineName ?? ""}, ''), machine_name),
      continuation_id = ${continuationId},
      current_task_id = ${taskId},
      status = ${input.status ?? "working"},
      last_heartbeat = now()
      where workspace_id = ${workspaceId} and id = ${agentId}`;
  }
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
  if (!input.taskId) throw new BoardError("task_required", "worktrees.register requires taskId.");
  if (!input.machineName?.trim()) {
    throw new BoardError("worktree_busy", "machineName required to register a worktree.");
  }
  const sql = await getSql();
  const task = await sql<{
    project_id: string;
    affinity_machine_name: string | null;
    worktree_path: string | null;
  }>`
    select project_id, affinity_machine_name, worktree_path
    from tasks where workspace_id = ${workspaceId} and id = ${input.taskId} and deleted_at is null limit 1`;
  const projectId = task[0]?.project_id;
  if (!projectId) throw new BoardError("not_found", "Task not found.");
  const parked = task[0]?.affinity_machine_name?.trim();
  const machine = input.machineName.trim();
  if (parked && parked !== machine) {
    throw new BoardError(
      "worktree_busy",
      `Worktree machine must match claim affinity (${parked}).`,
    );
  }
  const existingPath = task[0]?.worktree_path?.trim();
  if (existingPath && existingPath !== input.path) {
    throw new BoardError("worktree_busy", "Worktree path must match the claimed checkout.");
  }
  const clashAgent = await sql<{ agent_id: string | null }>`
    select agent_id from worktrees
    where workspace_id = ${workspaceId} and status = ${"active"}
      and path = ${input.path} and machine_name = ${machine}
      and agent_id is not null and agent_id <> ${input.agentId ?? ""}
    limit 1`;
  if (clashAgent[0]) {
    throw new BoardError("worktree_busy", "Path is active for another agent on this machine.");
  }
  const clashMachine = await sql<{ machine_name: string }>`
    select machine_name from worktrees
    where workspace_id = ${workspaceId} and status = ${"active"}
      and path = ${input.path} and machine_name <> ${machine}
    limit 1`;
  if (clashMachine[0]) {
    throw new BoardError("worktree_busy", `Path is active on ${clashMachine[0].machine_name}.`);
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
        ${input.path}, ${input.branch}, ${machine}, ${input.status ?? "active"})`;
  }
  await sql`update tasks set branch = ${input.branch}, worktree_path = ${input.path}, updated_at = now()
    where workspace_id = ${workspaceId} and id = ${input.taskId}`;
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

export async function nextReady(
  workspaceId: string,
  projectIds?: string[] | null,
  opts?: {
    machineName?: string | null | undefined;
    cacheToken?: string | null | undefined;
  },
) {
  await reapStaleAgents(workspaceId);
  const sql = await getSql();
  const ws = await sql<{ name: string; revision: number }>`
    select name, revision from workspaces where id = ${workspaceId}`;
  const empty = {
    task: null as CompactTask | null,
    spawnCommand: null as string | null,
    grokSessionId: null as string | null,
    cacheToken: "" as string,
    unchanged: false,
    incomplete: false,
  };
  if (!ws[0]) return empty;
  const count = await sql<{ n: number }>`
    select count(*)::int as n from tasks where workspace_id = ${workspaceId} and deleted_at is null`;
  if ((count[0]?.n ?? 0) > SNAPSHOT_TASK_CAP) {
    throw new BoardError(
      "snapshot_incomplete",
      "Snapshot truncated — refuse next rather than rank a prefix.",
    );
  }
  const snap = await loadSnapshot(workspaceId, ws[0].name, ws[0].revision, projectIds);
  if (snap.incomplete) {
    throw new BoardError(
      "snapshot_incomplete",
      "Snapshot truncated — refuse next rather than rank a prefix.",
    );
  }
  if (opts?.cacheToken && opts.cacheToken === snap.cacheToken) {
    return { ...empty, cacheToken: snap.cacheToken, unchanged: true };
  }
  const cap = snap.project.maxInFlight;
  const id = dequeueIds(snap.tasks, {
    machineName: opts?.machineName ?? null,
    maxInFlight: cap,
  })[0];
  let task = id ? (snap.tasks.find((t) => t.id === id) ?? null) : null;
  if (!task) {
    return { ...empty, cacheToken: snap.cacheToken };
  }
  const { mintSession, spawnCommand } = await import("./sessions");
  let session = task.grokSessionId;
  let spawn: string | null = null;
  const machine = opts?.machineName?.trim() || task.affinityMachineName || "";
  if (session) {
    spawn = spawnCommand(session, task.id);
  } else {
    const minted = await mintSession(workspaceId, task.id, { machineName: machine });
    session = minted?.grokSessionId ?? null;
    spawn = minted?.spawnCommand ?? null;
    if (minted?.task) {
      task = {
        ...task,
        grokSessionId: minted.task.grokSessionId,
        continuationId: minted.task.continuationId,
        affinityMachineName: minted.task.affinityMachineName,
      };
    }
  }
  const rev = await sql<{
    revision: number;
  }>`select revision from workspaces where id = ${workspaceId}`;
  const token = cacheTokenFor(
    workspaceId,
    rev[0]?.revision ?? snap.revision,
    projectIds?.length ? [...projectIds].sort().join(",") : "",
  );
  return {
    task,
    spawnCommand: spawn,
    grokSessionId: session,
    cacheToken: token,
    unchanged: false,
    incomplete: false,
  };
}

export async function releaseTask(workspaceId: string, taskId: string, agentId?: string | null) {
  const sql = await getSql();
  const t = await sql.query<TaskRecord>(
    `select ${TASK_SELECT} from tasks where workspace_id = $1 and id = $2 and deleted_at is null`,
    [workspaceId, taskId],
  );
  if (!t[0]) throw new BoardError("not_found", "Task not found.");
  if (agentId && t[0].assignee_agent_id && t[0].assignee_agent_id !== agentId) {
    throw new BoardError("forbidden", "Only the claimant or an owner can release this lease.");
  }
  const won = await sql.query<{ id: string }>(
    `update tasks set status = 'ready', factory = 'Planted', assignee_agent_id = null, updated_at = now()
     where workspace_id = $1 and id = $2
       and status in ('claimed','in_progress')
       and factory in ('Planted','Dispatched')
       and deleted_at is null
     returning id`,
    [workspaceId, taskId],
  );
  if (!won[0]) throw new BoardError("not_ready", "Task is not on an active lease.");
  await recordEvent(sql, workspaceId, "release", "Claim released", taskId, agentId ?? undefined);
  await bumpRevision(sql, workspaceId);
  return getTaskDetail(workspaceId, taskId);
}

export async function failTreatment(
  workspaceId: string,
  taskId: string,
  input: { name: string; produced: string },
) {
  const name = input.name.trim();
  const produced = input.produced.trim();
  if (!name) throw new BoardError("invalid_card", "Treatment name required.");
  const sql = await getSql();
  const rows = await sql.query<TaskRecord>(
    `select ${TASK_SELECT} from tasks where workspace_id = $1 and id = $2 and deleted_at is null`,
    [workspaceId, taskId],
  );
  const t = rows[0];
  if (!t) throw new BoardError("not_found", "Task not found.");
  const treatments = asTreatments(t.failed_treatments);
  treatments.push({ name, produced });
  const card = cardFromInput({
    title: t.title,
    body: t.body,
    objective: t.objective,
    doneWhen: asStringArray(t.done_when),
    writeRoots: asStringArray(t.write_roots),
    lane: t.lane,
    knownGood: t.known_good,
    outOfScope: t.out_of_scope,
    notTested: t.not_tested,
  });
  card.failedTreatments = treatments;
  await sql.query(
    `update tasks set failed_treatments = $3::jsonb, body = $4, updated_at = now()
     where workspace_id = $1 and id = $2`,
    [workspaceId, taskId, jsonb(treatments), serializeCard(card)],
  );
  await recordEvent(sql, workspaceId, "treatment", `${name}: ${produced}`.slice(0, 140), taskId);
  await bumpRevision(sql, workspaceId);
  return getTaskDetail(workspaceId, taskId);
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
