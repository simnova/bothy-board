import { enforceIpLimit, isRateLimited, rateLimitedResponse } from "@bothy-board/core/rate-limit";
import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/auth/server";

async function handleAuth(request: Request): Promise<Response> {
  try {
    await enforceIpLimit(request, "auth");
    return auth.handler(request);
  } catch (err) {
    if (isRateLimited(err)) return rateLimitedResponse(err, request);
    throw err;
  }
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleAuth(request),
      POST: ({ request }) => handleAuth(request),
    },
  },
});
