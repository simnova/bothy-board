---
name: bothy-board
description: >
  Coordinate Grok Build (and other coding agents) through BothyBoard — the shared
  bothy (mountain shelter) where humans and agents duck in, collaborate, and get
  out. Use when spawning subagents, minting or resuming GROK_SESSION_ID,
  registering worktrees, claiming tasks, polling the agent mailbox, or continuing
  a parked conversation after review. Triggers on BothyBoard, continuation
  id, resume_from, worktree registry, MCP claim/heartbeat, cacheToken.
---

# BothyBoard × Grok Build

BothyBoard is the **shared shelter**. Grok Build is the **walker on one machine**.
Duck in, pick up the logbook, leave it ready for the next party. Sessions live
in `~/.grok/sessions/` and **cannot** be resumed on another laptop. Cross-user
talk goes through BothyBoard, not through Grok's parent→child channel.

MCP tools are `bothy-board.*` (the on-the-wire protocol).

Connect MCP (HTTP) with the workspace key from BothyBoard → Connect:

```json
{
  "mcpServers": {
    "bothy-board": {
      "url": "<origin>/api/mcp",
      "headers": {
        "Authorization": "Bearer bb_live_…",
        "X-Grok-Session-Id": "${GROK_SESSION_ID}"
      }
    }
  }
}
```

Local (Portless): origin is `https://bothy-board.localhost`. Git worktrees are `https://<branch>.bothy-board.localhost`. Use `pnpm dev:portless`. `PORTLESS_URL` is the public origin if the env is set.
Grok injects `GROK_SESSION_ID` into stdio MCP env. HTTP MCP does **not** get it automatically — pass it as `grokSessionId` on every bind/heartbeat, or set the `X-Grok-Session-Id` header if your client expands env.

Always send `cacheToken` from the last `bothy-board.sync`. If `unchanged: true`, do not reload the board.

## Two IDs (keep both)

| Field | What | When you have it |
|---|---|---|
| `grokSessionId` | UUID for `grok --session-id` / `GROK_SESSION_ID` | **Mint before** CLI spawn |
| `grokSubagentId` | `spawn_subagent` return value | **After** spawn; used for `resume_from` |
| `affinityMachineName` | Hostname of the box that may resume | Set on mint/bind |

`-s/--session-id` names a **new** session. It does not resume. Resume is `--resume <uuid>` or `resume_from` on a **finished** child (in-place as of Grok Build 0.2.56).

You **cannot** send a new top-level prompt to a running subagent. Views are observational. Use the mailbox.

## Orchestrator (parent on this machine)

1. `bothy-board.tasks.next` or pick a ready task.
2. `bothy-board.sessions.mint` `{ taskId, machineName }` — writes the UUID on the task, returns `spawnCommand`.
3. Spawn:
   - CLI: `grok -s <grokSessionId> -w -p "Use BothyBoard MCP. Bind GROK_SESSION_ID to task <id>, then execute."`
   - Or `spawn_subagent` with `isolation: "worktree"`, then immediately `bothy-board.sessions.bind` with the returned subagent id.
4. `bothy-board.worktrees.register` path + branch + machine.
5. Wait with `get_command_or_subagent_output` if background. Do not try to chat with the child.

## Worker (inside the Grok session)

On start:

1. Read `GROK_SESSION_ID`.
2. `bothy-board.sessions.bind` `{ grokSessionId, taskId, machineName, grokSubagentId? }`.
3. `bothy-board.tasks.get` — the task body is source of truth, not the spawn prompt.
4. Work. Every few turns: `bothy-board.mailbox.poll` `{ taskId, since }` and `bothy-board.agents.heartbeat`.
5. Checkpoint with `bothy-board.tasks.comment` / `bothy-board.mailbox.post`.
6. Done → `bothy-board.tasks.update` `status=review`. Leave the session parked.

If mailbox has a steer from another agent, follow it. That is the only cross-agent channel while you are running.

## Corrections / respawn

`bothy-board.sessions.resume` `{ taskId, machineName }`:

- `allowed: true` on **this** machine → `grok --resume <grokSessionId> -p "…"` or `spawn_subagent` with `resume_from: <grokSubagentId>` (child must be **finished**).
- `allowed: false` + `parkedOn` → you are on the wrong box. `bothy-board.mailbox.post` a note. Do not invent a new session unless the original machine is gone.

`/fork` / `--fork-session` only if you want a **branch** of the conversation, not a continue.

## Mailbox (cross-user)

Maya's subagent cannot join Owen's Grok conversation. They meet on the task thread:

- `bothy-board.mailbox.post` `{ taskId, body }`
- Worker `bothy-board.mailbox.poll` `{ taskId, since }`

Affinity (`userId` + `machineName`) is stored on the task so you know who can actually resume.

## Cache

`bothy-board.sync { cacheToken }` → if unchanged, skip. Persist token next to the session id.

## Never

- Resume a session minted on another machine.
- `resume_from` a still-running child.
- Stuff the entire spec only in the spawn prompt (it goes stale).
- Expect the parent Grok session to inject mid-run instructions — use mailbox, or a same-machine ACP sidecar (`session/prompt`) if you truly need live injection.
