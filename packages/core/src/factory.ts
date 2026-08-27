import { BoardError } from "./errors.ts";
import { FACTORY_STATES, type FactoryState, type TaskStatus } from "./types.ts";

export const CLAIM_TTL_MS = 10 * 60 * 1000;
export const MAX_IN_FLIGHT_PER_PROJECT = 2;
export const SNAPSHOT_TASK_CAP = 5000;

const WORKER_STATUS = new Set<TaskStatus>(["in_progress", "review", "blocked"]);
const IN_FLIGHT_STATUS = new Set<TaskStatus>(["claimed", "in_progress", "review"]);

export type WriterKind = "owner" | "agent" | "orchestrator";

export function parseFactory(raw: string | null | undefined): FactoryState {
  if (raw && (FACTORY_STATES as readonly string[]).includes(raw)) return raw as FactoryState;
  return "Idle";
}

export function isInFlight(status: TaskStatus, factory: FactoryState): boolean {
  return IN_FLIGHT_STATUS.has(status) && (factory === "Planted" || factory === "Dispatched");
}

export function assertClaimable(row: {
  status: TaskStatus;
  factory: FactoryState;
  assigneeAgentId: string | null;
  childCount?: number;
}): void {
  if (row.childCount && row.childCount > 0) {
    throw new BoardError("not_ready", "Parent containers are not in the dequeue.");
  }
  if (row.status !== "ready" || row.factory !== "Planted") {
    throw new BoardError("not_ready", "Claim requires factory=Planted and status=ready.");
  }
  if (row.assigneeAgentId) throw new BoardError("already_claimed", "Task already claimed.");
}

export function assertWorkerPatch(patch: {
  status?: TaskStatus | undefined;
  factory?: FactoryState | undefined;
}): void {
  if (patch.factory) {
    throw new BoardError("forbidden", "Workers cannot set factory (Planted/Landed/Graded).");
  }
  if (patch.status && !WORKER_STATUS.has(patch.status)) {
    throw new BoardError(
      "forbidden",
      "Workers may set review or blocked, not done/Landed/ready/cancelled.",
    );
  }
}

export function nextFactoryOnBind(current: FactoryState): FactoryState {
  if (current === "Planted" || current === "Dispatched") return "Dispatched";
  throw new BoardError("not_ready", "Bind requires a Planted (or already Dispatched) task.");
}

export function writeRootsOverlap(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return true;
  const set = new Set(a);
  return b.some((p) => set.has(p));
}

/** Dequeue: Planted + ready + deps done + not a parent container. */
export function dequeueIds<
  T extends {
    id: string;
    status: TaskStatus;
    factory: FactoryState;
    priority: number;
    depIds: string[];
    childCount: number;
  },
>(tasks: T[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks
    .filter((t) => {
      if (t.childCount > 0) return false;
      if (t.status !== "ready" || t.factory !== "Planted") return false;
      return t.depIds.every((id) => byId.get(id)?.status === "done");
    })
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map((t) => t.id);
}
