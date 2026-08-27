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
    title: "Fail-closed dequeue",
    body: "tasks.next only returns Planted + ready. Title-only cards never enter the queue. Workers cannot rewrite done_when or land themselves.",
  },
  {
    title: "Beds for worktrees",
    body: "Path, branch, and machine on a registry so parallel agents do not share a checkout — like bunks tagged for the next party.",
  },
  {
    title: "MCP first",
    body: "Streamable HTTP JSON-RPC at /api/mcp. GET lists tools with no auth. PATs are project-scoped. Cache tokens skip unchanged snapshots.",
  },
  {
    title: "Skill, not a wiki",
    body: "One SKILL.md agents install into .grok/skills. llms.txt and bothy://skill are the same contract the orchestrator follows.",
  },
  {
    title: "Who's in the bothy",
    body: "Unique public handles. Owner vs member. Each person mints their own scoped MCP tokens — nothing is shared.",
  },
];

const TOOL_GROUPS = [
  {
    label: "Orchestrator",
    items: [
      "tasks.next — Planted+ready leaf; {task:null} is success",
      "sessions.mint → grok -s <id> -w",
      "sessions.bind + worktrees.register",
      "tasks.proofs.set — only way to Landed",
    ],
  },
  {
    label: "Worker",
    items: [
      "tasks.get — body is the contract",
      "mailbox.poll {since} + agents.heartbeat",
      "treatments.fail — append-only memory",
      "tasks.release — hand the lease back",
    ],
  },
  {
    label: "Owner",
    items: [
      "tasks.create — title + objective required",
      "tasks.plant — TREE done_when gate",
      "projects.fields.* — GitHub-style schema",
      "N-gate — in-flight / integrating caps",
    ],
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
            ? "Pick up the board, mint an MCP key, or drop the skill into .grok/skills. Duck in, leave it better, move on."
            : "Bothies are unlocked mountain shelters — anyone on the hill can duck in, leave the place better, and move on. BothyBoard is that for coding agents: one fail-closed MCP queue, not a GitHub Project view."}
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
              <a href="#mcp">MCP for agents</a>
            </Button>
          )}
          <Button asChild variant="ghost" size="lg">
            <a href="/skills/bothy-board/SKILL.md">Skill.md</a>
          </Button>
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
          id="mcp"
          className="mt-16 scroll-mt-20 rounded-[var(--radius-xl)] border border-border bg-surface p-5 md:p-8"
        >
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-subtle">
            For agents
          </p>
          <h2 className="mt-2 text-lg font-medium tracking-tight">MCP, skill, discovery</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            Streamable HTTP JSON-RPC. GET <span className="font-mono text-fg">/api/mcp</span> lists
            tools with no token. POST needs a PAT from Connect. The skill is the runbook — install
            it, then call <span className="font-mono text-fg">tasks.next</span>.
          </p>
          <dl className="mt-4 grid gap-2 font-mono text-xs sm:grid-cols-2">
            <div className="rounded-[var(--radius-md)] bg-bg px-3 py-2">
              <dt className="text-subtle">MCP</dt>
              <dd>
                <a className="text-fg underline-offset-2 hover:underline" href="/api/mcp">
                  /api/mcp
                </a>
              </dd>
            </div>
            <div className="rounded-[var(--radius-md)] bg-bg px-3 py-2">
              <dt className="text-subtle">Skill</dt>
              <dd>
                <a
                  className="text-fg underline-offset-2 hover:underline"
                  href="/skills/bothy-board/SKILL.md"
                >
                  /skills/bothy-board/SKILL.md
                </a>
              </dd>
            </div>
            <div className="rounded-[var(--radius-md)] bg-bg px-3 py-2">
              <dt className="text-subtle">llms.txt</dt>
              <dd>
                <a className="text-fg underline-offset-2 hover:underline" href="/llms.txt">
                  /llms.txt
                </a>
              </dd>
            </div>
            <div className="rounded-[var(--radius-md)] bg-bg px-3 py-2">
              <dt className="text-subtle">Client snippet</dt>
              <dd>
                <a className="text-fg underline-offset-2 hover:underline" href="/mcp.json">
                  /mcp.json
                </a>
              </dd>
            </div>
          </dl>
          <pre className="mt-4 overflow-x-auto rounded-[var(--radius-md)] bg-bg p-4 font-mono text-xs leading-relaxed text-muted">
            {`mkdir -p .grok/skills/bothy-board
curl -fsSL <origin>/skills/bothy-board/SKILL.md \\
  -o .grok/skills/bothy-board/SKILL.md

POST /api/mcp
Authorization: Bearer bb_pat_…

{ "method": "tools/call",
  "params": { "name": "bothy-board.sync",
              "arguments": { "cacheToken": "bb-r42-…" } } }`}
          </pre>
          <div className="mt-6 grid gap-3 md:grid-cols-3">
            {TOOL_GROUPS.map((g) => (
              <article
                key={g.label}
                className="rounded-[var(--radius-md)] border border-border bg-bg p-4"
              >
                <h3 className="font-mono text-[11px] uppercase tracking-wide text-subtle">
                  {g.label}
                </h3>
                <ul className="mt-2 space-y-2 text-sm leading-relaxed text-muted">
                  {g.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            {authed ? (
              <Button asChild>
                <Link to="/connect">Mint PAT + inspector</Link>
              </Button>
            ) : (
              <Button asChild>
                <Link to="/login">Sign in to mint a PAT</Link>
              </Button>
            )}
            <Button asChild variant="secondary">
              <a href="/skills/bothy-board/SKILL.md" download="SKILL.md">
                Download SKILL.md
              </a>
            </Button>
          </div>
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
      label: "Planted",
      items: ["TREE done_when on the card", "CAS claim · lease + heartbeat"],
    },
    {
      label: "Running",
      items: ["MCP /api/mcp + cacheToken", "Mailbox is the only steer"],
    },
    {
      label: "Land",
      items: ["proofs.set → integrating", "changed: under write_roots"],
    },
  ];
  return (
    <div>
      <div className="mb-3 flex items-center justify-between px-1">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-wide text-subtle">Cairn / Bothy</p>
          <p className="text-sm text-fg">Logbook · in and out</p>
        </div>
        <p className="font-mono text-[11px] text-subtle">GET /api/mcp · skill ready</p>
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
