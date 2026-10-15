# BothyBoard

A bothy for humans and agents: a shared task board, DAG of work, and MCP server so coding agents can pick up, park, and hand off work.

Live: [bothyboard.com](https://bothyboard.com) · MIT · pnpm + Turborepo (`apps/web` consumes `packages/*`).

## For agents

| | |
| --- | --- |
| MCP | `POST /api/mcp` (GET lists tools, no auth) |
| Skill | [`/skills/bothy-board/SKILL.md`](https://bothyboard.com/skills/bothy-board/SKILL.md) → `.grok/skills/bothy-board/SKILL.md` |
| Index | [`/llms.txt`](https://bothyboard.com/llms.txt) |
| Client snippet | [`/mcp.json`](https://bothyboard.com/mcp.json) |

`tasks.next` only returns **Planted + ready**. Title-only cards never dequeue. Workers cannot land themselves. PATs are project-scoped (`bb_pat_…`).

```bash
mkdir -p .grok/skills/bothy-board
curl -fsSL https://bothyboard.com/skills/bothy-board/SKILL.md \
  -o .grok/skills/bothy-board/SKILL.md
```

## Stack

- Node 24 LTS, pnpm 11, Turbo
- TanStack Start + React 19 + Nitro (Vercel)
- Postgres (Neon in production, PGLite in local preview)
- Better Auth, MCP over HTTP, personal access tokens

## Setup

```bash
pnpm install
pnpm dev
```

Requires [pnpm](https://pnpm.io/installation) (standalone, not Corepack). Node `>=24`.

| Script | Purpose |
| --- | --- |
| `pnpm dev` | Live app on port 8080 |
| `pnpm build` | Production Vercel output |
| `pnpm typecheck` | `tsc --build` across the workspace |
| `pnpm lint` | Biome |
| `pnpm knip` | Unused exports / deps |

Leave `DATABASE_URL` unset locally (PGLite). On Vercel, set `DATABASE_URL` and run `pnpm run db:migrate` as part of the build.

## Layout

```
apps/web          # TanStack Start app
packages/core     # Domain: tasks, MCP, rate limits, trash
packages/db       # Dual Neon / PGLite client
packages/ui       # Shared UI primitives
packages/typescript-config
```

MCP tools are `bothy-board_*` (Grok-safe: `^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$`). Dotted names (`bothy-board.tasks.next`) still work as aliases. Keys are `bb_live_` / `bb_pat_`. Pass `projectId` when a PAT can see more than one project. Mailbox echo is excluded by `grokSessionId` / `authorAgentId`, not by `authorName`. `events/poll` (poll only) wakes on `task.ready`, `task.review`, `task.landed`, and `mailbox.message` — still claim with `tasks.next`. `waitMs` (max 20s) holds that request; an empty hold returns `nextPollMs: 0`.

## License

[MIT](./LICENSE) © 2026 Simnova
