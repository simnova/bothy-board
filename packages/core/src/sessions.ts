import { getSql, type Sql } from "@bothy-board/db";
import { assertMailboxBody } from "./factory";
import { makeId, makeUuid } from "./ids";
import { claimTask, getTaskDetail, heartbeat } from "./queries";
import type { CommentRow } from "./types";
import { bumpRevision } from "./workspace";

export function spawnCommand(sessionId: string, taskId: string): string {
  return `grok -s ${sessionId} -w -p "Use BothyBoard MCP. Call bothy-board_sessions_bind with grokSessionId from GROK_SESSION_ID and taskId=${taskId}. Then bothy-board_tasks_get, execute the spec, and poll bothy-board_mailbox_poll_"`;
}

export function resumeCommand(sessionId: string, taskId: string): string {
  return `grok --resume ${sessionId} -p "Read BothyBoard task ${taskId}. Poll bothy-board_mailbox_poll, address new comments, then continue."`;
}

export function resumeFromHint(subagentId: string): string {
  return `spawn_subagent resume_from=${subagentId} — continues the finished child in place (same transcript and worktree). Do not use this on a still-running child.`;
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

export type Affinity = {
  allowed: boolean;
  parkedOn: string | null;
  reason: string | null;
};

export function checkAffinity(
  task: {
    affinityMachineName: string | null;
    affinityUserId: string | null;
    grokSessionId: string | null;
  },
  input: {
    machineName?: string | undefined;
    userId?: string | undefined;
    grokSessionId?: string | undefined;
  },
): Affinity {
  const parked = task.affinityMachineName;
  if (!parked) return { allowed: true, parkedOn: null, reason: null };
  const machine = (input.machineName ?? "").trim();
  if (machine && machine === parked) return { allowed: true, parkedOn: parked, reason: null };
  if (
    input.grokSessionId &&
    task.grokSessionId &&
    input.grokSessionId === task.grokSessionId &&
    !machine
  ) {
    return { allowed: true, parkedOn: parked, reason: null };
  }
  return {
    allowed: false,
    parkedOn: parked,
    reason: `Session is parked on ${parked}. Resume only on that machine (Grok sessions are local to ~/.grok/sessions). Use bothy-board_mailbox_poll / comment to talk to the worker.`,
  };
}

export async function mintSession(
  workspaceId: string,
  taskId: string,
  input: { machineName: string; userId?: string | undefined },
) {
  const sql = await getSql();
  const rows = await sql<{
    grok_session_id: string | null;
    grok_subagent_id: string | null;
    affinity_machine_name: string | null;
    affinity_user_id: string | null;
    title: string;
  }>`select grok_session_id, grok_subagent_id, affinity_machine_name, affinity_user_id, title
     from tasks where workspace_id = ${workspaceId} and id = ${taskId} and deleted_at is null`;
  const t = rows[0];
  if (!t) return null;

  const sessionId = t.grok_session_id || makeUuid();
  const machine = input.machineName.trim();
  await sql`update tasks set
      grok_session_id = ${sessionId},
      continuation_id = coalesce(continuation_id, ${sessionId}),
      affinity_machine_name = ${machine || t.affinity_machine_name},
      affinity_user_id = ${input.userId ?? t.affinity_user_id},
      updated_at = now()
    where workspace_id = ${workspaceId} and id = ${taskId}`;
  await recordEvent(
    sql,
    workspaceId,
    "session",
    `Minted Grok session ${sessionId} on ${machine || "unbound"}`,
    taskId,
  );
  await bumpRevision(sql, workspaceId);
  const task = await getTaskDetail(workspaceId, taskId);
  return {
    taskId,
    grokSessionId: sessionId,
    grokSubagentId: t.grok_subagent_id,
    affinityMachineName: machine || t.affinity_machine_name,
    spawnCommand: spawnCommand(sessionId, taskId),
    resumeCommand: resumeCommand(sessionId, taskId),
    note: "Pass -s before spawn. Subagent IDs are assigned at spawn — bind them with bothy-board_sessions_bind_ Grok cannot message a running child; use the mailbox.",
    task,
  };
}

export async function bindSession(
  workspaceId: string,
  input: {
    grokSessionId: string;
    taskId?: string | undefined;
    grokSubagentId?: string | undefined;
    machineName?: string | undefined;
    name?: string | undefined;
    kind?: "grok" | "cursor" | "claude" | "codex" | "other" | undefined;
    agentId?: string | undefined;
    userId?: string | undefined;
  },
) {
  const sql = await getSql();
  const sessionId = input.grokSessionId.trim();
  if (!sessionId) return { error: "grokSessionId required" };

  const taskId = input.taskId;
  if (!taskId) {
    return { error: "taskId required" };
  }

  const rows = await sql<{
    grok_session_id: string | null;
    affinity_machine_name: string | null;
    affinity_user_id: string | null;
    status: string;
    factory: string;
    assignee_agent_id: string | null;
    title: string;
  }>`select grok_session_id, affinity_machine_name, affinity_user_id, status, factory, assignee_agent_id, title
     from tasks where workspace_id = ${workspaceId} and id = ${taskId} and deleted_at is null`;
  const t = rows[0];
  if (!t) return { error: "task not found" };

  const affinity = checkAffinity(
    {
      grokSessionId: t.grok_session_id,
      affinityMachineName: t.affinity_machine_name,
      affinityUserId: t.affinity_user_id,
    },
    { machineName: input.machineName, userId: input.userId, grokSessionId: sessionId },
  );
  if (!affinity.allowed) {
    return { error: affinity.reason, parkedOn: affinity.parkedOn, allowed: false };
  }

  if (t.status === "ready" && t.factory === "Planted") {
    try {
      await claimTask(workspaceId, taskId, {
        id: input.agentId,
        name: input.name ?? "grok-build",
        kind: input.kind ?? "grok",
        machineName: input.machineName,
        continuationId: sessionId,
        grokSessionId: sessionId,
        grokSubagentId: input.grokSubagentId,
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : "claim failed" };
    }
  } else if (t.status !== "claimed" && t.status !== "in_progress") {
    return { error: "bind_without_claim" };
  }

  const beat = await heartbeat(workspaceId, {
    agentId: input.agentId,
    name: input.name ?? "grok-build",
    kind: input.kind ?? "grok",
    machineName: input.machineName,
    continuationId: sessionId,
    grokSessionId: sessionId,
    currentTaskId: taskId,
    status: "working",
  });

  await sql`update tasks set
      grok_session_id = ${sessionId},
      grok_subagent_id = coalesce(${input.grokSubagentId ?? null}, grok_subagent_id),
      continuation_id = ${sessionId},
      assignee_agent_id = ${beat.agentId},
      affinity_machine_name = coalesce(nullif(${input.machineName ?? ""}, ''), affinity_machine_name),
      factory = ${"Dispatched"},
      status = ${"in_progress"},
      updated_at = now()
    where workspace_id = ${workspaceId} and id = ${taskId}
      and status in ('claimed','in_progress')`;
  await recordEvent(
    sql,
    workspaceId,
    "bind",
    `Bound GROK_SESSION_ID ${sessionId}`,
    taskId,
    beat.agentId,
  );
  await bumpRevision(sql, workspaceId);
  const task = await getTaskDetail(workspaceId, taskId);
  return {
    allowed: true,
    agentId: beat.agentId,
    grokSessionId: sessionId,
    grokSubagentId: input.grokSubagentId ?? task?.grokSubagentId ?? null,
    taskId,
    affinityMachineName: task?.affinityMachineName ?? input.machineName ?? null,
    resumeFromHint: task?.grokSubagentId ? resumeFromHint(task.grokSubagentId) : null,
    task,
  };
}

export async function resumeSession(
  workspaceId: string,
  input: {
    taskId: string;
    machineName?: string | undefined;
    grokSessionId?: string | undefined;
    userId?: string | undefined;
  },
) {
  const task = await getTaskDetail(workspaceId, input.taskId);
  if (!task) return { error: "task not found" };
  const affinity = checkAffinity(task, input);
  if (!affinity.allowed) {
    return {
      allowed: false,
      parkedOn: affinity.parkedOn,
      reason: affinity.reason,
      mailbox:
        "Post bothy-board_mailbox_post / bothy-board_tasks_comment_ The worker on that machine should poll.",
      grokSessionId: task.grokSessionId,
      grokSubagentId: task.grokSubagentId,
    };
  }
  if (!task.grokSessionId) {
    return {
      allowed: false,
      reason: "No grokSessionId on this task. Call bothy-board_sessions_mint first.",
      parkedOn: null,
    };
  }
  return {
    allowed: true,
    parkedOn: task.affinityMachineName,
    grokSessionId: task.grokSessionId,
    grokSubagentId: task.grokSubagentId,
    resumeCommand: resumeCommand(task.grokSessionId, task.id),
    resumeFromHint: task.grokSubagentId ? resumeFromHint(task.grokSubagentId) : null,
    note: "resume_from only works after the child has finished, on this machine. Grok cannot inject a prompt into a running subagent.",
    task,
  };
}

export async function pollMailbox(
  workspaceId: string,
  taskId: string,
  since?: string,
): Promise<{ taskId: string; comments: CommentRow[]; nextSince: string; unread: number }> {
  const sql = await getSql();
  const comments = since
    ? await sql<CommentRow>`
        select id,
          task_id as "taskId",
          author_kind as "authorKind",
          author_name as "authorName",
          body,
          grok_session_id as "grokSessionId",
          created_at as "createdAt"
        from comments
        where workspace_id = ${workspaceId} and task_id = ${taskId} and created_at > ${since}
        order by created_at asc`
    : await sql<CommentRow>`
        select id,
          task_id as "taskId",
          author_kind as "authorKind",
          author_name as "authorName",
          body,
          grok_session_id as "grokSessionId",
          created_at as "createdAt"
        from comments
        where workspace_id = ${workspaceId} and task_id = ${taskId}
        order by created_at asc`;
  const last = comments.at(-1)?.createdAt ?? since ?? new Date().toISOString();
  return { taskId, comments, nextSince: last, unread: comments.length };
}

export async function postMailbox(
  workspaceId: string,
  taskId: string,
  input: {
    body: string;
    authorName: string;
    authorKind: "user" | "agent";
    authorUserId?: string | undefined;
    authorAgentId?: string | undefined;
    grokSessionId?: string | undefined;
  },
) {
  assertMailboxBody(input.body);
  const sql = await getSql();
  const id = makeId("cmt");
  await sql`insert into comments (id, workspace_id, task_id, author_kind, author_user_id, author_agent_id, author_name, body, grok_session_id)
    values (${id}, ${workspaceId}, ${taskId}, ${input.authorKind}, ${input.authorUserId ?? null},
      ${input.authorAgentId ?? null}, ${input.authorName}, ${input.body.trim()}, ${input.grokSessionId ?? null})`;
  await recordEvent(
    sql,
    workspaceId,
    "mailbox",
    input.body.trim().slice(0, 140),
    taskId,
    input.authorAgentId,
  );
  await bumpRevision(sql, workspaceId);
  return { id, task: await getTaskDetail(workspaceId, taskId) };
}
