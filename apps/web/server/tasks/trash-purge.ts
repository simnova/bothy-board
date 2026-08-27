import { purgeAllExpiredTrash } from "@bothy-board/core/trash";
import { defineTask } from "nitro/task";

export default defineTask({
  meta: {
    name: "trash:purge",
    description: "Hard-delete tasks and projects past the 7-day trash window",
  },
  async run() {
    const result = await purgeAllExpiredTrash();
    return { result };
  },
});
