import type { Snapshot } from "@bothy-board/core/types";
import { statusTone } from "./status";

export function GraphView({
  snapshot,
  onSelect,
}: {
  snapshot: Snapshot;
  onSelect: (id: string) => void;
}) {
  const nodes = snapshot.tasks.filter((t) => t.parentId);
  const byId = new Map(snapshot.tasks.map((t) => [t.id, t]));
  const incoming = new Map<string, number>();
  for (const n of nodes) incoming.set(n.id, 0);
  for (const n of nodes) {
    for (const d of n.depIds) {
      if (incoming.has(n.id) && byId.get(d)) incoming.set(n.id, (incoming.get(n.id) ?? 0) + 1);
    }
  }
  const layers: string[][] = [];
  const remaining = new Set(nodes.map((n) => n.id));
  const indeg = new Map(incoming);
  while (remaining.size) {
    const ready = [...remaining].filter((id) => (indeg.get(id) ?? 0) === 0);
    const fallback = [...remaining][0];
    if (!ready.length && !fallback) break;
    const wave = ready.length ? ready : [fallback as string];
    layers.push(wave);
    for (const id of wave) remaining.delete(id);
    for (const n of nodes) {
      if (!remaining.has(n.id)) continue;
      const cut = n.depIds.filter((d) => wave.includes(d)).length;
      if (cut) indeg.set(n.id, Math.max(0, (indeg.get(n.id) ?? 0) - cut));
    }
  }

  const colW = 220;
  const rowH = 72;
  const width = Math.max(layers.length, 1) * colW + 40;
  const height = Math.max(...layers.map((l) => l.length), 1) * rowH + 40;

  return (
    <div className="overflow-auto rounded-[var(--radius-lg)] border border-border bg-surface p-4">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="min-w-full">
        <title>Task dependency graph</title>
        {layers.map((layer, i) =>
          layer.map((id) => {
            const task = byId.get(id);
            if (!task) return null;
            const x1 = 20 + i * colW + 180;
            const y1 = 20 + layer.indexOf(id) * rowH + 18;
            return task.depIds.map((dep) => {
              const li = layers.findIndex((l) => l.includes(dep));
              const lj = layers[li]?.indexOf(dep) ?? 0;
              if (li < 0) return null;
              const x0 = 20 + li * colW + 180;
              const y0 = 20 + lj * rowH + 18;
              return (
                <line
                  key={`${dep}-${id}`}
                  x1={x0}
                  y1={y0}
                  x2={x1 - 180}
                  y2={y1}
                  stroke="currentColor"
                  className="text-border"
                  strokeWidth="1"
                />
              );
            });
          }),
        )}
        {layers.map((layer, i) =>
          layer.map((id, j) => {
            const task = byId.get(id);
            if (!task) return null;
            const x = 20 + i * colW;
            const y = 20 + j * rowH;
            const tone = statusTone(task.status);
            const fill =
              tone === "danger"
                ? "rgb(212 122 118 / 0.15)"
                : tone === "success"
                  ? "rgb(143 191 159 / 0.15)"
                  : "rgb(26 26 30)";
            return (
              <a
                key={id}
                href={`#${id}`}
                className="cursor-pointer"
                onClick={(e) => {
                  e.preventDefault();
                  onSelect(id);
                }}
              >
                <rect
                  x={x}
                  y={y}
                  width={180}
                  height={52}
                  rx={10}
                  fill={fill}
                  stroke="currentColor"
                  className="text-border"
                />
                <text x={x + 10} y={y + 20} fill="currentColor" className="text-fg" fontSize="11">
                  {task.title.length > 26 ? `${task.title.slice(0, 26)}…` : task.title}
                </text>
                <text
                  x={x + 10}
                  y={y + 38}
                  fill="currentColor"
                  className="text-subtle"
                  fontSize="10"
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {task.status.replace("_", " ")}
                </text>
              </a>
            );
          }),
        )}
      </svg>
    </div>
  );
}
