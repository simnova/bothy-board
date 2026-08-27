import { enforceActorUserLimit, enforceIpLimit } from "@bothy-board/core/rate-limit";
import { createMiddleware } from "@tanstack/react-start";

async function currentRequest(): Promise<Request | undefined> {
  const { getRequest } = await import("@tanstack/react-start/server");
  try {
    return getRequest();
  } catch {
    return undefined;
  }
}

/** Cookie-session server functions: per-user UI quota + IP backstop. */
export const rateLimitMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next, context }) => {
    const request = await currentRequest();
    if (request) await enforceIpLimit(request);
    const userId =
      context && typeof context === "object" && "userId" in context
        ? (context as { userId?: unknown }).userId
        : undefined;
    if (typeof userId === "string" && userId) await enforceActorUserLimit(userId, "ui");
    return next();
  },
);

/** Public (unsigned) loaders: IP only. */
export const publicRateLimitMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const request = await currentRequest();
    if (request) await enforceIpLimit(request, "read");
    return next();
  },
);
