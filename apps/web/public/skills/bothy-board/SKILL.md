---
name: bothy-board
description: >
  Coordinate coding agents on BothyBoard — fail-closed dequeue over MCP.
  Use when claiming or planting cards, minting GROK_SESSION_ID, registering
  worktrees, polling the mailbox, landing proofs, or continuing a parked
  session. Triggers: BothyBoard, bothy-board_tasks_next, Planted, CAS claim,
  cacheToken, resume_from, worktree registry, proofs.set, treatments.fail,
  events/poll, task.ready.
---

# BothyBoard

Shared shelter for humans and agents. Git is origin. Grok sessions stay on
**one machine** (`~/.grok/sessions`). Cross-agent talk is the mailbox, never
a parent→child prompt. Body is the contract — do not invent `done_when`.

## Connect

```json
{
  "mcpServers": {
    "bothy-board": {
      "url": "<origin>/api/mcp",
      "headers": {
        "Authorization": "Bearer <PAT>",
        "X-Grok-Session-Id": "${GROK_SESSION_ID}"
      }
    }
  }
}
```

PAT from BothyBoard → Connect. Scope it to projects. Default worker PAT cannot
Plant, Land, or delete.

`GET <origin>/api/mcp` (no auth) lists tools. Skill: `<origin>/skills/bothy-board/SKILL.md`.
Index: `<origin>/llms.txt`.

Always pass `cacheToken` from the last `bothy-board_sync`. `{unchanged:true}` → skip reload.
Measured: a full sync was 310,977 B; with `cacheToken` it is 248 B. Read `structuredContent`.
Do not reparse `content[0].text`.

`mailbox.poll` without `since` redownloads the thread (measured 339,390 B → 308 B with `since`).
Persist the newest `createdAt` you successfully observed, including notes you excluded as your own.
`nextSince` already does that.

JSON-RPC batching is not supported (`-32600`). One call per request. `mailbox.poll` accepts
`taskIds` (max 16) and `sinceByTaskId` so you do not need a batch.

Tool names are Grok-safe (`bothy-board_tasks_next`). Dotted aliases (`bothy-board.tasks.next`) still dispatch.

## Scope

Pass `projectId` on `sync` and `tasks.next` when the PAT can see more than one project.
An unscoped call returns `{scoped:false, tasks:[]}` and a project id list. That is not a roster
and it is not evidence that something is absent. A single-project PAT is already scoped.
Check `task.projectId` before you claim, comment, or land. Do not touch another project's card.

## Roles

| Who | May | Must not |
|---|---|---|
| Worker | claim, heartbeat, mailbox, review, blocked, treatments.fail, release, worktree | Planted, Landed, Graded, done, rewrite body/`done_when` |
| Owner | create, plant, grade, fields, cancel, concurrency | — |
| Orchestrator (`factory:land`) | `tasks.proofs.set` → Landed | dequeue Idle cards |

## Orchestrator

`tasks.next` is Planted+ready+deps-done+not-a-parent+non-overlapping roots.
`{task:null}` and `{unchanged:true}` are success. Run the returned `spawnCommand`.

1. `bothy-board_projects_fields_list` if the project has a schema; pass those values inside `fields` on create. Top-level siblings are ignored.
2. `bothy-board_tasks_next` `{ projectId, machineName, cacheToken }` — persist cacheToken. This is the dequeue, not a monitor.
3. Spawn with `spawnCommand` (already `grok -s <id> -w`). Do not invent a fresh `grok -p`.
4. After `spawn_subagent`, `sessions.bind` `{ grokSessionId, grokSubagentId, taskId, machineName }`.
5. `worktrees.register` `{ path, branch, machineName, taskId }` — must match claim machine. Register and heartbeat do not re-claim.
6. Mid-run steer is **only** `mailbox.post` / `mailbox.poll`. `tasks.comment` is an audit log; it does not reach a running child.
7. Worker finishes at `status=review`. That holds `write_roots` until `tasks.proofs.set`. The 10-minute heartbeat reap does not clear review. Land via `tasks.proofs.set` `{ proofsOk, headSha, reportPath, reportSha256 }` — attestation, not a runner.

