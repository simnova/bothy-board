/** Grok / OpenAI tool names: letter-or-underscore, then [A-Za-z0-9_-], max 64. No dots. */
export const GROK_TOOL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

/** Advertised BothyBoard MCP tools: bothy-board + `_segment`s, no trailing `_`, no dots. */
export const BOTHY_MCP_TOOL_RE = /^bothy-board(_[A-Za-z][A-Za-z0-9]*)+$/;

/** Dots are a legacy alias. `bothy-board.tasks.next` → `bothy-board_tasks_next`. */
export function canonicalToolName(name: string): string {
  return name.replaceAll(".", "_");
}

export const PAT_SCOPES = [
  {
    id: "board:read",
    label: "Read board",
    hint: "Snapshot, ready queue, task detail, members",
    tools: [
      "bothy-board_sync",
      "bothy-board_tasks_next",
      "bothy-board_tasks_get",
      "bothy-board_team_members",
      "bothy-board_projects_list",
      "bothy-board_projects_fields_list",
    ],
  },
  {
    id: "tasks:write",
    label: "Edit tasks",
    hint: "Create, claim, update, decompose, comment",
    tools: [
      "bothy-board_tasks_create",
      "bothy-board_tasks_update",
      "bothy-board_tasks_claim",
      "bothy-board_tasks_release",
      "bothy-board_tasks_treatments_fail",
      "bothy-board_tasks_decompose",
      "bothy-board_tasks_comment",
    ],
  },
  {
    id: "factory:plant",
    label: "Plant cards",
    hint: "Owner: Idle → Planted, plus field schema. Not on default worker tokens.",
    tools: [
      "bothy-board_tasks_plant",
      "bothy-board_tasks_import",
      "bothy-board_projects_create",
      "bothy-board_projects_fields_set",
      "bothy-board_projects_fields_applyTemplate",
    ],
  },
  {
    id: "factory:land",
    label: "Land proofs",
    hint: "Orchestrator-only: proofs.set → Landed. Not on default worker tokens.",
    tools: ["bothy-board_tasks_proofs_set"],
  },
  {
    id: "sessions",
    label: "Grok sessions",
    hint: "Mint, bind, and resume continuation IDs",
    tools: [
      "bothy-board_sessions_mint",
      "bothy-board_sessions_bind",
      "bothy-board_sessions_resume",
    ],
  },
  {
    id: "mailbox",
    label: "Mailbox",
    hint: "Poll and post on a task thread",
    tools: ["bothy-board_mailbox_poll", "bothy-board_mailbox_post"],
  },
  {
    id: "worktrees",
    label: "Worktrees",
    hint: "Register branch/path/machine",
    tools: ["bothy-board_worktrees_register"],
  },
  {
    id: "agents",
    label: "Agent heartbeat",
    hint: "Fleet presence",
    tools: ["bothy-board_agents_heartbeat"],
  },
  {
    id: "tasks:delete",
    label: "Delete to trash",
    hint: "Soft-delete tasks (7-day recovery). Not granted by default.",
    tools: ["bothy-board_tasks_delete", "bothy-board_tasks_restore", "bothy-board_trash_list"],
  },
] as const;

export type PatScopeId = (typeof PAT_SCOPES)[number]["id"];

export const ALL_SCOPE_IDS: PatScopeId[] = PAT_SCOPES.map((s) => s.id);

/** Default mint: no delete, no plant, no land, no schema edits. */
export const DEFAULT_SCOPE_IDS: PatScopeId[] = ALL_SCOPE_IDS.filter(
  (id) => id !== "tasks:delete" && id !== "factory:plant" && id !== "factory:land",
);

const TOOL_TO_SCOPE = new Map<string, PatScopeId>();
for (const scope of PAT_SCOPES) {
  for (const tool of scope.tools) TOOL_TO_SCOPE.set(tool, scope.id);
}

export function parseScopes(raw: string | string[] | undefined): PatScopeId[] {
  const parts = Array.isArray(raw) ? raw : (raw ?? "").split(/[\s,]+/).filter(Boolean);
  const allowed = new Set<string>(ALL_SCOPE_IDS);
  const out: PatScopeId[] = [];
  for (const p of parts) {
    if (allowed.has(p) && !out.includes(p as PatScopeId)) out.push(p as PatScopeId);
  }
  return out.length ? out : [...DEFAULT_SCOPE_IDS];
}

export function serializeScopes(scopes: string[]): string {
  return parseScopes(scopes).join(",");
}

export function scopeForTool(toolName: string): PatScopeId | null {
  return TOOL_TO_SCOPE.get(canonicalToolName(toolName)) ?? null;
}

export function toolsForScopes(scopes: string[]): string[] {
  const set = new Set(parseScopes(scopes));
  return PAT_SCOPES.filter((s) => set.has(s.id)).flatMap((s) => [...s.tools]);
}
