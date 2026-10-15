import { getSql } from "@bothy-board/db";
import type { Actor } from "./actor";
import { BoardError } from "./errors";
import { makeId } from "./ids";
import {
  canonicalFilter,
  clampMaxEvents,
  clampReplayMs,
  decodeCursor,
  type EventFilter,
  type EventOccurrence,
  encodeCursor,
  type FeedRow,
  MCP_EVENTS_TTL_MS,
  type McpEventName,
  nextPollMs,
  pageFeed,
} from "./mcp-events";

const PAGE_CAP = 200;

export function actorKey(actor: Actor): string {
  if (actor.type === "pat") return `pat:${actor.tokenId}`;
  if (actor.type === "user") return `user:${actor.userId}`;
  return `agent:${actor.keyId}`;
}

export function iso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString();
}

type AuditSqlRow = {
  id: string;
  kind: string;
  message: string;
  created_at: string | Date;
  task_id: string | null;
  project_id: string | null;
  lane: string | null;
  priority: number | null;
  title: string | null;
};

type CommentSqlRow = AuditSqlRow & {
  author_agent_id: string | null;
  grok_session_id: string | null;
  body: string;
};

function auditKinds(name: McpEventName): string[] | null {
  if (name === "task.ready") return ["plant", "release"];
  if (name === "task.landed") return ["landed"];
  if (name === "task.review") return ["status"];
  return null;
}

async function dbNow(): Promise<string> {
  const sql = await getSql();
  const rows = await sql<{ now: string | Date }>`select now() as now`;
  return iso(rows[0]?.now ?? new Date());
}

export async function nowCursor(): Promise<string> {
  return encodeCursor(await dbNow(), "");
}

function replayFloor(
  cursor: { at: string; id: string } | null,
  maxAgeMs: number,
  nowMs: number,
): {
  cursor: { at: string; id: string } | null;
  truncated: boolean;
} {
  if (!cursor) return { cursor: null, truncated: false };
  const at = Date.parse(cursor.at);
  if (Number.isNaN(at)) return { cursor: null, truncated: false };
  const floor = nowMs - maxAgeMs;
  if (at >= floor) return { cursor, truncated: false };
  return { cursor: { at: new Date(floor).toISOString(), id: "" }, truncated: true };
}

async function selectAudit(
  workspaceId: string,
  name: McpEventName,
  filter: EventFilter,
  allowed: string[] | null,
  after: { at: string; id: string } | null,
  fromNow: boolean,
  limit: number,
): Promise<FeedRow[]> {
  const kinds = auditKinds(name);
  if (!kinds) return [];
  const sql = await getSql();
  const params: unknown[] = [workspaceId, kinds];
  let where = `e.workspace_id = $1 and e.kind = any($2::text[]) and t.deleted_at is null`;
  if (name === "task.review") where += ` and e.message like '%→ review'`;
  if (fromNow) {
    where += ` and e.created_at > now()`;
  } else if (after) {
    params.push(after.at, after.id);
    const a = params.length - 1;
    const b = params.length;
    where += ` and (e.created_at > $${a} or (e.created_at = $${a} and e.id > $${b}))`;
  }
  if (filter.projectId) {
    params.push(filter.projectId);
    where += ` and t.project_id = $${params.length}`;
  } else if (allowed) {
    params.push(allowed);
    where += ` and t.project_id = any($${params.length}::text[])`;
  }
  if (filter.taskId) {
    params.push(filter.taskId);
    where += ` and e.task_id = $${params.length}`;
  }
  if (filter.lane && name === "task.ready") {
    params.push(filter.lane);
    where += ` and t.lane = $${params.length}`;
  }
  params.push(limit);
  const rows = await sql.query<AuditSqlRow>(
    `select e.id, e.kind, e.message, e.created_at, e.task_id, t.project_id, t.lane, t.priority, t.title
     from events e
     join tasks t on t.id = e.task_id and t.workspace_id = e.workspace_id
     where ${where}
     order by e.created_at, e.id
     limit $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    message: row.message,
    createdAt: iso(row.created_at),
    taskId: row.task_id,
    projectId: row.project_id,
    lane: row.lane,
    priority: row.priority,
    title: row.title,
  }));
}

async function selectComments(
  workspaceId: string,
  filter: EventFilter,
  allowed: string[] | null,
  after: { at: string; id: string } | null,
  fromNow: boolean,
  limit: number,
): Promise<FeedRow[]> {
  const sql = await getSql();
  const params: unknown[] = [workspaceId];
  let where = `c.workspace_id = $1 and t.deleted_at is null`;
  if (fromNow) {
    where += ` and c.created_at > now()`;
  } else if (after) {
    params.push(after.at, after.id);
    const a = params.length - 1;
    const b = params.length;
    where += ` and (c.created_at > $${a} or (c.created_at = $${a} and c.id > $${b}))`;
  }
  if (filter.projectId) {
    params.push(filter.projectId);
    where += ` and t.project_id = $${params.length}`;
  } else if (allowed) {
    params.push(allowed);
    where += ` and t.project_id = any($${params.length}::text[])`;
  }
  const ids = filter.taskIds?.length ? filter.taskIds : filter.taskId ? [filter.taskId] : null;
  if (ids) {
    params.push(ids);
    where += ` and c.task_id = any($${params.length}::text[])`;
  }
  params.push(limit);
  const rows = await sql.query<CommentSqlRow>(
    `select c.id, 'comment' as kind, '' as message, c.created_at, c.task_id, t.project_id, t.lane,
            t.priority, t.title, c.author_agent_id, c.grok_session_id, c.body
     from comments c
     join tasks t on t.id = c.task_id and t.workspace_id = c.workspace_id
     where ${where}
     order by c.created_at, c.id
     limit $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    kind: "comment",
    message: "",
    createdAt: iso(row.created_at),
    taskId: row.task_id,
    projectId: row.project_id,
    lane: row.lane,
    priority: row.priority,
    title: row.title,
    authorAgentId: row.author_agent_id,
    grokSessionId: row.grok_session_id,
    body: row.body,
  }));
}

