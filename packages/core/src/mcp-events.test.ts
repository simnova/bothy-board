import assert from "node:assert/strict";
import test from "node:test";
import {
  clampWaitMs,
  decodeCursor,
  encodeCursor,
  type FeedRow,
  holdPoll,
  MCP_EVENTS_FUNCTION_MAX_MS,
  MCP_EVENTS_HOLD_TAIL_MS,
  MCP_EVENTS_MAX_WAIT_MS,
  occurrenceFromRow,
  pageFeed,
  pollDeliveryMode,
  resolveEventWatch,
  taskEventName,
} from "./mcp-events.ts";

const at = "2026-10-15T19:00:00.000Z";

function row(partial: Partial<FeedRow> & Pick<FeedRow, "id" | "kind">): FeedRow {
  return {
    message: "",
    createdAt: at,
    taskId: "tsk_1",
    projectId: "prj_a",
    lane: "hot",
    priority: 0,
    title: "Card",
    ...partial,
  };
}

test("cursor round-trips", () => {
  const cursor = encodeCursor(at, "evt_abc");
  assert.deepEqual(decodeCursor(cursor), { at, id: "evt_abc" });
  assert.equal(decodeCursor("nope"), null);
  assert.equal(decodeCursor(null), null);
});

test("audit kinds map to wakes, not claims", () => {
  assert.equal(taskEventName("plant", "x Planted"), "task.ready");
  assert.equal(taskEventName("release", "Claim released"), "task.ready");
  assert.equal(taskEventName("landed", "Landed"), "task.landed");
  assert.equal(taskEventName("status", "Card → review"), "task.review");
  assert.equal(taskEventName("status", "Card → ready"), null);
  assert.equal(taskEventName("claim", "claimed"), null);
});

test("task.ready payload is a wake and honors lane", () => {
  const planted = occurrenceFromRow(
    row({ id: "evt_1", kind: "plant", message: "Card Planted" }),
    "task.ready",
    {},
  );
  assert.equal(planted?.data["claim"], false);
  assert.match(String(planted?.data["wake"]), /tasks\.next/);
  assert.equal(planted?.data["reason"], "plant");
  const otherLane = occurrenceFromRow(
    row({ id: "evt_2", kind: "release", lane: "cold" }),
    "task.ready",
    { lane: "hot" },
  );
  assert.equal(otherLane, null);
});

test("mailbox echo is dropped but the cursor still advances", () => {
  const rows = [
    row({
      id: "cmt_self",
      kind: "comment",
      grokSessionId: "sess-me",
      body: "mine",
      createdAt: "2026-10-15T19:00:00.000Z",
    }),
    row({
      id: "cmt_them",
      kind: "comment",
      grokSessionId: "sess-you",
      authorAgentId: "agt_2",
      body: "steer",
      createdAt: "2026-10-15T19:00:01.000Z",
    }),
  ];
  const page = pageFeed(rows, "mailbox.message", { excludeGrokSessionId: "sess-me" }, 50, false);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0]?.data["body"], "steer");
  assert.equal(page.events[0]?.data["authorAgentId"], "agt_2");
  assert.equal(decodeCursor(page.cursor)?.id, "cmt_them");
  assert.equal(page.hasMore, false);
});

test("multi-project PAT must name a project for task.ready", () => {
  const missing = resolveEventWatch("task.ready", {}, ["prj_a", "prj_b"]);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "project_required");
  const scoped = resolveEventWatch("task.ready", { projectId: "prj_b", lane: "hot" }, [
    "prj_a",
    "prj_b",
  ]);
  assert.equal(scoped.ok, true);
  if (scoped.ok) {
    assert.equal(scoped.filter.projectId, "prj_b");
    assert.equal(scoped.filter.lane, "hot");
  }
  const forbidden = resolveEventWatch("task.ready", { projectId: "prj_z" }, ["prj_a"]);
  assert.equal(forbidden.ok, false);
});

test("mailbox accepts taskIds and refuses a firehose", () => {
  const ids = resolveEventWatch("mailbox.message", { taskIds: ["tsk_b", "tsk_a"] }, [
    "prj_a",
    "prj_b",
  ]);
  assert.equal(ids.ok, true);
  if (ids.ok) assert.deepEqual(ids.filter.taskIds, ["tsk_a", "tsk_b"]);
  const flood = resolveEventWatch("mailbox.message", {}, null);
  assert.equal(flood.ok, false);
  if (!flood.ok) assert.equal(flood.code, "task_or_project_required");
  const cap = resolveEventWatch(
    "mailbox.message",
    { taskIds: Array.from({ length: 17 }, (_, i) => `tsk_${i}`) },
    null,
  );
  assert.equal(cap.ok, false);
});

test("only poll delivery is accepted", () => {
  assert.equal(pollDeliveryMode(undefined).ok, true);
  assert.equal(pollDeliveryMode({ mode: "poll" }).ok, true);
  const hook = pollDeliveryMode({ mode: "webhook", url: "https://example.com" });
  assert.equal(hook.ok, false);
});

