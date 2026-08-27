import type { CompactTask, Snapshot, TaskStatus } from "@bothy-board/core/types";
import { Badge } from "@bothy-board/ui/badge";
import { Button } from "@bothy-board/ui/button";
import { cn } from "@bothy-board/ui/cn";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Plus } from "lucide-react";
import { useState } from "react";
import { getSnapshot, patchTask, postTask } from "@/lib/bothy-board/server-fns";
import { GraphView } from "./graph-view";
import { agentName, COLUMNS, dropStatus, kindTone, shortId, statusTone } from "./status";
import { TaskPanel } from "./task-panel";

export function BoardView() {
  const qc = useQueryClient();
  const snap = useQuery({
    queryKey: ["snapshot"],
    queryFn: () => getSnapshot(),
    refetchInterval: 8000,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"board" | "graph">("board");
  const [draft, setDraft] = useState("");
  const [projectId, setProjectId] = useState("");

  const data = snap.data;
  const projects = data?.projects?.length ? data.projects : data?.project.id ? [data.project] : [];
  const preferred = projects.find((p) => p.name === "BothyBoard")?.id ?? projects[0]?.id ?? "";
  const activeProjectId = projectId || preferred;
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? data?.project;
  const viewData = data
    ? (() => {
        const tasks = activeProjectId
          ? data.tasks.filter((t) => t.projectId === activeProjectId)
          : data.tasks;
        return {
          ...data,
          project: activeProject ?? data.project,
          tasks,
          readyIds: data.readyIds.filter((id) => tasks.some((t) => t.id === id)),
        };
      })()
    : null;
  const selectedTask = viewData?.tasks.find((t) => t.id === selected) ?? null;

  const create = useMutation({
    mutationFn: (title: string) =>
      postTask({
        data: activeProjectId ? { title, projectId: activeProjectId } : { title },
      }),
    onSuccess: (res) => {
      qc.setQueryData(["snapshot"], res.snapshot);
      setDraft("");
    },
  });

  const move = useMutation({
    mutationFn: (input: { taskId: string; status: TaskStatus }) => patchTask({ data: input }),
    onSuccess: (next) => qc.setQueryData(["snapshot"], next),
  });

  if (snap.isPending && !data) {
    return <BoardSkeleton />;
  }
  if (snap.error) {
    const message = (snap.error as Error).message || "Could not load board";
    if (message === "Unauthorized") {
      return (
        <p className="text-sm text-muted">
          Session expired.{" "}
          <a href="/login" className="text-fg underline">
            Sign in again
          </a>
          .
        </p>
      );
    }
    return <p className="text-sm text-danger">{message}</p>;
  }
  if (!data || !viewData) return null;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-subtle">
            {viewData.workspace.name} /{" "}
            {viewData.project.repo || viewData.project.name || "no project"}
          </p>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-medium tracking-tight">
            Board
            {viewData.project.id ? (
              <Badge tone={viewData.project.visibility === "public" ? "accent" : "muted"}>
                {viewData.project.visibility}
              </Badge>
            ) : null}
            {viewData.myRole ? <Badge>{viewData.myRole}</Badge> : null}
          </h1>
          {projects.length > 1 ? (
            <label className="mt-3 block">
              <span className="sr-only">Project</span>
              <select
                value={activeProjectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="h-11 max-w-xs rounded-[var(--radius-md)] border border-border bg-bg px-2 text-sm outline-none focus:ring-2 focus:ring-accent/30"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Stat label="rev" value={String(viewData.revision)} />
          <Stat label="cache" value={viewData.cacheToken} />
          <Stat label="ready" value={String(viewData.readyIds.length)} />
          <div className="flex rounded-[var(--radius-sm)] border border-border p-0.5">
            {(["board", "graph"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={cn(
                  "rounded-[6px] px-3 py-1.5 text-xs capitalize",
                  view === v ? "bg-surface-2 text-fg" : "text-muted",
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {view === "graph" ? (
        <GraphView snapshot={viewData} onSelect={setSelected} />
      ) : (
        <Kanban
          data={viewData}
          draft={draft}
          setDraft={setDraft}
          onCreate={() => draft.trim() && create.mutate(draft.trim())}
          creating={create.isPending}
          onSelect={setSelected}
          onMove={(taskId, status) => move.mutate({ taskId, status })}
        />
      )}

      {selectedTask && viewData ? (
        <TaskPanel snapshot={viewData} taskId={selectedTask.id} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  );
}

function Kanban({
  data,
  draft,
  setDraft,
  onCreate,
  creating,
  onSelect,
  onMove,
}: {
  data: Snapshot;
  draft: string;
  setDraft: (v: string) => void;
  onCreate: () => void;
  creating: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, status: TaskStatus) => void;
}) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-4">
      {COLUMNS.map((col) => {
        const items = data.tasks.filter((t) => col.statuses.includes(t.status) && t.parentId);
        const roots = data.tasks.filter((t) => col.statuses.includes(t.status) && !t.parentId);
        const shown = [...roots, ...items];
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: HTML5 drop target for the column
          <section
            key={col.id}
            className="w-[260px] shrink-0 rounded-[var(--radius-lg)] border border-border bg-surface p-3"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const id = e.dataTransfer.getData("text/task-id");
              if (id) onMove(id, dropStatus(col.id));
            }}
          >
            <header className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-medium">{col.label}</h2>
              <span className="font-mono text-[11px] tabular-nums text-subtle">{shown.length}</span>
            </header>
            {col.id === "queue" ? (
              <form
                className="mb-3 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  onCreate();
                }}
              >
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="New task"
                  className="h-9 w-full rounded-[var(--radius-sm)] border border-border bg-bg px-2 text-sm outline-none placeholder:text-subtle focus:ring-2 focus:ring-accent/30"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={creating || !draft.trim()}
                  className="px-2"
                >
                  <Plus className="size-4" />
                </Button>
              </form>
            ) : null}
            <div className="space-y-2">
              {shown.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  snapshot={data}
                  onSelect={() => onSelect(task.id)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TaskCard({
  task,
  snapshot,
  onSelect,
}: {
  task: CompactTask;
  snapshot: Snapshot;
  onSelect: () => void;
}) {
  const agent = agentName(task, snapshot.agents);
  const blocked = task.depIds.filter(
    (id) => snapshot.tasks.find((t) => t.id === id)?.status !== "done",
  );
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/task-id", task.id)}
      onClick={onSelect}
      className="w-full rounded-[var(--radius-md)] border border-border bg-bg p-3 text-left transition-colors duration-150 hover:border-accent/40"
    >
      <div className="mb-2 flex items-center gap-1.5">
        <Badge tone={kindTone(task.kind)}>{task.kind}</Badge>
        <Badge tone={statusTone(task.status)}>{task.status.replace("_", " ")}</Badge>
      </div>
      <p className="text-sm font-medium leading-snug">{task.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[10px] text-subtle">
        <span>{shortId(task.id)}</span>
        {task.branch ? (
          <span className="inline-flex items-center gap-1">
            <GitBranch className="size-3" />
            {task.branch.replace(/^(feat|fix|integrate)\//, "")}
          </span>
        ) : null}
        {task.continuationId ? <span>cont {task.continuationId.slice(-6)}</span> : null}
        {task.grokSessionId ? <span>sess {task.grokSessionId.slice(0, 8)}</span> : null}
        {task.affinityMachineName ? <span>@{task.affinityMachineName}</span> : null}
      </div>
      {agent ? <p className="mt-2 text-[11px] text-muted">{agent}</p> : null}
      {blocked.length > 0 ? (
        <p className="mt-1 text-[11px] text-danger">blocked by {blocked.length}</p>
      ) : null}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-sm)] border border-border bg-surface px-2.5 py-1.5">
      <p className="font-mono text-[10px] uppercase tracking-wide text-subtle">{label}</p>
      <p className="max-w-[160px] truncate font-mono text-[11px] tabular-nums text-fg">{value}</p>
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-10 w-48 animate-pulse rounded-md bg-surface" />
      <div className="flex gap-3">
        {COLUMNS.map((col) => (
          <div
            key={col.id}
            className="h-72 w-[260px] animate-pulse rounded-[var(--radius-lg)] bg-surface"
          />
        ))}
      </div>
    </div>
  );
}
