import { execFileSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PROJECT_ROOT, '../..');
const CONFIG_ROOT = process.env.EXOCORTEX_CONFIG_DIR?.trim()
  ? path.resolve(process.env.EXOCORTEX_CONFIG_DIR)
  : path.join(REPO_ROOT, 'config');

export type ExternalToolDaemonAction = 'start' | 'stop' | 'restart' | 'status';

export interface ExternalToolDaemonStatus {
  toolName: string;
  action: ExternalToolDaemonAction;
  configured: boolean;
  managed: boolean;
  running: boolean;
  pid: number | null;
  restartPolicy: 'on-failure' | 'always' | 'never' | null;
  message: string;
}

function detectWorktreeName(): string | null {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.resolve(REPO_ROOT, gitDir) !== path.resolve(REPO_ROOT, gitCommonDir)
      ? path.basename(gitDir)
      : null;
  } catch {
    return null;
  }
}

function exocortexSocketPath(): string {
  const worktree = detectWorktreeName();
  return worktree
    ? path.join(CONFIG_ROOT, 'runtime', worktree, 'exocortexd.sock')
    : path.join(CONFIG_ROOT, 'runtime', 'exocortexd.sock');
}

export function isExocortexRunning(): boolean {
  return fs.existsSync(exocortexSocketPath());
}

export async function manageExternalToolDaemon(toolName: string, action: ExternalToolDaemonAction, timeoutMs = 10_000): Promise<ExternalToolDaemonStatus> {
  const socketPath = exocortexSocketPath();
  if (!fs.existsSync(socketPath)) {
    throw new Error('exocortexd is not running. Start exocortexd to manage supervised tool daemons.');
  }

  const reqId = `tool_daemon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return new Promise<ExternalToolDaemonStatus>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;

    const finish = (err?: Error, status?: ExternalToolDaemonStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else if (status) resolve(status);
      else reject(new Error('No response from exocortexd'));
    };

    const timer = setTimeout(() => {
      finish(new Error(`Timed out after ${timeoutMs}ms waiting for exocortexd`));
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(JSON.stringify({
        type: 'manage_external_tool_daemon',
        reqId,
        toolName,
        action,
      }) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          try {
            const event = JSON.parse(line) as {
              type?: string;
              reqId?: string;
              message?: string;
              status?: ExternalToolDaemonStatus;
            };
            if (event.type === 'error' && event.reqId === reqId) {
              finish(new Error(event.message ?? 'exocortexd returned an error'));
              return;
            }
            if (event.type === 'external_tool_daemon_result' && event.reqId === reqId && event.status) {
              finish(undefined, event.status);
              return;
            }
          } catch (err) {
            finish(err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
        newlineIdx = buffer.indexOf('\n');
      }
    });

    socket.on('error', (err) => finish(err));
    socket.on('close', () => {
      if (!settled) finish(new Error('Connection closed before exocortexd replied'));
    });
  });
}
