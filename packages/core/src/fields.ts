import { BoardError } from "./errors.ts";
import { makeId } from "./ids.ts";

export const FIELD_TYPES = ["text", "number", "date", "select", "list"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export type FieldWhen = { field: string; equals?: string; in?: string[] };

export type SelectOption = {
  id: string;
  name: string;
  color?: string;
  description?: string;
};

export type FieldDef = {
  id: string;
  projectId: string;
  key: string;
  name: string;
  type: FieldType;
  description: string;
  required: boolean;
  plantRequired: boolean;
  dumpInBody: boolean;
  source: "value" | "title_or_body";
  pattern: string | null;
  requiredWhen: FieldWhen | null;
  options: SelectOption[];
  sortOrder: number;
};

export type FieldValue = string | number | string[] | null;
export type FieldMap = Record<string, FieldValue>;

const KEY = /^[a-z][a-z0-9_-]{0,63}$/;

export function slugKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replaceAll(" ", "_")
    .replace(/[^a-z0-9_-]/g, "");
}

function whenHits(when: FieldWhen | null, values: FieldMap): boolean {
  if (!when) return false;
  const raw = values[when.field];
  const v = Array.isArray(raw) ? raw.join(",") : raw == null ? "" : String(raw);
  if (when.equals !== undefined) return v === when.equals;
  if (when.in?.length) return when.in.includes(v);
  return Boolean(v);
}

function asText(value: FieldValue | undefined): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function isEmpty(value: FieldValue | undefined): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "number") return false;
  return String(value).trim() === "";
}

function assertPattern(pattern: string, text: string, label: string) {
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    throw new BoardError("invalid_field", `Invalid pattern on ${label}.`);
  }
  if (!re.test(text)) {
    throw new BoardError("invalid_card", `${label} does not match /${pattern}/i.`);
  }
}

function coerce(def: FieldDef, value: FieldValue | undefined): FieldValue {
  if (value == null || value === "") return null;
  switch (def.type) {
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n))
        throw new BoardError("invalid_card", `${def.name} must be a number.`);
      return n;
    }
    case "date": {
      const s = String(value).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        throw new BoardError("invalid_card", `${def.name} must be YYYY-MM-DD.`);
      }
      return s;
    }
    case "list": {
      if (Array.isArray(value))
        return value
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean);
      return String(value)
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    case "select": {
      const s = String(value).trim();
      const opt = def.options.find((o) => o.id === s || o.name === s);
      if (!opt) throw new BoardError("invalid_card", `${def.name} is not a valid option.`);
      return opt.id;
    }
    default:
      return String(value);
  }
}

export type FieldGate = "create" | "plant";

export function assertFields(
  schema: FieldDef[],
  values: FieldMap,
  ctx: { title: string; body: string; gate: FieldGate },
): FieldMap {
  const out: FieldMap = { ...values };
  for (const def of schema) {
    const needed =
      (ctx.gate === "create" && def.required) ||
      (ctx.gate === "plant" && (def.required || def.plantRequired)) ||
      whenHits(def.requiredWhen, out);
    if (def.source === "title_or_body") {
      const text = `${ctx.title}\n${ctx.body}`;
      if (needed && def.pattern) assertPattern(def.pattern, text, def.name);
      continue;
    }
    if (!isEmpty(out[def.key])) out[def.key] = coerce(def, out[def.key]);
    if (needed && isEmpty(out[def.key])) {
      throw new BoardError("invalid_card", `${def.name} is required.`);
    }
    if (!isEmpty(out[def.key]) && def.pattern && def.type === "text") {
      assertPattern(def.pattern, asText(out[def.key]), def.name);
    }
  }
  return out;
}

const CANONICAL_KEYS = new Set([
  "lane",
  "objective",
  "write_roots",
  "write-roots",
  "known_good",
  "known-good",
  "done_when",
  "done-when",
  "out_of_scope",
  "out-of-scope",
  "not_tested",
  "not-tested",
  "failed_treatments",
  "failed-treatments",
]);

export function dumpFields(schema: FieldDef[], values: FieldMap): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const def of schema) {
    if (!def.dumpInBody || def.source !== "value") continue;
    if (CANONICAL_KEYS.has(def.key)) continue;
    const v = values[def.key];
    if (isEmpty(v)) continue;
    extra[def.key] = Array.isArray(v) ? v.join(",") : String(v);
  }
  return extra;
}

export function valuesFromBody(schema: FieldDef[], extra: Record<string, string>): FieldMap {
  const out: FieldMap = {};
  for (const def of schema) {
    const v = extra[def.key] ?? extra[def.key.replaceAll("_", "-")];
    if (v) out[def.key] = v;
  }
  return out;
}

