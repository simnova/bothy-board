import { getSql } from "@bothy-board/db";
import { BoardError } from "./errors";
import {
  assertFieldDraft,
  FIELD_TEMPLATES,
  type FieldDef,
  type FieldMap,
  type FieldTemplateId,
  parseFieldDefs,
  slugKey,
  templateFields,
} from "./fields";
import { makeId } from "./ids";
import { requireProjectRole } from "./projects";
import { bumpRevision } from "./workspace";

export async function listProjectFields(projectId: string): Promise<FieldDef[]> {
  const sql = await getSql();
  const rows = await sql.query<Record<string, unknown>>(
    `select id, project_id, key, name, type, description, required, plant_required, dump_in_body,
            source, pattern, required_when, options, sort_order
     from project_fields where project_id = $1 order by sort_order asc, key asc`,
    [projectId],
  );
  return parseFieldDefs(rows);
}

export async function listFieldsForProjects(
  projectIds: string[],
): Promise<Map<string, FieldDef[]>> {
  const map = new Map<string, FieldDef[]>();
  if (!projectIds.length) return map;
  const sql = await getSql();
  const rows = await sql.query<Record<string, unknown>>(
    `select id, project_id, key, name, type, description, required, plant_required, dump_in_body,
            source, pattern, required_when, options, sort_order
     from project_fields where project_id = any($1) order by sort_order asc, key asc`,
    [projectIds],
  );
  for (const def of parseFieldDefs(rows)) {
    const list = map.get(def.projectId) ?? [];
    list.push(def);
    map.set(def.projectId, list);
  }
  return map;
}

export async function replaceProjectFields(
  workspaceId: string,
  userId: string,
  projectId: string,
  fields: Array<Partial<FieldDef> & { key: string; name: string; type: FieldDef["type"] }>,
): Promise<FieldDef[]> {
  const { project, role } = await requireProjectRole(workspaceId, userId, projectId);
  if (role !== "owner") throw new BoardError("forbidden", "Only a project owner can edit fields.");
  const sql = await getSql();
  const seen = new Set<string>();
  const next: FieldDef[] = [];
  for (const [i, draft] of fields.entries()) {
    const key = slugKey(draft.key);
    assertFieldDraft({ ...draft, key });
    if (seen.has(key)) throw new BoardError("invalid_field", `Duplicate field key ${key}.`);
    seen.add(key);
    next.push({
      id: draft.id && draft.id.startsWith("fld_") ? draft.id : makeId("fld"),
      projectId: project.id,
      key,
      name: draft.name.trim(),
      type: draft.type,
      description: draft.description ?? "",
      required: Boolean(draft.required),
      plantRequired: Boolean(draft.plantRequired),
      dumpInBody: draft.dumpInBody !== false,
      source: draft.source === "title_or_body" ? "title_or_body" : "value",
      pattern: draft.pattern ?? null,
      requiredWhen: draft.requiredWhen
        ? { ...draft.requiredWhen, field: slugKey(draft.requiredWhen.field) }
        : null,
      options: draft.options ?? [],
      sortOrder: draft.sortOrder ?? i,
    });
  }
  await sql`delete from project_fields where project_id = ${project.id}`;
  for (const f of next) {
    await sql.query(
      `insert into project_fields (
         id, project_id, key, name, type, description, required, plant_required, dump_in_body,
         source, pattern, required_when, options, sort_order
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14)`,
      [
        f.id,
        f.projectId,
        f.key,
        f.name,
        f.type,
        f.description,
        f.required,
        f.plantRequired,
        f.dumpInBody,
        f.source,
        f.pattern,
        JSON.stringify(f.requiredWhen),
        JSON.stringify(f.options),
        f.sortOrder,
      ],
    );
  }
  await bumpRevision(sql, workspaceId);
  return next;
}

export async function applyFieldTemplate(
  workspaceId: string,
  userId: string,
  projectId: string,
  template: FieldTemplateId,
): Promise<FieldDef[]> {
  if (!(template in FIELD_TEMPLATES)) {
    throw new BoardError("invalid_field", `Unknown template ${template}.`);
  }
  const drafts = templateFields(projectId, template);
  return replaceProjectFields(
    workspaceId,
    userId,
    projectId,
    drafts.map((d) => d),
  );
}

export async function fieldsForTask(
  projectId: string,
  stored: unknown,
): Promise<{
  schema: FieldDef[];
  values: FieldMap;
}> {
  const { parseFieldMap } = await import("./fields");
  return { schema: await listProjectFields(projectId), values: parseFieldMap(stored) };
}
