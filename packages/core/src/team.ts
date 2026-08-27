import { getSql, type Sql } from "@bothy-board/db";
import { makeId, makeUuid } from "./ids";
import {
  addMemberToWorkspaceProjects,
  listUserProjects,
  primaryProject,
  projectRole,
} from "./projects";
import type { MemberRow } from "./types";
import { bumpRevision } from "./workspace";

export const HANDLE_RE = /^[a-z][a-z0-9_]{2,23}$/;
export const INVITE_TTL_HOURS = 72;
const RESERVED = new Set([
  "bothyboard",
  "bothy-board",
  "admin",
  "system",
  "owner",
  "api",
  "team",
  "board",
  "connect",
  "grok",
  "agent",
]);

export type InviteRow = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  invitedByHandle: string;
  recipientHandle: string;
  expiresAt: string;
  createdAt: string;
};

export type WorkspaceChoice = {
  id: string;
  name: string;
  role: "owner" | "member";
};

export type TeamState = {
  handle: string;
  workspaceId: string;
  workspaceName: string;
  role: "owner" | "member";
  workspaces: WorkspaceChoice[];
  members: MemberRow[];
  outgoing: InviteRow[];
  incoming: InviteRow[];
  profile: MyProfile;
  project: {
    id: string;
    name: string;
    repo: string;
    visibility: "private" | "public";
  } | null;
  projects: {
    id: string;
    name: string;
    repo: string;
    visibility: "private" | "public";
    role: "owner" | "member";
  }[];
};

export type MyProfile = {
  handle: string;
  displayName: string;
  bio: string;
  avatarUrl: string;
  email: string;
  location: string;
  pubDisplayName: boolean;
  pubBio: boolean;
  pubAvatar: boolean;
  pubEmail: boolean;
  pubLocation: boolean;
  pubBoards: boolean;
  discoverable: boolean;
};

export type PublicProfile = {
  handle: string;
  exists: boolean;
  discoverable: boolean;
  isOwner: boolean;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  email: string | null;
  location: string | null;
  boards: string[] | null;
};

type ProfileRecord = {
  user_id: string;
  handle: string;
  display_name: string;
  bio: string;
  avatar_url: string;
  email: string;
  location: string;
  pub_display_name: boolean;
  pub_bio: boolean;
  pub_avatar: boolean;
  pub_email: boolean;
  pub_location: boolean;
  pub_boards: boolean;
  discoverable: boolean;
};

function asBool(v: unknown, fallback = false): boolean {
  if (v === true || v === "t" || v === "true" || v === 1) return true;
  if (v === false || v === "f" || v === "false" || v === 0) return false;
  return fallback;
}

function toMyProfile(row: ProfileRecord): MyProfile {
  return {
    handle: row.handle,
    displayName: row.display_name ?? "",
    bio: row.bio ?? "",
    avatarUrl: row.avatar_url ?? "",
    email: row.email ?? "",
    location: row.location ?? "",
    pubDisplayName: asBool(row.pub_display_name, true),
    pubBio: asBool(row.pub_bio, true),
    pubAvatar: asBool(row.pub_avatar, true),
    pubEmail: asBool(row.pub_email, false),
    pubLocation: asBool(row.pub_location, false),
    pubBoards: asBool(row.pub_boards, false),
    discoverable: asBool(row.discoverable, true),
  };
}

export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@/, "");
}

export function assertHandle(handle: string): string {
  const h = normalizeHandle(handle);
  if (!HANDLE_RE.test(h)) {
    throw new Error(
      "Handle must be 3–24 characters, start with a letter, and use only lowercase letters, numbers, and underscores.",
    );
  }
  if (RESERVED.has(h)) throw new Error("That handle is reserved.");
  return h;
}

