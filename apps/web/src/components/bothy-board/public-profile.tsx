import type { PublicProfile } from "@bothy-board/core/team";
import { Link } from "@tanstack/react-router";

export function PublicProfileCard({
  profile,
  compact,
}: {
  profile: PublicProfile;
  compact?: boolean;
}) {
  if (!profile.exists) {
    return (
      <p className="text-sm text-muted">
        No BothyBoard user has @{profile.handle}. They need to claim that handle first.
      </p>
    );
  }
  if (!profile.discoverable && !profile.isOwner) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
        <p className="font-mono text-sm">@{profile.handle}</p>
        <p className="mt-2 text-sm text-muted">This profile is private.</p>
      </div>
    );
  }

  const title = profile.displayName || `@${profile.handle}`;
  return (
    <article
      className={
        compact
          ? "rounded-[var(--radius-md)] border border-border bg-bg p-3"
          : "rounded-[var(--radius-lg)] border border-border bg-surface p-5"
      }
    >
      <div className="flex items-start gap-4">
        {profile.avatarUrl ? (
          <img
            src={profile.avatarUrl}
            alt=""
            className="size-14 shrink-0 rounded-full object-cover"
            crossOrigin="anonymous"
          />
        ) : (
          <span className="grid size-14 shrink-0 place-items-center rounded-full bg-surface-2 font-medium">
            {(profile.displayName || profile.handle).charAt(0).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-lg font-medium tracking-tight">{title}</h2>
          <p className="font-mono text-sm text-muted">@{profile.handle}</p>
          {profile.isOwner && !profile.discoverable ? (
            <p className="mt-1 text-xs text-subtle">
              Only you can see this — the profile is not discoverable.
            </p>
          ) : null}
        </div>
      </div>
      {profile.bio ? (
        <p className="mt-4 text-sm leading-relaxed text-muted">{profile.bio}</p>
      ) : null}
      <dl className="mt-4 space-y-1 text-sm">
        {profile.location ? (
          <div className="flex gap-2">
            <dt className="text-subtle">Location</dt>
            <dd>{profile.location}</dd>
          </div>
        ) : null}
        {profile.email ? (
          <div className="flex gap-2">
            <dt className="text-subtle">Email</dt>
            <dd>
              <a
                className="underline decoration-border underline-offset-2"
                href={`mailto:${profile.email}`}
              >
                {profile.email}
              </a>
            </dd>
          </div>
        ) : null}
        {profile.boards && profile.boards.length > 0 ? (
          <div className="flex gap-2">
            <dt className="text-subtle">Boards</dt>
            <dd>{profile.boards.join(", ")}</dd>
          </div>
        ) : null}
      </dl>
      {!compact ? (
        <p className="mt-4 text-xs text-subtle">
          Public page{" "}
          <Link to="/u/$handle" params={{ handle: profile.handle }} className="font-mono text-fg">
            /u/{profile.handle}
          </Link>
        </p>
      ) : null}
    </article>
  );
}
