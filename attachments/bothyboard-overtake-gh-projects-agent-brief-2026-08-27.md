---
id: BOTHY_OVERTAKE_GH_PROJECTS
audience: bothy-board-dev-agent
consumer: grok@simnova/bothy-board
producer: grok@simnova/OpenClinXR 2026-08-27
measured_against: bothy-board@0.2.0 live MCP + /tmp clone + OpenClinXR board-brief.ts
goal: replace GitHub Projects v2 (simnova project 7 Factory field) as HOT dequeue SSOT
non_goal: replace git/PRs/issues-as-code-review; replace OpenClinXR dispatch/integrate
claimBoundary: coordination-spec-not-product-not-clinical-not-quest
---

# TARGET

BothyBoard becomes the only `tasks.next` a factory orchestrator calls. GitHub issue/PR remain code-review + `changed:` proof targets. GitHub Project 7 Factory field becomes a *mirror* or is deleted after cutover.

Overtake iff ALL FAIL-CLOSED arrows below exist and a destructive probe of each is green. Shipping DAG+MCP without (G1) is a decorative board (OpenClinXR PROTO_BOARD_LOOP: "worse than no contract because it looks like one").

# OPENCLINXR CONSUMER CONTRACT (do not paraphrase)

```
owner authors card
  → briefFromIssue(body) REFUSE|DISPATCHABLE
  → dispatch({worktree:true, proofs})
  → orchestrator re-runs proofs on returned tree
  → integrate: merge-kill first, then merge
```

`body` consumed VERBATIM. No rewrite path. Delegator does not invent `done_when`.

Cutover adapter: BothyBoard `tasks.get.body` MUST parse with existing `briefFromIssue` (OpenClinXR `tools/openclinxr/openclaw/board-brief.ts`) with ZERO schema forks. Prefer: typed fields + canonical markdown dump of those fields as `body` so old parser still works.

# CARD SCHEMA (required fields; refuse create/ready without)

```yaml
factory_step: enum[body_param,clothing_consume,clothing_generate,motion_retarget,lip_sync,room_generate,equipment_generate,staging,dialogue_runtime,instrument]
unblocks: enum<factory_step>   # REQUIRED iff factory_step=instrument; else forbidden
lane: enum[A,B]                # A=learner/XR+assets B=API/admin/review
write_roots: string[]          # repo-relative; consumer-closure not just entry files
objective: string              # one sentence
known_good: string             # path:line in-tree
failed_treatments: [{name, produced}]
done_when: string[]            # bullets; parser stops at first non-bullet non-blank
out_of_scope: string
not_tested: string
# clothing_generate|clothing_consume: body|title MUST match /makeclothes|mhclo|hm08|mpfb/i else REFUSE
```

Optional later: `integration: A↔B`, `parent_id`, `dep_ids` (peer children only).

Canonical `body` serialization (byte-stable, for briefFromIssue):

```
## factory_step: <enum>
## lane: A|B
## write-roots: <comma or bullets>
## objective: ...
## known-good: ...
## failed-treatments: ...
## done_when
- exists:...
- run:...
## out-of-scope
...
```

# DONE_WHEN VOCAB (copy; do not invent)

TREE (merge-gate): `exists:` `min-bytes:` `run:` `changed:` `measured-before:` `live:`
NARRATIVE (not merge-gate): `handoff:` `skeptic:` exact `handoffs:all-done`

`run:` allowlist binaries: `pnpm` `node` `tsx` `git`. NO SHELL metachar `;|&$\`><\n\r`.

≥1 TREE rule required. Narrative-only → REFUSE ready.

Path targets: no markdown wrapping (`\`path\``). Tracked paths only for land proofs. `it.fails` without `live:` refuse.

Planted ≠ ready. `factory=Planted` iff RED+contract committed on consumer main. BothyBoard MUST NOT auto-Planted on create.

# LIFECYCLE (orthogonal pair; both required)

```
status:    backlog|ready|claimed|in_progress|blocked|review|integrating|done|cancelled
factory:   Idle|Planted|Dispatched|Landed|Graded
```

`tasks.next` SELECT:
- `factory=Planted`
- `status=ready`
- all `dep_ids` tasks `status=done` (peer deps, NOT parent)
- `priority` ASC then `id` ASC
- projectFilter match
- snapshot complete (if page truncated → REFUSE next, do not rank prefix)

Transitions (CAS only; illegal = error):
```
Idle+backlog --owner operationalize--> Idle+ready        # still not dequeue
Idle+ready   --RED on consumer main--> Planted+ready     # G1 body already valid
Planted+ready --claim CAS--> Planted+claimed
claimed --bind--> Planted+in_progress + factory=Dispatched
in_progress --worker--> review   # factory stays Dispatched
review --orchestrator proofsOk+merge-kill+merge--> Landed+integrating then Landed+done
Landed+done --owner grade--> Graded
blocked/cancelled anywhere except Graded
NEVER: bind(backlog), claim(non-ready), factory=Landed without proofs token, done without Landed
```

