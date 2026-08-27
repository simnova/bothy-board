import type { Sql } from "@bothy-board/db";
import { demoMcpKey, hashApiKey } from "./hash";
import { makeId } from "./ids";

type SeedTask = {
  id: string;
  parentId?: string;
  title: string;
  body: string;
  kind: string;
  status: string;
  priority: number;
  agentId?: string;
  continuationId?: string;
  grokSessionId?: string;
  grokSubagentId?: string;
  affinityMachine?: string;
  branch?: string;
  worktreePath?: string;
  integration?: string;
  blockedReason?: string;
  deps?: string[];
  assigneeUser?: boolean;
};

export async function seedNorthline(sql: Sql, workspaceId: string, ownerUserId: string) {
  const projectId = makeId("prj");
  const grokMaya = makeId("agt");
  const cursorOwen = makeId("agt");
  const grokPriya = makeId("agt");
  const claudeMaya = makeId("agt");

  const tEpic = makeId("tsk");
  const tAuth = makeId("tsk");
  const tCache = makeId("tsk");
  const tMcp = makeId("tsk");
  const tWorktrees = makeId("tsk");
  const tIntegrate = makeId("tsk");
  const tEtag = makeId("tsk");
  const tDocs = makeId("tsk");
  const tHeartbeat = makeId("tsk");
  const tReview = makeId("tsk");
  const tConflict = makeId("tsk");
  const tReady = makeId("tsk");

  await sql`insert into projects (id, workspace_id, name, repo, default_branch, visibility)
    values (${projectId}, ${workspaceId}, ${"Harbor"}, ${"northline/harbor"}, ${"main"}, ${"private"})`;
  await sql`insert into project_members (project_id, user_id, role)
    values (${projectId}, ${ownerUserId}, ${"owner"})`;

  const agents = [
    {
      id: grokMaya,
      name: "grok-build",
      kind: "grok",
      machine: "maya-mbp.local",
      cont: "cont_019e8a1c4f2b",
      task: tCache,
      status: "working",
    },
    {
      id: cursorOwen,
      name: "cursor-opus",
      kind: "cursor",
      machine: "owen-tower",
      cont: "cont_019e8a2219d0",
      task: tMcp,
      status: "working",
    },
    {
      id: grokPriya,
      name: "grok-build",
      kind: "grok",
      machine: "priya-dev",
      cont: "cont_019e8a2b77e4",
      task: tIntegrate,
      status: "blocked",
    },
    {
      id: claudeMaya,
      name: "claude-code",
      kind: "claude",
      machine: "maya-mbp.local",
      cont: "cont_019e8a31c0aa",
      task: tEtag,
      status: "working",
    },
  ];

  for (const a of agents) {
    await sql`insert into agents (id, workspace_id, name, kind, machine_name, continuation_id, current_task_id, status, last_heartbeat)
      values (${a.id}, ${workspaceId}, ${a.name}, ${a.kind}, ${a.machine}, ${a.cont}, ${a.task}, ${a.status}, now())`;
  }

  const tasks: SeedTask[] = [
    {
      id: tEpic,
      title: "Harbor v0.4 — agent-native API",
      body: "Ship the coordination surface agents actually call: compact snapshots, continuation IDs, worktree registry, MCP.",
      kind: "feature",
      status: "in_progress",
      priority: 0,
    },
    {
      id: tAuth,
      parentId: tEpic,
      title: "Session refresh for long-running agents",
      body: "Agents that run overnight need to refresh workspace credentials without human interaction.",
      kind: "feature",
      status: "done",
      priority: 1,
      branch: "feat/agent-session-refresh",
      worktreePath: "/wt/harbor-auth",
    },
    {
      id: tCache,
      parentId: tEpic,
      title: "Cache tokens on compact list endpoints",
      body: "Return cacheToken + ETag on every collection. Honor If-None-Match / cacheToken to skip payload. Compact fields by default.",
      kind: "feature",
      status: "in_progress",
      priority: 0,
      agentId: grokMaya,
      continuationId: "cont_019e8a1c4f2b",
      grokSessionId: "8f3c1a2e-9d44-4b1a-a7e2-1c9d0b4e7a11",
      grokSubagentId: "sub_maya_cache_01",
      affinityMachine: "maya-mbp.local",
      branch: "feat/cache-tokens",
      worktreePath: "/Users/maya/.bothy-board/wt/cache-tokens",
    },
    {
      id: tMcp,
      parentId: tEpic,
      title: "Streamable HTTP MCP transport",
      body: "JSON-RPC tools for claim, heartbeat, decompose, next-ready, worktree register. Keep tool schemas tiny.",
      kind: "feature",
      status: "claimed",
      priority: 0,
      agentId: cursorOwen,
      continuationId: "cont_019e8a2219d0",
      grokSessionId: "c21e90aa-3b18-4f0d-9c55-7a1e2d8b4410",
      grokSubagentId: "sub_owen_mcp_01",
      affinityMachine: "owen-tower",
      branch: "feat/mcp-http",
      worktreePath: "/home/owen/wt/harbor-mcp",
      deps: [tCache],
    },
    {
      id: tWorktrees,
      parentId: tEpic,
      title: "Worktree + branch registry",
      body: "Track path, branch, machine, owning agent, and merge state so two agents never share a checkout.",
      kind: "feature",
      status: "review",
      priority: 1,
      branch: "feat/worktree-registry",
      worktreePath: "/home/priya/wt/worktrees",
    },
    {
      id: tIntegrate,
      parentId: tEpic,
      title: "Integrate cache tokens + worktree registry",
      body: "Merge order: auth (done) → cache tokens → worktrees → MCP. Flag conflicts early.",
      kind: "integration",
      status: "blocked",
      priority: 0,
      agentId: grokPriya,
      continuationId: "cont_019e8a2b77e4",
      grokSessionId: "b7d4e610-2c91-4aa0-8f33-6e0c19d25f88",
      grokSubagentId: "sub_priya_int_01",
      affinityMachine: "priya-dev",
      integration: "waiting",
      blockedReason: "Waiting on cache tokens and MCP transport before merging to main.",
      deps: [tCache, tMcp, tWorktrees],
    },
    {
      id: tEtag,
      parentId: tEpic,
      title: "Bug: ETag collision on empty compact lists",
      body: "Two empty collections across projects produced the same weak ETag when revision was omitted from the hash.",
      kind: "bug",
      status: "in_progress",
      priority: 0,
      agentId: claudeMaya,
      continuationId: "cont_019e8a31c0aa",
      grokSessionId: "e0a19c44-5d72-4b8e-b1aa-3f6c8d2019ee",
      grokSubagentId: "sub_maya_etag_01",
      affinityMachine: "maya-mbp.local",
      branch: "fix/etag-empty-list",
      worktreePath: "/Users/maya/.bothy-board/wt/etag-fix",
    },
    {
      id: tHeartbeat,
      parentId: tEpic,
      title: "Agent heartbeat + continuation resume",
      body: "POST /agents/heartbeat with continuationId. If the process died, a new agent on the same machine resumes the same task.",
      kind: "feature",
      status: "ready",
      priority: 1,
      deps: [tAuth],
    },
    {
      id: tDocs,
      parentId: tEpic,
      title: "MCP install snippets for Cursor, Claude, Grok",
      body: "One config block per client. Same Bearer key. Document cacheToken so clients store it locally.",
      kind: "chore",
      status: "backlog",
      priority: 2,
      deps: [tMcp],
    },
    {
      id: tReview,
      parentId: tEpic,
      title: "Human review: worktree registry PR",
      body: "Diff is green. Needs a person to confirm machine-path conventions before merge.",
      kind: "chore",
      status: "review",
      priority: 1,
      assigneeUser: true,
      deps: [tWorktrees],
    },
    {
      id: tConflict,
      parentId: tEpic,
      title: "Conflict: rate-limit header names",
      body: "cache-tokens branch renamed X-RateLimit-* while MCP branch still reads the old names.",
      kind: "bug",
      status: "blocked",
      priority: 1,
      integration: "conflict",
      blockedReason: "Header rename on feat/cache-tokens collides with feat/mcp-http.",
      deps: [tCache, tMcp],
    },
    {
      id: tReady,
      parentId: tEpic,
      title: "Continuation ID on every claim",
      body: "Claim must mint or accept a continuationId. Return it in the compact task so the agent can persist locally.",
      kind: "feature",
      status: "ready",
      priority: 1,
      deps: [tAuth],
    },
  ];

  let order = 0;
  for (const t of tasks) {
    const assigneeUser = "assigneeUser" in t && t.assigneeUser ? ownerUserId : null;
    await sql`insert into tasks (
        id, workspace_id, project_id, parent_id, title, body, kind, status, priority,
        assignee_user_id, assignee_agent_id, continuation_id, grok_session_id, grok_subagent_id,
        affinity_machine_name, branch, worktree_path,
        integration_status, blocked_reason, sort_order
      ) values (
        ${t.id}, ${workspaceId}, ${projectId}, ${t.parentId ?? null}, ${t.title}, ${t.body},
        ${t.kind}, ${t.status}, ${t.priority}, ${assigneeUser}, ${t.agentId ?? null},
        ${t.continuationId ?? null}, ${t.grokSessionId ?? null}, ${t.grokSubagentId ?? null},
        ${t.affinityMachine ?? null}, ${t.branch ?? null}, ${t.worktreePath ?? null},
        ${t.integration ?? "none"}, ${t.blockedReason ?? null}, ${order++}
      )`;
    for (const dep of t.deps ?? []) {
      await sql`insert into task_deps (workspace_id, task_id, depends_on_id)
        values (${workspaceId}, ${t.id}, ${dep})`;
    }
  }

  const wt = [
    {
      id: makeId("wt"),
      agent: grokMaya,
      task: tCache,
      path: "/Users/maya/.bothy-board/wt/cache-tokens",
      branch: "feat/cache-tokens",
      machine: "maya-mbp.local",
      status: "dirty",
    },
    {
      id: makeId("wt"),
      agent: cursorOwen,
      task: tMcp,
      path: "/home/owen/wt/harbor-mcp",
      branch: "feat/mcp-http",
      machine: "owen-tower",
      status: "active",
    },
    {
      id: makeId("wt"),
      agent: grokPriya,
      task: tIntegrate,
      path: "/home/priya/wt/harbor-integrate",
      branch: "integrate/v0.4",
      machine: "priya-dev",
      status: "active",
    },
    {
      id: makeId("wt"),
      agent: claudeMaya,
      task: tEtag,
      path: "/Users/maya/.bothy-board/wt/etag-fix",
      branch: "fix/etag-empty-list",
      machine: "maya-mbp.local",
      status: "dirty",
    },
    {
      id: makeId("wt"),
      agent: null,
      task: tWorktrees,
      path: "/home/priya/wt/worktrees",
      branch: "feat/worktree-registry",
      machine: "priya-dev",
      status: "pr",
    },
  ];

  for (const w of wt) {
    await sql`insert into worktrees (id, workspace_id, project_id, agent_id, task_id, path, branch, machine_name, status)
      values (${w.id}, ${workspaceId}, ${projectId}, ${w.agent}, ${w.task}, ${w.path}, ${w.branch}, ${w.machine}, ${w.status})`;
  }

  const comments = [
    {
      task: tCache,
      kind: "agent",
      agent: grokMaya,
      name: "grok-build@maya-mbp",
      body: "Compact list now returns cacheToken. Next: honor If-None-Match on /tasks and /snapshot.",
    },
    {
      task: tCache,
      kind: "user",
      name: "Maya",
      body: "Keep the payload under 2kb for 50 tasks. Agents should not re-download the board every heartbeat.",
    },
    {
      task: tIntegrate,
      kind: "agent",
      agent: grokPriya,
      name: "grok-build@priya-dev",
      body: "Blocked. cache-tokens still dirty; mcp-http not in review. Continuation parked at cont_019e8a2b77e4.",
    },
    {
      task: tEtag,
      kind: "agent",
      agent: claudeMaya,
      name: "claude-code@maya-mbp",
      body: "Reproduced. Hash omitted workspace revision when items.length === 0. Patch in the etag-fix worktree.",
    },
    {
      task: tCache,
      kind: "agent",
      agent: cursorOwen,
      name: "cursor-opus@owen-tower",
      body: "Mailbox: MCP transport will consume cacheToken once your compact lists land. Don't merge header rename until I bind my session.",
    },
    {
      task: tReview,
      kind: "user",
      name: "Owen",
      body: "Registry looks right. Confirm we reject two active worktrees on the same branch+machine.",
    },
  ];

  for (const c of comments) {
    await sql`insert into comments (id, workspace_id, task_id, author_kind, author_agent_id, author_name, body)
      values (${makeId("cmt")}, ${workspaceId}, ${c.task}, ${c.kind}, ${c.agent ?? null}, ${c.name}, ${c.body})`;
  }

  const events = [
    {
      kind: "claim",
      message: "grok-build claimed cache tokens on maya-mbp.local",
      task: tCache,
      agent: grokMaya,
    },
    {
      kind: "worktree",
      message: "cursor-opus registered /home/owen/wt/harbor-mcp",
      task: tMcp,
      agent: cursorOwen,
    },
    {
      kind: "block",
      message: "Integration waiting on three upstream branches",
      task: tIntegrate,
      agent: grokPriya,
    },
    {
      kind: "bug",
      message: "ETag collision filed against empty compact lists",
      task: tEtag,
      agent: claudeMaya,
    },
    {
      kind: "review",
      message: "Worktree registry opened for human review",
      task: tReview,
      agent: null,
    },
  ];
  for (const e of events) {
    await sql`insert into events (id, workspace_id, task_id, agent_id, kind, message)
      values (${makeId("evt")}, ${workspaceId}, ${e.task}, ${e.agent}, ${e.kind}, ${e.message})`;
  }

  const key = demoMcpKey(workspaceId);
  await sql`insert into api_keys (id, workspace_id, name, key_hash, key_prefix, created_by_user_id)
    values (${makeId("key")}, ${workspaceId}, ${"Workspace MCP key"}, ${hashApiKey(key)}, ${key.slice(0, 18)}, ${ownerUserId})`;
}

