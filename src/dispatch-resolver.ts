/**
 * 🎯 Dispatch Resolver — unified task routing with 4 triggers
 *
 * Priority order:
 *   1. Explicit assign  — card.assignee is set → dispatch that agent
 *   2. @mention         — comment contains @agent-id → dispatch mentioned agent(s)
 *   3. Label routing    — card has labels → resolveAgent() by capability
 *   4. Auto-route       — extract capabilities from title + desc → best match
 *
 * Each dispatch goes through:
 *   - Board access check (is agent allowed on this board?)
 *   - RBAC check (can daemon delegate to this agent?)
 *   - Conversation budget check (agent-to-agent turns remaining?)
 */

import type { BoardCard, CardComment } from './board-client.js';
import type { AgentRouter, AgentResolution } from './agent-router.js';
import { ConversationBudget, parseMentions } from './conversation-budget.js';

// ─── Types ────────────────────────────────────────────────

export type DispatchTrigger = 'assign' | 'mention' | 'label' | 'auto' | 'reply';

export interface DispatchDecision {
  /** Should we dispatch? */
  dispatch: boolean;
  /** Which agent(s) to dispatch */
  agents: Array<{
    agentId: string;
    agentName: string;
    trigger: DispatchTrigger;
  }>;
  /** If not dispatching, why */
  reason?: string;
  /** Should the card move to "doing"? */
  moveCard: boolean;
  /** Is this a reply-only dispatch (agent just comments, no full execution)? */
  replyOnly: boolean;
  /** Conversation context to include in prompt */
  comments?: CardComment[];
}

// ─── Board Access (simple for now, extensible later) ──────

export interface BoardAccessConfig {
  /** Board ID → list of allowed agent IDs. undefined = all agents allowed */
  boardTeams: Map<string, Set<string> | 'all'>;
}

// ─── Dispatch Resolver ────────────────────────────────────

export class DispatchResolver {
  constructor(
    private readonly router: AgentRouter,
    private readonly budget: ConversationBudget,
    private readonly knownAgentIds: Set<string>,
    private readonly daemonActorId: string,
    private readonly boardAccess?: BoardAccessConfig,
  ) {}

  /**
   * Resolve what to do with a card in "todo" column (no comments yet).
   * Triggers: assign → label → auto
   */
  resolveNewTask(card: BoardCard): DispatchDecision {
    // Priority 1: Explicit assignee
    if (card.assignee && this.knownAgentIds.has(card.assignee)) {
      const access = this.checkBoardAccess(card.boardId, card.assignee);
      if (!access.allowed) {
        return { dispatch: false, agents: [], reason: access.reason, moveCard: false, replyOnly: false };
      }
      const agentConfig = this.router.getAgent(card.assignee);
      return {
        dispatch: true,
        agents: [{
          agentId: card.assignee,
          agentName: agentConfig?.display_name || card.assignee,
          trigger: 'assign',
        }],
        moveCard: true,
        replyOnly: false,
      };
    }

    // Priority 3: Label routing
    if (card.labels && card.labels.length > 0) {
      const caps = card.labels.map(l => l.label.toLowerCase());
      const candidates = this.router.resolveAgent(caps);
      if (candidates.length > 0) {
        const best = this.pickAccessible(card.boardId, candidates);
        if (best) {
          return {
            dispatch: true,
            agents: [{
              agentId: best.agent_id,
              agentName: best.display_name,
              trigger: 'label',
            }],
            moveCard: true,
            replyOnly: false,
          };
        }
      }
    }

    // Priority 4: Auto-route from title + description
    const capabilities = this.router.extractCapabilities({
      title: card.title,
      description: card.description || '',
      labels: card.labels,
    });

    if (capabilities.length > 0) {
      const candidates = this.router.resolveAgent(capabilities);
      if (candidates.length > 0) {
        const best = this.pickAccessible(card.boardId, candidates);
        if (best) {
          return {
            dispatch: true,
            agents: [{
              agentId: best.agent_id,
              agentName: best.display_name,
              trigger: 'auto',
            }],
            moveCard: true,
            replyOnly: false,
          };
        }
      }
    }

    return {
      dispatch: false,
      agents: [],
      reason: 'No assignee, no matching labels, no capabilities extracted',
      moveCard: false,
      replyOnly: false,
    };
  }

