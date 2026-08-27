import { cacheTokenFor } from "./hash";

export function corsHeaders(request: Request): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", request.headers.get("origin") || "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, If-None-Match, X-Bothy-Board-Cache-Token, X-Grok-Session-Id",
  );
  headers.set(
    "Access-Control-Expose-Headers",
    "ETag, X-Bothy-Board-Revision, X-Bothy-Board-Cache-Token, X-Bothy-Board-Cache, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset",
  );
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin, Authorization, If-None-Match");
  return headers;
}

export function withCache(
  body: unknown,
  workspaceId: string,
  revision: number,
  request: Request,
  extra?: HeadersInit,
  projectKey = "",
): Response {
  const token = cacheTokenFor(workspaceId, revision, projectKey);
  const etag = `"${token}"`;
  const incoming =
    request.headers.get("if-none-match") ||
    request.headers.get("x-bothy-board-cache-token") ||
    new URL(request.url).searchParams.get("cacheToken") ||
    "";
  const normalized = incoming.replaceAll('"', "");
  const headers = corsHeaders(request);
  headers.set("ETag", etag);
  headers.set("X-Bothy-Board-Revision", String(revision));
  headers.set("X-Bothy-Board-Cache-Token", token);
  headers.set("Cache-Control", "private, max-age=0, must-revalidate");
  headers.set("Content-Type", "application/json");
  if (extra) {
    const extraHeaders = new Headers(extra);
    extraHeaders.forEach((v, k) => {
      headers.set(k, v);
    });
  }
  if (normalized && normalized === token) {
    headers.set("X-Bothy-Board-Cache", "HIT");
    return new Response(null, { status: 304, headers });
  }
  headers.set("X-Bothy-Board-Cache", "MISS");
  const payload = {
    cacheToken: token,
    revision,
    staleAfterMs: 8000,
    data: body,
  };
  return new Response(JSON.stringify(payload), { status: 200, headers });
}

export function json(
  body: unknown,
  status: number,
  request: Request,
  extra?: HeadersInit,
): Response {
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json");
  if (extra) {
    new Headers(extra).forEach((v, k) => {
      headers.set(k, v);
    });
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}
