import { resolveProjectScope } from "./actor.ts";

/** Wakes. Never a claim — the caller still CAS-dequeues with tasks.next. */
export const MCP_EVENT_NAMES = [
  "task.ready",
  "task.review",
  "task.landed",
  "mailbox.message",
] as const;
export type McpEventName = (typeof MCP_EVENT_NAMES)[number];

export const MCP_EVENT_DELIVERY = ["poll"] as const;
export const MCP_EVENTS_MAX = 100;
export const MCP_EVENTS_DEFAULT = 50;
export const MCP_EVENTS_TASK_CAP = 16;
export const MCP_EVENTS_DEFAULT_REPLAY_MS = 24 * 60 * 60 * 1000;
export const MCP_EVENTS_MAX_REPLAY_MS = 7 * 24 * 60 * 60 * 1000;
export const MCP_EVENTS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MCP_EVENTS_QUIET_POLL_MS = 15_000;
export const MCP_EVENTS_BUSY_POLL_MS = 1_000;

const WAKE_NEXT = "Wake only. Call tasks.next. This event is not a claim.";
const WAKE_LAND = "Wake only. review holds write_roots until tasks.proofs.set.";

export type EventFilter = {
  projectId?: string;
  taskId?: string;
  taskIds?: string[];
  lane?: string;
  excludeGrokSessionId?: string;
  excludeAuthorAgentId?: string;
  includeSelf?: boolean;
};

export type EventOccurrence = {
  eventId: string;
  name: McpEventName;
  timestamp: string;
  data: Record<string, unknown>;
  cursor: string;
};

export type FeedRow = {
  id: string;
  kind: string;
  message: string;
  createdAt: string;
  taskId: string | null;
  projectId: string | null;
  lane: string | null;
  priority: number | null;
  title: string | null;
  authorAgentId?: string | null;
  grokSessionId?: string | null;
  body?: string | null;
};

export type EventWatch =
  | { ok: true; name: McpEventName; filter: EventFilter }
  | { ok: false; code: string; message: string; projects?: string[] };

type Schema = Record<string, unknown>;

function obj(properties: Record<string, Schema>, extra?: Schema): Schema {
  return { type: "object", properties, ...extra };
}

const projectIdProp: Schema = {
  type: "string",
  description: "Required when the PAT can see more than one project.",
};
const taskIdProp: Schema = { type: "string" };

export const MCP_EVENT_DEFS: Array<{
  name: McpEventName;
  description: string;
  delivery: string[];
  inputSchema: Schema;
  payloadSchema: Schema;
}> = [
  {
    name: "task.ready",
    description:
      "A card became Planted+ready (plant or release). Wake the orchestrator. Do not spawn from the payload — call tasks.next.",
    delivery: ["poll"],
    inputSchema: obj({
      projectId: projectIdProp,
      lane: { type: "string", description: "Exact lane. Omit for every lane." },
    }),
    payloadSchema: obj(
      {
        taskId: taskIdProp,
        projectId: projectIdProp,
        lane: { type: ["string", "null"] },
        priority: { type: "integer" },
        title: { type: "string" },
        reason: { type: "string", enum: ["plant", "release"] },
        wake: { type: "string" },
        claim: { type: "boolean" },
      },
      { required: ["taskId", "projectId", "wake", "claim"] },
    ),
  },
  {
    name: "task.review",
    description:
      "A worker set status=review. Wake the lander. write_roots stay held until tasks.proofs.set.",
    delivery: ["poll"],
    inputSchema: obj({ projectId: projectIdProp, taskId: taskIdProp }),
    payloadSchema: obj(
      {
        taskId: taskIdProp,
        projectId: projectIdProp,
        title: { type: "string" },
        wake: { type: "string" },
        holdsWriteRoots: { type: "boolean" },
      },
      { required: ["taskId", "projectId", "holdsWriteRoots"] },
    ),
  },
  {
    name: "task.landed",
    description: "proofs.set moved the card to Landed. Observe. Do not dequeue.",
    delivery: ["poll"],
    inputSchema: obj({ projectId: projectIdProp, taskId: taskIdProp }),
    payloadSchema: obj(
      {
        taskId: taskIdProp,
        projectId: projectIdProp,
        title: { type: "string" },
        factory: { type: "string" },
      },
      { required: ["taskId", "projectId", "factory"] },
    ),
  },
  {
    name: "mailbox.message",
    description:
      "A mailbox note. Echo is dropped by grokSessionId / authorAgentId, not authorName. The caller's X-Grok-Session-Id is excluded unless includeSelf.",
    delivery: ["poll"],
    inputSchema: obj({
      projectId: projectIdProp,
      taskId: taskIdProp,
      taskIds: {
        type: "array",
        items: { type: "string" },
        maxItems: MCP_EVENTS_TASK_CAP,
        description: "Up to 16 task ids.",
      },
      excludeGrokSessionId: { type: "string" },
      excludeAuthorAgentId: { type: "string" },
      includeSelf: { type: "boolean", default: false },
    }),
    payloadSchema: obj(
      {
        taskId: taskIdProp,
        projectId: projectIdProp,
        commentId: { type: "string" },
        authorAgentId: { type: ["string", "null"] },
        grokSessionId: { type: ["string", "null"] },
        body: { type: "string" },
      },
      { required: ["taskId", "commentId", "body"] },
    ),
  },
];