  /**
   * Resolve what to do when new comments are detected on any card.
   * Triggers: @mention (from human or agent) or user reply to agent question.
   */
  resolveComment(
    card: BoardCard,
    newComment: CardComment,
    allComments: CardComment[],
  ): DispatchDecision {
    const isHuman = !this.knownAgentIds.has(newComment.actorId);
    const isAgent = !isHuman;

    // ── Human comment: check for @mentions, or reply to assigned agent
    if (isHuman) {
      // Record human comment — resets budget
      this.budget.recordHumanComment(card.id, newComment.actorId);

      // Check for @mentions in human's comment
      const mentioned = parseMentions(newComment.text, newComment.actorId, this.knownAgentIds);
      if (mentioned.length > 0) {
        const agents = mentioned
          .filter(id => this.checkBoardAccess(card.boardId, id).allowed)
          .map(id => {
            const cfg = this.router.getAgent(id);
            return {
              agentId: id,
              agentName: cfg?.display_name || id,
              trigger: 'mention' as DispatchTrigger,
            };
          });

        if (agents.length > 0) {
          return {
            dispatch: true,
            agents,
            moveCard: false, // mention = respond in place
            replyOnly: true,
            comments: allComments,
          };
        }
      }

      // No @mention — is there an assigned agent who should respond?
      const conv = this.budget.get(card.id);
      const assignedAgent = card.assignee || conv.assignedAgent;
      if (assignedAgent && this.knownAgentIds.has(assignedAgent)) {
        const access = this.checkBoardAccess(card.boardId, assignedAgent);
        if (access.allowed) {
          const cfg = this.router.getAgent(assignedAgent);
          return {
            dispatch: true,
            agents: [{
              agentId: assignedAgent,
              agentName: cfg?.display_name || assignedAgent,
              trigger: 'reply',
            }],
            moveCard: false,
            replyOnly: false, // full execution — user replied to agent's question
            comments: allComments,
          };
        }
      }

      return { dispatch: false, agents: [], reason: 'Human comment, no agent to dispatch', moveCard: false, replyOnly: false };
    }

    // ── Agent comment: @mentions + card owner notification
    if (isAgent) {
      const mentioned = parseMentions(newComment.text, newComment.actorId, this.knownAgentIds);
      const agents: DispatchDecision['agents'] = [];

      // Dispatch @mentioned agents
      if (mentioned.length > 0) {
        const budgetCheck = this.budget.canDispatchAgentToAgent(card.id, mentioned.length);
        if (!budgetCheck.allowed) {
          return {
            dispatch: false, agents: [], reason: budgetCheck.reason,
            moveCard: false, replyOnly: false,
          };
        }

        for (const id of mentioned) {
          if (!this.checkBoardAccess(card.boardId, id).allowed) continue;
          this.budget.burnAgentTurn(card.id, newComment.actorId, id);
          const cfg = this.router.getAgent(id);
          agents.push({ agentId: id, agentName: cfg?.display_name || id, trigger: 'mention' });
        }
      }

      // Card owner notification: if someone else commented on a card,
      // the assigned agent (owner) should be dispatched to read it.
      // This ensures no comment is a dead letter.
      const conv = this.budget.get(card.id);
      const cardOwner = card.assignee || conv.assignedAgent;
      if (
        cardOwner &&
        cardOwner !== newComment.actorId &&  // not the owner's own comment
        !agents.some(a => a.agentId === cardOwner) &&  // not already dispatched via @mention
        this.knownAgentIds.has(cardOwner) &&
        this.checkBoardAccess(card.boardId, cardOwner).allowed
      ) {
        // Check budget for owner notify (costs 1 agent-to-agent turn)
        const ownerBudget = this.budget.canDispatchAgentToAgent(card.id, 1);
        if (ownerBudget.allowed) {
          this.budget.burnAgentTurn(card.id, newComment.actorId, cardOwner);
          const cfg = this.router.getAgent(cardOwner);
          agents.push({
            agentId: cardOwner,
            agentName: cfg?.display_name || cardOwner,
            trigger: 'reply',  // owner reading a reply on their card
          });
        }
      }

      if (agents.length > 0) {
        return {
          dispatch: true, agents, moveCard: false,
          replyOnly: true, comments: allComments,
        };
      }

      return { dispatch: false, agents: [], reason: 'No agents to dispatch (no @mentions, no card owner)', moveCard: false, replyOnly: false };
    }

    return { dispatch: false, agents: [], reason: 'Unknown comment type', moveCard: false, replyOnly: false };
  }

  // ─── Board Access Check ─────────────────────────────────

  private checkBoardAccess(
    boardId: string,
    agentId: string,
  ): { allowed: boolean; reason: string } {
    if (!this.boardAccess) {
      return { allowed: true, reason: 'No board access config — all agents allowed' };
    }

    const team = this.boardAccess.boardTeams.get(boardId)
      ?? this.boardAccess.boardTeams.get('_default')
      ?? 'all';

    if (team === 'all') {
      return { allowed: true, reason: 'Board is public' };
    }

    if (team.has(agentId)) {
      return { allowed: true, reason: `Agent is in board team` };
    }

    return { allowed: false, reason: `Agent "${agentId}" is not in board team` };
  }

  // ─── Helper ─────────────────────────────────────────────

  private pickAccessible(
    boardId: string,
    candidates: AgentResolution[],
  ): AgentResolution | null {
    for (const c of candidates) {
      if (this.checkBoardAccess(boardId, c.agent_id).allowed) {
        return c;
      }
    }
    return null;
  }
}