async function uniqueHandle(sql: Sql, seed: string): Promise<string> {
  const base = HANDLE_RE.test(seed)
    ? seed
    : `m${makeId("h")
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 10)}`;
  const stem = (
    HANDLE_RE.test(base)
      ? base
      : `m${crypto.getRandomValues(new Uint8Array(4)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")}`
  ).slice(0, 20);
  for (let i = 0; i < 12; i++) {
    const candidate = i === 0 ? stem : `${stem}${i}`.slice(0, 24);
    if (!HANDLE_RE.test(candidate) || RESERVED.has(candidate)) continue;
    const taken = await sql<{
      user_id: string;
    }>`select user_id from profiles where handle = ${candidate} limit 1`;
    if (!taken[0]) return candidate;
  }
  return `m${makeUuid().replace(/-/g, "").slice(0, 12)}`;
}

export async function ensureProfile(sql: Sql, userId: string): Promise<string> {
  const existing = await sql<{
    handle: string;
  }>`select handle from profiles where user_id = ${userId}`;
  if (existing[0]) return existing[0].handle;
  const hex = userId
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(-10);
  const handle = await uniqueHandle(
    sql,
    hex.length >= 3 ? `m${hex}`.slice(0, 24) : `m${makeId("h").slice(-8)}`,
  );
  await sql`insert into profiles (user_id, handle) values (${userId}, ${handle})
    on conflict (user_id) do nothing`;
  const again = await sql<{
    handle: string;
  }>`select handle from profiles where user_id = ${userId}`;
  return again[0]?.handle ?? handle;
}

export async function getHandle(userId: string): Promise<string> {
  const sql = await getSql();
  return ensureProfile(sql, userId);
}

export async function setHandle(userId: string, raw: string): Promise<string> {
  const sql = await getSql();
  await ensureProfile(sql, userId);
  const handle = assertHandle(raw);
  const clash = await sql<{ user_id: string }>`
    select user_id from profiles where handle = ${handle} and user_id <> ${userId} limit 1`;
  if (clash[0]) throw new Error(`@${handle} is already taken.`);
  await sql`update profiles set handle = ${handle}, updated_at = now() where user_id = ${userId}`;
  return handle;
}

async function loadProfileRow(sql: Sql, userId: string): Promise<ProfileRecord | null> {
  const rows = await sql<ProfileRecord>`
    select user_id, handle, display_name, bio, avatar_url, email, location,
      pub_display_name, pub_bio, pub_avatar, pub_email, pub_location, pub_boards, discoverable
    from profiles where user_id = ${userId}`;
  return rows[0] ?? null;
}

async function loadProfileByHandle(sql: Sql, handle: string): Promise<ProfileRecord | null> {
  const rows = await sql<ProfileRecord>`
    select user_id, handle, display_name, bio, avatar_url, email, location,
      pub_display_name, pub_bio, pub_avatar, pub_email, pub_location, pub_boards, discoverable
    from profiles where handle = ${handle}`;
  return rows[0] ?? null;
}

export async function loadMyProfile(userId: string): Promise<MyProfile> {
  const sql = await getSql();
  await ensureProfile(sql, userId);
  const row = await loadProfileRow(sql, userId);
  if (!row) throw new Error("Profile missing.");
  return toMyProfile(row);
}

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function validUrl(value: string): string {
  const v = value.trim();
  if (!v) return "";
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad");
    return v.slice(0, 500);
  } catch {
    throw new Error("Avatar must be an http(s) URL.");
  }
}

function validEmail(value: string): string {
  const v = value.trim();
  if (!v) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || v.length > 120)
    throw new Error("That email does not look valid.");
  return v;
}

