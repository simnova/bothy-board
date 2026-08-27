import { createFileRoute } from "@tanstack/react-router";
import { BoardView } from "@/components/bothy-board/board-view";
import { RequireAuth } from "@/components/bothy-board/gate";

export const Route = createFileRoute("/board")({ component: BoardPage });

function BoardPage() {
  return (
    <RequireAuth>
      <BoardView />
    </RequireAuth>
  );
}
