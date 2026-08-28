---
name: bothy-board
description: >
  Coordinate coding agents on BothyBoard — fail-closed dequeue over MCP.
  Use when claiming or planting cards, minting GROK_SESSION_ID, registering
  worktrees, polling the mailbox, landing proofs, or continuing a parked
  session. Triggers: BothyBoard, bothy-board.*, tasks.next, Planted, CAS claim,
  cacheToken, resume_from, worktree registry, proofs.set, treatments.fail.
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

Always pass `cacheToken` from the last `bothy-board.sync`. `{unchanged:true}` → skip reload.

## Roles

| Who | May | Must not |
|---|---|---|
| Worker | claim, heartbeat, mailbox, review, blocked, treatments.fail, release, worktree | Planted, Landed, Graded, done, rewrite body/`done_when` |
| Owner | create, plant, grade, fields, cancel, concurrency | — |
| Orchestrator (`factory:land`) | `tasks.proofs.set` → Landed | dequeue Idle cards |

## Orchestrator

`tasks.next` is Planted+ready+deps-done+not-a-parent+non-overlapping roots.
`{task:null}` and `{unchanged:true}` are success. Run the returned `spawnCommand`.

1. `bothy-board.projects.fields.list` if the project has a schema; pass `fields` on create.
2. `bothy-board.tasks.next` `{ machineName, cacheToken }` — persist cacheToken.
3. Spawn with `spawnCommand` (already `grok -s <id> -w`). Do not invent a fresh `grok -p`.
4. After `spawn_subagent`, `sessions.bind` `{ grokSessionId, grokSubagentId, taskId, machineName }`.
5. `worktrees.register` `{ path, branch, machineName, taskId }` — must match claim machine.
6. Mid-run steer is **only** `mailbox.post` / `mailbox.poll`. `tasks.comment` is an audit log; it does not reach a running child.
7. Worker finishes at `status=review`. Land via `tasks.proofs.set` `{ proofsOk, headSha, reportPath, reportSha256 }` — attestation, not a runner.

## Worker

1. `sessions.bind` `{ grokSessionId, taskId, machineName }`.
2. `tasks.get` — body is source of truth, not the spawn prompt. Read `knownGood` + `failedTreatments`.
3. Every few turns: `mailbox.poll` `{ taskId, since }` and `agents.heartbeat`.
4. Dead end → `tasks.treatments.fail` `{ name, produced }` (append-only). Cannot rewrite the spec.
5. Cannot finish → `tasks.release` (back to Planted+ready). Do not wait for the 10-minute reap.
6. Done → `tasks.update` `status=review`. Park the session.

## Contract (fail-closed)

Create needs title **and** objective. Plant needs ≥1 TREE `done_when`:
`exists:` `min-bytes:` `run:` `changed:` `measured-before:` `live:`.
Narrative-only (`handoff:` / `skeptic:`) is refused. `run:` binaries: pnpm|node|tsx|git — no shell metachar.
Project `requiredWhen` fields (e.g. factory_step clothing token, instrument unblocks) also refuse **create**, not only plant.

After Planted the contract is frozen for workers. Owner plants; workers execute.

Project fields (GitHub-style) are configuration, not protocol. List them, then send `fields`.

## Resume

`sessions.resume` `{ taskId, machineName }`:
- same machine → `grok --resume <id>` or `resume_from` on a **finished** child
- `parkedOn` another box → mailbox.post, do not mint a new session

## Never

- `tasks.next` on Idle / title-only cards
- Worker `factory=Landed` or `status=done`
- Rewrite `done_when` after Planted
- Resume a session on another machine
- Dual-dequeue GitHub Projects **from this MCP** — if you called `tasks.next`, do not also pick GitHub Project cards.