export async function updateProfile(userId: string, patch: Partial<MyProfile>): Promise<MyProfile> {
  const sql = await getSql();
  await ensureProfile(sql, userId);
  const current = await loadProfileRow(sql, userId);
  if (!current) throw new Error("Profile missing.");
  const next = {
    display_name:
      patch.displayName !== undefined ? clip(patch.displayName, 80) : current.display_name,
    bio: patch.bio !== undefined ? clip(patch.bio, 280) : current.bio,
    avatar_url: patch.avatarUrl !== undefined ? validUrl(patch.avatarUrl) : current.avatar_url,
    email: patch.email !== undefined ? validEmail(patch.email) : current.email,
    location: patch.location !== undefined ? clip(patch.location, 80) : current.location,
    pub_display_name: patch.pubDisplayName ?? asBool(current.pub_display_name, true),
    pub_bio: patch.pubBio ?? asBool(current.pub_bio, true),
    pub_avatar: patch.pubAvatar ?? asBool(current.pub_avatar, true),
    pub_email: patch.pubEmail ?? asBool(current.pub_email, false),
    pub_location: patch.pubLocation ?? asBool(current.pub_location, false),
    pub_boards: patch.pubBoards ?? asBool(current.pub_boards, false),
    discoverable: patch.discoverable ?? asBool(current.discoverable, true),
  };
  await sql`update profiles set
      display_name = ${next.display_name}, bio = ${next.bio}, avatar_url = ${next.avatar_url},
      email = ${next.email}, location = ${next.location},
      pub_display_name = ${next.pub_display_name}, pub_bio = ${next.pub_bio}, pub_avatar = ${next.pub_avatar},
      pub_email = ${next.pub_email}, pub_location = ${next.pub_location}, pub_boards = ${next.pub_boards},
      discoverable = ${next.discoverable}, updated_at = now()
    where user_id = ${userId}`;
  const row = await loadProfileRow(sql, userId);
  if (!row) throw new Error("Profile missing after save.");
  return toMyProfile(row);
}

async function publicBoards(sql: Sql, userId: string, includePrivate: boolean): Promise<string[]> {
  const rows = includePrivate
    ? await sql<{ name: string; visibility: string }>`
        select pr.name, pr.visibility
        from project_members m
        join projects pr on pr.id = m.project_id
        where m.user_id = ${userId}
        order by pr.created_at asc`
    : await sql<{ name: string; visibility: string }>`
        select pr.name, pr.visibility
        from project_members m
        join projects pr on pr.id = m.project_id
        where m.user_id = ${userId} and pr.visibility = 'public'
        order by pr.created_at asc`;
  return rows.map((r) => (includePrivate ? `${r.name} (${r.visibility})` : r.name));
}

function publishedView(
  row: ProfileRecord,
  boards: string[] | null,
  isOwner: boolean,
): PublicProfile {
  const mine = toMyProfile(row);
  const showAll = isOwner;
  return {
    handle: mine.handle,
    exists: true,
    discoverable: mine.discoverable,
    isOwner,
    displayName: showAll || mine.pubDisplayName ? mine.displayName || null : null,
    bio: showAll || mine.pubBio ? mine.bio || null : null,
    avatarUrl: showAll || mine.pubAvatar ? mine.avatarUrl || null : null,
    email: showAll || mine.pubEmail ? mine.email || null : null,
    location: showAll || mine.pubLocation ? mine.location || null : null,
    boards: showAll || mine.pubBoards ? boards : null,
  };
}

export async function loadPublicProfile(
  handleRaw: string,
  viewerUserId: string | null,
): Promise<PublicProfile> {
  const sql = await getSql();
  let handle: string;
  try {
    handle = assertHandle(handleRaw);
  } catch {
    return {
      handle: normalizeHandle(handleRaw),
      exists: false,
      discoverable: false,
      isOwner: false,
      displayName: null,
      bio: null,
      avatarUrl: null,
      email: null,
      location: null,
      boards: null,
    };
  }
  const row = await loadProfileByHandle(sql, handle);
  if (!row) {
    return {
      handle,
      exists: false,
      discoverable: false,
      isOwner: false,
      displayName: null,
      bio: null,
      avatarUrl: null,
      email: null,
      location: null,
      boards: null,
    };
  }
  const isOwner = viewerUserId === row.user_id;
  const boards =
    asBool(row.pub_boards, false) || isOwner ? await publicBoards(sql, row.user_id, isOwner) : null;
  const view = publishedView(row, boards, isOwner);
  if (!view.discoverable && !isOwner) {
    return {
      handle: view.handle,
      exists: true,
      discoverable: false,
      isOwner: false,
      displayName: null,
      bio: null,
      avatarUrl: null,
      email: null,
      location: null,
      boards: null,
    };
  }
  return view;
}

