import type { FailedTreatment } from "./card";
import type { FieldDef, FieldMap } from "./fields";

export const TASK_KINDS = ["feature", "bug", "chore", "integration", "spike", "epic"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATUSES = [
  "backlog",
  "ready",
  "claimed",
  "in_progress",
  "blocked",
  "review",
  "integrating",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const FACTORY_STATES = ["Idle", "Planted", "Dispatched", "Landed", "Graded"] as const;
export type FactoryState = (typeof FACTORY_STATES)[number];

export const AGENT_KINDS = ["grok", "cursor", "claude", "codex", "other"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const AGENT_STATUSES = ["idle", "working", "blocked", "offline"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const WORKTREE_STATUSES = ["active", "dirty", "pr", "merged", "abandoned"] as const;
export type WorktreeStatus = (typeof WORKTREE_STATUSES)[number];

export const INTEGRATION_STATUSES = ["none", "waiting", "conflict", "merged"] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export type CompactTask = {
  id: string;
  parentId: string | null;
  projectId: string;
  title: string;
  kind: TaskKind;
  status: TaskStatus;
  factory: FactoryState;
  lane: string | null;
  writeRoots: string[];
  objective: string;
  doneWhen: string[];
  knownGood: string;
  failedTreatments: FailedTreatment[];
  priority: number;
  assigneeAgentId: string | null;
  continuationId: string | null;
  grokSessionId: string | null;
  grokSubagentId: string | null;
  affinityUserId: string | null;
  affinityMachineName: string | null;
  branch: string | null;
  worktreePath: string | null;
  integrationStatus: IntegrationStatus;
  blockedReason: string | null;
  depIds: string[];
  childCount: number;
  fields: FieldMap;
  updatedAt: string;
};

export type TaskDetail = CompactTask & {
  body: string;
  projectId: string;
  assigneeUserId: string | null;
  outOfScope: string;
  knownGood: string;
  notTested: string;
  noGrade: boolean;
  proofsLines: string[];
  createdAt: string;
  comments: CommentRow[];
  children: CompactTask[];
};

export type CommentRow = {
  id: string;
  taskId: string;
  authorKind: "user" | "agent";
  authorName: string;
  body: string;
  grokSessionId?: string | null;
  createdAt: string;
};

export type AgentRow = {
  id: string;
  name: string;
  kind: AgentKind;
  machineName: string;
  continuationId: string | null;
  currentTaskId: string | null;
  status: AgentStatus;
  lastHeartbeat: string | null;
};

export type WorktreeRow = {
  id: string;
  taskId: string | null;
  agentId: string | null;
  path: string;
  branch: string;
  machineName: string;
  status: WorktreeStatus;
  updatedAt: string;
};

export type EventRow = {
  id: string;
  taskId: string | null;
  agentId: string | null;
  kind: string;
  message: string;
  createdAt: string;
};

export type ProjectRow = {
  id: string;
  name: string;
  repo: string;
  defaultBranch: string;
  visibility: "private" | "public";
  fields: FieldDef[];
  maxInFlight: number;
  maxIntegrating: number;
};

export type WorkspaceRow = {
  id: string;
  name: string;
  revision: number;
  cacheToken: string;
};

export type MemberRow = {
  userId: string;
  handle: string;
  role: "owner" | "member";
};

export type Snapshot = {
  workspace: WorkspaceRow;
  project: ProjectRow;
  projects: ProjectRow[];
  cacheToken: string;
  revision: number;
  tasks: CompactTask[];
  agents: AgentRow[];
  worktrees: WorktreeRow[];
  events: EventRow[];
  members: MemberRow[];
  readyIds: string[];
  incomplete: boolean;
  myRole: "owner" | "member" | null;
};

export type ApiEnvelope<T> = {
  cacheToken: string;
  revision: number;
  staleAfterMs: number;
  data: T;
};
