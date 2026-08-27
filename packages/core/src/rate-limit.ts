import { getSql } from "@bothy-board/db";
import type { Actor } from "./actor";
import { sha256Hex } from "./hash";
import { corsHeaders } from "./http";

export type RateKind =
  | "read"
  | "write"
  | "expensive"
  | "auth"
  | "ui"
  | "ip"
  | "destructive"
  | "agentDestroy";

type Quota = { limit: number; windowMs: number };

export class RateLimited extends Error {
  readonly status = 429;
  constructor(
    readonly retryAfterSec: number,
    readonly limit: number,
    readonly remaining: number,
    readonly resetAt: number,
  ) {
    super("Too many requests");
    this.name = "RateLimited";
  }
}

export function isRateLimited(err: unknown): err is RateLimited {
  return err instanceof RateLimited;
}

const globalRef = globalThis as typeof globalThis & {
  __bothyBoardRateBuckets__?: Map<string, { count: number; windowStart: number }>;
};

function buckets(): Map<string, { count: number; windowStart: number }> {
  globalRef.__bothyBoardRateBuckets__ ??= new Map();
  return globalRef.__bothyBoardRateBuckets__;
}

/** Neon/Vercel: real money. Preview/PGLite: single process, looser so demos work. */
export function isHosted(): boolean {
  return Boolean(process.env["VERCEL"]) || Boolean(process.env["DATABASE_URL"]?.trim());
}

function durableEnabled(): boolean {
  return Boolean(process.env["DATABASE_URL"]?.trim());
}

function quotas(): Record<RateKind, Quota> {
  if (isHosted()) {
    return {
      read: { limit: 90, windowMs: 60_000 },
      write: { limit: 90, windowMs: 60_000 },
      expensive: { limit: 8, windowMs: 60_000 },
      auth: { limit: 12, windowMs: 60_000 },
      ui: { limit: 90, windowMs: 60_000 },
      ip: { limit: 180, windowMs: 60_000 },
      destructive: { limit: 20, windowMs: 60_000 },
      agentDestroy: { limit: 3, windowMs: 15 * 60_000 },
    };
  }
  return {
    read: { limit: 180, windowMs: 60_000 },
    write: { limit: 60, windowMs: 60_000 },
    expensive: { limit: 20, windowMs: 60_000 },
    auth: { limit: 30, windowMs: 60_000 },
    ui: { limit: 180, windowMs: 60_000 },
    ip: { limit: 360, windowMs: 60_000 },
    destructive: { limit: 40, windowMs: 60_000 },
    agentDestroy: { limit: 8, windowMs: 60_000 },
  };
}

export function clientIp(request: Request): string {
  const vercel = request.headers.get("x-vercel-forwarded-for");
  const forwarded = request.headers.get("x-forwarded-for");
  const real = request.headers.get("x-real-ip") ?? request.headers.get("cf-connecting-ip");
  const raw = vercel || forwarded || real || "local";
  const first = raw.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "local";
}

export function clientIpHash(request: Request): string {
  return sha256Hex(clientIp(request)).slice(0, 16);
}

function memoryHit(
  bucket: string,
  windowStart: number,
  quota: Quota,
): { count: number; resetAt: number } {
  const store = buckets();
  const slot = store.get(bucket);
  if (!slot || slot.windowStart !== windowStart) {
    store.set(bucket, { count: 1, windowStart });
    return { count: 1, resetAt: windowStart + quota.windowMs };
  }
  slot.count += 1;
  return { count: slot.count, resetAt: windowStart + quota.windowMs };
}

function memoryForce(bucket: string, windowStart: number, count: number): void {
  buckets().set(bucket, { count, windowStart });
}

async function durableHit(bucket: string, windowStart: number): Promise<number> {
  const sql = await getSql();
  const rows = await sql<{ hits: number }>`
    insert into rate_limits (bucket, window_start, hits)
    values (${bucket}, ${windowStart}, 1)
    on conflict (bucket, window_start)
    do update set hits = rate_limits.hits + 1
    returning hits`;
  const hits = rows[0]?.hits ?? 1;
  if (hits === 1) {
    const cutoff = windowStart - 10 * 60_000;
    void sql`delete from rate_limits where window_start < ${cutoff}`.catch(() => undefined);
  }
  return hits;
}