export type PollInput = {
  name: McpEventName;
  filter: EventFilter;
  allowedProjectIds: string[] | null;
  cursor: string | null;
  maxEvents?: unknown;
  maxAgeMs?: unknown;
};

export async function pollEventFeed(
  workspaceId: string,
  input: PollInput,
): Promise<{
  events: EventOccurrence[];
  cursor: string;
  truncated: boolean;
  hasMore: boolean;
  nextPollMs: number;
}> {
  const decoded = input.cursor ? decodeCursor(input.cursor) : null;
  if (input.cursor && !decoded)
    throw new BoardError("invalid_cursor", "cursor is not a BothyBoard event cursor.");
  const maxEvents = clampMaxEvents(input.maxEvents);
  const replayMs = clampReplayMs(input.maxAgeMs);
  const nowMs = Date.now();
  const bounded = replayFloor(decoded, replayMs, nowMs);
  const fromNow = !input.cursor;
  const page = Math.min(PAGE_CAP, Math.max(maxEvents * 4, maxEvents + 1));
  const rows =
    input.name === "mailbox.message"
      ? await selectComments(
          workspaceId,
          input.filter,
          input.allowedProjectIds,
          bounded.cursor,
          fromNow,
          page,
        )
      : await selectAudit(
          workspaceId,
          input.name,
          input.filter,
          input.allowedProjectIds,
          bounded.cursor,
          fromNow,
          page,
        );
  const paged = pageFeed(rows, input.name, input.filter, maxEvents, rows.length === page);
  const cursor = paged.cursor ?? (input.cursor && decoded ? input.cursor : await nowCursor());
  const hasMore = paged.hasMore;
  return {
    events: paged.events,
    cursor,
    truncated: bounded.truncated,
    hasMore,
    nextPollMs: nextPollMs(hasMore),
  };
}

type SubRow = {
  id: string;
  name: string;
  arguments: EventFilter | string;
  cursor: string | null;
  expires_at: string | Date;
};

function parseArgs(value: EventFilter | string): EventFilter {
  if (typeof value === "string") return JSON.parse(value) as EventFilter;
  return value ?? {};
}

