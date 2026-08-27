import type {
  AgentStatus,
  CompactTask,
  TaskKind,
  TaskStatus,
  WorktreeStatus,
} from "@bothy-board/core/types";

export function statusTone(status: TaskStatus): "muted" | "accent" | "danger" | "success" | "warn" {
  if (status === "done") return "success";
  if (status === "blocked" || status === "cancelled") return "danger";
  if (status === "in_progress" || status === "claimed") return "accent";
  if (status === "review" || status === "integrating") return "warn";
  return "muted";
}

export function kindTone(kind: TaskKind): "muted" | "accent" | "danger" | "success" | "warn" {
  if (kind === "bug") return "danger";
  if (kind === "integration") return "warn";
  if (kind === "feature") return "accent";
  return "muted";
}

export function agentTone(status: AgentStatus) {
  if (status === "working") return "accent" as const;
  if (status === "blocked") return "danger" as const;
  if (status === "offline") return "muted" as const;
  return "muted" as const;
}

export function worktreeTone(status: WorktreeStatus) {
  if (status === "merged") return "success" as const;
  if (status === "dirty") return "warn" as const;
  if (status === "abandoned") return "danger" as const;
  if (status === "pr") return "accent" as const;
  return "muted" as const;
}

export const COLUMNS: { id: string; label: string; statuses: TaskStatus[] }[] = [
  { id: "queue", label: "Queue", statuses: ["backlog", "ready"] },
  { id: "running", label: "Running", statuses: ["claimed", "in_progress"] },
  { id: "blocked", label: "Blocked", statuses: ["blocked"] },
  { id: "review", label: "Review", statuses: ["review", "integrating"] },
  { id: "done", label: "Done", statuses: ["done"] },
];

export function dropStatus(columnId: string): TaskStatus {
  switch (columnId) {
    case "running":
      return "in_progress";
    case "blocked":
      return "blocked";
    case "review":
      return "review";
    case "done":
      return "done";
    default:
      return "ready";
  }
}

export function shortId(id: string) {
  const parts = id.split("_");
  return parts[1]?.slice(0, 6) ?? id.slice(-6);
}

export function agentName(
  task: CompactTask,
  agents: { id: string; name: string; machineName: string }[],
) {
  const a = agents.find((x) => x.id === task.assigneeAgentId);
  return a ? `${a.name}@${a.machineName || "local"}` : null;
}
