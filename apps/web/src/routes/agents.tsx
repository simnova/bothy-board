import { Badge } from "@bothy-board/ui/badge";
import { Button } from "@bothy-board/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { RequireAuth } from "@/components/bothy-board/gate";
import { agentTone, shortId, worktreeTone } from "@/components/bothy-board/status";
import { getSnapshot, postHeartbeat } from "@/lib/bothy-board/server-fns";

export const Route = createFileRoute("/agents")({ component: AgentsPage });

function AgentsPage() {
  return (
    <RequireAuth>
      <Fleet />
    </RequireAuth>
  );
}

function Fleet() {
  const qc = useQueryClient();
  const snap = useQuery({
    queryKey: ["snapshot"],
    queryFn: () => getSnapshot(),
    refetchInterval: 8000,
  });
  const beat = useMutation({
    mutationFn: () =>
      postHeartbeat({
        data: {
          name: "console-sim",
          kind: "grok",
          machineName: "preview-host",
          currentTaskId: snap.data?.readyIds[0] ?? null,
        },
      }),
    onSuccess: (res) => qc.setQueryData(["snapshot"], res.snapshot),
  });
  const data = snap.data;
  if (!data) {
    return <div className="h-40 animate-pulse rounded-[var(--radius-lg)] bg-surface" />;
  }
  const machines = [...new Set(data.agents.map((a) => a.machineName).filter(Boolean))];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-subtle">Fleet</p>
          <h1 className="mt-1 text-2xl font-medium tracking-tight">Agents & worktrees</h1>
        </div>
        <Button variant="secondary" onClick={() => beat.mutate()} disabled={beat.isPending}>
          Heartbeat a local agent
        </Button>
      </div>
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Machines</h2>
        <div className="flex flex-wrap gap-2">
          {machines.map((m) => (
            <Badge key={m} tone="muted">
              {m}
            </Badge>
          ))}
        </div>
      </section>
      <section className="grid gap-3 md:grid-cols-2">
        {data.agents.map((a) => {
          const task = data.tasks.find((t) => t.id === a.currentTaskId);
          return (
            <article
              key={a.id}
              className="rounded-[var(--radius-lg)] border border-border bg-surface p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-medium">
                    {a.name}
                    <span className="text-muted"> @{a.machineName}</span>
                  </h3>
                  <p className="mt-1 font-mono text-[11px] text-subtle">
                    {a.kind} · {shortId(a.id)}
                  </p>
                </div>
                <Badge tone={agentTone(a.status)}>{a.status}</Badge>
              </div>
              <dl className="mt-4 space-y-1 font-mono text-[11px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-subtle">continuation</dt>
                  <dd className="truncate">{a.continuationId ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-subtle">grok session</dt>
                  <dd className="truncate">{task?.grokSessionId ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-subtle">parked on</dt>
                  <dd className="truncate">{task?.affinityMachineName ?? a.machineName}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-subtle">task</dt>
                  <dd className="truncate">{task?.title ?? "idle"}</dd>
                </div>
              </dl>
            </article>
          );
        })}
      </section>
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Worktree registry</h2>
        <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-border">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-surface text-subtle">
              <tr className="font-mono text-[11px] uppercase tracking-wide">
                <th className="px-3 py-2 font-medium">Path</th>
                <th className="px-3 py-2 font-medium">Branch</th>
                <th className="px-3 py-2 font-medium">Machine</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.worktrees.map((w) => (
                <tr key={w.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-[12px]">{w.path}</td>
                  <td className="px-3 py-2 font-mono text-[12px]">{w.branch}</td>
                  <td className="px-3 py-2">{w.machineName}</td>
                  <td className="px-3 py-2">
                    <Badge tone={worktreeTone(w.status)}>{w.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Activity</h2>
        <ul className="space-y-2">
          {data.events.map((e) => (
            <li
              key={e.id}
              className="rounded-[var(--radius-md)] border border-border bg-surface px-3 py-2 text-sm"
            >
              <span className="font-mono text-[11px] uppercase text-subtle">{e.kind}</span>
              <span className="ml-2">{e.message}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