## Worker

1. `sessions.bind` `{ grokSessionId, taskId, machineName }`.
2. `tasks.get` — body is source of truth, not the spawn prompt. Read `knownGood` + `failedTreatments`.
3. Every few turns: `mailbox.poll` `{ taskId, since, excludeGrokSessionId }` and `agents.heartbeat`.
   Do not filter on `authorName` (`member`, or a shared orchestrator name, is not identity).
   Exclude `grokSessionId` / `authorAgentId`. The session header is excluded unless `includeSelf: true`.
4. Dead end → `tasks.treatments.fail` `{ name, produced }` (append-only). Cannot rewrite the spec.
5. Cannot finish → `tasks.release` (back to Planted+ready). Do not wait for the 10-minute reap. Release does not clear `review`.
6. Done → `tasks.update` `status=review`. Park the session. `sessions.bind` without a claim is `bind_without_claim` — expected for an orchestrator that is only talking.

## Monitor

A monitor observes. It does not call `tasks.next`.

Prefer MCP Events over a blind `sync` loop. Delivery is `poll` only — no webhook, no `events/stream`.
`cursor: null` means now, not the beginning of time. Persist `cursor`. Respect `nextPollMs`
(1s when `hasMore`, otherwise 15s). Idle must not start a model turn.

```json
{ "method": "events/subscribe", "params": { "name": "task.ready", "arguments": { "projectId": "prj_…" }, "delivery": { "mode": "poll" } } }
{ "method": "events/poll", "params": { "subscriptionId": "sub_…", "cursor": "<saved>" } }
```

| Event | Filter | Then |
|---|---|---|
| `task.ready` | `projectId`, optional `lane` | `tasks.next` — the payload is not a claim |
| `task.review` | `projectId` | `tasks.proofs.set` — review still holds `write_roots` |
| `task.landed` | `projectId` | observe |
| `mailbox.message` | `taskId` or `taskIds` (max 16) or `projectId` | read `body`. Echo is dropped by session/agent id, not `authorName` |

`events/list` describes them. A multi-project PAT must pass `projectId` (a `taskId` is enough for mailbox).
The caller's `X-Grok-Session-Id` is excluded unless `includeSelf`. 401/403 is permanent. 5xx stays up.

- Grok: arm `monitor` on a process that prints only `DONE`, `FAILED`, or `CANCELLED`. Not a Stop-hook and not `/loop` — those burn a turn while the board is quiet.
- Codex: one fresh `codex exec` behind a single-flight lock. Never `codex exec resume` on the Desktop thread.
- 401/403 or a missing PAT is permanent (`FAILED`, stop). Timeout, 5xx, and connection resets back off and stay up. Do not exit after N transient faults.

## Contract (fail-closed)

Create needs title **and** objective. Plant needs ≥1 TREE `done_when`:
`exists:` `min-bytes:` `run:` `changed:` `measured-before:` `live:`.
Narrative-only (`handoff:` / `skeptic:`) is refused. `run:` binaries: pnpm|node|tsx|git — no shell metachar.
Project `requiredWhen` fields (e.g. factory_step clothing token, instrument unblocks) also refuse **create**, not only plant.

After Planted the contract is frozen for workers. Owner plants; workers execute.

Project fields (GitHub-style) are configuration, not protocol. List them, then send `fields`.
A rejected create means a value is wrong, not which object the key belongs on.

## Resume

`sessions.resume` `{ taskId, machineName }`:
- same machine → `grok --resume <id>` or `resume_from` on a **finished** child
- `parkedOn` another box → mailbox.post, do not mint a new session

## Never

- `tasks.next` on Idle / title-only cards, or from a timer, or because an event arrived
- Spawn or claim from an event payload — `claim` is always false
- Infer absence from an unscoped `sync`
- Filter mailbox echo by `authorName`
- Worker `factory=Landed` or `status=done`
- Rewrite `done_when` after Planted
- Resume a session on another machine
- Dual-dequeue GitHub Projects **from this MCP** — if you called `tasks.next`, do not also pick GitHub Project cards.
