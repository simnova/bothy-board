import { assertTaskAccess } from "@bothy-board/core/access";
import { type Actor, projectFilter } from "@bothy-board/core/actor";
import { isBoardError } from "@bothy-board/core/errors";
import {
  clampWaitMs,
  type EventFilter,
  holdPoll,
  isMcpEventName,
  MCP_EVENT_DEFS,
  type McpEventName,
  pollDeliveryMode,
  resolveEventWatch,
} from "@bothy-board/core/mcp-events";
import {
  loadSubscription,
  pollEventFeed,
  subscribeEvent,
  touchSubscription,
  unsubscribeEvent,
} from "@bothy-board/core/mcp-events-feed";
import { hasScope } from "./actor";

type Params = Record<string, unknown>;

export type EventsResult =
  | { ok: true; result: unknown }
  | { ok: false; code: number; message: string };

function str(params: Params, key: string): string {
  const v = params[key];
  return typeof v === "string" ? v.trim() : "";
}

function argsOf(params: Params): Record<string, unknown> {
  const raw = params["arguments"];
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function withCallerSession(name: McpEventName, filter: EventFilter, header?: string): EventFilter {
  if (name !== "mailbox.message" || filter.includeSelf || filter.excludeGrokSessionId)
    return filter;
  const session = header?.trim();
  if (!session) return filter;
  return { ...filter, excludeGrokSessionId: session };
}

function visibleDefs(actor: Actor) {
  return MCP_EVENT_DEFS.filter(
    (def) => def.name !== "mailbox.message" || hasScope(actor, "mailbox"),
  );
}

async function assertWatchTasks(
  actor: Actor,
  workspaceId: string,
  filter: EventFilter,
): Promise<void> {
  const ids = filter.taskIds?.length ? filter.taskIds : filter.taskId ? [filter.taskId] : [];
  for (const id of ids) await assertTaskAccess(actor, workspaceId, id);
}

function fail(err: unknown): EventsResult {
  if (isBoardError(err)) {
    const code = err.code === "forbidden" ? -32001 : -32602;
    return { ok: false, code, message: err.message };
  }
  const message = err instanceof Error ? err.message : "event error";
  return { ok: false, code: -32602, message };
}

export async function handleMcpEvents(
  actor: Actor,
  method: string,
  params: Params,
  grokSessionHeader?: string,
  opts?: { signal?: AbortSignal; invocationStartedAt?: number },
): Promise<EventsResult> {
  try {
    if (!hasScope(actor, "board:read")) {
      return { ok: false, code: -32001, message: "missing scope board:read" };
    }
    if (method === "events/stream") {
      return {
        ok: false,
        code: -32602,
        message: "events/stream is not supported. Use events/poll.",
      };
    }
    if (method === "events/list") {
      return { ok: true, result: { events: visibleDefs(actor) } };
    }
    if (method === "events/unsubscribe") {
      const id = str(params, "id") || str(params, "subscriptionId");
      if (!id) return { ok: false, code: -32602, message: "id required." };
      await unsubscribeEvent(actor.workspaceId, actor, id);
      return { ok: true, result: { ok: true } };
    }
    if (method === "events/subscribe") {
      const delivery = pollDeliveryMode(params["delivery"]);
      if (!delivery.ok) return { ok: false, code: -32602, message: delivery.message };
      const watch = resolveEventWatch(str(params, "name"), argsOf(params), projectFilter(actor));
      if (!watch.ok) return { ok: false, code: -32602, message: watch.message };
      if (watch.name === "mailbox.message" && !hasScope(actor, "mailbox")) {
        return { ok: false, code: -32001, message: "missing scope mailbox" };
      }
      await assertWatchTasks(actor, actor.workspaceId, watch.filter);
      const cursor = typeof params["cursor"] === "string" ? params["cursor"] : null;
      const sub = await subscribeEvent({
        workspaceId: actor.workspaceId,
        actor,
        name: watch.name,
        filter: watch.filter,
        cursor,
      });
      return {
        ok: true,
        result: {
          id: sub.id,
          name: watch.name,
          arguments: watch.filter,
          delivery: { mode: "poll" },
          cursor: sub.cursor,
          refreshBefore: sub.refreshBefore,
          truncated: false,
          note: "Poll with this id. Pass waitMs (max 20000) to hold the request. A wake is not a claim — call tasks.next or tasks.proofs.set.",
        },
      };
    }
    if (method === "events/poll") {
      const subscriptionId = str(params, "subscriptionId") || str(params, "id");
      let name: McpEventName;
      let filter: EventFilter;
      let storedCursor: string | null = null;
      if (subscriptionId) {
        const sub = await loadSubscription(actor.workspaceId, actor, subscriptionId);
        if (!isMcpEventName(sub.name))
          return { ok: false, code: -32602, message: "Unknown event." };
        name = sub.name;
        filter = sub.filter;
        storedCursor = sub.cursor;
      } else {
        const watch = resolveEventWatch(str(params, "name"), argsOf(params), projectFilter(actor));
        if (!watch.ok) return { ok: false, code: -32602, message: watch.message };
        name = watch.name;
        filter = watch.filter;
      }
      if (name === "mailbox.message" && !hasScope(actor, "mailbox")) {
        return { ok: false, code: -32001, message: "missing scope mailbox" };
      }
      filter = withCallerSession(name, filter, grokSessionHeader);
      await assertWatchTasks(actor, actor.workspaceId, filter);
      const cursor =
        params["cursor"] === null
          ? null
          : typeof params["cursor"] === "string"
            ? params["cursor"]
            : storedCursor;
      const pat = projectFilter(actor);
      const waitMs = clampWaitMs(params["waitMs"]);
      const page = await holdPoll(
        (cursor) =>
          pollEventFeed(actor.workspaceId, {
            name,
            filter,
            allowedProjectIds: filter.projectId ? null : pat,
            cursor,
            maxEvents: params["maxEvents"],
            maxAgeMs: params["maxAgeMs"],
          }),
        {
          cursor,
          waitMs,
          ...(opts?.signal ? { signal: opts.signal } : {}),
          ...(opts?.invocationStartedAt !== undefined
            ? { invocationStartedAt: opts.invocationStartedAt }
            : {}),
        },
      );
      if (subscriptionId)
        await touchSubscription(actor.workspaceId, actor, subscriptionId, page.cursor);
      return { ok: true, result: page };
    }
    return { ok: false, code: -32601, message: `unknown method ${method}` };
  } catch (err) {
    return fail(err);
  }
}
