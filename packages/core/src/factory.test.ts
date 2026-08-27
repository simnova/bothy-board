import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardError } from "./errors.ts";
import {
  assertChangedUnderRoots,
  assertClaimable,
  assertContractPatch,
  assertMailboxBody,
  assertWorkerPatch,
  dequeueIds,
  MAILBOX_MAX_CHARS,
  pathUnderRoots,
} from "./factory.ts";

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
  try {
    assertClaimable({
      status: "claimed",
      factory: "Planted",
      assigneeAgentId: "agt_2",
    });
    assert.fail("expected already_claimed");
  } catch (err) {
    assert.equal((err as BoardError).code, "already_claimed");
  }
});

test("workers cannot rewrite the contract after Planted", () => {
  try {
    assertContractPatch("agent", "Planted", { body: "## objective: no" });
    assert.fail("expected forbidden");
  } catch (err) {
    assert.equal((err as BoardError).code, "forbidden");
  }
  assertContractPatch("owner", "Planted", { body: "## objective: owner can amend" });
  assertContractPatch("agent", "Planted", { status: "review" } as never);
});

test("changed: must sit under write_roots", () => {
  assert.equal(pathUnderRoots("tools/a/x.ts", ["tools/a"]), true);
  assert.equal(pathUnderRoots("tools/b/x.ts", ["tools/a"]), false);
  try {
    assertChangedUnderRoots(["changed:apps/web/secret.ts"], ["packages/core"]);
    assert.fail("expected forbidden");
  } catch (err) {
    assert.equal((err as BoardError).code, "forbidden");
  }
  assertChangedUnderRoots(["changed:packages/core/src/card.ts"], ["packages/core"]);
  try {
    assertChangedUnderRoots(["changed:packages/core/src/card.ts"], []);
    assert.fail("expected invalid_card");
  } catch (err) {
    assert.equal((err as BoardError).code, "invalid_card");
  }
});

test("mailbox size cap", () => {
  assertMailboxBody("steer the worker");
  try {
    assertMailboxBody("x".repeat(MAILBOX_MAX_CHARS + 1));
    assert.fail("expected too_large");
  } catch (err) {
    assert.equal((err as BoardError).code, "too_large");
  }
});

test("next prefers affinity machine over priority", () => {
  const tasks = [
    {
      id: "tsk_fresh",
      status: "ready" as const,
      factory: "Planted" as const,
      priority: 0,
      depIds: [],
      childCount: 0,
      affinityMachineName: null,
    },
    {
      id: "tsk_parked",
      status: "ready" as const,
      factory: "Planted" as const,
      priority: 9,
      depIds: [],
      childCount: 0,
      affinityMachineName: "cabin",
    },
  ];
  assert.deepEqual(dequeueIds(tasks), ["tsk_fresh", "tsk_parked"]);
  assert.deepEqual(dequeueIds(tasks, { machineName: "cabin" }), ["tsk_parked", "tsk_fresh"]);
});
