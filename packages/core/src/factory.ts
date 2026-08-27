import { BoardError } from "./errors.ts";
import { FACTORY_STATES, type FactoryState, type TaskStatus } from "./types.ts";

export const CLAIM_TTL_MS = 10 * 60 * 1000;
export const MAX_IN_FLIGHT_PER_PROJECT = 2;
export const MAX_INTEGRATING_PER_PROJECT = 1;
export const SNAPSHOT_TASK_CAP = 5000;
export const MAILBOX_MAX_CHARS = 4_000;

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

const CONTRACT_KEYS = [
  "title",
  "body",
  "objective",
  "doneWhen",
  "writeRoots",
  "knownGood",
  "outOfScope",
  "notTested",
] as const;

export function assertContractPatch(
  writer: WriterKind,
  factory: FactoryState,
  patch: Partial<Record<(typeof CONTRACT_KEYS)[number], unknown>>,
): void {
  const touching = CONTRACT_KEYS.some((k) => patch[k] !== undefined);
  if (!touching) return;
  if (writer === "agent") {
    throw new BoardError("forbidden", "Workers cannot rewrite the card contract.");
  }
  if (factory !== "Idle" && writer !== "owner") {
    throw new BoardError("forbidden", "Contract is frozen after Planted.");
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

export function pathUnderRoots(path: string, roots: string[]): boolean {
  const p = path.replace(/^\.\//, "").replace(/\\/g, "/");
  if (!roots.length) return true;
  return roots.some((r) => {
    const root = r.replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/$/, "");
    return p === root || p.startsWith(`${root}/`);
  });
}

export function changedPaths(doneWhen: string[]): string[] {
  return doneWhen
    .map((line) => line.replace(/^\s*-\s+/, "").trim())
    .filter((line) => line.startsWith("changed:"))
    .map((line) => line.slice("changed:".length).trim())
    .filter(Boolean);
}

export function assertChangedUnderRoots(doneWhen: string[], writeRoots: string[]): void {
  const paths = changedPaths(doneWhen);
  if (!paths.length) return;
  if (!writeRoots.length) {
    throw new BoardError("invalid_card", "changed: requires write_roots.");
  }
  for (const path of paths) {
    if (!pathUnderRoots(path, writeRoots)) {
      throw new BoardError(
        "forbidden",
        `changed:${path} is outside write_roots (${writeRoots.join(", ")}).`,
      );
    }
  }
}

export function assertMailboxBody(body: string): void {
  const text = body.trim();
  if (!text) throw new BoardError("invalid_card", "Mailbox body required.");
  if (text.length > MAILBOX_MAX_CHARS) {
    throw new BoardError(
      "too_large",
      `Mailbox posts are capped at ${MAILBOX_MAX_CHARS} characters.`,
    );
  }
}

export function clampCap(raw: number | null | undefined, fallback: number, max = 32): number {
  if (raw == null || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(raw)));
}

/** Dequeue: Planted + ready + deps done + not a parent. Affinity machine sorts first. */
export function dequeueIds<
  T extends {
    id: string;
    status: TaskStatus;
    factory: FactoryState;
    priority: number;
    depIds: string[];
    childCount: number;
    affinityMachineName?: string | null;
  },
>(tasks: T[], opts?: { machineName?: string | null | undefined }): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const machine = opts?.machineName?.trim() || "";
  return tasks
    .filter((t) => {
      if (t.childCount > 0) return false;
      if (t.status !== "ready" || t.factory !== "Planted") return false;
      return t.depIds.every((id) => byId.get(id)?.status === "done");
    })
    .sort((a, b) => {
      if (machine) {
        const ah = a.affinityMachineName === machine ? 0 : 1;
        const bh = b.affinityMachineName === machine ? 0 : 1;
        if (ah !== bh) return ah - bh;
      }
      return a.priority - b.priority || a.id.localeCompare(b.id);
    })
    .map((t) => t.id);
}
