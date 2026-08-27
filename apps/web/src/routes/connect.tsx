import { DEFAULT_SCOPE_IDS, PAT_SCOPES, type PatScopeId } from "@bothy-board/core/scopes";
import { Badge } from "@bothy-board/ui/badge";
import { Button } from "@bothy-board/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { RequireAuth } from "@/components/bothy-board/gate";
import { getSnapshot, getTokens, postRevokeToken, postToken } from "@/lib/bothy-board/server-fns";

export const Route = createFileRoute("/connect")({ component: ConnectPage });

function ConnectPage() {
  return (
    <RequireAuth>
      <Connect />
    </RequireAuth>
  );
}

function Connect() {
  const snap = useQuery({ queryKey: ["snapshot"], queryFn: () => getSnapshot() });
  const [log, setLog] = useState<string>("");
  const [token, setToken] = useState<string>("");
  const [pat, setPat] = useState<string>("");
  const inspect = useMutation({
    mutationFn: async () => {
      const key = pat || snap.data?.mcpKey;
      if (!key) throw new Error("No MCP key");
      const headers: Record<string, string> = {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      };
      if (token) headers["X-Bothy-Board-Cache-Token"] = token;
      const init = await fetch("/api/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }).then((r) => r.json());
      const listed = await fetch("/api/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      }).then((r) => r.json());
      const sync = await fetch("/api/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "bothy-board.sync", arguments: { cacheToken: token || undefined } },
        }),
      }).then((r) => r.json());
      const rest = await fetch("/api/v1/snapshot", {
        headers: { Authorization: `Bearer ${key}`, "If-None-Match": token ? `"${token}"` : "" },
      });
      const parsed = sync?.result?.structuredContent as { cacheToken?: string } | undefined;
      if (parsed?.cacheToken) setToken(parsed.cacheToken);
      const tools = (listed?.result?.tools as { name: string }[] | undefined)?.map((t) => t.name);
      return {
        init,
        tools,
        sync,
        restStatus: rest.status,
        restCache: rest.headers.get("X-Bothy-Board-Cache"),
      };
    },
    onSuccess: (res) => setLog(JSON.stringify(res, null, 2)),
    onError: (err) => setLog((err as Error).message),
  });

  const data = snap.data;
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://your-app.grok.me";
  const bearer = pat || data?.mcpKey || "bb_pat_…";
  const mcpSnippet = `{
  "mcpServers": {
    "bothy-board": {
      "url": "${origin}/api/mcp",
      "headers": {
        "Authorization": "Bearer ${bearer}",
        "X-Grok-Session-Id": "\${GROK_SESSION_ID}"
      }
    }
  }
}`;

  return (
    <div className="space-y-8">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-subtle">Connect</p>
        <h1 className="mt-1 text-2xl font-medium tracking-tight">MCP, sessions, skill</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Mint a personal access token with only the scopes your agent needs. Each teammate creates
          their own — tokens are not shared.
        </p>
      </div>

      <PersonalTokens onPlaintext={setPat} active={pat} />

      <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Shared workspace key</h2>
          <Badge>bb_live</Badge>
        </div>
        <code className="block break-all rounded-[var(--radius-sm)] bg-bg px-3 py-3 font-mono text-xs">
          {data?.mcpKey ?? "loading…"}
        </code>
        <p className="mt-2 text-xs text-subtle">
          Full access for this board. Prefer a personal token above. This key is the same for every
          member.
        </p>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-medium">Client config</h2>
        <pre className="overflow-x-auto rounded-[var(--radius-lg)] border border-border bg-bg p-4 font-mono text-xs leading-relaxed">
          {mcpSnippet}
        </pre>
      </section>
      <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Grok Build skill</h2>
          <Button asChild variant="secondary">
            <a href="/skills/bothy-board/SKILL.md" download="SKILL.md">
              Download SKILL.md
            </a>
          </Button>
        </div>
        <p className="text-sm leading-relaxed text-muted">
          Save it in the repo as{" "}
          <span className="font-mono text-fg">.grok/skills/bothy-board/SKILL.md</span>. Grok Build
          auto-invokes it when spawning, resuming, or claiming BothyBoard work.
        </p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm leading-relaxed text-muted">
          <li>Mint: bothy-board.sessions.mint with taskId + machineName</li>
          <li>Spawn: grok -s SESSION_UUID -w (never use -s to resume)</li>
          <li>Bind GROK_SESSION_ID; after spawn_subagent, bind grokSubagentId</li>
          <li>Worker polls bothy-board.mailbox.poll — that is cross-agent talk</li>
          <li>
            Corrections: bothy-board.sessions.resume, then grok --resume or resume_from on the same
            machine
          </li>
        </ol>
      </section>
      <section className="grid gap-4 md:grid-cols-2">
        <article className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
          <h2 className="text-sm font-medium">Cache protocol</h2>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed text-muted">
            <li>Every collection includes cacheToken and revision.</li>
            <li>Send If-None-Match or X-Bothy-Board-Cache-Token. Unchanged → HTTP 304.</li>
            <li>MCP bothy-board.sync with the same token returns {"{ unchanged: true }"}.</li>
            <li>Keep the token on disk next to grokSessionId.</li>
          </ul>
        </article>
        <article className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
          <h2 className="text-sm font-medium">REST</h2>
          <ul className="mt-3 space-y-1 font-mono text-xs text-muted">
            <li>POST /api/v1/tokens</li>
            <li>POST /api/v1/tasks/:id/session/mint</li>
            <li>POST /api/v1/sessions/bind</li>
            <li>GET /api/v1/tasks/:id/mailbox</li>
            <li>POST /api/mcp</li>
          </ul>
        </article>
      </section>
      <section>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-sm font-medium">Inspector</h2>
          <Button
            variant="secondary"
            onClick={() => inspect.mutate()}
            disabled={inspect.isPending || !data}
          >
            Run initialize + tools/list + sync
          </Button>
          {token ? <span className="font-mono text-[11px] text-subtle">held {token}</span> : null}
        </div>
        <pre className="max-h-80 overflow-auto rounded-[var(--radius-lg)] border border-border bg-bg p-4 font-mono text-[11px] leading-relaxed text-muted">
          {log ||
            "Run the inspector to see initialize instructions, session tools, and a REST snapshot with ETag."}
        </pre>
      </section>
    </div>
  );
}