export function parseFieldDefs(rows: Array<Record<string, unknown>>): FieldDef[] {
  return rows.map((r) => ({
    id: String(r["id"] ?? ""),
    projectId: String(r["project_id"] ?? r["projectId"] ?? ""),
    key: String(r["key"] ?? ""),
    name: String(r["name"] ?? ""),
    type: (FIELD_TYPES as readonly string[]).includes(String(r["type"]))
      ? (r["type"] as FieldType)
      : "text",
    description: String(r["description"] ?? ""),
    required: Boolean(r["required"]),
    plantRequired: Boolean(r["plant_required"] ?? r["plantRequired"]),
    dumpInBody:
      r["dump_in_body"] === undefined && r["dumpInBody"] === undefined
        ? true
        : Boolean(r["dump_in_body"] ?? r["dumpInBody"]),
    source: r["source"] === "title_or_body" ? "title_or_body" : "value",
    pattern: r["pattern"] == null ? null : String(r["pattern"]),
    requiredWhen: (r["required_when"] ?? r["requiredWhen"] ?? null) as FieldWhen | null,
    options: Array.isArray(r["options"]) ? (r["options"] as SelectOption[]) : [],
    sortOrder: Number(r["sort_order"] ?? r["sortOrder"] ?? 0),
  }));
}

export function assertFieldDraft(
  input: Partial<FieldDef> & { key: string; name: string; type: FieldType },
) {
  const key = slugKey(input.key);
  if (!KEY.test(key)) throw new BoardError("invalid_field", "Field key must be a lowercase slug.");
  if (!input.name.trim()) throw new BoardError("invalid_field", "Field name required.");
  if (!(FIELD_TYPES as readonly string[]).includes(input.type)) {
    throw new BoardError("invalid_field", "Unknown field type.");
  }
  if (input.type === "select" && !(input.options ?? []).length) {
    throw new BoardError("invalid_field", "Select fields need at least one option.");
  }
}

const FACTORY_STEPS = [
  "body_param",
  "clothing_consume",
  "clothing_generate",
  "motion_retarget",
  "lip_sync",
  "room_generate",
  "equipment_generate",
  "staging",
  "dialogue_runtime",
  "instrument",
] as const;

/** Optional template — applied by the owner, not assumed. */
export const FIELD_TEMPLATES = {
  factory: {
    id: "factory",
    name: "Production factory",
    hint: "Step, lane, and unblocks — used by factory orchestrators (OpenClinXR and others).",
    fields: [
      {
        key: "factory_step",
        name: "Factory step",
        type: "select" as const,
        description: "Which factory stage this card belongs to.",
        required: true,
        plantRequired: true,
        dumpInBody: true,
        source: "value" as const,
        options: FACTORY_STEPS.map((id) => ({ id, name: id })),
      },
      {
        key: "lane",
        name: "Lane",
        type: "select" as const,
        description: "Concurrency group. Disjoint write-roots may run in parallel.",
        required: true,
        plantRequired: true,
        dumpInBody: true,
        source: "value" as const,
        options: [
          { id: "A", name: "A" },
          { id: "B", name: "B" },
        ],
      },
      {
        key: "unblocks",
        name: "Unblocks",
        type: "select" as const,
        description: "Required when factory_step is instrument.",
        required: false,
        plantRequired: false,
        dumpInBody: true,
        source: "value" as const,
        requiredWhen: { field: "factory_step", equals: "instrument" },
        options: FACTORY_STEPS.map((id) => ({ id, name: id })),
      },
      {
        key: "garment_token",
        name: "Garment pipeline token",
        type: "text" as const,
        description:
          "Title or body must mention the garment toolchain when the step is clothing_*.",
        required: false,
        plantRequired: false,
        dumpInBody: false,
        source: "title_or_body" as const,
        pattern: "makeclothes|mhclo|hm08|mpfb",
        requiredWhen: { field: "factory_step", in: ["clothing_generate", "clothing_consume"] },
        options: [],
      },
    ],
  },
} as const;

export type FieldTemplateId = keyof typeof FIELD_TEMPLATES;

export function templateFields(
  projectId: string,
  template: FieldTemplateId,
): Omit<FieldDef, "id">[] {
  const t = FIELD_TEMPLATES[template];
  return t.fields.map((f, i) => ({
    id: makeId("fld"),
    projectId,
    key: f.key,
    name: f.name,
    type: f.type,
    description: f.description,
    required: f.required,
    plantRequired: f.plantRequired,
    dumpInBody: f.dumpInBody,
    source: f.source,
    pattern: "pattern" in f ? (f.pattern as string) : null,
    requiredWhen: "requiredWhen" in f ? (f.requiredWhen as FieldWhen) : null,
    options: [...f.options],
    sortOrder: i,
  }));
}

export function parseFieldMap(raw: unknown): FieldMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: FieldMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v == null) out[k] = null;
    else if (typeof v === "number" || typeof v === "string") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.map(String);
  }
  return out;
}
