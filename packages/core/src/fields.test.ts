import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardError } from "./errors.ts";
import { assertFields, FIELD_TEMPLATES, templateFields } from "./fields.ts";

const schema = templateFields("prj_test", "factory");

function expectCode(fn: () => void, code: string) {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (err) {
    assert.equal((err as BoardError).code, code);
  }
}

test("factory template is opt-in and named", () => {
  assert.equal(FIELD_TEMPLATES.factory.id, "factory");
  assert.ok(schema.some((f) => f.key === "factory_step"));
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
