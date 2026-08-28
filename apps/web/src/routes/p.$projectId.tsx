import { Badge } from "@bothy-board/ui/badge";
import { Button } from "@bothy-board/ui/button";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Mark } from "@/components/bothy-board/shell";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { getPublicProject } from "@/lib/bothy-board/server-fns";

export const Route = createFileRoute("/p/$projectId")({
  component: PublicProjectPage,
});

function PublicProjectPage() {
  const { projectId } = Route.useParams();
  const { user } = useCurrentUserState();
  const card = useQuery({
    queryKey: ["public-project", projectId],
    queryFn: () => getPublicProject({ data: projectId }),
  });

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="mx-auto flex h-16 max-w-2xl items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2 font-medium">
          <Mark />
          BothyBoard
        </Link>
        {user ? (
          <Button asChild variant="secondary">
            <Link to="/board">Board</Link>
          </Button>
        ) : (
          <Button asChild variant="secondary">
            <Link to="/login">Sign in</Link>
          </Button>
        )}
      </header>
      <main className="mx-auto max-w-2xl px-4 py-10">
        {card.isPending ? (
          <div className="h-32 animate-pulse rounded-[var(--radius-lg)] bg-surface" />
        ) : !card.data ? (
          <p className="text-sm text-muted">This project is private or does not exist.</p>
        ) : (
          <article className="rounded-[var(--radius-lg)] border border-border bg-surface p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-medium tracking-tight">{card.data.name}</h1>
              <Badge tone={card.data.visibility === "public" ? "accent" : "muted"}>
                {card.data.visibility}
              </Badge>
            </div>
            {card.data.repo ? (
              <p className="mt-1 font-mono text-sm text-muted">{card.data.repo}</p>
            ) : null}
            <p className="mt-3 text-sm text-muted">
              Owner{" "}
              <Link
                to="/u/$handle"
                params={{ handle: card.data.ownerHandle }}
                className="font-mono text-fg"
              >
                @{card.data.ownerHandle}
              </Link>
            </p>
            {card.data.planted?.length ? (
              <ul className="mt-6 space-y-2">
                {card.data.planted.map((t) => (
                  <li
                    key={t.id}
                    className="rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2"
                  >
                    <p className="text-sm font-medium">{t.title}</p>
                    <p className="mt-1 font-mono text-[11px] text-subtle">
                      {t.factory} · {t.status}
                      {t.known_good ? ` · known-good ${t.known_good}` : ""}
                      {t.grok_session_id ? ` · sess ${t.grok_session_id.slice(0, 8)}` : ""}
                    </p>
                    {t.objective ? (
                      <p className="mt-1 line-clamp-2 text-xs text-muted">{t.objective}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-6 text-sm text-subtle">No Planted cards on this board.</p>
            )}
            {card.data.isMember ? (
              <Button asChild className="mt-4">
                <Link to="/board">Open board</Link>
              </Button>
            ) : (
              <p className="mt-4 text-sm text-subtle">
                Public listing only. Ask an owner to invite your handle if you need board access.
              </p>
            )}
          </article>
        )}
      </main>
    </div>
  );
}
