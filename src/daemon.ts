/**
 * 🦞 Agent Daemon — full-system orchestrator
 *
 * Scans ALL boards, ALL cards. Four dispatch triggers:
 *   1. Explicit assign (card.assignee)
 *   2. @mention in comment
 *   3. Label-based routing
 *   4. Auto-route from title/desc
 *
 * Conversation budget: 20 agent-to-agent turns per card.
 * Human comment = full reset. Budget 0 = paused.
 */

import 'dotenv/config';
import { resolve } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { BoardClient, type BoardCard, type CardComment } from './board-client.js';
import { AgentRouter, loadAgentOrg } from './agent-router.js';
import { runClaude, writeMcpConfig, type ExecConfig } from './executor.js';
import { ConversationBudget } from './conversation-budget.js';
import { DispatchResolver, type DispatchDecision, type DispatchTrigger } from './dispatch-resolver.js';

// ─── Config ───────────────────────────────────────────────

const config = {
  boardMcpServer: required('BOARD_MCP_SERVER'),
  orgConfig: required('ORG_CONFIG'),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '10000', 10),
  outputsDir: process.env.OUTPUTS_DIR || './outputs',
  defaultModel: process.env.DEFAULT_MODEL || 'sonnet',
  defaultMaxTurns: parseInt(process.env.DEFAULT_MAX_TURNS || '15', 10),
  triggerColumn: process.env.TRIGGER_COLUMN || 'todo',
  doingColumn: process.env.DOING_COLUMN || 'doing',
  doneColumn: process.env.DONE_COLUMN || 'done',
  daemonActorId: process.env.DAEMON_ACTOR_ID || 'engineering-manager',
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '3', 10),
  agentTurnBudget: parseInt(process.env.AGENT_TURN_BUDGET || '20', 10),
};

function required(key: string): string {
  const val = process.env[key];
  if (!val) { console.error(`❌ Missing env var: ${key}`); process.exit(1); }
  return val;
}

// ─── Logging ──────────────────────────────────────────────

