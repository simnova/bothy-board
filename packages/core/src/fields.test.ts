import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardError } from "./errors.ts";
import { assertFields, dumpFields, FIELD_TEMPLATES, slugKey, templateFields } from "./fields.ts";
import { DEFAULT_SCOPE_IDS, scopeForTool } from "./scopes.ts";

const schema = templateFields("prj_test", "factory");

function expectCode(fn: () => void, code: string) {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (err) {
    assert.equal((err as BoardError).code, code);
  }
}

test("slugKey keeps underscores", () => {
  assert.equal(slugKey("factory_step"), "factory_step");
  assert.equal(slugKey("Factory Step"), "factory_step");
  assert.equal(slugKey("garment_token"), "garment_token");
});

test("factory template keys stay underscored", () => {
  assert.equal(FIELD_TEMPLATES.factory.id, "factory");
  assert.deepEqual(
    schema.map((f) => f.key),
    ["factory_step", "lane", "unblocks", "garment_token"],
  );
  const unblocks = schema.find((f) => f.key === "unblocks");
  assert.equal(unblocks?.requiredWhen?.field, "factory_step");
});

test("dumpFields emits factory_step not factory-step", () => {
  const extra = dumpFields(schema, { factory_step: "body_param", lane: "A" });
  assert.equal(extra["factory_step"], "body_param");
  assert.equal(extra["factory-step"], undefined);
});

test("create without factory_step refused when template applied", () => {
  expectCode(
    () => assertFields(schema, {}, { title: "x", body: "objective here", gate: "create" }),
    "invalid_card",
  );
});

test("plant clothing_generate without garment token refused", () => {
  expectCode(
    () =>
      assertFields(
        schema,
        { factory_step: "clothing_generate", lane: "A" },
        { title: "make a shirt", body: "no toolchain mention", gate: "plant" },
      ),
    "invalid_card",
  );
});

test("plant clothing_generate with mhclo in body ok", () => {
  const out = assertFields(
    schema,
    { factory_step: "clothing_generate", lane: "A" },
    { title: "shirt", body: "export mhclo for the asset", gate: "plant" },
  );
  assert.equal(out.factory_step, "clothing_generate");
  assert.equal(out.lane, "A");
});

test("instrument requires unblocks", () => {
  expectCode(
    () =>
      assertFields(
        schema,
        { factory_step: "instrument", lane: "B" },
        { title: "wire", body: "instrument the runtime", gate: "plant" },
      ),
    "invalid_card",
  );
  const ok = assertFields(
    schema,
    { factory_step: "instrument", lane: "B", unblocks: "staging" },
    { title: "wire", body: "instrument the runtime", gate: "plant" },
  );
  assert.equal(ok.unblocks, "staging");
});

test("select rejects unknown option", () => {
  expectCode(
    () =>
      assertFields(
        schema,
        { factory_step: "not_a_step", lane: "A" },
        { title: "x", body: "y", gate: "create" },
      ),
    "invalid_card",
  );
});

test("default worker PAT cannot rewrite field schema", () => {
  assert.equal(DEFAULT_SCOPE_IDS.includes("factory:plant"), false);
  assert.equal(scopeForTool("bothy-board.projects.fields.set"), "factory:plant");
  assert.equal(scopeForTool("bothy-board.projects.fields.applyTemplate"), "factory:plant");
  assert.equal(scopeForTool("bothy-board.projects.create"), "factory:plant");
});