export async function consumeRateLimit(bucket: string, kind: RateKind): Promise<void> {
  const quota = quotas()[kind];
  const now = Date.now();
  const windowStart = Math.floor(now / quota.windowMs) * quota.windowMs;
  const mem = memoryHit(bucket, windowStart, quota);
  const retryAfterSec = Math.max(1, Math.ceil((mem.resetAt - now) / 1000));
  // Cost control: a hot isolate stops hitting Neon once it is already over.
  if (mem.count > quota.limit) {
    throw new RateLimited(retryAfterSec, quota.limit, 0, mem.resetAt);
  }
  if (!durableEnabled()) return;
  const hits = await durableHit(bucket, windowStart);
  if (hits > quota.limit) {
    memoryForce(bucket, windowStart, hits);
    throw new RateLimited(retryAfterSec, quota.limit, 0, mem.resetAt);
  }
}

export async function enforceIpLimit(request: Request, kind: RateKind = "ip"): Promise<void> {
  await consumeRateLimit(`ip:${clientIpHash(request)}:${kind}`, kind);
}

export async function enforceActorUserLimit(userId: string, kind: RateKind): Promise<void> {
  await consumeRateLimit(`user:${userId}:${kind}`, kind);
}

function identityBuckets(actor: Actor, kind: RateKind): string[] {
  if (actor.type === "pat") return [`user:${actor.userId}:${kind}`, `pat:${actor.tokenId}:${kind}`];
  if (actor.type === "agent")
    return [`key:${actor.keyId}:${kind}`, `ws:${actor.workspaceId}:${kind}`];
  return [`user:${actor.userId}:${kind}`];
}

export async function enforceActorLimit(actor: Actor, kind: RateKind): Promise<void> {
  const resolved =
    kind === "destructive" && actor.type !== "user" ? ("agentDestroy" satisfies RateKind) : kind;
  for (const bucket of identityBuckets(actor, resolved)) {
    await consumeRateLimit(bucket, resolved);
  }
}

export async function enforceDestructiveLimit(actor: Actor): Promise<void> {
  await enforceActorLimit(actor, "destructive");
}

export async function noteFailedAuth(request: Request): Promise<void> {
  await consumeRateLimit(`bad:${clientIpHash(request)}`, "auth");
}

export function restKind(method: string, path: string): RateKind {
  if (method === "DELETE" && (path === "project" || path.startsWith("tasks/")))
    return "destructive";
  if (method === "GET") return "read";
  if (
    path.startsWith("sessions") ||
    path === "tokens" ||
    path === "keys" ||
    path.includes("invite")
  ) {
    return "expensive";
  }
  return "write";
}

export function mcpKind(rpcMethod: string, toolName = ""): RateKind {
  if (rpcMethod !== "tools/call") return "read";
  if (
    toolName === "bothy-board.tasks.delete" ||
    toolName === "bothy-board.tasks.restore" ||
    toolName === "bothy-board.trash.list"
  ) {
    return "destructive";
  }
  if (
    toolName === "bothy-board.sessions.mint" ||
    toolName === "bothy-board.sessions.resume" ||
    toolName === "bothy-board.sessions.bind"
  ) {
    return "expensive";
  }
  if (
    toolName === "bothy-board.sync" ||
    toolName === "bothy-board.tasks.next" ||
    toolName === "bothy-board.tasks.get" ||
    toolName === "bothy-board.team.members" ||
    toolName === "bothy-board.mailbox.poll"
  ) {
    return "read";
  }
  return "write";
}

export function rateLimitedResponse(err: RateLimited, request: Request): Response {
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json");
  headers.set("Retry-After", String(err.retryAfterSec));
  headers.set("X-RateLimit-Limit", String(err.limit));
  headers.set("X-RateLimit-Remaining", String(err.remaining));
  headers.set("X-RateLimit-Reset", String(Math.ceil(err.resetAt / 1000)));
  return new Response(JSON.stringify({ error: "rate_limited", retryAfterSec: err.retryAfterSec }), {
    status: 429,
    headers,
  });
}