/** Real BothyBoard product board — created next to the Harbor demo, never twice. */
export async function ensureBothyBoardProject(
  sql: Sql,
  workspaceId: string,
  ownerUserId: string,
): Promise<string> {
  const existing = await sql<{ id: string }>`
    select id from projects
    where workspace_id = ${workspaceId} and name = ${"BothyBoard"} and deleted_at is null
    limit 1`;
  if (existing[0]) return existing[0].id;

  const projectId = makeId("prj");
  await sql`insert into projects (id, workspace_id, name, repo, default_branch, visibility)
    values (${projectId}, ${workspaceId}, ${"BothyBoard"}, ${"simnova/bothy-board"}, ${"main"}, ${"private"})`;
  await sql`insert into project_members (project_id, user_id, role)
    values (${projectId}, ${ownerUserId}, ${"owner"})`;
  const others = await sql<{ user_id: string }>`
    select user_id from workspace_members
    where workspace_id = ${workspaceId} and user_id <> ${ownerUserId}`;
  for (const o of others) {
    await sql`insert into project_members (project_id, user_id, role)
      values (${projectId}, ${o.user_id}, ${"member"})
      on conflict (project_id, user_id) do nothing`;
  }

  const tEpic = makeId("tsk");
  const tMcp = makeId("tsk");
  const tDb = makeId("tsk");
  const tKeys = makeId("tsk");
  const tasks: SeedTask[] = [
    {
      id: tEpic,
      title: "BothyBoard — humans and agents in the same hut",
      body: "Product board for this app. Harbor is the demo logbook; this project is the real work.",
      kind: "feature",
      status: "in_progress",
      priority: 0,
    },
    {
      id: tMcp,
      parentId: tEpic,
      title: "Dogfood MCP from Grok Build",
      body: "Connect with a BothyBoard-scoped PAT. Sync, claim, heartbeat. Do not use the Harbor demo token for this project.",
      kind: "chore",
      status: "ready",
      priority: 0,
    },
    {
      id: tDb,
      parentId: tEpic,
      title: "Show when the board is on PGLite, not Postgres",
      body: "Banner in the shell and landing whenever DATABASE_URL is missing. Publish uses Neon; preview data dies on restart.",
      kind: "feature",
      status: "ready",
      priority: 0,
    },
    {
      id: tKeys,
      parentId: tEpic,
      title: "Mint Connect keys scoped to BothyBoard",
      body: "Harbor-only PATs cannot see this project. After the project exists, mint a new key that includes BothyBoard.",
      kind: "chore",
      status: "ready",
      priority: 1,
    },
  ];
  for (const t of tasks) {
    await sql`insert into tasks (id, workspace_id, project_id, parent_id, title, body, kind, status, priority)
      values (${t.id}, ${workspaceId}, ${projectId}, ${t.parentId ?? null}, ${t.title}, ${t.body}, ${t.kind}, ${t.status}, ${t.priority})`;
  }
  await sql`insert into events (id, workspace_id, task_id, kind, message)
    values (${makeId("evt")}, ${workspaceId}, ${tEpic}, ${"create"}, ${"Opened the BothyBoard project"})`;
  await sql`update workspaces set revision = revision + 1, updated_at = now() where id = ${workspaceId}`;
  return projectId;
}
