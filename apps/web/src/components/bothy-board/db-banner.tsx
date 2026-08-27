import { useRouteContext } from "@tanstack/react-router";

/** Visible only on the in-memory PGLite fallback — not on published Postgres. */
export function PreviewDbBanner() {
  const { db } = useRouteContext({ from: "__root__" });
  if (db !== "pglite") return null;
  return (
    <div
      role="status"
      className="border-b border-accent/40 bg-accent/10 px-4 py-2 text-center text-xs leading-relaxed text-muted"
    >
      Preview database (PGLite). Data lives in this process and resets on restart. Publish the app
      to use Postgres.
    </div>
  );
}
