import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProjectScope } from "./actor.ts";
import { visibleMailboxComments } from "./mailbox.ts";

test("multi-project PAT must name a project", () => {
  const denied = resolveProjectScope(undefined, ["prj_a", "prj_b"]);
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.code, "project_required");
    assert.deepEqual(denied.projects, ["prj_a", "prj_b"]);
  }
  const ok = resolveProjectScope("prj_b", ["prj_a", "prj_b"]);
  assert.deepEqual(ok, { ok: true, projectIds: ["prj_b"] });
  const foreign = resolveProjectScope("prj_x", ["prj_a"]);
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.equal(foreign.code, "project_forbidden");
});

test("single-project PAT and session actors are scoped without an argument", () => {
  assert.deepEqual(resolveProjectScope(undefined, ["prj_a"]), {
    ok: true,
    projectIds: ["prj_a"],
  });
  assert.deepEqual(resolveProjectScope(undefined, null), { ok: true, projectIds: null });
});

test("mailbox visibility ignores authorName and drops the caller", () => {
  const comments = [
    {
      id: "c1",
      taskId: "tsk_1",
      authorKind: "agent" as const,
      authorName: "member",
      authorAgentId: "agt_self",
      grokSessionId: "sess_self",
      body: "mine",
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    {
      id: "c2",
      taskId: "tsk_1",
      authorKind: "agent" as const,
      authorName: "member",
      authorAgentId: "agt_other",
      grokSessionId: "sess_other",
      body: "theirs",
      createdAt: "2026-10-01T00:01:00.000Z",
    },
  ];
  const visible = visibleMailboxComments(comments, {
    excludeGrokSessionId: "sess_self",
    excludeAuthorAgentId: "agt_self",
  });
  assert.deepEqual(
    visible.map((c) => c.id),
    ["c2"],
  );
  assert.equal(visibleMailboxComments(comments).length, 2);
});
