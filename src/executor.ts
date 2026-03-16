/**
 * 🤖 Executor — spawns Claude Code agents with board MCP access
 *
 * Key architectural change from POC: agents get MCP access to the board
 * so they can move cards, post comments, and check other agents' work directly.
 */

import { spawn } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

// ─── Types ────────────────────────────────────────────────

export interface ExecConfig {
  model: string;
  maxTurns: number;
  cwd: string;
  /** Path to .mcp.json for this agent run */
  mcpConfigPath?: string;
}

export interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

// ─── MCP Config Builder ──────────────────────────────────

/**
 * Write a temporary .mcp.json so Claude Code can access the board.
 * Agent uses MCP tools: create-card, move-card, add-comment, list-cards, etc.
 */
export function writeMcpConfig(
  boardServerScript: string,
  outputPath: string,
): string {
  const config = {
    mcpServers: {
      kanban: {
        type: 'stdio',
        command: 'npx',
        args: ['tsx', boardServerScript],
        env: {},
      },
    },
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(config, null, 2));
  return outputPath;
}

// ─── Claude Code Executor ────────────────────────────────

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';

export function runClaude(
  prompt: string,
  config: ExecConfig,
  log: (msg: string) => void,
): Promise<ExecResult> {
  return new Promise((res) => {
    const args = [
      '--print',
      '--model', config.model,
      '--max-turns', String(config.maxTurns),
      '-', // read from stdin
    ];

    // If MCP config exists, tell Claude Code to use it
    if (config.mcpConfigPath) {
      args.push('--mcp-config', config.mcpConfigPath);
    }

    log(`CLI: claude ${args.slice(0, -1).join(' ')} (cwd: ${config.cwd})`);

    const proc = spawn('claude', args, {
      cwd: config.cwd,
      timeout: 300_000,
    });

    // Pass prompt via stdin (Claude Code v2.1.x requires this)
    proc.stdin.write(prompt);
    proc.stdin.end();

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let lastLine = '';
    let totalBytes = 0;
    const startTime = Date.now();

    // Heartbeat
    const heartbeat = setInterval(() => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      log(`⏳ ${elapsed}s elapsed, ${(totalBytes / 1024).toFixed(1)}KB output`);
    }, 15_000);

    // Stream stdout
    proc.stdout.on('data', (d: Buffer) => {
      chunks.push(d);
      totalBytes += d.length;
      const lines = d.toString('utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        lastLine = line;
        console.log(`${DIM}  │ ${RESET}${line.slice(0, 120)}`);
      }
    });

    // Stream stderr
    proc.stderr.on('data', (d: Buffer) => {
      errChunks.push(d);
      const text = d.toString('utf-8').trim();
      if (text) console.log(`${DIM}  ${RED}│ ${RESET}${text.slice(0, 120)}`);
    });

    proc.on('close', (code) => {
      clearInterval(heartbeat);
      const durationMs = Date.now() - startTime;
      log(`Exited (code ${code}) after ${(durationMs / 1000).toFixed(1)}s, ${(totalBytes / 1024).toFixed(1)}KB`);
      res({
        success: code === 0,
        output: Buffer.concat(chunks).toString('utf-8'),
        error: Buffer.concat(errChunks).toString('utf-8') || undefined,
        durationMs,
      });
    });

    proc.on('error', (err) => {
      clearInterval(heartbeat);
      res({ success: false, output: '', error: err.message, durationMs: Date.now() - startTime });
    });
  });
}