export async function subscribeEvent(input: {
  workspaceId: string;
  actor: Actor;
  name: McpEventName;
  filter: EventFilter;
  cursor?: string | null;
}): Promise<{ id: string; cursor: string; refreshBefore: number; expiresAt: string }> {
  const sql = await getSql();
  const key = actorKey(input.actor);
  const args = canonicalFilter(input.filter);
  const cursor = input.cursor && decodeCursor(input.cursor) ? input.cursor : await nowCursor();
  const expires = new Date(Date.now() + MCP_EVENTS_TTL_MS).toISOString();
  const found = await sql.query<SubRow>(
    `select id, name, arguments, cursor, expires_at from mcp_event_subscriptions
     where workspace_id = $1 and actor_key = $2 and name = $3 and arguments = $4::jsonb`,
    [input.workspaceId, key, input.name, JSON.stringify(args)],
  );
  const existing = found[0];
  if (existing) {
    await sql.query(
      `update mcp_event_subscriptions set expires_at = $2, updated_at = now(), cursor = coalesce($3, cursor)
       where id = $1`,
      [existing.id, expires, input.cursor ? cursor : null],
    );
    return {
      id: existing.id,
      cursor: input.cursor ? cursor : (existing.cursor ?? cursor),
      refreshBefore: MCP_EVENTS_TTL_MS,
      expiresAt: expires,
    };
  }
  const id = makeId("sub");
  try {
    await sql.query(
      `insert into mcp_event_subscriptions (id, workspace_id, actor_key, name, arguments, cursor, expires_at)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [id, input.workspaceId, key, input.name, JSON.stringify(args), cursor, expires],
    );
  } catch (err) {
    const again = await sql.query<SubRow>(
      `select id, cursor from mcp_event_subscriptions
       where workspace_id = $1 and actor_key = $2 and name = $3 and arguments = $4::jsonb`,
      [input.workspaceId, key, input.name, JSON.stringify(args)],
    );
    if (!again[0]) throw err;
    return {
      id: again[0].id,
      cursor: again[0].cursor ?? cursor,
      refreshBefore: MCP_EVENTS_TTL_MS,
      expiresAt: expires,
    };
  }
  return { id, cursor, refreshBefore: MCP_EVENTS_TTL_MS, expiresAt: expires };
}

export async function loadSubscription(
  workspaceId: string,
  actor: Actor,
  id: string,
): Promise<{ id: string; name: string; filter: EventFilter; cursor: string | null }> {
  const sql = await getSql();
  const rows = await sql.query<SubRow>(
    `select id, name, arguments, cursor, expires_at from mcp_event_subscriptions
     where id = $1 and workspace_id = $2 and actor_key = $3`,
    [id, workspaceId, actorKey(actor)],
  );
  const row = rows[0];
  if (!row) throw new BoardError("not_found", "Subscription not found.");
  if (new Date(iso(row.expires_at)).getTime() <= Date.now()) {
    await sql.query(`delete from mcp_event_subscriptions where id = $1`, [id]);
    throw new BoardError("subscription_expired", "Subscription expired. events/subscribe again.");
  }
  return { id: row.id, name: row.name, filter: parseArgs(row.arguments), cursor: row.cursor };
}

export async function touchSubscription(
  workspaceId: string,
  actor: Actor,
  id: string,
  cursor: string,
): Promise<void> {
  const sql = await getSql();
  const expires = new Date(Date.now() + MCP_EVENTS_TTL_MS).toISOString();
  await sql.query(
    `update mcp_event_subscriptions set cursor = $4, expires_at = $5, updated_at = now()
     where id = $1 and workspace_id = $2 and actor_key = $3`,
    [id, workspaceId, actorKey(actor), cursor, expires],
  );
}

export async function unsubscribeEvent(
  workspaceId: string,
  actor: Actor,
  id: string,
): Promise<boolean> {
  const sql = await getSql();
  const rows = await sql.query<{ id: string }>(
    `delete from mcp_event_subscriptions where id = $1 and workspace_id = $2 and actor_key = $3 returning id`,
    [id, workspaceId, actorKey(actor)],
  );
  if (rows[0]) return true;
  const other = await sql.query<{ id: string }>(
    `select id from mcp_event_subscriptions where id = $1 and workspace_id = $2`,
    [id, workspaceId],
  );
  if (other[0]) throw new BoardError("forbidden", "Subscription belongs to another actor.");
  return true;
}
