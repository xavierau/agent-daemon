/**
 * 📋 Board Client — MCP client wrapper for agent-board
 *
 * Spawns the agent-board MCP server as a child process,
 * connects via StdioClientTransport, and provides typed methods
 * for board operations.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ─── Types ────────────────────────────────────────────────

export interface BoardCard {
  id: string;
  title: string;
  description: string;
  column: string;
  position: number;
  boardId: string;
  labels?: Array<{ label: string; color: string }>;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface BoardInfo {
  id: string;
  name: string;
  columns: string[];
}

export interface CardComment {
  id: string;
  cardId: string;
  text: string;
  actorId: string;
  parentCommentId?: string;
  createdAt: string;
}

// ─── Board Client ─────────────────────────────────────────

export class BoardClient {
  private client: Client;
  private transport: StdioClientTransport | null = null;
  private connected = false;

  constructor() {
    this.client = new Client({ name: 'agent-daemon', version: '0.1.0' });
  }

  /** Spawn the agent-board MCP server and connect */
  async connect(serverScript: string): Promise<void> {
    this.transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', serverScript],
    });

    await this.client.connect(this.transport);
    this.connected = true;

    // Verify connection by listing tools
    const { tools } = await this.client.listTools();
    const toolNames = tools.map(t => t.name);
    console.error(`Board MCP connected (${tools.length} tools: ${toolNames.join(', ')})`);
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  // ─── Board operations ───────────────────────────────────

  async listBoards(): Promise<BoardInfo[]> {
    const result = await this.callTool('list-boards', {});
    return this.parseResult(result);
  }

  async createBoard(name: string, actorId: string, columns?: string[]): Promise<BoardInfo> {
    const result = await this.callTool('create-board', { name, actorId, columns });
    return this.parseResult(result);
  }

  // ─── Card operations ────────────────────────────────────

  async listCards(opts: { column?: string; boardId?: string } = {}): Promise<BoardCard[]> {
    const result = await this.callTool('list-cards', opts);
    return this.parseResult(result);
  }

  async createCard(
    boardId: string, title: string, actorId: string,
    opts: { description?: string; column?: string } = {},
  ): Promise<BoardCard> {
    const result = await this.callTool('create-card', {
      boardId, title, actorId,
      description: opts.description ?? '',
      column: opts.column ?? 'todo',
    });
    return this.parseResult(result);
  }

  async moveCard(cardId: string, toColumn: string, actorId: string): Promise<unknown> {
    const result = await this.callTool('move-card', { cardId, toColumn, actorId });
    return this.parseResult(result);
  }

  async updateCard(cardId: string, actorId: string, updates: { title?: string; description?: string }): Promise<unknown> {
    const result = await this.callTool('update-card', { cardId, actorId, ...updates });
    return this.parseResult(result);
  }

  async archiveCard(cardId: string, actorId: string): Promise<unknown> {
    const result = await this.callTool('archive-card', { cardId, actorId });
    return this.parseResult(result);
  }

  // ─── Label operations ───────────────────────────────────

  async addLabel(cardId: string, label: string, actorId: string, color = '#888888'): Promise<unknown> {
    const result = await this.callTool('add-label', { cardId, label, color, actorId });
    return this.parseResult(result);
  }

  async removeLabel(cardId: string, label: string, actorId: string): Promise<unknown> {
    const result = await this.callTool('remove-label', { cardId, label, actorId });
    return this.parseResult(result);
  }

  // ─── Comment operations ─────────────────────────────────

  async addComment(cardId: string, text: string, actorId: string, parentCommentId?: string): Promise<unknown> {
    const args: Record<string, unknown> = { cardId, text, actorId };
    if (parentCommentId) args.parentCommentId = parentCommentId;
    const result = await this.callTool('add-comment', args);
    return this.parseResult(result);
  }

  async listComments(cardId: string): Promise<CardComment[]> {
    const result = await this.callTool('list-comments', { cardId });
    return this.parseResult(result);
  }

  // ─── Agent operations ───────────────────────────────────

  async listAgents(): Promise<Array<{ id: string; display_name: string; role_type: string; email: string }>> {
    const result = await this.callTool('list-agents', {});
    return this.parseResult(result);
  }

  // ─── Internal ───────────────────────────────────────────

  private async callTool(name: string, args: Record<string, unknown>) {
    if (!this.connected) throw new Error('Board client not connected');
    return this.client.callTool({ name, arguments: args });
  }

  private parseResult<T>(result: unknown): T {
    const r = result as { content?: Array<{ type: string; text?: string }> };
    const textBlock = r.content?.find(c => c.type === 'text');
    if (!textBlock?.text) return [] as unknown as T;
    try {
      return JSON.parse(textBlock.text) as T;
    } catch {
      return textBlock.text as unknown as T;
    }
  }

  /** Get the MCP server script path for agent .mcp.json config */
  getMcpConfig(serverScript: string): object {
    return {
      mcpServers: {
        kanban: {
          type: 'stdio',
          command: 'npx',
          args: ['tsx', serverScript],
        },
      },
    };
  }
}
