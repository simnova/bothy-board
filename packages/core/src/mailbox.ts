import type { CommentRow } from "./types";

export type MailboxPollOpts = {
  since?: string | undefined;
  excludeGrokSessionId?: string | undefined;
  excludeAuthorAgentId?: string | undefined;
};

/** Drop the caller's own notes. authorName is not identity — many agents share it. */
export function visibleMailboxComments(
  comments: CommentRow[],
  opts?: MailboxPollOpts,
): CommentRow[] {
  const session = opts?.excludeGrokSessionId?.trim() || "";
  const agent = opts?.excludeAuthorAgentId?.trim() || "";
  if (!session && !agent) return comments;
  return comments.filter((comment) => {
    if (session && comment.grokSessionId && comment.grokSessionId === session) return false;
    if (agent && comment.authorAgentId && comment.authorAgentId === agent) return false;
    return true;
  });
}
