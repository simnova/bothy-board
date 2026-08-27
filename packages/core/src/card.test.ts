import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCard, cardFromInput, parseCard, serializeCard } from "./card.ts";
import type { BoardError } from "./errors.ts";
import { dequeueIds } from "./factory.ts";
import type { CompactTask } from "./types.ts";

function expectCode(fn: () => void, code: string) {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (err) {
    assert.equal((err as BoardError).code, code);
  }
}

test("G1 title-only create refused", () => {
  const card = cardFromInput({ title: "hello" });
  expectCode(() => assertCard(card, "create", "hello"), "invalid_card");
});

test("G1 create with objective ok, plant still needs TREE", () => {
  const card = cardFromInput({ title: "Auth", objective: "Ship session refresh" });
  assertCard(card, "create", "Auth");
  expectCode(() => assertCard(card, "plant", "Auth"), "invalid_card");
});

test("G1b prose done_when refused at plant", () => {
  const card = cardFromInput({
    title: "x",
    objective: "do the thing",
    doneWhen: ["the tests pass and it looks good"],
  });
  expectCode(() => assertCard(card, "plant", "x"), "invalid_card");
});

test("G1c narrative-only refused", () => {
  const card = cardFromInput({
    title: "x",
    objective: "handoff the work",
    doneWhen: ["handoff:maya"],
  });
  expectCode(() => assertCard(card, "plant", "x"), "invalid_card");
});

test("G1d markdown path refused", () => {
  const card = cardFromInput({
    title: "x",
    objective: "file exists",
    doneWhen: ["exists:`foo`"],
  });
  expectCode(() => assertCard(card, "plant", "x"), "invalid_card");
});

test("TREE exists: plants", () => {
  const card = cardFromInput({
    title: "x",
    objective: "land the file",
    doneWhen: ["exists:packages/core/src/queries.ts", "handoff:owner"],
  });
  assertCard(card, "plant", "x");
});

test("run: allowlist and metachar", () => {
  expectCode(
    () =>
      assertCard(
        cardFromInput({
          title: "x",
          objective: "run tests",
          doneWhen: ["run:bash -c rm"],
        }),
        "plant",
        "x",
      ),
    "invalid_card",
  );
  expectCode(
    () =>
      assertCard(
        cardFromInput({
          title: "x",
          objective: "run tests",
          doneWhen: ["run:pnpm test; rm -rf /"],
        }),
        "plant",
        "x",
      ),
    "invalid_card",
  );
  assertCard(
    cardFromInput({
      title: "x",
      objective: "run tests",
      doneWhen: ["run:pnpm test"],
    }),
    "plant",
    "x",
  );
});

test("canonical body round-trips extra headings for consumer parsers", () => {
  const body = serializeCard({
    objective: "retarget the clip",
    doneWhen: ["exists:out/clip.bvh"],
    writeRoots: ["tools/openclinxr"],
    lane: "A",
    knownGood: "tools/foo.ts:12",
    failedTreatments: [],
    outOfScope: "clinical scoring",
    notTested: "live device",
    extra: { "factory-step": "motion_retarget" },
  });
  const parsed = parseCard(body);
  assert.equal(parsed.objective, "retarget the clip");
  assert.equal(parsed.lane, "A");
  assert.equal(parsed.extra["factory-step"], "motion_retarget");
  assert.ok(body.includes("## factory-step: motion_retarget"));
});

test("G3 G7 dequeue: parent skipped, Idle skipped, priority then id", () => {
  const tasks = [
    {
      id: "tsk_parent",
      parentId: null,
      status: "ready",
      factory: "Planted",
      priority: 0,
      depIds: [],
      childCount: 2,
    },
    {
      id: "tsk_b",
      parentId: "tsk_parent",
      status: "ready",
      factory: "Planted",
      priority: 2,
      depIds: [],
      childCount: 0,
    },
    {
      id: "tsk_a",
      parentId: "tsk_parent",
      status: "ready",
      factory: "Planted",
      priority: 1,
      depIds: [],
      childCount: 0,
    },
    {
      id: "tsk_idle",
      parentId: null,
      status: "ready",
      factory: "Idle",
      priority: 0,
      depIds: [],
      childCount: 0,
    },
  ].map(
    (t) =>
      ({
        ...t,
        projectId: "p",
        title: t.id,
        kind: "feature",
        lane: null,
        writeRoots: [],
        objective: "x",
        doneWhen: ["exists:a"],
        assigneeAgentId: null,
        continuationId: null,
        grokSessionId: null,
        grokSubagentId: null,
        affinityUserId: null,
        affinityMachineName: null,
        branch: null,
        worktreePath: null,
        integrationStatus: "none",
        blockedReason: null,
        updatedAt: "",
      }) as CompactTask,
  );
  assert.deepEqual(dequeueIds(tasks), ["tsk_a", "tsk_b"]);
});