`--no-grade` twin: `factory=Landed` terminal allowed iff `no_grade=true` set by owner only.

# DECOMPOSE (invert current 0.2.0)

CURRENT BUG: `decomposeTask` inserts `task_deps(child, parent)` + child `status=backlog` (`packages/core/src/queries.ts:448-452`). Children wait on parent-done. Parent stays claimable. `readyIds` excludes backlog → children never `tasks.next`.

REQUIRED:
- parent = container (`kind` or `role=parent`). Parent NOT in `tasks.next`.
- children `parent_id=parent`, NO dep on parent.
- optional `dep_ids` among siblings.
- children inherit `factory_step/lane` unless overridden.
- children `status=backlog` until each child's body passes G1 AND factory=Planted independently.
- same-lane children serialize via explicit dep or lane-lock; A∥B allowed if `write_roots` disjoint.

Cycle detect on `task_deps`. Dep on deleted task → REFUSE create / mark blocked `dep_missing`.

# CLAIM / BIND / HEARTBEAT (fix 0.2.0)

```sql
UPDATE tasks SET status='claimed', assignee_agent_id=$1, ...
 WHERE id=$2 AND workspace_id=$3 AND status='ready' AND factory='Planted'
   AND assignee_agent_id IS NULL
 RETURNING *;
-- 0 rows => error already_claimed|not_ready
```

Single transaction. Second claim → error, not last-write-wins.

`heartbeat` MUST NOT set `assignee_agent_id` unless already assignee.
On claim of task B, clear `assignee_agent_id` from prior task A if still claimed by this agent (or require release).

TTL: if `now()-last_heartbeat > 10min` → agent `offline`; if exclusive claim, auto `status=ready` `factory=Planted` `assignee=null` + event `reaped`. Status `offline` must be written (enum exists, unused).

# WORKTREES

`register` FAIL if `(path|branch)` + `machine` has `status=active` for another `agent_id`.
FAIL if same `path` active on another machine (optional warn vs fail: FAIL for this factory).
`taskId` required. No fallback to workspace first project (`queries.ts:574-579` bug).
`tasks.next` MAY require register before bind; empty registry + `in_progress` is illegal.

# ISOLATION (live bugs 2026-08-27)

PAT `projectIds` applied to tasks/worktrees. NOT applied to:
- `loadSnapshot` agents (`queries.ts:131-137`) workspace-wide
- events
- `listMembers` (`team.ts:404-414` JOIN projects → N-duplicate)
- `projects.list` uses `listUserProjects` not `actor.projectIds` (`mcp.ts:540-547`)
- `sessions.bind` without `taskId` resolves grokSessionId workspace-wide then writes (`sessions.ts` + `mcp.ts:354-365`)

REQUIRED: every list/sync field filtered by `projectFilter`. Drop `currentTaskId` if PAT cannot `tasks.get` it. `listMembers` `GROUP BY user_id`. `projects.list` = intersection(membership, token.projectIds).

SECURITY REVIEW: REST Snapshot.mcpKey (`types.ts:134`, `hash.ts` demoMcpKey) = deterministic workspace key, `projectFilter=null` for actor.type=agent. MCP sync 2026-08-27 did NOT return mcpKey. If REST still emits it: remove from snapshot; rotate; never deterministic.

# MCP TOOLS (keep + change)

KEEP: sync(cacheToken), sessions.mint/bind/resume, mailbox.poll/post, worktrees.register, agents.heartbeat, tasks.comment.

CHANGE:
- `tasks.create`: require schema; default status=backlog factory=Idle; do not accept title-only.
- `tasks.next`: Planted+ready+deps+priority; return null is success (`no-candidate`).
- `tasks.claim`: CAS.
- `tasks.decompose`: invert deps.
- `tasks.update`: state machine; worker MAY set review/blocked/blockedReason; MAY NOT set done/Landed/Graded/Planted.
- `tasks.ready` or `factory.set`: owner-only Planted (after G1).
- NEW `tasks.proofs.set` `{taskId, proofsOk, headSha, reportPath}` orchestrator-only → allows Landed.

`cacheToken` MUST include `projectKey` (today REST ETag omits filter). Heartbeat should NOT bump workspace revision (cache stampede); bump task.updated_at only.

Priority: `nextReady` currently `find()` on sort_order (`queries.ts:619`) vs MCP "highest-priority" — implement `ORDER BY priority ASC, id ASC`.

# CONCURRENCY

N=2: one claimed A + one claimed B per project if write_roots disjoint. Third claim REFUSE `lane_busy` unless N-gate flag. Integrate SERIAL: at most one `factory=integrating` per repo.