/** Signed-in lookup for invites: handle must exist. Unlisted profiles still resolve. */
export async function lookupHandleForInvite(handleRaw: string): Promise<PublicProfile> {
  const sql = await getSql();
  const handle = assertHandle(handleRaw);
  const row = await loadProfileByHandle(sql, handle);
  if (!row) {
    throw new Error(
      `No BothyBoard user has the handle @${handle}. They need to claim it before you can invite them.`,
    );
  }
  const boards = asBool(row.pub_boards, false) ? await publicBoards(sql, row.user_id, false) : null;
  return publishedView(row, boards, false);
}

export async function listMembers(
  workspaceId: string,
  projectIds?: string[] | null,
): Promise<MemberRow[]> {
  const sql = await getSql();
  if (projectIds?.length) {
    return sql.query<MemberRow>(
      `select m.user_id as "userId",
        coalesce(p.handle, 'unknown') as handle,
        case when bool_or(coalesce(pm.role, m.role) = 'owner') then 'owner' else 'member' end as role
       from workspace_members m
       left join profiles p on p.user_id = m.user_id
       left join project_members pm on pm.user_id = m.user_id
       left join projects pr on pr.id = pm.project_id and pr.workspace_id = m.workspace_id
       where m.workspace_id = $1 and pr.id = any($2) and pr.deleted_at is null
       group by m.user_id, p.handle
       order by case when bool_or(coalesce(pm.role, m.role) = 'owner') then 0 else 1 end, coalesce(p.handle, m.user_id)`,
      [workspaceId, projectIds],
    );
  }
  return sql<MemberRow>`
    select m.user_id as "userId",
      coalesce(p.handle, 'unknown') as handle,
      case when bool_or(coalesce(pm.role, m.role) = 'owner') then 'owner' else 'member' end as role
    from workspace_members m
    left join profiles p on p.user_id = m.user_id
    left join projects pr on pr.workspace_id = m.workspace_id
    left join project_members pm on pm.project_id = pr.id and pm.user_id = m.user_id
    where m.workspace_id = ${workspaceId}
    group by m.user_id, p.handle
    order by case when bool_or(coalesce(pm.role, m.role) = 'owner') then 0 else 1 end, coalesce(p.handle, m.user_id)`;
}

export async function listWorkspaces(userId: string): Promise<WorkspaceChoice[]> {
  const sql = await getSql();
  return sql<WorkspaceChoice>`
    select w.id, w.name, m.role
    from workspace_members m
    join workspaces w on w.id = m.workspace_id
    where m.user_id = ${userId}
    order by m.created_at asc`;
}

async function roleIn(
  sql: Sql,
  workspaceId: string,
  userId: string,
): Promise<"owner" | "member" | null> {
  const rows = await sql<{ role: "owner" | "member" }>`
    select role from workspace_members where workspace_id = ${workspaceId} and user_id = ${userId}`;
  return rows[0]?.role ?? null;
}

export async function switchWorkspace(userId: string, workspaceId: string) {
  const sql = await getSql();
  const role = await roleIn(sql, workspaceId, userId);
  if (!role) throw new Error("You are not a member of that workspace.");
  await sql`insert into user_prefs (user_id, active_workspace_id)
    values (${userId}, ${workspaceId})
    on conflict (user_id) do update set active_workspace_id = excluded.active_workspace_id`;
  return workspaceId;
}

function mapInvite(row: {
  id: string;
  workspace_id: string;
  workspace_name: string;
  invited_by_handle: string;
  recipient_handle: string;
  expires_at: string;
  created_at: string;
}): InviteRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    invitedByHandle: row.invited_by_handle,
    recipientHandle: row.recipient_handle,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export async function listOutgoing(workspaceId: string): Promise<InviteRow[]> {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    workspace_id: string;
    workspace_name: string;
    invited_by_handle: string;
    recipient_handle: string;
    expires_at: string;
    created_at: string;
  }>`
    select i.id, i.workspace_id, w.name as workspace_name,
      coalesce(p.handle, 'member') as invited_by_handle,
      i.recipient_handle, i.expires_at, i.created_at
    from workspace_invites i
    join workspaces w on w.id = i.workspace_id
    left join profiles p on p.user_id = i.invited_by_user_id
    where i.workspace_id = ${workspaceId}
      and i.accepted_at is null and i.revoked_at is null and i.declined_at is null
      and i.expires_at > now()
    order by i.created_at desc`;
  return rows.map(mapInvite);
}

