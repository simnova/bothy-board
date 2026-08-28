export const PAT_SCOPES = [
  {
    id: "board:read",
    label: "Read board",
    hint: "Snapshot, ready queue, task detail, members",
    tools: [
      "bothy-board.sync",
      "bothy-board.tasks.next",
      "bothy-board.tasks.get",
      "bothy-board.team.members",
      "bothy-board.projects.list",
      "bothy-board.projects.fields.list",
    ],
  },
  {
    id: "tasks:write",
    label: "Edit tasks",
    hint: "Create, claim, update, decompose, comment",
    tools: [
      "bothy-board.tasks.create",
      "bothy-board.tasks.update",
      "bothy-board.tasks.claim",
      "bothy-board.tasks.release",
      "bothy-board.tasks.treatments.fail",
      "bothy-board.tasks.decompose",
      "bothy-board.tasks.comment",
    ],
  },
  {
    id: "factory:plant",
    label: "Plant cards",
    hint: "Owner: Idle → Planted, plus field schema. Not on default worker tokens.",
    tools: [
      "bothy-board.tasks.plant",
      "bothy-board.tasks.import",
      "bothy-board.projects.create",
      "bothy-board.projects.fields.set",
      "bothy-board.projects.fields.applyTemplate",
    ],
  },
  {
    id: "factory:land",
    label: "Land proofs",
    hint: "Orchestrator-only: proofs.set → Landed. Not on default worker tokens.",
    tools: ["bothy-board.tasks.proofs.set"],
  },
  {
    id: "sessions",
    label: "Grok sessions",
    hint: "Mint, bind, and resume continuation IDs",
    tools: [
      "bothy-board.sessions.mint",
      "bothy-board.sessions.bind",
      "bothy-board.sessions.resume",
    ],
  },
  {
    id: "mailbox",
    label: "Mailbox",
    hint: "Poll and post on a task thread",
    tools: ["bothy-board.mailbox.poll", "bothy-board.mailbox.post"],
  },
  {
    id: "worktrees",
    label: "Worktrees",
    hint: "Register branch/path/machine",
    tools: ["bothy-board.worktrees.register"],
  },
  {
    id: "agents",
    label: "Agent heartbeat",
    hint: "Fleet presence",
    tools: ["bothy-board.agents.heartbeat"],
  },
  {
    id: "tasks:delete",
    label: "Delete to trash",
    hint: "Soft-delete tasks (7-day recovery). Not granted by default.",
    tools: ["bothy-board.tasks.delete", "bothy-board.tasks.restore", "bothy-board.trash.list"],
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
  return TOOL_TO_SCOPE.get(toolName) ?? null;
}

export function toolsForScopes(scopes: string[]): string[] {
  const set = new Set(parseScopes(scopes));
  return PAT_SCOPES.filter((s) => set.has(s.id)).flatMap((s) => [...s.tools]);
}