# CONTENT GUARD

Reject create/comment/mailbox if body matches product/clinical dump heuristics (scenario dialogue, PHI tokens, score tables). Banner constant on every owner-facing card. Coordination metadata only. Size cap mailbox posts.

# GIT HUB RELATION

Keep: PRs, `changed:` paths, `gh` as proof runner in consumer repo.
Stop being SSOT: Project v2 item fields (Factory, Priority dequeue).
Mirror (optional): webhook Factory→GitHub label for humans; never a second `tasks.next`.

OpenClinXR cutover (their repo, not yours): `openclaw-slice-runner` `selectNextFromBoard` reads BothyBoard `tasks.next` instead of `gh project item-list`. Do not cut over until G1–G7 probed.

# ACCEPTANCE PROBES (plant → fail → fix → pass)

| id | plant | expect |
|---|---|---|
| G1 | create title-only | HTTP/MCP error; not in next |
| G1b | done_when prose bullets no prefix | refuse ready/Planted |
| G1c | done_when `handoff:` only | refuse |
| G1d | `exists:\`foo\`` markdown path | refuse |
| G1e | clothing_generate body without makeclothes\|mhclo\|hm08\|mpfb | refuse |
| G1f | instrument without unblocks: or unblocks not in FACTORY_STEPS | refuse |
| G2 | two concurrent claim same Planted+ready | exactly one winner |
| G3 | decompose 2 children | parent absent from next; children not ready until own Planted; no dep on parent |
| G4 | PAT project=OpenClinXR | sync.agents/tasks/projects/members contain only that project; members unique |
| G5 | heartbeat stop 11min | agent offline; task reaped to Planted+ready |
| G6 | register same path second agent | error |
| G7 | next when zero Planted | `{task:null}` not error |
| G8 | worker update factory=Landed | error |
| G9 | bind without claim | error (or auto-claim CAS) |
| G10 | truncated snapshot | next REFUSE incomplete |

# RANKED IMPLEMENTATION (this order)

1. G2 claim CAS + G5 TTL (correctness)
2. G4 projectFilter on sync/list/bind (isolation)
3. G1+schema+Planted gate (SSOT)
4. G3 decompose invert
5. G6 worktree exclusive; heartbeat no revision bump
6. G8 state machine
7. mcpKey/demo key audit
8. consumer adapter (OpenClinXR `tasks.next` → briefFromIssue) — after 1–6 green

Do not: prettier canvas, more TASK_KINDS, FlowGram, delete-scope expansion, dual-dequeue.

# LIVE 0.2.0 BASELINE (re-measure)

```
OpenClinXR prj_9b390b99b443a964 tasks=[] readyIds=[]
projects.list leaked Harbor+BothyBoard+OpenClinXR
agents=9 workspace-wide; tasks.get those ids → "not scoped"
members owner×3
worktrees=[]
tools/list omitted delete (good)
TASK_KINDS feature/bug/chore/integration/spike
INTEGRATION_STATUSES none/waiting/conflict/merged — labels not merge-kill
```

# FILE MAP (bothy-board)

```
packages/core/src/types.ts          +factory +lane +write_roots +done_when typed
packages/core/src/queries.ts        claim CAS, readyIds, nextReady priority, decompose, heartbeat TTL, snapshot filter
packages/core/src/access.ts         bind always assertTaskAccess
packages/core/src/team.ts           GROUP BY user_id
packages/core/src/sessions.ts       affinity on mint/claim; no cross-project bind
packages/core/src/scopes.ts         keep delete off default
apps/web/src/lib/bothy-board/mcp.ts tool schemas + next description honesty
apps/web/public/skills/bothy-board/SKILL.md  orchestrator: next only if factory=Planted
```

# FILE MAP (OpenClinXR consumer, later)

```
tools/openclinxr/openclaw/board-brief.ts     already the refuse oracle — call on BothyBoard body
tools/openclinxr/openclaw/board-next-selector.ts  replace gh fetch
tools/openclinxr/openclaw/board-cli.ts       FACTORY_STAGES writers → MCP
.claude/skills/board-conduit/SKILL.md        origin=bothy-board
```

# OWNER VS AGENT WRITES

```
owner: create, Planted, Graded, no_grade, N-gate, priority, cancel
agent: claim, heartbeat, mailbox, comment, review, blockedReason, worktree register
orchestrator: proofs.set → Landed
```

Rogue agent cannot Planted/Landed/Graded/done.

# DONE WHEN THIS SPEC IS SATISFIED (BothyBoard repo)

- exists: packages/core tests for G1–G10
- run: pnpm test covering claim CAS race
- changed: packages/core/src/queries.ts packages/core/src/types.ts apps/web/src/lib/bothy-board/mcp.ts
- NOT TESTED: OpenClinXR cutover; live PAT re-probe after deploy