export async function listIncoming(handle: string, userId: string): Promise<InviteRow[]> {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    workspace_id: string;
    workspace_name: string;
    invited_by_handle: string;
    recipient_handle: string;
    expires_at: string;
    created_at: string;
  }>`
    select i.id, i.workspace_id, w.name as workspace_name,
      coalesce(p.handle, 'member') as invited_by_handle,
      i.recipient_handle, i.expires_at, i.created_at
    from workspace_invites i
    join workspaces w on w.id = i.workspace_id
    left join profiles p on p.user_id = i.invited_by_user_id
    where (i.recipient_handle = ${handle} or i.recipient_user_id = ${userId})
      and i.accepted_at is null and i.revoked_at is null and i.declined_at is null
      and i.expires_at > now()
    order by i.created_at desc`;
  return rows.map(mapInvite);
}

export async function inviteTeammate(workspaceId: string, userId: string, rawHandle: string) {
  const sql = await getSql();
  const role = await roleIn(sql, workspaceId, userId);
  if (!role) throw new Error("You are not a member of this workspace.");
  const recipient = assertHandle(rawHandle);
  const myHandle = await ensureProfile(sql, userId);
  if (recipient === myHandle) throw new Error("You cannot invite yourself.");

  const person = await sql<{ user_id: string }>`
    select user_id from profiles where handle = ${recipient} limit 1`;
  if (!person[0]) {
    throw new Error(
      `No BothyBoard user has the handle @${recipient}. They must claim that handle before you can invite them.`,
    );
  }
  const recipientUserId = person[0].user_id;
  if (recipientUserId === userId) throw new Error("You cannot invite yourself.");

  const already = await sql<{ user_id: string }>`
    select user_id from workspace_members
    where workspace_id = ${workspaceId} and user_id = ${recipientUserId}
    limit 1`;
  if (already[0]) throw new Error(`@${recipient} is already on this board.`);

  const pending = await sql<{ id: string }>`
    select id from workspace_invites
    where workspace_id = ${workspaceId} and recipient_handle = ${recipient}
      and accepted_at is null and revoked_at is null and declined_at is null
      and expires_at > now()
    limit 1`;

  const expires = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000).toISOString();
  const token = makeUuid();
  if (pending[0]) {
    await sql`update workspace_invites
      set token = ${token}, expires_at = ${expires}, invited_by_user_id = ${userId},
        recipient_user_id = ${recipientUserId}, created_at = now()
      where id = ${pending[0].id}`;
    await bumpRevision(sql, workspaceId);
    return { id: pending[0].id, recipientHandle: recipient, expiresAt: expires, resent: true };
  }

  const id = makeId("inv");
  await sql`insert into workspace_invites
    (id, workspace_id, invited_by_user_id, recipient_handle, recipient_user_id, token, expires_at)
    values (${id}, ${workspaceId}, ${userId}, ${recipient}, ${recipientUserId}, ${token}, ${expires})`;
  await bumpRevision(sql, workspaceId);
  return { id, recipientHandle: recipient, expiresAt: expires, resent: false };
}

