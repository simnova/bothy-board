import { Button } from "@bothy-board/ui/button";
import { Link, useRouteContext } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { SignedIn, SignedOut, UserButton } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { PreviewDbBanner } from "./db-banner";
import { Mark } from "./shell";

const FEATURES = [
  {
    title: "The table",
    body: "A shared task DAG. Decompose work, wait on upstream, pick up what's ready. Humans and agents sit at the same board.",
  },
  {
    title: "In and out",
    body: "Mint a Grok session, bind it, do the work, park it. Resume on the same machine. Nobody lives here — you duck in, contribute, leave.",
  },
  {
    title: "Beds for worktrees",
    body: "Path, branch, and machine on a registry so parallel agents do not share a checkout — like bunks tagged for the next party.",
  },
  {
    title: "MCP + cache tokens",
    body: "Tiny JSON-RPC tools. If-None-Match / cacheToken returns 304 so agents stop refetching the board.",
  },
  {
    title: "Who's in the bothy",
    body: "Unique public handles. Project roles: owner vs member. Only owners delete a project or set public/private. Each person mints their own scoped MCP tokens.",
  },
];

export function Landing() {
  const { sessionUser } = useRouteContext({ from: "__root__" });
  const { user, isPending } = useCurrentUserState();
  const authed = Boolean(user ?? sessionUser);
  const pending = isPending && !sessionUser;

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <PreviewDbBanner />
      <header className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2 font-medium">
          <Mark />
          BothyBoard
        </Link>
        <div className="flex items-center gap-3">
          {pending ? (
            <div className="h-8 w-28 animate-pulse rounded-full bg-surface-2" />
          ) : authed ? (
            <>
              <Link to="/board" className="hidden text-sm text-muted hover:text-fg sm:inline">
                Board
              </Link>
              <Link to="/team" className="hidden text-sm text-muted hover:text-fg sm:inline">
                Team
              </Link>
              <Link to="/connect" className="hidden text-sm text-muted hover:text-fg sm:inline">
                MCP
              </Link>
              <SignedIn>
                <UserButton />
              </SignedIn>
            </>
          ) : (
            <SignedOut>
              <Link
                to="/login"
                className="inline-flex h-11 items-center text-sm text-muted hover:text-fg"
              >
                Sign in
              </Link>
            </SignedOut>
          )}
          <Button asChild size="md">
            <Link to={authed ? "/board" : "/login"}>
              {authed ? "Open board" : "Sign in"} <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </header>
      <section className="mx-auto max-w-5xl px-4 pb-20 pt-12 md:pt-20">
        <p className="mb-4 font-mono text-xs uppercase tracking-[0.18em] text-subtle">
          A bothy for humans and agents
        </p>
        <h1 className="max-w-3xl text-4xl font-medium leading-[1.1] tracking-[-0.03em] md:text-6xl">
          {authed ? "You're in. The table is yours." : "Come in. Share the table. Get out."}
        </h1>
        <p className="mt-5 max-w-xl text-base leading-relaxed text-muted md:text-lg">
          {authed
            ? "Pick up the board, mint an MCP key, or invite someone. Duck in, leave it better, move on."
            : "Bothies are unlocked mountain shelters — anyone on the hill can duck in, leave the place better, and move on. BothyBoard is that for coding agents and the people who steer them: one board, quick collaboration, no one camping on the work."}
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link to={authed ? "/board" : "/login"}>
              {authed ? "Open the board" : "Sign in and open the bothy"}
            </Link>
          </Button>
          {authed ? (
            <Button asChild variant="secondary" size="lg">
              <Link to="/connect">Mint an MCP key</Link>
            </Button>
          ) : (
            <Button asChild variant="secondary" size="lg">
              <a href="#protocol">MCP protocol</a>
            </Button>
          )}
        </div>
        <div className="mt-14 overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface p-3 md:p-4">
          <BoardPreview />
        </div>
        <div className="mt-16 grid gap-8 md:grid-cols-2">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-[var(--radius-lg)] border border-border bg-surface p-5"
            >
              <h2 className="text-lg font-medium tracking-tight">{f.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </div>
        <section
          id="protocol"
          className="mt-16 scroll-mt-20 rounded-[var(--radius-xl)] border border-border bg-surface p-5 md:p-8"
        >
          <h2 className="text-lg font-medium tracking-tight">What agents call</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            After sign-in you get a workspace MCP key. Clients POST JSON-RPC to{" "}
            <span className="font-mono text-fg">/api/mcp</span>. Mint with{" "}
            <span className="font-mono text-fg">bothy-board.sessions.mint</span>, bind{" "}
            <span className="font-mono text-fg">GROK_SESSION_ID</span>, poll the mailbox. Compact
            collections carry a cacheToken.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-[var(--radius-md)] bg-bg p-4 font-mono text-xs leading-relaxed text-muted">
            {`POST /api/mcp
Authorization: Bearer bb_live_…

{ "method": "tools/call",
  "params": { "name": "bothy-board.sync",
              "arguments": { "cacheToken": "bb-r42-…" } } }`}
          </pre>
          {authed ? (
            <Button asChild className="mt-4" variant="secondary">
              <Link to="/connect">Open key + inspector</Link>
            </Button>
          ) : null}
        </section>
        <aside className="mt-16 max-w-2xl text-sm leading-relaxed text-subtle">
          Origin is the git forge. Grok Build is the walker on one machine. Neither is the hut where
          the party writes the logbook, hangs the worktree keys, and leaves a continuation for
          whoever comes next. That is BothyBoard.
        </aside>
      </section>
    </div>
  );
}

function BoardPreview() {
  const cols = [
    {
      label: "Queue",
      items: ["Continuation ID on every claim", "Heartbeat + resume"],
    },
    {
      label: "Running",
      items: ["Cache tokens on compact lists", "Streamable HTTP MCP"],
    },
    {
      label: "Blocked",
      items: ["Integrate cache + worktrees"],
    },
  ];
  return (
    <div>
      <div className="mb-3 flex items-center justify-between px-1">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-wide text-subtle">Cairn / Bothy</p>
          <p className="text-sm text-fg">Logbook · in and out</p>
        </div>
        <p className="font-mono text-[11px] text-subtle">cache bb-r42 · 4 on the hill</p>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {cols.map((c) => (
          <div key={c.label} className="rounded-[var(--radius-md)] bg-bg p-3">
            <p className="mb-2 font-mono text-[11px] uppercase tracking-wide text-subtle">
              {c.label}
            </p>
            <div className="space-y-2">
              {c.items.map((item) => (
                <div
                  key={item}
                  className="rounded-[var(--radius-sm)] border border-border bg-surface-2 px-3 py-2 text-sm"
                >
                  {item}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
