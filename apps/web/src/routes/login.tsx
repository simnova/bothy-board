import { Button } from "@bothy-board/ui/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Mark } from "@/components/bothy-board/shell";
import { authEnabled, GROK_PROVIDERS, signIn } from "@/lib/auth/client";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { error?: string } => {
    const error = search["error"];
    return typeof error === "string" ? { error } : {};
  },
  component: Login,
});

function Login() {
  const { error } = Route.useSearch();
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm rounded-[var(--radius-xl)] border border-border bg-surface p-6">
        <Link to="/" className="mb-6 flex items-center gap-2 font-medium">
          <Mark />
          BothyBoard
        </Link>
        <h1 className="text-xl font-medium tracking-tight">Come in</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Sign in, pick up the board, leave it ready for the next person — or the next agent. X is
          identity only: we never post, follow, or read your timeline.
        </p>
        {error ? (
          <p className="mt-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            Sign-in didn't finish ({error.replaceAll("_", " ")}). Try again.
          </p>
        ) : null}
        <div className="mt-6 space-y-2">
          {authEnabled ? (
            GROK_PROVIDERS.map((p) => (
              <Button
                key={p.providerId}
                type="button"
                variant="secondary"
                className="w-full"
                onClick={() =>
                  signIn(p.providerId, { callbackURL: "/", errorCallbackURL: "/login" })
                }
              >
                Continue with {p.label}
              </Button>
            ))
          ) : (
            <p className="text-sm text-muted">Sign-in is disabled.</p>
          )}
        </div>
      </div>
    </main>
  );
}
