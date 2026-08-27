import type { InviteRow, MyProfile, PublicProfile, TeamState } from "@bothy-board/core/team";
import { Badge } from "@bothy-board/ui/badge";
import { Button } from "@bothy-board/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { RequireAuth } from "@/components/bothy-board/gate";
import { PublicProfileCard } from "@/components/bothy-board/public-profile";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import {
  getTeam,
  getTrash,
  lookupInviteHandle,
  postAcceptInvite,
  postCreateProject,
  postDeclineInvite,
  postDeleteProject,
  postFieldTemplate,
  postHandle,
  postInvite,
  postProfile,
  postProjectVisibility,
  postRestoreTrash,
  postRevokeInvite,
  postSwitchWorkspace,
} from "@/lib/bothy-board/server-fns";

export const Route = createFileRoute("/team")({
  component: TeamPage,
});

function TeamPage() {
  return (
    <RequireAuth>
      <TeamView />
    </RequireAuth>
  );
}

function remaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d left`;
  if (hours > 0) return `${hours}h ${mins}m left`;
  return `${Math.max(mins, 1)}m left`;
}

function TeamView() {
  const qc = useQueryClient();
  const user = useCurrentUser();
  const inviteParam = useRouterState({
    select: (s) => {
      const str = s.location.searchStr || "";
      const q = new URLSearchParams(str.startsWith("?") ? str.slice(1) : str);
      return q.get("invite") ?? undefined;
    },
  });
  const team = useQuery({ queryKey: ["team"], queryFn: () => getTeam(), refetchInterval: 8000 });
  const [handleDraft, setHandleDraft] = useState("");
  const [inviteDraft, setInviteDraft] = useState(inviteParam ?? "");
  const [lookedUp, setLookedUp] = useState<PublicProfile | null>(null);

  const saveHandle = useMutation({
    mutationFn: () => postHandle({ data: { handle: handleDraft || team.data?.handle || "" } }),
    onSuccess: (res) => {
      qc.setQueryData(["team"], res.team);
      setHandleDraft("");
      toast.success(`Handle set to @${res.handle}`);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const lookup = useMutation({
    mutationFn: (handle: string) => lookupInviteHandle({ data: handle }),
    onSuccess: (profile) => setLookedUp(profile),
    onError: (err) => {
      setLookedUp(null);
      toast.error((err as Error).message);
    },
  });
  const invite = useMutation({
    mutationFn: (handle: string) => postInvite({ data: { handle } }),
    onSuccess: (res) => {
      qc.setQueryData(["team"], res.team);
      setInviteDraft("");
      setLookedUp(null);
      toast.success(
        res.result.resent
          ? `Invite to @${res.result.recipientHandle} refreshed (72h).`
          : `Invited @${res.result.recipientHandle}. Only they can accept, and they have 72 hours.`,
      );
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const accept = useMutation({
    mutationFn: (inviteId: string) => postAcceptInvite({ data: { inviteId } }),
    onSuccess: (next) => {
      qc.setQueryData(["team"], next);
      void qc.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success(`Joined ${next.workspaceName}`);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const decline = useMutation({
    mutationFn: (inviteId: string) => postDeclineInvite({ data: { inviteId } }),
    onSuccess: (next) => qc.setQueryData(["team"], next),
    onError: (err) => toast.error((err as Error).message),
  });
  const revoke = useMutation({
    mutationFn: (inviteId: string) => postRevokeInvite({ data: { inviteId } }),
    onSuccess: (next) => qc.setQueryData(["team"], next),
    onError: (err) => toast.error((err as Error).message),
  });
  const switchWs = useMutation({
    mutationFn: (workspaceId: string) => postSwitchWorkspace({ data: { workspaceId } }),
    onSuccess: (res) => {
      qc.setQueryData(["team"], res.team);
      qc.setQueryData(["snapshot"], res.snapshot);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot prefill from the query string
  useEffect(() => {
    if (inviteParam) {
      setInviteDraft(inviteParam);
      lookup.mutate(inviteParam);
    }
  }, [inviteParam]);

  const data = team.data;
  if (team.isPending && !data) {
    return <div className="h-40 animate-pulse rounded-[var(--radius-lg)] bg-surface" />;
  }
  if (!data)
    return (
      <p className="text-sm text-danger">
        {(team.error as Error | undefined)?.message ?? "Could not load team"}
      </p>
    );

  return (
    <div className="space-y-8">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-subtle">Team</p>
        <h1 className="mt-1 text-2xl font-medium tracking-tight">{data.workspaceName}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Invites require an existing handle. They last 72 hours and can only be accepted by that
          person.
        </p>
      </div>

      {data.incoming.length > 0 ? (
        <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
          <h2 className="text-sm font-medium">Invites for @{data.handle}</h2>
          <ul className="mt-3 space-y-3">
            {data.incoming.map((inv) => (
              <InviteCard
                key={inv.id}
                invite={inv}
                incoming
                onAccept={() => accept.mutate(inv.id)}
                onDecline={() => decline.mutate(inv.id)}
                busy={accept.isPending || decline.isPending}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <ProjectSettings
        team={data}
        onTeam={(next) => qc.setQueryData(["team"], next)}
        onDeleted={(res) => {
          qc.setQueryData(["team"], res.team);
          qc.setQueryData(["snapshot"], res.snapshot);
          void qc.invalidateQueries({ queryKey: ["trash"] });
        }}
      />

      <TrashBin
        onRestored={(res) => {
          qc.setQueryData(["team"], res.team);
          qc.setQueryData(["snapshot"], res.snapshot);
        }}
      />

      <ProfileEditor
        profile={data.profile}
        photoUrl={user?.profileImageUrl}
        onSaved={(teamNext) => qc.setQueryData(["team"], teamNext)}
      />

      <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">Your handle</h2>
        <p className="mt-1 text-sm text-muted">
          Globally unique. This is how people find and invite you.{" "}
          <Link
            to="/u/$handle"
            params={{ handle: data.handle }}
            className="text-fg underline decoration-border underline-offset-2"
          >
            Public profile
          </Link>
        </p>
        <p className="mt-2 font-mono text-sm">
          Current <span className="text-fg">@{data.handle}</span>
        </p>
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            saveHandle.mutate();
          }}
        >
          <input
            value={handleDraft}
            onChange={(e) => setHandleDraft(e.target.value)}
            placeholder="new_handle"
            autoComplete="off"
            className="h-11 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/30 sm:max-w-xs"
          />
          <Button type="submit" disabled={saveHandle.isPending || !handleDraft.trim()}>
            Save handle
          </Button>
        </form>
      </section>

      {data.workspaces.length > 1 ? (
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted">Boards you belong to</h2>
          <div className="flex flex-wrap gap-2">
            {data.workspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => w.id !== data.workspaceId && switchWs.mutate(w.id)}
                className={
                  w.id === data.workspaceId
                    ? "h-11 rounded-[var(--radius-md)] border border-accent bg-surface-2 px-3 text-sm"
                    : "h-11 rounded-[var(--radius-md)] border border-border bg-surface px-3 text-sm text-muted hover:text-fg"
                }
              >
                {w.name} · {w.role}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Members</h2>
        <ul className="divide-y divide-border overflow-hidden rounded-[var(--radius-lg)] border border-border">
          {data.members.map((m) => (
            <li
              key={m.userId}
              className="flex items-center justify-between gap-3 bg-surface px-4 py-3"
            >
              <Link
                to="/u/$handle"
                params={{ handle: m.handle }}
                className="font-mono text-sm hover:underline"
              >
                @{m.handle}
              </Link>
              <Badge tone={m.role === "owner" ? "accent" : "muted"}>{m.role}</Badge>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">Invite by handle</h2>
        <p className="mt-1 text-sm text-muted">
          Look up an existing handle, confirm their public profile, then send. The invite is bound
          to that person and expires in 72 hours.
        </p>
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (inviteDraft.trim()) lookup.mutate(inviteDraft.trim());
          }}
        >
          <input
            value={inviteDraft}
            onChange={(e) => {
              setInviteDraft(e.target.value);
              setLookedUp(null);
            }}
            placeholder="@teammate"
            autoComplete="off"
            required
            className="h-11 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/30 sm:max-w-xs"
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={lookup.isPending || !inviteDraft.trim()}
          >
            Look up
          </Button>
        </form>
        {lookedUp ? (
          <div className="mt-4 space-y-3">
            <PublicProfileCard profile={lookedUp} compact />
            <Button
              disabled={invite.isPending || !lookedUp.exists}
              onClick={() => invite.mutate(lookedUp.handle)}
            >
              Invite @{lookedUp.handle}
            </Button>
          </div>
        ) : null}
        {data.outgoing.length > 0 ? (
          <ul className="mt-4 space-y-3">
            {data.outgoing.map((inv) => (
              <InviteCard
                key={inv.id}
                invite={inv}
                onRevoke={() => revoke.mutate(inv.id)}
                busy={revoke.isPending}
              />
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-subtle">No pending invites.</p>
        )}
      </section>
    </div>
  );
}

function ProjectSettings({
  team,
  onTeam,
  onDeleted,
}: {
  team: TeamState;
  onTeam: (team: TeamState) => void;
  onDeleted: (res: { team: TeamState; snapshot: unknown }) => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [newName, setNewName] = useState("");
  const [newRepo, setNewRepo] = useState("");
  const projects = team.projects?.length
    ? team.projects
    : team.project
      ? [{ ...team.project, role: team.role }]
      : [];
  const vis = useMutation({
    mutationFn: (input: { visibility: "public" | "private"; projectId: string }) =>
      postProjectVisibility({ data: input }),
    onSuccess: (next) => {
      onTeam(next);
      toast.success("Visibility updated");
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const del = useMutation({
    mutationFn: (projectId: string) => postDeleteProject({ data: { projectId } }),
    onSuccess: (res) => {
      onDeleted(res);
      setConfirm("");
      toast.success("Project moved to trash (7 days to restore)");
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const create = useMutation({
    mutationFn: () =>
      postCreateProject({
        data: newRepo.trim() ? { name: newName, repo: newRepo.trim() } : { name: newName },
      }),
    onSuccess: (res) => {
      onDeleted(res);
      setNewName("");
      setNewRepo("");
      toast.success("Project created — you are the owner");
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const isWsOwner = team.role === "owner" || projects.some((p) => p.role === "owner");

  return (
    <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
      <h2 className="text-sm font-medium">Projects</h2>
      <p className="mt-1 text-sm text-muted">
        Harbor is the demo logbook. BothyBoard is this product. Each token is scoped to the projects
        you pick on Connect.
      </p>
      {projects.length === 0 ? (
        <p className="mt-3 text-sm text-subtle">No projects yet.</p>
      ) : (
        <ul className="mt-4 space-y-4">
          {projects.map((project) => {
            const owner = project.role === "owner";
            return (
              <li key={project.id} className="rounded-[var(--radius-md)] border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-mono text-sm">
                    {project.name}
                    {project.repo ? <span className="text-subtle"> · {project.repo}</span> : null}
                  </p>
                  <Badge tone={owner ? "accent" : "muted"}>{project.role}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(["private", "public"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      disabled={!owner || vis.isPending}
                      onClick={() => owner && vis.mutate({ visibility: v, projectId: project.id })}
                      className={
                        project.visibility === v
                          ? "h-11 rounded-[var(--radius-md)] border border-accent bg-surface-2 px-3 text-sm"
                          : "h-11 rounded-[var(--radius-md)] border border-border bg-bg px-3 text-sm text-muted disabled:opacity-50"
                      }
                    >
                      {v}
                    </button>
                  ))}
                </div>
                {owner ? <FieldSchema projectId={project.id} onTeam={onTeam} /> : null}
                {owner ? (
                  <form
                    className="mt-3 flex flex-col gap-2 sm:flex-row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (confirm === project.name) del.mutate(project.id);
                    }}
                  >
                    <input
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      placeholder={`Type ${project.name} to trash`}
                      className="h-11 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/30 sm:max-w-xs"
                    />
                    <Button
                      type="submit"
                      variant="secondary"
                      disabled={del.isPending || confirm !== project.name}
                    >
                      Move to trash
                    </Button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {isWsOwner ? (
        <form
          className="mt-4 flex flex-col gap-2 border-t border-border pt-4 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) create.mutate();
          }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New project name"
            className="h-11 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 text-sm outline-none focus:ring-2 focus:ring-accent/30 sm:max-w-xs"
          />
          <input
            value={newRepo}
            onChange={(e) => setNewRepo(e.target.value)}
            placeholder="owner/repo (optional)"
            className="h-11 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/30 sm:max-w-xs"
          />
          <Button type="submit" disabled={create.isPending || !newName.trim()}>
            Add project
          </Button>
        </form>
      ) : (
        <p className="mt-3 text-sm text-subtle">Ask an owner to add a project.</p>
      )}
    </section>
  );
}

function TrashBin({
  onRestored,
}: {
  onRestored: (res: { team: TeamState; snapshot: unknown }) => void;
}) {
  const trash = useQuery({ queryKey: ["trash"], queryFn: () => getTrash() });
  const restore = useMutation({
    mutationFn: (item: { kind: "task" | "project"; id: string }) =>
      postRestoreTrash({ data: item }),
    onSuccess: (res) => {
      onRestored(res);
      void trash.refetch();
      toast.success("Restored from trash");
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const items = trash.data ?? [];
  return (
    <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
      <h2 className="text-sm font-medium">Trash</h2>
      <p className="mt-1 text-sm text-muted">
        Soft-deleted work stays here for 7 days, then is permanently removed.
      </p>
      {items.length === 0 ? (
        <p className="mt-4 text-sm text-subtle">Trash is empty.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`} className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm">{item.title}</p>
                <p className="font-mono text-[11px] text-subtle">
                  {item.kind} · purges {new Date(item.purgeAfter).toLocaleDateString()}
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={restore.isPending}
                onClick={() => restore.mutate({ kind: item.kind, id: item.id })}
              >
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProfileEditor({
  profile,
  photoUrl,
  onSaved,
}: {
  profile: MyProfile;
  photoUrl: string | null | undefined;
  onSaved: (team: TeamState) => void;
}) {
  const [draft, setDraft] = useState(profile);
  useEffect(() => setDraft(profile), [profile]);
  const save = useMutation({
    mutationFn: () => postProfile({ data: draft }),
    onSuccess: (res) => {
      onSaved(res.team);
      toast.success("Public profile saved");
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
      <h2 className="text-sm font-medium">Public profile</h2>
      <p className="mt-1 text-sm text-muted">
        Handle is always your identity. Everything else is off the public page unless you turn it
        on.
      </p>
      <div className="mt-4 grid gap-3">
        <Field label="Display name">
          <input
            value={draft.displayName}
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
            className="h-11 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 text-sm outline-none focus:ring-2 focus:ring-accent/30"
          />
        </Field>
        <Field label="Bio">
          <textarea
            value={draft.bio}
            onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
            rows={3}
            maxLength={280}
            className="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent/30"
          />
        </Field>
        <Field label="Avatar URL">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={draft.avatarUrl}
              onChange={(e) => setDraft({ ...draft, avatarUrl: e.target.value })}
              placeholder="https://"
              className="h-11 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 text-sm outline-none focus:ring-2 focus:ring-accent/30"
            />
            {photoUrl ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setDraft({ ...draft, avatarUrl: photoUrl })}
              >
                Use sign-in photo
              </Button>
            ) : null}
          </div>
        </Field>
        <Field label="Email (private unless published)">
          <input
            value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            type="email"
            className="h-11 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 text-sm outline-none focus:ring-2 focus:ring-accent/30"
          />
        </Field>
        <Field label="Location">
          <input
            value={draft.location}
            onChange={(e) => setDraft({ ...draft, location: e.target.value })}
            className="h-11 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 text-sm outline-none focus:ring-2 focus:ring-accent/30"
          />
        </Field>
      </div>
      <h3 className="mt-5 text-xs font-medium uppercase tracking-wide text-subtle">
        Visible on your public page
      </h3>
      <div className="mt-2 grid gap-2">
        <Toggle
          label="Discoverable profile"
          hint="If off, /u/handle looks private to everyone else. People who already know the handle can still invite you."
          on={draft.discoverable}
          onChange={(v) => setDraft({ ...draft, discoverable: v })}
        />
        <Toggle
          label="Display name"
          on={draft.pubDisplayName}
          onChange={(v) => setDraft({ ...draft, pubDisplayName: v })}
        />
        <Toggle label="Bio" on={draft.pubBio} onChange={(v) => setDraft({ ...draft, pubBio: v })} />
        <Toggle
          label="Avatar"
          on={draft.pubAvatar}
          onChange={(v) => setDraft({ ...draft, pubAvatar: v })}
        />
        <Toggle
          label="Email"
          on={draft.pubEmail}
          onChange={(v) => setDraft({ ...draft, pubEmail: v })}
        />
        <Toggle
          label="Location"
          on={draft.pubLocation}
          onChange={(v) => setDraft({ ...draft, pubLocation: v })}
        />
        <Toggle
          label="Board names"
          hint="Lists workspaces you belong to. Off by default."
          on={draft.pubBoards}
          onChange={(v) => setDraft({ ...draft, pubBoards: v })}
        />
      </div>
      <Button className="mt-4" onClick={() => save.mutate()} disabled={save.isPending}>
        Save profile
      </Button>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="block">
      <span className="mb-1 block text-xs text-subtle">{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  label,
  hint,
  on,
  onChange,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2">
      <span>
        <span className="block text-sm">{label}</span>
        {hint ? <span className="text-xs text-subtle">{hint}</span> : null}
      </span>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
        className="size-5"
      />
    </label>
  );
}

function InviteCard({
  invite,
  incoming,
  onAccept,
  onDecline,
  onRevoke,
  busy,
}: {
  invite: InviteRow;
  incoming?: boolean;
  onAccept?: () => void;
  onDecline?: () => void;
  onRevoke?: () => void;
  busy?: boolean;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-border bg-bg p-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm">
          {incoming ? (
            <>
              <Link
                to="/u/$handle"
                params={{ handle: invite.invitedByHandle }}
                className="font-medium"
              >
                @{invite.invitedByHandle}
              </Link>{" "}
              invited you to {invite.workspaceName}
            </>
          ) : (
            <>
              Waiting on{" "}
              <Link
                to="/u/$handle"
                params={{ handle: invite.recipientHandle }}
                className="font-mono"
              >
                @{invite.recipientHandle}
              </Link>
            </>
          )}
        </p>
        <p className="mt-1 font-mono text-[11px] text-subtle">{remaining(invite.expiresAt)}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {incoming ? (
          <>
            <Button onClick={onAccept} disabled={busy}>
              Accept
            </Button>
            <Button variant="secondary" onClick={onDecline} disabled={busy}>
              Decline
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onRevoke} disabled={busy}>
            Revoke
          </Button>
        )}
      </div>
    </li>
  );
}

function FieldSchema({
  projectId,
  onTeam,
}: {
  projectId: string;
  onTeam: (team: TeamState) => void;
}) {
  const apply = useMutation({
    mutationFn: () => postFieldTemplate({ data: { projectId, template: "factory" } }),
    onSuccess: (res) => {
      onTeam(res.team);
      toast.success("Applied production-factory fields");
    },
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <div className="mt-3 rounded-[var(--radius-sm)] border border-border bg-bg p-3">
      <p className="text-xs font-medium text-fg">Configurable fields</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        GitHub Projects-style: text, number, date, select. Required, plant-required, and pattern
        gates run on create and Plant. Apply a template — OpenClinXR is not hardcoded.
      </p>
      <Button
        className="mt-2"
        size="sm"
        variant="secondary"
        disabled={apply.isPending}
        onClick={() => apply.mutate()}
      >
        Apply factory template
      </Button>
    </div>
  );
}
