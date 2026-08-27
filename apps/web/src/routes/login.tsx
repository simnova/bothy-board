import { Button } from "@bothy-board/ui/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Mark } from "@/components/bothy-board/shell";
import { authEnabled, GROK_PROVIDERS, signIn } from "@/lib/auth/client";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
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
        <div className="mt-6 space-y-2">
          {authEnabled ? (
            GROK_PROVIDERS.map((p) => (
              <Button
                key={p.providerId}
                type="button"
                variant="secondary"
                className="w-full"
                onClick={() => signIn(p.providerId, { callbackURL: "/" })}
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