export function isMcpEventName(name: string): name is McpEventName {
  return (MCP_EVENT_NAMES as readonly string[]).includes(name);
}

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}\n${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const nl = raw.indexOf("\n");
  if (nl <= 0) return null;
  const at = raw.slice(0, nl);
  const id = raw.slice(nl + 1);
  if (Number.isNaN(Date.parse(at))) return null;
  return { at, id };
}

export function canonicalFilter(filter: EventFilter): EventFilter {
  const out: EventFilter = {};
  if (filter.projectId) out.projectId = filter.projectId;
  if (filter.taskId) out.taskId = filter.taskId;
  if (filter.taskIds?.length) out.taskIds = [...new Set(filter.taskIds)].sort();
  if (filter.lane) out.lane = filter.lane;
  if (filter.excludeGrokSessionId) out.excludeGrokSessionId = filter.excludeGrokSessionId;
  if (filter.excludeAuthorAgentId) out.excludeAuthorAgentId = filter.excludeAuthorAgentId;
  if (filter.includeSelf) out.includeSelf = true;
  return out;
}

function str(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  return typeof v === "string" ? v.trim() : "";
}

export function resolveEventWatch(
  name: string,
  raw: Record<string, unknown> | undefined,
  patFilter: string[] | null,
): EventWatch {
  if (!isMcpEventName(name)) {
    return { ok: false, code: "unknown_event", message: `Unknown event ${name}.` };
  }
  const args = raw ?? {};
  const taskIds = new Set<string>();
  const one = str(args, "taskId");
  if (one) taskIds.add(one);
  const many = args["taskIds"];
  if (Array.isArray(many)) {
    for (const id of many) {
      if (typeof id === "string" && id.trim()) taskIds.add(id.trim());
    }
  }
  if (taskIds.size > MCP_EVENTS_TASK_CAP) {
    return { ok: false, code: "mailbox_cap", message: "taskIds cap is 16." };
  }
  const filter: EventFilter = {};
  if (name === "task.ready") {
    const lane = str(args, "lane");
    if (lane) filter.lane = lane;
  }
  if (name === "mailbox.message") {
    const session = str(args, "excludeGrokSessionId");
    const agent = str(args, "excludeAuthorAgentId");
    if (session) filter.excludeGrokSessionId = session;
    if (agent) filter.excludeAuthorAgentId = agent;
    if (args["includeSelf"] === true) filter.includeSelf = true;
  }
  const asked = str(args, "projectId");
  if (name === "mailbox.message" && taskIds.size > 0) {
    if (asked) {
      const scope = resolveProjectScope(asked, patFilter);
      if (!scope.ok) return scope;
      const project = scope.projectIds?.[0];
      if (project) filter.projectId = project;
    }
    const ids = [...taskIds];
    const only = ids.length === 1 ? ids[0] : undefined;
    if (only) filter.taskId = only;
    if (ids.length > 1) filter.taskIds = ids.sort();
    return { ok: true, name, filter: canonicalFilter(filter) };
  }
  const scope = resolveProjectScope(asked || undefined, patFilter);
  if (!scope.ok) return scope;
  if (scope.projectIds?.length === 1 && scope.projectIds[0]) filter.projectId = scope.projectIds[0];
  if (name !== "mailbox.message") {
    if (taskIds.size === 1) {
      const id = [...taskIds][0];
      if (id) filter.taskId = id;
    } else if (taskIds.size > 1) {
      return { ok: false, code: "invalid_params", message: `${name} takes a single taskId.` };
    }
    return { ok: true, name, filter: canonicalFilter(filter) };
  }
  return {
    ok: false,
    code: "task_or_project_required",
    message: "mailbox.message needs taskId, taskIds (max 16), or projectId.",
  };
}

