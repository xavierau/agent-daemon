/**
 * 🧭 Agent Router — wraps agent-org OrchestratorFacade
 *
 * Provides capability-based agent routing + RBAC enforcement
 * for the daemon's task assignment pipeline.
 */

// agent-org is a TypeScript package — import via path for reliability
const AGENT_ORG_SRC = process.env.AGENT_ORG_SRC || '../agent-org/src';

// Dynamic import at init time (see createRouter below)
let OrchestratorFacade: any;

export async function loadAgentOrg(): Promise<void> {
  try {
    // Try npm package first
    const mod = await import('agent-org');
    OrchestratorFacade = mod.OrchestratorFacade;
  } catch {
    // Fallback: import from local source path
    const mod = await import(`${AGENT_ORG_SRC}/index.js`);
    OrchestratorFacade = mod.OrchestratorFacade;
  }
}

// Re-export types manually
export interface AgentResolution {
  agent_id: string;
  display_name: string;
  email: string;
  confidence: 'exact' | 'capability_match' | 'scope_match';
}

export interface TaskAssignment {
  success: boolean;
  assigned_to: string;
  assigned_by: string;
  task: string;
  message: string;
}

export interface ActionRequest {
  allowed: boolean;
  action: string;
  agent: string;
  message: string;
  escalated_to?: string | 'human';
}

// ─── Types ────────────────────────────────────────────────

export interface RouteResult {
  agent: AgentResolution;
  assignment: TaskAssignment;
}

// ─── Agent Router ─────────────────────────────────────────

export class AgentRouter {
  private readonly orch: OrchestratorFacade;
  private readonly daemonActorId: string;

  constructor(orgConfigPath: string, daemonActorId: string) {
    this.orch = new OrchestratorFacade({
      orgConfigPath,
      auditBackend: 'memory',
      auditEnabled: true,
    });
    this.daemonActorId = daemonActorId;
  }

  /**
   * Find the best agent for a task based on labels/capabilities.
   * Returns ranked candidates.
   */
  resolveAgent(capabilities: string[]): AgentResolution[] {
    return this.orch.resolveAgent(capabilities);
  }

  /**
   * Assign a task from the daemon (acting as EM) to a resolved agent.
   * Validates delegation chain via RBAC.
   */
  async assignTask(toAgent: string, taskDescription: string): Promise<TaskAssignment> {
    return this.orch.assignTask(this.daemonActorId, toAgent, taskDescription);
  }

  /**
   * Check if an agent can perform an action (e.g., deploy, merge).
   */
  async requestAction(agentId: string, action: string): Promise<ActionRequest> {
    return this.orch.requestAction(agentId, action);
  }

  /**
   * Check gates for an action.
   */
  async checkGates(action: string, approvals: string[]): Promise<{ passed: boolean; missing: string[] }> {
    return this.orch.checkGates(action, approvals);
  }

  /**
   * Get agent details.
   */
  getAgent(agentId: string) {
    return this.orch.getAgent(agentId);
  }

  /**
   * Get the org tree.
   */
  getOrgTree() {
    return this.orch.getOrgTree();
  }

  /**
   * Extract capability hints from a card.
   * Parses labels and description keywords to build a capabilities array
   * that can be passed to resolveAgent().
   */
  extractCapabilities(card: {
    title: string;
    description: string;
    labels?: Array<{ label: string }>;
  }): string[] {
    const caps: string[] = [];

    // From labels
    if (card.labels) {
      for (const l of card.labels) {
        caps.push(l.label.toLowerCase());
      }
    }

    // From title + description keywords
    const text = `${card.title} ${card.description}`.toLowerCase();
    const keywordMap: Record<string, string[]> = {
      laravel: ['laravel'],
      api: ['api_design', 'api_development'],
      database: ['database', 'database_design'],
      frontend: ['react', 'vue', 'css', 'component_design'],
      backend: ['api_development', 'service_logic'],
      test: ['test_automation', 'regression_analysis'],
      deploy: ['deployment_automation', 'ci_cd_pipelines'],
      docker: ['docker', 'container_management'],
      infrastructure: ['infrastructure_design'],
      review: ['technical_review', 'code_review_oversight'],
    };

    for (const [keyword, capabilities] of Object.entries(keywordMap)) {
      if (text.includes(keyword)) {
        caps.push(...capabilities);
      }
    }

    return [...new Set(caps)];
  }
}
