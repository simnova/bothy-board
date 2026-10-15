import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCursor,
  encodeCursor,
  type FeedRow,
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
