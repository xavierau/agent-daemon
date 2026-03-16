# 🦞 Agent Daemon

Full-system orchestrator that connects **agent-board** (local kanban MCP server) with **agent-org** (RBAC + org hierarchy) to dispatch tasks to Claude Code agents.

## Architecture

```
agent-daemon (this repo)
  ├─ depends on: agent-board (MCP server — kanban board, SQLite, event-sourced)
  ├─ depends on: agent-org   (RBAC, org hierarchy, delegation chains)
  └─ spawns:     Claude Code  (with board MCP access — agents are active participants)
```

## How it Works

The daemon polls all boards, all cards, every 10 seconds. Four dispatch triggers in priority order:

| Priority | Trigger | When | Card moves? |
|----------|---------|------|-------------|
| 1 | **Explicit assign** | `card.assignee` is set | → doing |
| 2 | **@mention** | Comment contains `@agent-id` | No (reply-only) |
| 3 | **Label routing** | Card has labels matching capabilities | → doing |
| 4 | **Auto-route** | Extract capabilities from title/desc | → doing |

### Agent-to-Agent Conversations

Agents can @mention each other in comments — the daemon dispatches the mentioned agent automatically. A **per-card conversation budget** (default: 20 turns) prevents infinite loops:

- Agent @mentions agent = costs 1 turn
- Human comment on the card = **free + full budget reset**
- Budget exhausted = daemon pauses and notifies human

### Card Owner Notifications

When anyone comments on a card, the assigned agent (card owner) is always dispatched to read it. No comment is ever a dead letter — the owner reads the thread and decides the next step: continue work, @mention someone, or move the card to done.

### Concurrency

Dispatches are **fire-and-forget** — the poll loop is never blocked by agent execution. Active dispatches are tracked as `cardId:agentId` pairs, allowing multiple agents to work on the same card simultaneously (e.g., @mentioned QA + card owner). Configurable concurrency limit (default: 3).

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with paths to agent-board and agent-org repos
npm start
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BOARD_MCP_SERVER` | required | Path to agent-board MCP server index.ts |
| `ORG_CONFIG` | required | Path to agent-org org.yaml |
| `POLL_INTERVAL_MS` | 10000 | Polling interval |
| `MAX_CONCURRENT` | 3 | Max simultaneous agent executions |
| `AGENT_TURN_BUDGET` | 20 | Agent-to-agent turns per card before pause |
| `DAEMON_ACTOR_ID` | engineering-manager | Who the daemon acts as in the org |
| `TRIGGER_COLUMN` | todo | Column for new tasks |
| `DOING_COLUMN` | doing | Column for in-progress work |
| `DONE_COLUMN` | done | Column for completed work |

## Project Structure

```
src/
├── daemon.ts              # Poll loop, orchestration, prompt builders
├── dispatch-resolver.ts   # 4 triggers + priority + board access + card owner notify
├── conversation-budget.ts # Per-card turn budget + @mention parser
├── agent-router.ts        # Wraps agent-org OrchestratorFacade (RBAC + routing)
├── board-client.ts        # MCP client wrapper for agent-board
└── executor.ts            # Claude Code CLI spawning + MCP config
```

## Dependencies

| Package | Role |
|---------|------|
| [agent-board](https://github.com/xavierau/agent-board) | Local kanban board with MCP server |
| [agent-org](https://github.com/xavierau/agent-org) | Agent directory, RBAC, delegation chains |
| `@modelcontextprotocol/sdk` | MCP client for board communication |

## Dispatch Flow

```
Poll: all boards, all cards (every 10s, non-blocking)
│
├─ Phase 1: "todo" cards
│  └─ Dispatch resolver: assign → label → auto
│     └─ RBAC check → fire-and-forget execution
│
└─ Phase 2: all non-done cards — comment detection
   ├─ Human comment → dispatch assigned agent (free, budget reset)
   ├─ Agent @mention → dispatch mentioned agent (1 turn)
   │  └─ Also notify card owner if not mentioned (1 turn)
   └─ Budget exhausted → pause, notify human
```

## License

MIT
