import type { CompactTask, Snapshot, TaskStatus } from "@bothy-board/core/types";
import { Badge } from "@bothy-board/ui/badge";
import { Button } from "@bothy-board/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import {
  getTask,
  patchTask,
  postClaim,
  postComment,
  postDecompose,
  postDeleteTask,
  postMintSession,
  postPlant,
  postResumeSession,
} from "@/lib/bothy-board/server-fns";
import { kindTone, statusTone } from "./status";

const STATUSES: TaskStatus[] = [
  "backlog",
  "ready",
  "claimed",
  "in_progress",
  "blocked",
  "review",
  "integrating",
  "done",
  "cancelled",
];

export function TaskPanel({
  snapshot,
  taskId,
  onClose,
}: {
  snapshot: Snapshot;
  taskId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const user = useCurrentUser();
  const detail = useQuery({ queryKey: ["task", taskId], queryFn: () => getTask({ data: taskId }) });
  const [note, setNote] = useState("");
  const [split, setSplit] = useState("");
  const [machine, setMachine] = useState("preview-host");
  const [copied, setCopied] = useState<string | null>(null);
  const [resumeLog, setResumeLog] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (status: TaskStatus) => patchTask({ data: { taskId, status } }),
    onSuccess: (next) => {
      qc.setQueryData(["snapshot"], next);
      void detail.refetch();
    },
  });
  const comment = useMutation({
    mutationFn: (body: string) =>
      postComment({
        data: { taskId, body, authorName: user?.displayName || user?.primaryEmail || "member" },
      }),
    onSuccess: () => {
      setNote("");
      void detail.refetch();
    },
  });
  const claim = useMutation({
    mutationFn: () =>
      postClaim({
        data: {
          taskId,
          name: "human-dispatch",
          kind: "other",
          machineName: machine,
        },
      }),
    onSuccess: (res) => {
      qc.setQueryData(["snapshot"], res.snapshot);
      void detail.refetch();
    },
  });
  const plant = useMutation({
    mutationFn: () => postPlant({ data: { taskId } }),
    onSuccess: (next) => {
      qc.setQueryData(["snapshot"], next);
      void detail.refetch();
    },
  });
  const remove = useMutation({
    mutationFn: () => postDeleteTask({ data: { taskId } }),
    onSuccess: (next) => {
      qc.setQueryData(["snapshot"], next);
      void qc.invalidateQueries({ queryKey: ["trash"] });
      onClose();
    },
  });
  const mint = useMutation({
    mutationFn: () => postMintSession({ data: { taskId, machineName: machine } }),
    onSuccess: (res) => {
      if (res.snapshot) qc.setQueryData(["snapshot"], res.snapshot);
      void detail.refetch();
    },
  });
  const resume = useMutation({
    mutationFn: () => postResumeSession({ data: { taskId, machineName: machine } }),
    onSuccess: (res) => {
      if ("resumeCommand" in res && res.resumeCommand) setResumeLog(res.resumeCommand);
      else if ("reason" in res) setResumeLog(String(res.reason));
      else setResumeLog(JSON.stringify(res));
    },
  });
  const decompose = useMutation({
    mutationFn: (titles: string[]) =>
      postDecompose({ data: { taskId, children: titles.map((title) => ({ title })) } }),
    onSuccess: (next) => {
      qc.setQueryData(["snapshot"], next);
      setSplit("");
      void detail.refetch();
    },
  });

  const task = detail.data;
  const deps = (task?.depIds ?? [])
    .map((id) => snapshot.tasks.find((t) => t.id === id))
    .filter((t): t is CompactTask => t !== undefined);
  const spawn = mint.data?.minted?.spawnCommand;
  const sessionId = task?.grokSessionId;

  async function copy(label: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1600);
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-bg/50"
        aria-label="Close task"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-md flex-col border-l border-border bg-surface shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {task ? <Badge tone={kindTone(task.kind)}>{task.kind}</Badge> : null}
              {task ? (
                <Badge tone={statusTone(task.status)}>{task.status.replace("_", " ")}</Badge>
              ) : null}
              {task ? <Badge>{task.factory}</Badge> : null}
            </div>
            <h2 className="text-lg font-medium leading-snug tracking-tight">
              {task?.title ?? "Loading"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid size-11 place-items-center text-muted hover:text-fg"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {task?.body ? <p className="text-sm leading-relaxed text-muted">{task.body}</p> : null}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 font-mono text-[11px]">
            <dt className="text-subtle">continuation</dt>
            <dd className="truncate text-fg">{task?.continuationId ?? "—"}</dd>
            <dt className="text-subtle">grok session</dt>
            <dd className="truncate text-fg">{task?.grokSessionId ?? "—"}</dd>
            <dt className="text-subtle">subagent</dt>
            <dd className="truncate">{task?.grokSubagentId ?? "—"}</dd>
            <dt className="text-subtle">affinity</dt>
            <dd className="truncate">{task?.affinityMachineName ?? "unbound"}</dd>
            <dt className="text-subtle">branch</dt>
            <dd className="truncate">{task?.branch ?? "—"}</dd>
            <dt className="text-subtle">worktree</dt>
            <dd className="truncate">{task?.worktreePath ?? "—"}</dd>
            <dt className="text-subtle">integration</dt>
            <dd>{task?.integrationStatus}</dd>
          </dl>
          {task?.blockedReason ? <p className="text-sm text-danger">{task.blockedReason}</p> : null}
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-subtle">
              Grok Bind
            </h3>
            <p className="mb-2 text-sm leading-relaxed text-muted">
              Mint a session UUID before spawn. Resume only works on the parked machine. Mid-run
              talk uses the mailbox below — Grok cannot prompt a running child.
            </p>
            <label className="mb-2 block text-[11px] text-subtle">
              Machine
              <input
                value={machine}
                onChange={(e) => setMachine(e.target.value)}
                className="mt-1 h-11 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 text-sm outline-none focus:ring-2 focus:ring-accent/30"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => mint.mutate()}
                disabled={mint.isPending || !machine.trim()}
              >
                Mint session
              </Button>
              <Button
                variant="secondary"
                onClick={() => resume.mutate()}
                disabled={resume.isPending || !sessionId}
              >
                Check resume
              </Button>
              <Button variant="secondary" onClick={() => claim.mutate()} disabled={claim.isPending}>
                Dispatch
              </Button>
              {task?.factory === "Idle" ? (
                <Button
                  variant="secondary"
                  onClick={() => plant.mutate()}
                  disabled={plant.isPending}
                >
                  Plant
                </Button>
              ) : null}
            </div>
            {spawn ? (
              <div className="mt-3">
                <button
                  type="button"
                  className="w-full rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2 text-left font-mono text-[11px] leading-relaxed text-muted"
                  onClick={() => copy("spawn", spawn)}
                >
                  {copied === "spawn" ? "Copied spawn command" : spawn}
                </button>
              </div>
            ) : sessionId ? (
              <button
                type="button"
                className="mt-3 w-full rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2 text-left font-mono text-[11px] leading-relaxed text-muted"
                onClick={() =>
                  copy(
                    "resume",
                    `grok --resume ${sessionId} -p "Read BothyBoard task ${taskId}. Poll mailbox, then continue."`,
                  )
                }
              >
                {copied === "resume"
                  ? "Copied resume command"
                  : `grok --resume ${sessionId} -p "Read BothyBoard task ${taskId}…"`}
              </button>
            ) : null}
            {resumeLog ? (
              <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted">{resumeLog}</p>
            ) : null}
          </section>
          {deps.length > 0 ? (
            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-subtle">
                Depends on
              </h3>
              <ul className="space-y-1 text-sm">
                {deps.map((d) => (
                  <li key={d.id} className="flex justify-between gap-2">
                    <span>{d.title}</span>
                    <Badge tone={statusTone(d.status)}>{d.status}</Badge>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {task?.children.length ? (
            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-subtle">
                Children
              </h3>
              <ul className="space-y-1 text-sm">
                {task.children.map((c) => (
                  <li key={c.id} className="flex justify-between gap-2">
                    <span>{c.title}</span>
                    <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-subtle">Status</h3>
            <div className="flex flex-wrap gap-1.5">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => save.mutate(s)}
                  className="rounded-full border border-border px-2.5 py-1 text-[11px] hover:bg-surface-2"
                >
                  {s.replace("_", " ")}
                </button>
              ))}
            </div>
          </section>
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-subtle">
              Decompose
            </h3>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const titles = split
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean);
                if (titles.length) decompose.mutate(titles);
              }}
            >
              <textarea
                value={split}
                onChange={(e) => setSplit(e.target.value)}
                placeholder={"One child title per line"}
                rows={3}
                className="w-full rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-accent/30"
              />
            </form>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              disabled={!split.trim() || decompose.isPending}
              onClick={() => {
                const titles = split
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean);
                if (titles.length) decompose.mutate(titles);
              }}
            >
              Split
            </Button>
          </section>
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-subtle">
              Mailbox
            </h3>
            <p className="mb-2 text-xs text-subtle">
              Agents poll this thread. It is the cross-machine conversation bus.
            </p>
            <ul className="space-y-3">
              {(task?.comments ?? []).map((c) => (
                <li key={c.id}>
                  <p className="font-mono text-[11px] text-subtle">
                    {c.authorName} · {c.authorKind}
                  </p>
                  <p className="text-sm leading-relaxed">{c.body}</p>
                </li>
              ))}
            </ul>
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (note.trim()) comment.mutate(note.trim());
              }}
            >
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Steer the worker"
                className="h-11 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 text-sm outline-none focus:ring-2 focus:ring-accent/30"
              />
              <Button type="submit" disabled={!note.trim() || comment.isPending}>
                Send
              </Button>
            </form>
          </section>
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-subtle">Trash</h3>
            <p className="mb-2 text-xs text-subtle">
              Soft-delete hides this task for 7 days. Restore it from Team → Trash.
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Move to trash
            </Button>
          </section>
        </div>
      </aside>
    </div>
  );
}
