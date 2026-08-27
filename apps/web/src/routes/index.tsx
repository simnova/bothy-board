import { createFileRoute } from "@tanstack/react-router";
import { Landing } from "@/components/bothy-board/landing";

export const Route = createFileRoute("/")({ component: Landing });
