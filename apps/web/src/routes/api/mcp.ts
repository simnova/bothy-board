import { createFileRoute } from "@tanstack/react-router";
import { handleMcp } from "@/lib/bothy-board/mcp";

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      GET: ({ request }) => handleMcp(request),
      POST: ({ request }) => handleMcp(request),
      OPTIONS: ({ request }) => handleMcp(request),
    },
  },
});
