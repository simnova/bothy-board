import { createFileRoute } from "@tanstack/react-router";
import { handleRest } from "@/lib/bothy-board/rest";

export const Route = createFileRoute("/api/v1/")({
  server: {
    handlers: {
      GET: ({ request }) => handleRest(request),
      OPTIONS: ({ request }) => handleRest(request),
    },
  },
});