function PersonalTokens({
  onPlaintext,
  active,
}: {
  onPlaintext: (key: string) => void;
  active: string;
}) {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ["pats"], queryFn: () => getTokens() });
  const projects = tokens.data?.projects ?? [];
  const [name, setName] = useState("laptop mcp");
  const [scopes, setScopes] = useState<PatScopeId[]>([...DEFAULT_SCOPE_IDS]);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [days, setDays] = useState<number | null>(90);
  const [secret, setSecret] = useState<string | null>(null);

  useEffect(() => {
    if (projects.length && projectIds.length === 0) {
      setProjectIds(projects.map((p) => p.id));
    }
  }, [projects, projectIds.length]);

  const mint = useMutation({
    mutationFn: () => postToken({ data: { name, scopes, days, projectIds } }),
    onSuccess: (res) => {
      setSecret(res.plaintext);
      onPlaintext(res.plaintext);
      void qc.invalidateQueries({ queryKey: ["pats"] });
      toast.success("Token created — copy it now, it will not be shown again.");
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const revoke = useMutation({
    mutationFn: (tokenId: string) => postRevokeToken({ data: { tokenId } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pats"] });
      toast.success("Token revoked");
    },
    onError: (err) => toast.error((err as Error).message),
  });

  function toggle(id: PatScopeId) {
    setScopes((cur) => (cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id]));
  }
  function toggleProject(id: string) {
    setProjectIds((cur) => (cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id]));
  }

  return (
    <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Personal access tokens</h2>
        <Badge tone="accent">bb_pat</Badge>
      </div>
      <p className="text-sm text-muted">
        Bound to the projects you select. The agent can only read and write those projects — not the
        rest of the workspace.
      </p>
      <h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-subtle">Projects</h3>
      <div className="mt-2 grid gap-2">
        {projects.length === 0 ? (
          <p className="text-sm text-subtle">No projects on this board yet.</p>
        ) : (
          projects.map((p) => (
            <label
              key={p.id}
              className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2"
            >
              <span>
                <span className="block text-sm">{p.name}</span>
                <span className="font-mono text-[11px] text-subtle">
                  {p.repo || p.id} · {p.role}
                </span>
              </span>
              <input
                type="checkbox"
                className="size-5"
                checked={projectIds.includes(p.id)}
                onChange={() => toggleProject(p.id)}
              />
            </label>
          ))
        )}
      </div>
      <h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-subtle">Scopes</h3>
      <div className="mt-2 grid gap-2">
        {PAT_SCOPES.map((s) => (
          <label
            key={s.id}
            className="flex min-h-11 cursor-pointer items-start justify-between gap-3 rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2"
          >
            <span>
              <span className="block text-sm">{s.label}</span>
              <span className="font-mono text-[11px] text-subtle">
                {s.id} — {s.hint}
              </span>
            </span>
            <input
              type="checkbox"
              className="mt-1 size-5"
              checked={scopes.includes(s.id)}
              onChange={() => toggle(s.id)}
            />
          </label>
        ))}
      </div>
      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (scopes.length && projectIds.length) mint.mutate();
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Token name"
          className="h-11 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 text-sm outline-none focus:ring-2 focus:ring-accent/30 sm:max-w-xs"
        />
        <select
          value={days ?? 0}
          onChange={(e) => setDays(Number(e.target.value) || null)}
          className="h-11 rounded-[var(--radius-md)] border border-border bg-bg px-2 text-sm outline-none focus:ring-2 focus:ring-accent/30"
        >
          <option value={30}>Expires in 30 days</option>
          <option value={90}>Expires in 90 days</option>
          <option value={0}>No expiry</option>
        </select>
        <Button
          type="submit"
          disabled={mint.isPending || scopes.length === 0 || projectIds.length === 0}
        >
          Create token
        </Button>
      </form>
      {secret ? (
        <div className="mt-4">
          <p className="text-xs text-subtle">Copy this secret now.</p>
          <code className="mt-1 block break-all rounded-[var(--radius-sm)] bg-bg px-3 py-3 font-mono text-xs">
            {secret}
          </code>
        </div>
      ) : null}
      {active && secret && active === secret ? (
        <p className="mt-2 text-xs text-success">
          This token is used in the snippet and inspector below.
        </p>
      ) : null}
      <ul className="mt-4 divide-y divide-border overflow-hidden rounded-[var(--radius-md)] border border-border">
        {(tokens.data?.tokens ?? []).length === 0 ? (
          <li className="bg-bg px-3 py-3 text-sm text-subtle">No active tokens yet.</li>
        ) : (
          (tokens.data?.tokens ?? []).map((t) => (
            <li
              key={t.id}
              className="flex flex-col gap-2 bg-bg px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="text-sm">{t.name}</p>
                <p className="font-mono text-[11px] text-subtle">
                  {t.prefix}… · {(t.projects ?? []).map((p) => p.name).join(", ") || "no projects"}
                </p>
                <p className="font-mono text-[11px] text-subtle">
                  {t.scopes.join(", ")}
                  {t.expiresAt
                    ? ` · exp ${new Date(t.expiresAt).toLocaleDateString()}`
                    : " · no expiry"}
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={() => revoke.mutate(t.id)}
                disabled={revoke.isPending}
              >
                Revoke
              </Button>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
