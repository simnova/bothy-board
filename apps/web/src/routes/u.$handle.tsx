import { Button } from "@bothy-board/ui/button";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PublicProfileCard } from "@/components/bothy-board/public-profile";
import { Mark } from "@/components/bothy-board/shell";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { getPublicProfile } from "@/lib/bothy-board/server-fns";

export const Route = createFileRoute("/u/$handle")({
  component: PublicProfilePage,
});

function PublicProfilePage() {
  const { handle } = Route.useParams();
  const { user } = useCurrentUserState();
  const profile = useQuery({
    queryKey: ["public-profile", handle],
    queryFn: () => getPublicProfile({ data: handle }),
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
            <Link to="/team">Team</Link>
          </Button>
        ) : (
          <Button asChild variant="secondary">
            <Link to="/login">Sign in</Link>
          </Button>
        )}
      </header>
      <main className="mx-auto max-w-2xl px-4 py-10">
        {profile.isPending ? (
          <div className="h-40 animate-pulse rounded-[var(--radius-lg)] bg-surface" />
        ) : profile.data ? (
          <>
            <PublicProfileCard profile={profile.data} />
            {user && profile.data.exists && profile.data.handle !== undefined ? (
              <div className="mt-4">
                <Button asChild>
                  <a href={`/team?invite=${encodeURIComponent(profile.data.handle)}`}>
                    Invite @{profile.data.handle} to a board
                  </a>
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-danger">Could not load this profile.</p>
        )}
      </main>
    </div>
  );
}