const R = '\x1b[0m', D = '\x1b[2m', B = '\x1b[1m';
const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m', MAGENTA = '\x1b[35m', CYAN = '\x1b[36m';

function ts(): string { return D + new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, '') + R; }
function log(icon: string, c: string, tag: string, msg: string, data?: Record<string, unknown>) {
  console.log(`${ts()} ${icon} ${c}${B}[${tag}]${R} ${msg}`);
  if (data) for (const [k, v] of Object.entries(data))
    console.log(`${' '.repeat(22)}${D}├─ ${k}: ${R}${typeof v === 'string' ? v : JSON.stringify(v)}`);
}
function logPoll(m: string, d?: Record<string, unknown>)   { log('🔄', CYAN, 'POLL', m, d); }
function logEvent(m: string, d?: Record<string, unknown>)  { log('⚡', YELLOW, 'EVENT', m, d); }
function logRoute(m: string, d?: Record<string, unknown>)  { log('🧭', MAGENTA, 'ROUTE', m, d); }
function logExec(m: string, d?: Record<string, unknown>)   { log('🤖', GREEN, 'EXEC', m, d); }
function logResult(m: string, d?: Record<string, unknown>) { log('📋', BLUE, 'RESULT', m, d); }
function logError(m: string, d?: Record<string, unknown>)  { log('❌', RED, 'ERROR', m, d); }
function logBudget(m: string, d?: Record<string, unknown>) { log('💰', YELLOW, 'BUDGET', m, d); }
function logSystem(m: string) { console.log(`${ts()} 🦞 ${B}${m}${R}`); }

const TRIGGER_EMOJI: Record<DispatchTrigger, string> = {
  assign: '👤', mention: '💬', label: '🏷️', auto: '🤖', reply: '↩️',
};

// ─── State ────────────────────────────────────────────────

const board = new BoardClient();
let router: AgentRouter;
let resolver: DispatchResolver;
const budget = new ConversationBudget(config.agentTurnBudget);
let pollCount = 0;

/** Active dispatches tracked as "cardId:agentId" — allows multiple agents on same card */
const activeDispatches = new Set<string>();

function isCardBusy(cardId: string): boolean {
  for (const key of activeDispatches) {
    if (key.startsWith(cardId + ':')) return true;
  }
  return false;
}

function isDispatchActive(cardId: string, agentId: string): boolean {
  return activeDispatches.has(`${cardId}:${agentId}`);
}

function activeCount(): number {
  return activeDispatches.size;
}

const commentTracker = new Map<string, { count: number; lastActorId: string }>();
const skippedCards = new Set<string>();
let knownAgentIds = new Set<string>();

// ─── Initialize ───────────────────────────────────────────

async function initialize(): Promise<void> {
  logSystem('Initializing...');

  logSystem('Connecting to board MCP server...');
  await board.connect(config.boardMcpServer);

  logSystem('Loading agent-org module...');
  await loadAgentOrg();
  logSystem(`Loading org config from ${config.orgConfig}`);
  router = new AgentRouter(config.orgConfig, config.daemonActorId);

  // Discover boards
  const boards = await board.listBoards();
  if (boards.length === 0) {
    await board.createBoard('Agent Board', config.daemonActorId, [
      config.triggerColumn, config.doingColumn, 'review', config.doneColumn,
    ]);
  }
  logSystem(`${boards.length} board(s) discovered`);
  for (const b of boards) console.log(`  ${D}• "${b.name}" (${b.id})${R}`);

  // Build agent ID set
  const agents = await board.listAgents();
  knownAgentIds = new Set([...agents.map(a => a.id), config.daemonActorId, 'system']);
  logSystem(`${agents.length} agent(s) registered:`);
  for (const a of agents) console.log(`  ${D}• ${a.display_name} (${a.id}) [${a.role_type}]${R}`);

  // Init dispatch resolver
  resolver = new DispatchResolver(router, budget, knownAgentIds, config.daemonActorId);

  // Setup
  mkdirSync(resolve(config.outputsDir), { recursive: true });
  writeMcpConfig(config.boardMcpServer, resolve('.agent-mcp.json'));

  // Initial comment snapshot
  logSystem('Building initial comment snapshot...');
  const allCards = await board.listCards();
  for (const card of allCards) {
    if (card.column === config.doneColumn || card.archived) continue;
    const comments = await board.listComments(card.id);
    if (comments.length > 0) {
      const last = comments[comments.length - 1];
      commentTracker.set(card.id, { count: comments.length, lastActorId: last.actorId });
    }
  }
  logSystem(`Tracking ${commentTracker.size} card(s)`);

  console.log('');
  logSystem('Config:');
  console.log(`  ${D}├─ Scan scope:      ${R}ALL boards, ALL columns`);
  console.log(`  ${D}├─ Poll interval:   ${R}${config.pollIntervalMs}ms`);
  console.log(`  ${D}├─ Max concurrent:  ${R}${config.maxConcurrent} agents`);
  console.log(`  ${D}├─ Turn budget:     ${R}${config.agentTurnBudget} per card`);
  console.log(`  ${D}├─ Daemon actor:    ${R}${config.daemonActorId}`);
  console.log(`  ${D}└─ Outputs:         ${R}${resolve(config.outputsDir)}`);
  console.log('');
}

// ─── Poll ─────────────────────────────────────────────────

async function poll(): Promise<void> {
  pollCount++;
  const pid = String(pollCount).padStart(4, '0');

  const allCards = await board.listCards();
  const boards = await board.listBoards();
  const todoCards = allCards.filter(c => c.column === config.triggerColumn && !c.archived);
  const budgetStats = budget.stats();

  logPoll(`#${pid} — ${allCards.length} cards, ${boards.length} boards`, {
    todo: todoCards.length,
    active: activeCount(),
    paused: budgetStats.pausedCards,
  });

  // ── Phase 1: New tasks in "todo" ──────────────────────
  for (const card of todoCards) {
    if (isCardBusy(card.id) || skippedCards.has(card.id)) continue;
    if (activeCount() >= config.maxConcurrent) {
      logPoll(`Concurrency limit (${config.maxConcurrent}) — deferring`);
      break;
    }

    const decision = resolver.resolveNewTask(card);
    if (!decision.dispatch) {
      logRoute(`Skip: ${decision.reason}`, { card: card.title });
      skippedCards.add(card.id);
      continue;
    }

    for (const agent of decision.agents) {
      logRoute(`${TRIGGER_EMOJI[agent.trigger]} ${agent.trigger}: ${B}${agent.agentName}${R}`, {
        card: card.title,
        agent: agent.agentId,
      });

      // RBAC check
      const assignment = await router.assignTask(agent.agentId, card.title);
      if (!assignment.success) {
        logError(`RBAC denied`, { reason: assignment.message });
        await board.addComment(card.id, `⚠️ Cannot assign to ${agent.agentName}: ${assignment.message}`, config.daemonActorId);
        continue;
      }

      budget.recordHumanDispatch(card.id, agent.agentId);
      budget.setAssignedAgent(card.id, agent.agentId);

      fireDispatch(card, agent.agentId, agent.agentName, decision);
    }
  }

  // ── Phase 2: Check all non-done cards for new comments ─
  const monitored = allCards.filter(c =>
    c.column !== config.doneColumn && !c.archived
  );

  for (const card of monitored) {
    await checkComments(card);
  }

  logPoll(`#${pid} done`, { active: activeCount(), tracked: commentTracker.size });
}

// ─── Comment Detection ────────────────────────────────────

async function checkComments(card: BoardCard): Promise<void> {
  const comments = await board.listComments(card.id);
  if (comments.length === 0) return;

  const prev = commentTracker.get(card.id);
  const last = comments[comments.length - 1];
  commentTracker.set(card.id, { count: comments.length, lastActorId: last.actorId });

  if (!prev || comments.length <= prev.count) return;

  // Process each new comment
  const newComments = comments.slice(prev.count);
  for (const comment of newComments) {
    const decision = resolver.resolveComment(card, comment, comments);

    if (!decision.dispatch) {
      if (decision.reason && !decision.reason.includes('no @mentions') && !decision.reason.includes('no agent to dispatch')) {
        // Log interesting rejections (budget exhausted, etc)
        logBudget(decision.reason, { card: card.title });

        // If budget exhausted, notify on card
        if (budget.isPaused(card.id)) {
          await board.addComment(
            card.id,
            `🛑 **Agent conversation paused** — ${config.agentTurnBudget} agent-to-agent turns used. Human input needed to continue.`,
            config.daemonActorId,
          );
        }
      }
      continue;
    }

    if (activeCount() >= config.maxConcurrent) {
      logPoll(`Concurrency limit — deferring comment dispatch for "${card.title}"`);
      // Undo the comment tracker advance so we catch it next poll
      commentTracker.set(card.id, prev);
      return;
    }

    for (const agent of decision.agents) {
      const isAgentComment = knownAgentIds.has(comment.actorId);

      logEvent(`${TRIGGER_EMOJI[agent.trigger]} ${isAgentComment ? 'Agent' : 'User'} → ${agent.agentName}`, {
        card: card.title,
        from: comment.actorId,
        trigger: agent.trigger,
        budget: `${budget.get(card.id).budgetRemaining}/${config.agentTurnBudget}`,
        replyOnly: decision.replyOnly,
      });

      fireDispatch(card, agent.agentId, agent.agentName, decision);
    }
  }
}

// ─── Fire Dispatch (fire-and-forget) ──────────────────────

function fireDispatch(
  card: BoardCard,
  agentId: string,
  agentName: string,
  decision: DispatchDecision,
): void {
  if (isDispatchActive(card.id, agentId)) return;
  if (activeCount() >= config.maxConcurrent) return;

  dispatchAgent(card, agentId, agentName, decision).catch(err =>
    logError(`Dispatch failed: "${card.title}"`, { error: (err as Error).message })
  );
}

async function dispatchAgent(
  card: BoardCard,
  agentId: string,
  agentName: string,
  decision: DispatchDecision,
): Promise<void> {
  const dispatchKey = `${card.id}:${agentId}`;
  activeDispatches.add(dispatchKey);

  // Move card if needed
  if (decision.moveCard && card.column === config.triggerColumn) {
    try {
      await board.moveCard(card.id, config.doingColumn, config.daemonActorId);
    } catch (err) {
      logError('Move failed', { error: (err as Error).message });
    }
  }

  // Build prompt
  const trigger = decision.agents.find(a => a.agentId === agentId)?.trigger ?? 'auto';
  const prompt = decision.replyOnly
    ? buildReplyPrompt(card, agentId, agentName, decision.comments || [], trigger)
    : buildTaskPrompt(card, agentId, agentName, decision.comments);

  // Notify
  const verb = decision.replyOnly ? 'reviewing' : 'working on';
  await board.addComment(card.id, `🤖 **${agentName}** is ${verb} this...`, agentId);

  logExec(`${decision.replyOnly ? 'Reply' : 'Execute'}: ${agentName}`, {
    card: card.title, model: config.defaultModel,
  });

  const result = await runClaude(prompt, {
    model: config.defaultModel,
    maxTurns: decision.replyOnly ? 5 : config.defaultMaxTurns, // reply-only = fewer turns
    cwd: process.cwd(),
    mcpConfigPath: resolve('.agent-mcp.json'),
  }, logExec);

  // Save output
  const outFile = saveOutput(card, agentId, result.output, result.durationMs);

  if (result.success) {
    logResult(`✅ ${(result.durationMs / 1000).toFixed(1)}s`, { file: outFile });
    const summary = extractSummary(result.output, 600);
    await board.addComment(card.id, `✅ **Done** (${(result.durationMs / 1000).toFixed(0)}s)\n\n${summary}`, agentId);

    if (!decision.replyOnly) {
      try { await board.moveCard(card.id, config.doneColumn, agentId); } catch { /* ok */ }
    }
  } else {
    logError(`Failed ${(result.durationMs / 1000).toFixed(1)}s`, { error: result.error?.slice(0, 200) });
    await board.addComment(card.id, `❌ Failed: ${result.error?.slice(0, 200) || 'Unknown'}`, agentId);
  }

  // Update tracker
  const latest = await board.listComments(card.id);
  if (latest.length > 0) {
    commentTracker.set(card.id, { count: latest.length, lastActorId: latest[latest.length - 1].actorId });
  }

  activeDispatches.delete(dispatchKey);
}

// ─── Prompt Builders ──────────────────────────────────────

function buildTaskPrompt(card: BoardCard, agentId: string, agentName: string, comments?: CardComment[]): string {
  const cfg = router.getAgent(agentId);
  const s: string[] = [];

  s.push('# Your role');
  s.push(`You are: ${agentName} (${agentId})`);
  if (cfg) {
    s.push(`Role: ${cfg.role_type} | Scope: ${cfg.scope.join(', ')}`);
    if (cfg.capabilities) s.push(`Capabilities: ${cfg.capabilities.join(', ')}`);
  }
  s.push('');
  s.push(`# Task: ${card.title}`);
  s.push(`Card ID: ${card.id} | Board: ${card.boardId} | Column: ${card.column}`);
  if (card.description) { s.push('', '## Description', card.description); }
  s.push('');

  if (comments && comments.length > 0) {
    s.push('# Conversation history');
    for (const c of comments) {
      const role = c.actorId === agentId ? 'You' :
                   knownAgentIds.has(c.actorId) ? `Agent (${c.actorId})` : `User (${c.actorId})`;
      const text = c.text.length > 500 ? c.text.slice(0, 500) + '...' : c.text;
      s.push(`### ${role} — ${c.createdAt}`, text, '');
    }
    s.push('Continue based on the latest message above.', '');
  }

  s.push('# Board MCP tools');
  s.push(`Use actorId "${agentId}" for all tool calls.`);
  s.push('- `add-comment` — post updates, ask questions, or @mention another agent');
  s.push('- `list-comments` — read discussion thread');
  s.push('- `move-card` — move card when done');
  s.push('- `list-cards` — check related work');
  s.push('');
  s.push('You can @mention other agents in comments (e.g. "@qa-engineer please review").');
  s.push(`They will be dispatched automatically. Budget: ${budget.get(card.id).budgetRemaining} agent-to-agent turns remaining.`);
  s.push('');
  s.push('## Output format');
  s.push('- **Status**: completed | partial | failed | needs_input');
  s.push('- **Summary**: What was accomplished');
  s.push('- **Question**: (if needs_input) Your specific question');
  s.push('- **Files changed**: List of files');

  return s.join('\n');
}

function buildReplyPrompt(card: BoardCard, agentId: string, agentName: string, comments: CardComment[], trigger: DispatchTrigger): string {
  const cfg = router.getAgent(agentId);
  const isOwner = card.assignee === agentId || budget.get(card.id).assignedAgent === agentId;
  const s: string[] = [];

  s.push('# Your role');
  s.push(`You are: ${agentName} (${agentId})`);
  if (cfg) s.push(`Role: ${cfg.role_type} | Scope: ${cfg.scope.join(', ')}`);
  s.push('');
  s.push(`# Card: ${card.title}`);
  s.push(`Card ID: ${card.id}`);
  if (card.description) s.push('', card.description);
  s.push('');

  if (isOwner) {
    s.push('# You are the card owner — new activity on your card');
    s.push('Someone commented on your card. Read the thread and decide the next step.');
    s.push('');
  } else {
    s.push('# You were @mentioned in this conversation');
    s.push('Read the thread and respond with your input.');
    s.push('');
  }

  for (const c of comments) {
    const role = c.actorId === agentId ? 'You' :
                 knownAgentIds.has(c.actorId) ? `Agent (${c.actorId})` : `User (${c.actorId})`;
    const text = c.text.length > 500 ? c.text.slice(0, 500) + '...' : c.text;
    s.push(`### ${role} — ${c.createdAt}`, text, '');
  }

  s.push('# Instructions');
  s.push(`Use \`add-comment\` with actorId "${agentId}" for all board tool calls.`);
  s.push(`Agent-to-agent budget: ${budget.get(card.id).budgetRemaining} turns remaining.`);
  s.push('');

  if (isOwner) {
    s.push('As the card owner, you should:');
    s.push('1. Read the latest comment(s)');
    s.push('2. Decide: continue work, ask a follow-up, @mention another agent, or finish');
    s.push('3. If the task is complete, use `move-card` to move it to "done"');
    s.push('4. If you need more input, post a comment (optionally @mention someone)');
    s.push('5. If there is more work to do, continue and update the card');
  } else {
    s.push('1. Read the conversation above');
    s.push('2. Post your response as a comment');
    s.push('3. You may @mention other agents if needed');
    s.push('4. Be concise and actionable');
  }

  return s.join('\n');
}

// ─── Output ───────────────────────────────────────────────

function saveOutput(card: BoardCard, agentId: string, output: string, durationMs: number): string {
  const dir = resolve(config.outputsDir, agentId);
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().split('T')[0];
  const slug = card.title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 50);
  const fp = resolve(dir, `${date}-${slug}.md`);
  writeFileSync(fp, `# ${card.title}\n\n| Agent | ${agentId} | Duration | ${(durationMs / 1000).toFixed(1)}s |\n|---|---|\n\n---\n\n${output}`, 'utf-8');
  return `${agentId}/${date}-${slug}.md`;
}

