import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardError } from "./errors.ts";
import { assertClaimable, assertWorkerPatch } from "./factory.ts";

test("G8 worker cannot Landed or done", () => {
  try {
    assertWorkerPatch({ factory: "Landed" });
    assert.fail("expected forbidden");
  } catch (err) {
    assert.equal((err as BoardError).code, "forbidden");
  }
  try {
    assertWorkerPatch({ status: "done" });
    assert.fail("expected forbidden");
  } catch (err) {
    assert.equal((err as BoardError).code, "forbidden");
  }
  assertWorkerPatch({ status: "review" });
  assertWorkerPatch({ status: "blocked" });
});

test("G2 claimable predicate", () => {
  try {
    assertClaimable({ status: "ready", factory: "Idle", assigneeAgentId: null });
    assert.fail("expected not_ready");
  } catch (err) {
    assert.equal((err as BoardError).code, "not_ready");
  }
  try {
    assertClaimable({
      status: "ready",
      factory: "Planted",
      assigneeAgentId: "agt_1",
    });
    assert.fail("expected already_claimed");
  } catch (err) {
    assert.equal((err as BoardError).code, "already_claimed");
  }
  assertClaimable({ status: "ready", factory: "Planted", assigneeAgentId: null, childCount: 0 });
});
