import { cn } from "@bothy-board/ui/cn";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { GitBranch, KeyRound, LayoutGrid, Users } from "lucide-react";
import { SignedIn, SignedOut, UserButton } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { getTeam, postSwitchWorkspace } from "@/lib/bothy-board/server-fns";

const NAV = [
  { to: "/board", label: "Board", icon: LayoutGrid },
  { to: "/agents", label: "Fleet", icon: GitBranch },
  { to: "/team", label: "Team", icon: Users },
  { to: "/connect", label: "MCP", icon: KeyRound },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { user, isPending } = useCurrentUserState();
  const qc = useQueryClient();
  const team = useQuery({
    queryKey: ["team"],
    queryFn: () => getTeam(),
    enabled: Boolean(user),
    refetchInterval: 12000,
  });
  const switchWs = useMutation({
    mutationFn: (workspaceId: string) => postSwitchWorkspace({ data: { workspaceId } }),
    onSuccess: (res) => {
      qc.setQueryData(["team"], res.team);
      qc.setQueryData(["snapshot"], res.snapshot);
    },
  });
  const incoming = team.data?.incoming.length ?? 0;

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-20 border-b border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 font-medium tracking-tight">
            <Mark />
            <span>BothyBoard</span>
          </Link>
          <nav className="ml-2 hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "relative rounded-[var(--radius-sm)] px-3 py-2 text-sm transition-colors duration-150",
                  pathname === item.to ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
                )}
              >
                {item.label}
                {item.to === "/team" && incoming > 0 ? (
                  <span className="ml-1.5 inline-flex min-w-5 justify-center rounded-full bg-accent px-1.5 font-mono text-[10px] text-accent-fg">
                    {incoming}
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {user && team.data ? (
              <>
                {team.data.workspaces.length > 1 ? (
                  <label className="hidden sm:block">
                    <span className="sr-only">Workspace</span>
                    <select
                      value={team.data.workspaceId}
                      onChange={(e) => switchWs.mutate(e.target.value)}
                      className="h-11 max-w-[160px] rounded-[var(--radius-md)] border border-border bg-bg px-2 text-sm outline-none focus:ring-2 focus:ring-accent/30"
                    >
                      {team.data.workspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <Link
                  to="/u/$handle"
                  params={{ handle: team.data.handle }}
                  className="hidden font-mono text-xs text-subtle hover:text-fg md:inline"
                >
                  @{team.data.handle}
                </Link>
              </>
            ) : null}
            {isPending ? (
              <div className="h-8 w-8 animate-pulse rounded-full bg-surface-2" />
            ) : user ? (
              <SignedIn>
                <UserButton />
              </SignedIn>
            ) : (
              <SignedOut>
                <Link to="/login" className="text-sm text-muted hover:text-fg">
                  Sign in
                </Link>
              </SignedOut>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-6 pb-24 md:pb-8">{children}</main>
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-bg/95 backdrop-blur md:hidden">
        <div className="grid grid-cols-4">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "relative flex min-h-14 flex-col items-center justify-center gap-1 text-[11px]",
                  active ? "text-fg" : "text-muted",
                )}
              >
                <Icon className="size-4" />
                {item.label}
                {item.to === "/team" && incoming > 0 ? (
                  <span className="absolute right-1/4 top-1 size-1.5 rounded-full bg-accent" />
                ) : null}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

export function Mark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "grid size-6 place-items-center rounded-[7px] border border-border bg-surface",
        className,
      )}
      aria-hidden
    >
      <svg viewBox="0 0 16 16" className="size-3.5 text-accent" aria-hidden>
        <title>BothyBoard</title>
        <path
          d="M2 8.5 L8 3 L14 8.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path d="M3.5 8.2 V13 H12.5 V8.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M7 13 V10.2 H9 V13" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    </span>
  );
}