function extractSummary(output: string, maxLen: number): string {
  if (!output) return '_(no output)_';
  const m = output.match(/\*?\*?Summary\*?\*?:\s*([\s\S]*?)(?=\n\*?\*?(?:Files|Notes|Question)|$)/i);
  const text = m ? m[1].trim() : output;
  return text.length <= maxLen ? text : text.slice(0, maxLen) + '...';
}

// ─── Main ─────────────────────────────────────────────────

async function main() {
  console.log(`\n${CYAN}${'═'.repeat(60)}${R}`);
  console.log(`${CYAN}  🦞  Agent Daemon — full-system orchestrator${R}`);
  console.log(`${CYAN}${'═'.repeat(60)}${R}\n`);

  await initialize();

  logSystem(`Poll loop starting (every ${config.pollIntervalMs / 1000}s)...`);
  logSystem('Dispatch: assign → @mention → label → auto');
  logSystem(`Budget: ${config.agentTurnBudget} agent-to-agent turns/card, human comment = full reset`);
  console.log(`${D}  Press Ctrl+C to stop\n${R}`);

  await poll();
  const timer = setInterval(async () => {
    try { await poll(); } catch (err) { logError('Poll failed', { error: (err as Error).message }); }
  }, config.pollIntervalMs);

  process.on('SIGINT', async () => {
    console.log(`\n${ts()} 🦞 ${B}Shutting down...${R}`);
    clearInterval(timer);
    await board.disconnect();
    const bs = budget.stats();
    logSystem(`Stats: ${bs.totalCards} cards tracked, ${bs.totalTurns} agent turns, ${bs.pausedCards} paused`);
    process.exit(0);
  });
}

main().catch(err => { logError('Fatal', { error: err.message }); process.exit(1); });