test("a full page asks the client to poll again", () => {
  const rows = [row({ id: "evt_1", kind: "plant", message: "Card Planted" })];
  const page = pageFeed(rows, "task.ready", {}, 50, true);
  assert.equal(page.events.length, 1);
  assert.equal(page.hasMore, true);
});

function quiet(events: readonly unknown[] = [], extra?: { hasMore?: boolean; cursor?: string }) {
  return {
    events,
    cursor: extra?.cursor ?? "c",
    hasMore: extra?.hasMore ?? false,
    nextPollMs: 15_000,
  };
}

test("waitMs clamps to the hold that fits the function budget", () => {
  assert.equal(clampWaitMs(undefined), 0);
  assert.equal(clampWaitMs(0), 0);
  assert.equal(clampWaitMs(-5), 0);
  assert.equal(clampWaitMs("20000"), 20_000);
  assert.equal(clampWaitMs(999_999), MCP_EVENTS_MAX_WAIT_MS);
  assert.ok(MCP_EVENTS_MAX_WAIT_MS + MCP_EVENTS_HOLD_TAIL_MS <= MCP_EVENTS_FUNCTION_MAX_MS);
});

test("a hit on the first check does not sleep", async () => {
  let sleeps = 0;
  const page = await holdPoll(async () => quiet([{ id: "1" }]), {
    cursor: null,
    waitMs: 20_000,
    now: () => 1_000,
    sleep: async () => {
      sleeps += 1;
    },
  });
  assert.equal(sleeps, 0);
  assert.equal(page.events.length, 1);
  assert.equal(page.nextPollMs, 0);
});

test("hold sleeps until an event and then the client should poll again immediately", async () => {
  let t = 0;
  let calls = 0;
  const seen: Array<string | null> = [];
  const page = await holdPoll(
    async (cursor) => {
      seen.push(cursor);
      calls += 1;
      if (calls < 3) return quiet([], { cursor: `echo-${calls}` });
      return quiet([{ id: "e" }], { cursor: "hit" });
    },
    {
      cursor: "start",
      waitMs: 20_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    },
  );
  assert.deepEqual(seen, ["start", "echo-1", "echo-2"]);
  assert.equal(page.events.length, 1);
  assert.equal(page.cursor, "hit");
  assert.equal(page.nextPollMs, 0);
  assert.equal(t, 2_000);
});

test("an empty hold ends at the deadline with nextPollMs 0", async () => {
  let t = 0;
  let calls = 0;
  const page = await holdPoll(
    async () => {
      calls += 1;
      return quiet();
    },
    {
      cursor: "c0",
      waitMs: 2_500,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    },
  );
  assert.equal(page.events.length, 0);
  assert.equal(page.nextPollMs, 0);
  assert.equal(t, 2_500);
  assert.equal(calls, 4);
});

test("waitMs 0 stays a short poll", async () => {
  let sleeps = 0;
  const page = await holdPoll(async () => quiet(), {
    cursor: null,
    waitMs: 0,
    sleep: async () => {
      sleeps += 1;
    },
  });
  assert.equal(sleeps, 0);
  assert.equal(page.nextPollMs, 15_000);
});

test("hasMore stays a 1s drain, including after a hold", async () => {
  const page = await holdPoll(async () => quiet([{ id: "1" }], { hasMore: true }), {
    cursor: null,
    waitMs: 20_000,
    now: () => 0,
    sleep: async () => {
      throw new Error("should not sleep");
    },
  });
  assert.equal(page.nextPollMs, 1_000);
});

test("a full page of echoes is drained without sleeping, then capped", async () => {
  let calls = 0;
  const page = await holdPoll(
    async () => {
      calls += 1;
      return quiet([], { hasMore: true, cursor: `p${calls}` });
    },
    {
      cursor: null,
      waitMs: 20_000,
      now: () => 0,
      sleep: async () => {
        throw new Error("should not sleep");
      },
    },
  );
  assert.equal(calls, 9);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextPollMs, 1_000);
  assert.equal(page.cursor, "p9");
});

test("abort during the sleep returns without another query", async () => {
  const ac = new AbortController();
  let calls = 0;
  const page = await holdPoll(
    async () => {
      calls += 1;
      return quiet();
    },
    {
      cursor: null,
      waitMs: 20_000,
      now: () => 0,
      signal: ac.signal,
      sleep: async () => {
        ac.abort();
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(page.nextPollMs, 0);
});

test("a hold does not start when the function budget is already spent", async () => {
  let sleeps = 0;
  const page = await holdPoll(async () => quiet(), {
    cursor: null,
    waitMs: 20_000,
    now: () => 23_000,
    invocationStartedAt: 0,
    sleep: async () => {
      sleeps += 1;
    },
  });
  assert.equal(sleeps, 0);
  assert.equal(page.nextPollMs, 15_000);
});