export async function acceptInvite(userId: string, inviteId: string) {
  const sql = await getSql();
  const handle = await ensureProfile(sql, userId);
  const rows = await sql<{
    id: string;
    workspace_id: string;
    recipient_handle: string;
    recipient_user_id: string | null;
    expires_at: string;
    accepted_at: string | null;
    revoked_at: string | null;
    declined_at: string | null;
  }>`select id, workspace_id, recipient_handle, recipient_user_id, expires_at, accepted_at, revoked_at, declined_at
     from workspace_invites where id = ${inviteId}`;
  const inv = rows[0];
  if (!inv) throw new Error("Invite not found.");
  const forThisUser = inv.recipient_user_id
    ? inv.recipient_user_id === userId
    : inv.recipient_handle === handle;
  if (!forThisUser) {
    throw new Error(
      `This invite is only for @${inv.recipient_handle}. Sign in as that handle to accept.`,
    );
  }
  if (inv.accepted_at) throw new Error("This invite was already used.");
  if (inv.revoked_at) throw new Error("This invite was revoked.");
  if (inv.declined_at) throw new Error("This invite was declined.");
  if (new Date(inv.expires_at).getTime() <= Date.now()) throw new Error("This invite has expired.");

  const member = await roleIn(sql, inv.workspace_id, userId);
  if (!member) {
    await sql`insert into workspace_members (workspace_id, user_id, role)
      values (${inv.workspace_id}, ${userId}, ${"member"})`;
  }
  await addMemberToWorkspaceProjects(sql, inv.workspace_id, userId, "member");
  await sql`update workspace_invites set accepted_at = now() where id = ${inviteId}`;
  await sql`insert into user_prefs (user_id, active_workspace_id)
    values (${userId}, ${inv.workspace_id})
    on conflict (user_id) do update set active_workspace_id = excluded.active_workspace_id`;
  await bumpRevision(sql, inv.workspace_id);
  return { workspaceId: inv.workspace_id };
}

export async function declineInvite(userId: string, inviteId: string) {
  const sql = await getSql();
  const handle = await ensureProfile(sql, userId);
  const rows = await sql<{
    recipient_handle: string;
    recipient_user_id: string | null;
    declined_at: string | null;
    accepted_at: string | null;
  }>`
    select recipient_handle, recipient_user_id, declined_at, accepted_at from workspace_invites where id = ${inviteId}`;
  const inv = rows[0];
  if (!inv) throw new Error("Invite not found.");
  const forThisUser = inv.recipient_user_id
    ? inv.recipient_user_id === userId
    : inv.recipient_handle === handle;
  if (!forThisUser) throw new Error("This invite is not for you.");
  if (inv.accepted_at) throw new Error("Already accepted.");
  await sql`update workspace_invites set declined_at = now() where id = ${inviteId} and recipient_handle = ${handle}`;
}

export async function revokeInvite(workspaceId: string, userId: string, inviteId: string) {
  const sql = await getSql();
  const role = await roleIn(sql, workspaceId, userId);
  if (!role) throw new Error("You are not a member of this workspace.");
  await sql`update workspace_invites set revoked_at = now()
    where id = ${inviteId} and workspace_id = ${workspaceId} and accepted_at is null`;
  await bumpRevision(sql, workspaceId);
}

export async function loadTeamState(
  userId: string,
  workspaceId: string,
  workspaceName: string,
): Promise<TeamState> {
  const sql = await getSql();
  const handle = await ensureProfile(sql, userId);
  const wsRole = (await roleIn(sql, workspaceId, userId)) ?? "member";
  const row = await loadProfileRow(sql, userId);
  const projects = await listUserProjects(workspaceId, userId);
  const project = projects[0] ?? (await primaryProject(workspaceId));
  const pRole = project ? await projectRole(project.id, userId) : null;
  const [workspaces, members, outgoing, incoming] = await Promise.all([
    listWorkspaces(userId),
    listMembers(workspaceId),
    listOutgoing(workspaceId),
    listIncoming(handle, userId),
  ]);
  return {
    handle,
    workspaceId,
    workspaceName,
    role: pRole ?? wsRole,
    workspaces,
    members,
    outgoing,
    incoming,
    project: project
      ? { id: project.id, name: project.name, repo: project.repo, visibility: project.visibility }
      : null,
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      repo: p.repo,
      visibility: p.visibility,
      role: p.role,
    })),
    profile: row
      ? toMyProfile(row)
      : {
          handle,
          displayName: "",
          bio: "",
          avatarUrl: "",
          email: "",
          location: "",
          pubDisplayName: true,
          pubBio: true,
          pubAvatar: true,
          pubEmail: false,
          pubLocation: false,
          pubBoards: false,
          discoverable: true,
        },
  };
}