export function taskEventName(kind: string, message: string): McpEventName | null {
  if (kind === "plant" || kind === "release") return "task.ready";
  if (kind === "landed") return "task.landed";
  if (kind === "status" && message.trimEnd().endsWith("→ review")) return "task.review";
  return null;
}

function matchesProject(row: FeedRow, filter: EventFilter): boolean {
  if (!row.taskId || !row.projectId) return false;
  if (filter.projectId && row.projectId !== filter.projectId) return false;
  if (filter.taskId && row.taskId !== filter.taskId) return false;
  if (filter.taskIds?.length && !filter.taskIds.includes(row.taskId)) return false;
  return true;
}

export function occurrenceFromRow(
  row: FeedRow,
  name: McpEventName,
  filter: EventFilter,
): EventOccurrence | null {
  const timestamp = row.createdAt;
  const cursor = encodeCursor(timestamp, row.id);
  if (name === "mailbox.message") {
    if (row.kind !== "comment") return null;
    if (!matchesProject(row, filter)) return null;
    if (!filter.includeSelf) {
      if (filter.excludeGrokSessionId && row.grokSessionId === filter.excludeGrokSessionId)
        return null;
      if (filter.excludeAuthorAgentId && row.authorAgentId === filter.excludeAuthorAgentId)
        return null;
    }
    return {
      eventId: row.id,
      name,
      timestamp,
      cursor,
      data: {
        taskId: row.taskId,
        projectId: row.projectId,
        commentId: row.id,
        authorAgentId: row.authorAgentId ?? null,
        grokSessionId: row.grokSessionId ?? null,
        body: row.body ?? "",
      },
    };
  }
  if (taskEventName(row.kind, row.message) !== name) return null;
  if (!matchesProject(row, filter)) return null;
  if (name === "task.ready" && filter.lane && row.lane !== filter.lane) return null;
  const base = { taskId: row.taskId, projectId: row.projectId, title: row.title ?? "" };
  if (name === "task.ready") {
    return {
      eventId: row.id,
      name,
      timestamp,
      cursor,
      data: {
        ...base,
        lane: row.lane,
        priority: row.priority ?? 1,
        reason: row.kind === "release" ? "release" : "plant",
        wake: WAKE_NEXT,
        claim: false,
      },
    };
  }
  if (name === "task.review") {
    return {
      eventId: row.id,
      name,
      timestamp,
      cursor,
      data: { ...base, wake: WAKE_LAND, holdsWriteRoots: true },
    };
  }
  return {
    eventId: row.id,
    name,
    timestamp,
    cursor,
    data: { ...base, factory: "Landed" },
  };
}

/** Walk raw rows in order. Cursor advances past excluded echoes so they do not replay. */
export function pageFeed(
  rows: FeedRow[],
  name: McpEventName,
  filter: EventFilter,
  limit: number,
  pageFull: boolean,
): { events: EventOccurrence[]; cursor: string | null; hasMore: boolean } {
  const events: EventOccurrence[] = [];
  let cursor: string | null = null;
  let stoppedEarly = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    cursor = encodeCursor(row.createdAt, row.id);
    const occ = occurrenceFromRow(row, name, filter);
    if (occ) events.push(occ);
    if (events.length >= limit) {
      stoppedEarly = i < rows.length - 1;
      break;
    }
  }
  return { events, cursor, hasMore: stoppedEarly || pageFull };
}

export function clampMaxEvents(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return MCP_EVENTS_DEFAULT;
  return Math.min(MCP_EVENTS_MAX, Math.floor(n));
}

export function clampReplayMs(value: unknown): number {
  if (value === undefined || value === null || value === "") return MCP_EVENTS_DEFAULT_REPLAY_MS;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return MCP_EVENTS_DEFAULT_REPLAY_MS;
  return Math.min(MCP_EVENTS_MAX_REPLAY_MS, Math.floor(n));
}

export function nextPollMs(hasMore: boolean): number {
  return hasMore ? MCP_EVENTS_BUSY_POLL_MS : MCP_EVENTS_QUIET_POLL_MS;
}

export function pollDeliveryMode(delivery: unknown): { ok: true } | { ok: false; message: string } {
  if (delivery == null) return { ok: true };
  if (typeof delivery !== "object") return { ok: false, message: "delivery must be an object." };
  const mode = (delivery as { mode?: unknown }).mode;
  if (mode == null || mode === "poll") return { ok: true };
  return {
    ok: false,
    message: `delivery.mode ${String(mode)} is not supported. Use poll. Webhook and push are not available.`,
  };
}
