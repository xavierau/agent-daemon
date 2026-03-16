/**
 * 💬 Conversation Budget — per-card turn limiter for agent-to-agent talk
 *
 * Rules:
 *   - Each card has a budget of N agent-to-agent turns (default 20)
 *   - Agent @mentions agent = costs 1 turn per unique mentioned agent
 *   - Human comment on the card = full budget reset (free + reset)
 *   - Budget exhausted = daemon pauses agent dispatches, notifies human
 *   - Human → agent dispatch always costs 0
 *   - Agent self-@mention = filtered out (no cost, no dispatch)
 */

// ─── Types ────────────────────────────────────────────────

export interface ConversationTurn {
  actorId: string;
  isAgent: boolean;
  /** Which @mention triggered this dispatch (null = direct assign or human) */
  triggeredBy: string | null;
  /** Who was mentioned (the dispatched agent) */
  targetAgentId: string | null;
  timestamp: string;
}

export interface CardConversation {
  cardId: string;
  /** Remaining agent-to-agent turns */
  budgetRemaining: number;
  /** Total agent-to-agent turns used since last reset */
  agentTurnsUsed: number;
  /** Whether agent dispatches are paused on this card */
  paused: boolean;
  /** Audit trail of all dispatches */
  turns: ConversationTurn[];
  /** Last human interaction timestamp (for reset detection) */
  lastHumanCommentAt: string | null;
  /** Which agent is currently assigned to this card */
  assignedAgent: string | null;
}

// ─── Budget Manager ───────────────────────────────────────

const DEFAULT_BUDGET = 20;

export class ConversationBudget {
  private cards = new Map<string, CardConversation>();
  private readonly maxBudget: number;

  constructor(maxBudget = DEFAULT_BUDGET) {
    this.maxBudget = maxBudget;
  }

  /** Get or create conversation state for a card */
  get(cardId: string): CardConversation {
    if (!this.cards.has(cardId)) {
      this.cards.set(cardId, {
        cardId,
        budgetRemaining: this.maxBudget,
        agentTurnsUsed: 0,
        paused: false,
        turns: [],
        lastHumanCommentAt: null,
        assignedAgent: null,
      });
    }
    return this.cards.get(cardId)!;
  }

  /**
   * Record a human comment on a card.
   * Resets the budget to full. Always free.
   */
  recordHumanComment(cardId: string, actorId: string): void {
    const conv = this.get(cardId);
    const wasPaused = conv.paused;

    // Full reset
    conv.budgetRemaining = this.maxBudget;
    conv.agentTurnsUsed = 0;
    conv.paused = false;
    conv.lastHumanCommentAt = new Date().toISOString();

    conv.turns.push({
      actorId,
      isAgent: false,
      triggeredBy: null,
      targetAgentId: null,
      timestamp: new Date().toISOString(),
    });

    if (wasPaused) {
      // Signal that this card just unpaused
      return;
    }
  }

  /**
   * Check whether an agent-to-agent dispatch is allowed.
   * Returns { allowed, budgetRemaining, reason }.
   */
  canDispatchAgentToAgent(
    cardId: string,
    mentionCount = 1,
  ): { allowed: boolean; budgetRemaining: number; reason: string } {
    const conv = this.get(cardId);

    if (conv.paused) {
      return {
        allowed: false,
        budgetRemaining: 0,
        reason: `Card is paused — budget exhausted (${conv.agentTurnsUsed} agent turns used). Waiting for human input.`,
      };
    }

    if (conv.budgetRemaining < mentionCount) {
      return {
        allowed: false,
        budgetRemaining: conv.budgetRemaining,
        reason: `Budget too low: ${conv.budgetRemaining} remaining, need ${mentionCount}. Human input needed.`,
      };
    }

    return {
      allowed: true,
      budgetRemaining: conv.budgetRemaining,
      reason: `OK — ${conv.budgetRemaining} turns remaining`,
    };
  }

  /**
   * Burn budget for an agent-to-agent dispatch.
   * Call AFTER the dispatch is confirmed.
   * Returns the new budget state.
   */
  burnAgentTurn(
    cardId: string,
    fromAgentId: string,
    toAgentId: string,
  ): { budgetRemaining: number; paused: boolean } {
    const conv = this.get(cardId);

    conv.agentTurnsUsed++;
    conv.budgetRemaining = Math.max(0, conv.budgetRemaining - 1);

    conv.turns.push({
      actorId: fromAgentId,
      isAgent: true,
      triggeredBy: `@${toAgentId}`,
      targetAgentId: toAgentId,
      timestamp: new Date().toISOString(),
    });

    // Check if budget exhausted
    if (conv.budgetRemaining === 0) {
      conv.paused = true;
    }

    return {
      budgetRemaining: conv.budgetRemaining,
      paused: conv.paused,
    };
  }

  /**
   * Record a human-initiated dispatch (assign, direct task).
   * Always free — does not consume budget.
   */
  recordHumanDispatch(cardId: string, agentId: string): void {
    const conv = this.get(cardId);
    conv.assignedAgent = agentId;

    conv.turns.push({
      actorId: 'human',
      isAgent: false,
      triggeredBy: null,
      targetAgentId: agentId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Set the assigned agent for a card.
   */
  setAssignedAgent(cardId: string, agentId: string): void {
    this.get(cardId).assignedAgent = agentId;
  }

  /**
   * Check if a card is paused.
   */
  isPaused(cardId: string): boolean {
    return this.get(cardId).paused;
  }

  /**
   * Check if a card was just unpaused by a human comment.
   * (budgetRemaining === maxBudget && has turns)
   */
  wasRecentlyReset(cardId: string): boolean {
    const conv = this.get(cardId);
    return conv.budgetRemaining === this.maxBudget && conv.turns.length > 0;
  }

  /** Stats for logging */
  stats(): { totalCards: number; pausedCards: number; totalTurns: number } {
    let pausedCards = 0;
    let totalTurns = 0;
    for (const conv of this.cards.values()) {
      if (conv.paused) pausedCards++;
      totalTurns += conv.agentTurnsUsed;
    }
    return { totalCards: this.cards.size, pausedCards, totalTurns };
  }
}

// ─── @Mention Parser ──────────────────────────────────────

const MENTION_RE = /@([\w-]+)/g;

/**
 * Parse @mentions from comment text.
 * Returns unique agent IDs that were mentioned.
 * Filters out self-mentions and unknown agents.
 */
export function parseMentions(
  text: string,
  authorId: string,
  knownAgentIds: Set<string>,
): string[] {
  const mentions = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = MENTION_RE.exec(text)) !== null) {
    const mentioned = match[1];
    // Filter: no self-mention, must be known agent
    if (mentioned !== authorId && knownAgentIds.has(mentioned)) {
      mentions.add(mentioned);
    }
  }

  return [...mentions];
}
