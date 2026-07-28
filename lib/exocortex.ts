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

export type ExternalNotificationDelivery = 'wake' | 'inbox';

export interface ExternalNotificationSourceDefinition {
  id: string;
  label: string;
  description?: string;
}

export interface ExternalNotificationSource extends ExternalNotificationSourceDefinition {
  toolName: string;
  registeredAt: number;
}

export interface ExternalNotificationSubscription {
  id: string;
  toolName: string;
  sourceId: string;
  sourceLabel: string;
  sourceDescription?: string;
  convId: string;
  delivery: ExternalNotificationDelivery;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ExternalNotificationSubscriptionFilter {
  toolName?: string;
  sourceId?: string;
  convId?: string;
}

export type ExternalNotificationDeliveryStatus = 'started' | 'queued' | 'inbox' | 'duplicate' | 'failed';

export interface ExternalNotificationPublishDelivery {
  subscriptionId: string;
  convId: string;
  status: ExternalNotificationDeliveryStatus;
  message?: string;
}

export interface ExternalNotificationPublishResult {
  toolName: string;
  sourceId: string;
  eventId: string;
  deliveries: ExternalNotificationPublishDelivery[];
}

export interface ExocortexIpcCommand {
  type: string;
  reqId?: string;
}

export interface ExocortexIpcEvent {
  type: string;
  reqId?: string;
}

interface ExocortexErrorEvent extends ExocortexIpcEvent {
  type: 'error';
  message?: string;
}

interface ManageExternalToolDaemonCommand extends ExocortexIpcCommand {
  type: 'manage_external_tool_daemon';
  toolName: string;
  action: ExternalToolDaemonAction;
}

interface ExternalToolDaemonResultEvent extends ExocortexIpcEvent {
  type: 'external_tool_daemon_result';
  status: ExternalToolDaemonStatus;
}

interface RegisterExternalNotificationSourceCommand extends ExocortexIpcCommand {
  type: 'register_external_notification_source';
  toolName: string;
  source: ExternalNotificationSourceDefinition;
}

interface ExternalNotificationSourceEvent extends ExocortexIpcEvent {
  type: 'external_notification_source';
  source: ExternalNotificationSource;
}

interface ListExternalNotificationSubscriptionsCommand extends ExocortexIpcCommand, ExternalNotificationSubscriptionFilter {
  type: 'list_external_notification_subscriptions';
}

interface ExternalNotificationSubscriptionsEvent extends ExocortexIpcEvent {
  type: 'external_notification_subscriptions';
  subscriptions: ExternalNotificationSubscription[];
  removed?: number;
}

interface SubscribeExternalNotificationCommand extends ExocortexIpcCommand {
  type: 'subscribe_external_notification';
  toolName: string;
  sourceId: string;
  sourceLabel?: string;
  sourceDescription?: string;
  convId: string;
  delivery: ExternalNotificationDelivery;
}

interface ExternalNotificationSubscriptionEvent extends ExocortexIpcEvent {
  type: 'external_notification_subscription';
  subscription: ExternalNotificationSubscription;
}

interface UnsubscribeExternalNotificationCommand extends ExocortexIpcCommand, ExternalNotificationSubscriptionFilter {
  type: 'unsubscribe_external_notification';
  subscriptionId?: string;
}

interface PublishExternalNotificationCommand extends ExocortexIpcCommand {
  type: 'publish_external_notification';
  toolName: string;
  sourceId: string;
  eventId: string;
  text: string;
  occurredAt?: number;
  data?: Record<string, unknown>;
}

interface ExternalNotificationPublishResultEvent extends ExocortexIpcEvent, ExternalNotificationPublishResult {
  type: 'external_notification_publish_result';
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

let cachedExocortexSocketPath: string | undefined;

function exocortexSocketPath(): string {
  if (cachedExocortexSocketPath) return cachedExocortexSocketPath;
  const worktree = detectWorktreeName();
  cachedExocortexSocketPath = worktree
    ? path.join(CONFIG_ROOT, 'runtime', worktree, 'exocortexd.sock')
    : path.join(CONFIG_ROOT, 'runtime', 'exocortexd.sock');
  return cachedExocortexSocketPath;
}

export function isExocortexRunning(): boolean {
  return fs.existsSync(exocortexSocketPath());
}

/**
 * Send one typed NDJSON request to exocortexd and wait for its matching typed
 * response. Unrelated daemon events are ignored; matching error events reject.
 */
export async function sendExocortexIpcRequest<
  TCommand extends ExocortexIpcCommand,
  TEvent extends ExocortexIpcEvent,
>(
  command: TCommand,
  responseType: TEvent['type'],
  timeoutMs = 10_000,
  socketPathOverride?: string,
): Promise<TEvent> {
  const socketPath = socketPathOverride ?? exocortexSocketPath();
  if (!fs.existsSync(socketPath)) {
    throw new Error('exocortexd is not running. Start exocortexd and try again.');
  }

  const reqId = command.reqId ?? `${command.type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return new Promise<TEvent>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;

    const finish = (err?: Error, event?: TEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else if (event) resolve(event);
      else reject(new Error('No response from exocortexd'));
    };

    const timer = setTimeout(() => {
      finish(new Error(`Timed out after ${timeoutMs}ms waiting for exocortexd`));
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(JSON.stringify({ ...command, reqId }) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          try {
            const event = JSON.parse(line) as ExocortexIpcEvent & { message?: string };
            if (event.reqId === reqId && event.type === 'error') {
              finish(new Error((event as ExocortexErrorEvent).message ?? 'exocortexd returned an error'));
              return;
            }
            if (event.reqId === reqId && event.type === responseType) {
              finish(undefined, event as TEvent);
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

export async function manageExternalToolDaemon(
  toolName: string,
  action: ExternalToolDaemonAction,
  timeoutMs = 10_000,
): Promise<ExternalToolDaemonStatus> {
  const event = await sendExocortexIpcRequest<ManageExternalToolDaemonCommand, ExternalToolDaemonResultEvent>(
    { type: 'manage_external_tool_daemon', toolName, action },
    'external_tool_daemon_result',
    timeoutMs,
  );
  return event.status;
}

export async function registerExternalNotificationSource(
  toolName: string,
  source: ExternalNotificationSourceDefinition,
  timeoutMs = 10_000,
): Promise<ExternalNotificationSource> {
  const event = await sendExocortexIpcRequest<RegisterExternalNotificationSourceCommand, ExternalNotificationSourceEvent>(
    { type: 'register_external_notification_source', toolName, source },
    'external_notification_source',
    timeoutMs,
  );
  return event.source;
}

export async function listExternalNotificationSubscriptions(
  filter: ExternalNotificationSubscriptionFilter = {},
  timeoutMs = 10_000,
): Promise<ExternalNotificationSubscription[]> {
  const event = await sendExocortexIpcRequest<ListExternalNotificationSubscriptionsCommand, ExternalNotificationSubscriptionsEvent>(
    { type: 'list_external_notification_subscriptions', ...filter },
    'external_notification_subscriptions',
    timeoutMs,
  );
  return event.subscriptions;
}

export async function subscribeExternalNotification(
  input: Omit<SubscribeExternalNotificationCommand, 'type' | 'reqId'>,
  timeoutMs = 10_000,
): Promise<ExternalNotificationSubscription> {
  const event = await sendExocortexIpcRequest<SubscribeExternalNotificationCommand, ExternalNotificationSubscriptionEvent>(
    { type: 'subscribe_external_notification', ...input },
    'external_notification_subscription',
    timeoutMs,
  );
  return event.subscription;
}

export async function unsubscribeExternalNotification(
  input: Omit<UnsubscribeExternalNotificationCommand, 'type' | 'reqId'>,
  timeoutMs = 10_000,
): Promise<{ subscriptions: ExternalNotificationSubscription[]; removed: number }> {
  const event = await sendExocortexIpcRequest<UnsubscribeExternalNotificationCommand, ExternalNotificationSubscriptionsEvent>(
    { type: 'unsubscribe_external_notification', ...input },
    'external_notification_subscriptions',
    timeoutMs,
  );
  return { subscriptions: event.subscriptions, removed: event.removed ?? 0 };
}

export async function publishExternalNotification(
  input: Omit<PublishExternalNotificationCommand, 'type' | 'reqId'>,
  timeoutMs = 10_000,
): Promise<ExternalNotificationPublishResult> {
  const event = await sendExocortexIpcRequest<PublishExternalNotificationCommand, ExternalNotificationPublishResultEvent>(
    { type: 'publish_external_notification', ...input },
    'external_notification_publish_result',
    timeoutMs,
  );
  const { type: _type, reqId: _reqId, ...result } = event;
  return result;
}
