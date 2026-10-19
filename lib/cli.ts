/**
 * WhatsApp CLI — command dispatcher for daemon and IPC commands.
 *
 * Called from bin/whatsapp as: tsx lib/cli.ts [--json] <cmd> [args...]
 * Login/logout/help are handled in the bash wrapper.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { IpcOutcomeUnknownError, sendCommand, isDaemonRunning } from './client.js';
import { generateOutgoingMessageId } from './message-id.js';
import { AUTH_DIR, LOG_FILE } from './paths.js';
import { acquireSessionLock, SessionLockedError } from './session-lock.js';
import {
  listExternalNotificationSubscriptions,
  manageExternalToolDaemon,
  subscribeExternalNotification,
  unsubscribeExternalNotification,
  type ExternalNotificationSubscription,
} from './exocortex.js';
import { INCOMING_MESSAGES_SOURCE, OWNER_AI_COMMANDS_SOURCE, WHATSAPP_TOOL_NAME } from './notifications.js';
import { CONNECTION_HEALTH_SOURCE } from './health.js';

const NOTIFY_SOURCES = {
  messages: INCOMING_MESSAGES_SOURCE,
  health: CONNECTION_HEALTH_SOURCE,
  'owner-ai': OWNER_AI_COMMANDS_SOURCE,
} as const;

function notifySource(args: string[]): (typeof NOTIFY_SOURCES)[keyof typeof NOTIFY_SOURCES] {
  const name = optionValue(args, ['--source']) ?? 'messages';
  const source = NOTIFY_SOURCES[name as keyof typeof NOTIFY_SOURCES];
  if (!source) die(`--source must be one of: ${Object.keys(NOTIFY_SOURCES).join(', ')}`);
  return source;
}
import {
  PayloadUsageError,
  decodeExactUtf8,
  parseSendStructure,
  readStdinBytes,
} from './payload.js';
import {
  formatChats,
  formatMessages,
  formatContacts,
  formatGroupInfo,
  formatStatus,
  formatJson,
  formatSearchResults,
  formatAliases,
  formatContext,
  type ResolvedChatSummary,
} from './format.js';
import type { StoredMessage, StoredChat, StoredContact, Alias, DaemonStatus, GroupInfo } from './types.js';

// ─── Helpers ───────────────────────────────────────────────

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function requireDaemon(): void {
  if (!isDaemonRunning()) {
    die('Daemon not running. Start with: whatsapp daemon start');
  }
}

const jsonMode = process.argv.includes('--json');

function output(data: unknown, formatter: (data: unknown) => string): void {
  if (jsonMode) {
    console.log(formatJson(data));
  } else {
    console.log(formatter(data));
  }
}

function parseLimit(args: string[], fallback = 50): number {
  const nIdx = args.indexOf('-n');
  if (nIdx !== -1 && args[nIdx + 1]) {
    return parseInt(args[nIdx + 1]) || fallback;
  }
  return fallback;
}

function optionValue(args: string[], names: string[]): string | undefined {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index !== -1) {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) die(`Missing value after ${name}`);
      return value;
    }
  }
  return undefined;
}

function positionalValues(args: string[], start: number, optionsWithValues: string[]): string[] {
  const values: string[] = [];
  for (let i = start; i < args.length; i++) {
    const arg = args[i];
    if (optionsWithValues.includes(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) die(`Unknown option: ${arg}`);
    values.push(arg);
  }
  return values;
}

function formatNotificationSubscriptions(subscriptions: ExternalNotificationSubscription[]): string {
  if (subscriptions.length === 0) return 'No WhatsApp notification subscriptions.';
  return subscriptions.map(subscription => [
    `${subscription.sourceLabel} → ${subscription.convId}`,
    `  delivery: ${subscription.delivery}  ${subscription.enabled ? 'enabled' : 'disabled'}`,
    `  id: ${subscription.id}`,
  ].join('\n')).join('\n\n');
}

// ─── Commands ──────────────────────────────────────────────

async function cmdDaemon(args: string[]): Promise<void> {
  const subcmd = args[0];

  switch (subcmd) {
    case 'start': {
      const status = await manageExternalToolDaemon('whatsapp', 'start');
      console.log(status.message);
      break;
    }

    case 'stop': {
      const status = await manageExternalToolDaemon('whatsapp', 'stop');
      console.log(status.message);
      break;
    }

    case 'restart': {
      const status = await manageExternalToolDaemon('whatsapp', 'restart');
      console.log(status.message);
      break;
    }

    case 'status': {
      if (!isDaemonRunning()) {
        console.log('Daemon not running');
        return;
      }
      const status = await sendCommand('status') as DaemonStatus;
      output(status, (d) => formatStatus(d as DaemonStatus));
      break;
    }

    case 'log':
    case 'logs': {
      const logFile = LOG_FILE;
      if (!fs.existsSync(logFile)) {
        console.log('No log file found');
        return;
      }
      if (args.includes('-f')) {
        const child = spawn('tail', ['-f', logFile], { stdio: 'inherit' });
        child.on('exit', (code) => process.exit(code || 0));
      } else {
        // Read only the tail; the log can be tens of megabytes.
        const fd = fs.openSync(logFile, 'r');
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, 64 * 1024);
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, size - length);
        fs.closeSync(fd);
        const allLines = buf.toString('utf-8').trim().split('\n');
        console.log(allLines.slice(-30).join('\n'));
      }
      break;
    }

    default:
      die(`Unknown daemon command: ${subcmd}\nUsage: whatsapp daemon start|stop|restart|status|logs`);
  }
}

async function cmdLogout(args: string[]): Promise<void> {
  const usage = [
    'usage: whatsapp logout --yes',
    '',
    'Unlinks this machine from the WhatsApp account (it disappears from the',
    "phone's Linked Devices) and deletes the local credentials. Message history",
    'stays. Getting WhatsApp back requires `whatsapp login` and a QR scan by the',
    'phone owner. A session conflict does NOT need this: run',
    '`whatsapp daemon restart` instead.',
  ].join('\n');
  if (args.includes('-h') || args.includes('--help')) {
    console.log(usage);
    return;
  }
  if (!args.includes('--yes')) die(`Refusing to log out without --yes.\n\n${usage}`);

  if (isDaemonRunning()) {
    const result = await sendCommand('logout', undefined, 60_000) as { unlinked: boolean };
    console.log(result.unlinked
      ? 'Logged out: device unlinked from the account and local credentials deleted.'
      : 'Local credentials deleted. WhatsApp was not reachable, so the device may still be listed under Linked Devices on the phone.');
    return;
  }

  let release: () => void;
  try {
    release = acquireSessionLock('whatsapp logout');
  } catch (err) {
    if (err instanceof SessionLockedError) die(`${err.message} Stop it first.`);
    throw err;
  }
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  release();
  console.log('Local credentials deleted (daemon not running, so the device may still be listed under Linked Devices on the phone).');
}

async function cmdChats(_args: string[]): Promise<void> {
  requireDaemon();
  const chats = await sendCommand('chats') as StoredChat[];
  output(chats, (d) => formatChats(d as StoredChat[]));
}

async function cmdGroups(_args: string[]): Promise<void> {
  requireDaemon();
  const groups = await sendCommand('groups') as StoredChat[];
  output(groups, (d) => formatChats(d as StoredChat[]));
}

async function cmdContacts(_args: string[]): Promise<void> {
  requireDaemon();
  const contacts = await sendCommand('contacts') as StoredContact[];
  output(contacts, (d) => formatContacts(d as StoredContact[]));
}

async function cmdMessages(args: string[]): Promise<void> {
  requireDaemon();
  const target = args[0];
  if (!target) die('Usage: whatsapp messages <name_or_jid> [-n count]');

  const result = await sendCommand('messages', { target, limit: parseLimit(args) }) as {
    chat: ResolvedChatSummary;
    messages: StoredMessage[];
  };
  output(result, () => formatMessages(result.messages, result.chat));
}

async function cmdSearch(args: string[]): Promise<void> {
  requireDaemon();
  // Collect non-flag args as the query
  const queryParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n') { i++; continue; } // skip -n and its value
    queryParts.push(args[i]);
  }
  const query = queryParts.join(' ');
  if (!query) die('Usage: whatsapp search "query"');

  const results = await sendCommand('search', { query, limit: parseLimit(args) }) as StoredMessage[];

  if (jsonMode) {
    console.log(formatJson(results));
  } else {
    // Build a JID→name map from all chats so search results show names
    const chats = await sendCommand('chats') as StoredChat[];
    const chatNames: Record<string, string> = {};
    for (const c of chats) {
      if (c.name) chatNames[c.jid] = c.name;
    }
    console.log(formatSearchResults(results, chatNames));
  }
}

/** Exit code for "the send may or may not have happened". */
const EXIT_OUTCOME_UNKNOWN = 75;
const TEXT_SEND_TIMEOUT_MS = Number(process.env.WHATSAPP_CLI_SEND_TIMEOUT_MS) || 120_000;
const FILE_SEND_TIMEOUT_MS = Number(process.env.WHATSAPP_CLI_SEND_TIMEOUT_MS) || 600_000;

interface SendResult {
  status: string;
  id: string;
  jid: string;
  duplicate: boolean;
  error?: string;
  chat: ResolvedChatSummary;
}

function outcomeUnknown(messageId: string, target: string, reason: string): never {
  console.error([
    `OUTCOME UNKNOWN: ${reason}.`,
    `The message (ID ${messageId}) may or may not have been sent to ${target}.`,
    `Do not resend blindly. Check first: whatsapp outbox ${messageId}   (or: whatsapp messages ${JSON.stringify(target)})`,
    `To retry safely, repeat the same command with --id ${messageId}; it will not send a second copy if the first one went out.`,
  ].join('\n'));
  process.exit(EXIT_OUTCOME_UNKNOWN);
}

function reportSend(result: SendResult, kind: 'message' | 'file', target: string): void {
  if (jsonMode) {
    console.log(formatJson(result));
  } else {
    const who = `${result.chat.name} <${result.chat.jid}> (matched by ${result.chat.match})`;
    const confirmed = ['server_ack', 'delivered', 'read'].includes(result.status);
    if (result.duplicate && result.status !== 'sending') {
      console.log(`Already sent earlier with ID ${result.id} to ${who} (status: ${result.status}); not sent again.`);
    } else if (confirmed) {
      console.log(`Sent ${kind} to ${who}; WhatsApp server confirmed. ID: ${result.id}`);
    } else if (result.status === 'written') {
      console.log(`Sent ${kind} to ${who}; written to the WhatsApp connection, server confirmation still pending. ID: ${result.id} (check: whatsapp outbox ${result.id})`);
    }
  }
  if (result.status === 'sending') {
    outcomeUnknown(result.id, target, 'a send with this ID is still in progress');
  }
}

async function cmdSend(args: string[]): Promise<void> {
  const help = [
    'usage:',
    '  whatsapp send <target> [--reply <message_id>] [--id <message_id>]',
    '  whatsapp send <target> --file <path> [--id <message_id>]',
    '',
    'Message text is required as exact UTF-8 on stdin.',
    'With --file, stdin is the optional exact caption; empty stdin sends no caption.',
    'Inline text and --caption are not accepted.',
    '',
    'Every send gets a message ID before it leaves the CLI. If the outcome is',
    `unknown (exit code ${EXIT_OUTCOME_UNKNOWN}), check \`whatsapp outbox <id>\` and retry only with`,
    '--id <id>, which never sends a second copy of a message that went out.',
    'Exit codes: 0 sent, 1 not sent, 2 usage error, 75 outcome unknown.',
  ].join('\n');
  if (args.includes('-h') || args.includes('--help')) {
    console.log(help);
    return;
  }

  const structure = parseSendStructure(args);
  const stdin = await readStdinBytes();
  const messageId = structure.messageId ?? generateOutgoingMessageId();

  if (structure.file) {
    const caption = decodeExactUtf8(stdin, 'file caption', { required: false });
    requireDaemon();
    let result: SendResult;
    try {
      result = await sendCommand('send_file', {
        target: structure.target,
        file: path.resolve(structure.file),
        message_id: messageId,
        ...(caption !== undefined ? { caption } : {}),
      }, FILE_SEND_TIMEOUT_MS) as SendResult;
    } catch (err) {
      if (err instanceof IpcOutcomeUnknownError) outcomeUnknown(messageId, structure.target, err.message);
      throw err;
    }
    reportSend(result, 'file', structure.target);
    return;
  }

  const text = decodeExactUtf8(stdin, 'message text')!;
  requireDaemon();
  let result: SendResult;
  try {
    result = await sendCommand('send', {
      target: structure.target,
      text,
      reply_to: structure.replyTo,
      message_id: messageId,
    }, TEXT_SEND_TIMEOUT_MS) as SendResult;
  } catch (err) {
    if (err instanceof IpcOutcomeUnknownError) outcomeUnknown(messageId, structure.target, err.message);
    throw err;
  }
  reportSend(result, 'message', structure.target);
}

interface OutboxRow {
  id: string;
  chat_jid: string;
  name: string;
  kind: string;
  state: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const OUTBOX_STATE_TEXT: Record<string, string> = {
  sending: 'being sent right now',
  written: 'written to the WhatsApp connection; no server confirmation yet',
  server_ack: 'sent (WhatsApp server confirmed)',
  delivered: 'sent and delivered to the recipient',
  read: 'sent, delivered and read',
  failed: 'NOT sent',
  unknown: 'outcome unknown (the daemon stopped mid-send); check the chat before retrying',
};

function formatOutboxRow(row: OutboxRow): string {
  const error = row.error ? ` — ${row.error}` : '';
  return `${row.id}  ${row.kind} to ${row.name} <${row.chat_jid}>  ${row.created_at}\n  ${OUTBOX_STATE_TEXT[row.state] ?? row.state}${error}`;
}

async function cmdOutbox(args: string[]): Promise<void> {
  if (args.includes('-h') || args.includes('--help')) {
    console.log('usage: whatsapp outbox [message_id] [-n count]\n\nShows what happened to messages sent through this CLI.');
    return;
  }
  requireDaemon();
  const id = args.find((arg, index) => !arg.startsWith('-') && args[index - 1] !== '-n');
  if (id) {
    const row = await sendCommand('outbox', { id }) as OutboxRow;
    output(row, () => formatOutboxRow(row));
    return;
  }
  const rows = await sendCommand('outbox', { limit: parseLimit(args, 20) }) as OutboxRow[];
  output(rows, () => rows.length === 0 ? 'No outgoing messages recorded.' : rows.map(formatOutboxRow).join('\n\n'));
}

async function cmdMedia(args: string[]): Promise<void> {
  requireDaemon();
  const subcmd = args[0];

  switch (subcmd) {
    case 'download': {
      const messageId = args[1];
      const outDir = args[2];
      if (!messageId || !outDir) {
        die('Usage: whatsapp media download <message_id> <outdir>');
      }

      const result = await sendCommand('download_media', {
        message_id: messageId,
        outdir: path.resolve(outDir),
      }) as {
        message_id: string;
        path: string;
        file_name: string;
        size_bytes: number;
      };

      if (jsonMode) {
        console.log(formatJson(result));
      } else {
        console.log(`Downloaded. Path: ${result.path}`);
      }
      break;
    }

    default:
      die(`Unknown media command: ${subcmd}\nUsage: whatsapp media download <message_id> <outdir>`);
  }
}

async function cmdTyping(args: string[]): Promise<void> {
  requireDaemon();
  const target = args[0];
  const state = args[1];
  if (!target || !state) die('Usage: whatsapp typing <name_or_jid> on|off');

  await sendCommand('typing', { target, on: state === 'on' });
  console.log(`Typing ${state} for ${target}`);
}

async function cmdRead(args: string[]): Promise<void> {
  requireDaemon();
  const target = args[0];
  if (!target) die('Usage: whatsapp read <name_or_jid>');

  await sendCommand('mark_read', { target });
  console.log(`Marked ${target} as read`);
}

async function cmdInfo(args: string[]): Promise<void> {
  requireDaemon();
  const target = args[0];
  if (!target) die('Usage: whatsapp info <name_or_jid>');

  const info = await sendCommand('group_info', { target }) as GroupInfo;
  output(info, (d) => formatGroupInfo(d as GroupInfo));
}

async function cmdSync(_args: string[]): Promise<void> {
  requireDaemon();
  const result = await sendCommand('sync_groups') as { synced: number };
  console.log(`Synced ${result.synced} groups`);
}

async function cmdAlias(args: string[]): Promise<void> {
  requireDaemon();
  const subcmd = args[0];

  switch (subcmd) {
    case 'list':
    case undefined: {
      const aliases = await sendCommand('alias_list') as Alias[];
      output(aliases, (d) => formatAliases(d as Alias[]));
      break;
    }

    case 'set': {
      const target = args[1];
      const name = args[2];
      if (!target || !name) die('Usage: whatsapp alias set <jid_or_number> "Name" [--note "description"]');

      // Parse --note flag
      const noteIdx = args.indexOf('--note');
      const notes = noteIdx !== -1 ? args.slice(noteIdx + 1).join(' ') : '';

      const result = await sendCommand('alias_set', { target, name, notes }) as Alias;
      if (jsonMode) {
        console.log(formatJson(result));
      } else {
        console.log(`Alias set: ${result.name} → ${result.jid}${result.notes ? ` (${result.notes})` : ''}`);
      }
      break;
    }

    case 'remove':
    case 'rm': {
      const target = args[1];
      if (!target) die('Usage: whatsapp alias remove <name_or_jid>');

      const result = await sendCommand('alias_remove', { target }) as { removed: string };
      if (jsonMode) {
        console.log(formatJson(result));
      } else {
        console.log(`Alias removed: ${result.removed}`);
      }
      break;
    }

    default:
      die(`Unknown alias command: ${subcmd}\nUsage: whatsapp alias [list|set|remove]`);
  }
}

async function cmdContext(_args: string[]): Promise<void> {
  requireDaemon();
  const ctx = await sendCommand('context');
  output(ctx, (d) => formatContext(d as Parameters<typeof formatContext>[0]));
}

async function cmdNotify(args: string[]): Promise<void> {
  const subcmd = args[0];
  const usage = [
    'Usage:',
    '  whatsapp notify subscribe <conversation_id> [--delivery wake|inbox] [--source S]  (alias: add)',
    '  whatsapp notify unsubscribe <conversation_id> [--source S]                       (alias: remove)',
    '  whatsapp notify unsubscribe --id <subscription_id>',
    '  whatsapp notify list [conversation_id] [--source S]',
    '',
    'Sources: messages (default; incoming messages), health (offline, logged out,',
    'session conflict, recovered), owner-ai (your own /ai commands).',
    'Health alerts also reach messages subscribers while nobody subscribes to health.',
  ].join('\n');

  switch (subcmd) {
    case 'subscribe':
    case 'add': {
      const positional = positionalValues(args, 1, ['--delivery', '--source']);
      if (positional.length !== 1) die(usage);
      const source = notifySource(args);
      const convId = positional[0];
      const deliveryValue = optionValue(args, ['--delivery']) ?? 'wake';
      if (deliveryValue !== 'wake' && deliveryValue !== 'inbox') {
        die('--delivery must be wake or inbox');
      }
      const subscription = await subscribeExternalNotification({
        toolName: WHATSAPP_TOOL_NAME,
        sourceId: source.id,
        sourceLabel: source.label,
        sourceDescription: source.description,
        convId,
        delivery: deliveryValue,
      });
      if (jsonMode) console.log(formatJson(subscription));
      else console.log(`Subscribed ${subscription.sourceLabel} to ${subscription.convId} (${subscription.delivery}).`);
      break;
    }

    case 'unsubscribe':
    case 'remove': {
      const subscriptionId = optionValue(args, ['--id', '--subscription-id']);
      const positional = positionalValues(args, 1, ['--id', '--subscription-id', '--conv', '--conversation', '--source']);
      if (positional.length > 1) die(usage);
      const source = notifySource(args);
      const convOption = optionValue(args, ['--conv', '--conversation']);
      if (convOption && positional.length > 0) die('Specify the conversation once, either positionally or with --conv');
      const convId = convOption ?? positional[0];
      if (subscriptionId && convId) die('Specify either a subscription ID or a conversation ID, not both');
      if (!subscriptionId && !convId) die(usage);
      const result = subscriptionId
        ? await unsubscribeExternalNotification({ subscriptionId })
        : await unsubscribeExternalNotification({
            toolName: WHATSAPP_TOOL_NAME,
            sourceId: source.id,
            convId,
          });
      if (jsonMode) console.log(formatJson(result));
      else console.log(`Removed ${result.removed} notification subscription${result.removed === 1 ? '' : 's'}.`);
      break;
    }

    case 'list':
    case undefined: {
      const positional = positionalValues(args, 1, ['--conv', '--conversation', '--source']);
      if (positional.length > 1) die(usage);
      const convOption = optionValue(args, ['--conv', '--conversation']);
      if (convOption && positional.length > 0) die('Specify the conversation once, either positionally or with --conv');
      const convId = convOption ?? positional[0];
      const listAll = !args.includes('--source');
      const subscriptions = await listExternalNotificationSubscriptions({
        toolName: WHATSAPP_TOOL_NAME,
        ...(listAll ? {} : { sourceId: notifySource(args).id }),
        ...(convId ? { convId } : {}),
      });
      output(subscriptions, data => formatNotificationSubscriptions(data as ExternalNotificationSubscription[]));
      break;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(usage);
      break;

    default:
      die(`Unknown notify command: ${subcmd}\n${usage}`);
  }
}

// ─── Help ──────────────────────────────────────────────────

/** Usage for commands without their own --help handling. */
const COMMAND_HELP: Record<string, string> = {
  daemon: 'usage: whatsapp daemon start|stop|restart|status|logs [-f]',
  chats: 'usage: whatsapp chats\n\nAll chats, most recent first, with their JIDs.',
  groups: 'usage: whatsapp groups',
  contacts: 'usage: whatsapp contacts',
  messages: 'usage: whatsapp messages <target> [-n count]\n\nPrints which chat the target resolved to, then its messages (oldest first).\nJSON: {"chat": {...}, "messages": [...]}.',
  search: 'usage: whatsapp search <query> [-n count]',
  media: 'usage: whatsapp media download <message_id> <outdir>',
  typing: 'usage: whatsapp typing <target> on|off',
  read: 'usage: whatsapp read <target>\n\nMarks the latest incoming message in the chat as read.',
  info: 'usage: whatsapp info <group>',
  sync: 'usage: whatsapp sync\n\nRe-fetches group names and settings.',
  alias: 'usage: whatsapp alias [list] | set <phone_or_jid> "Name" [--note text] | remove <name_or_jid>',
  context: 'usage: whatsapp context\n\nAccount status, aliases and recent chats.',
};
COMMAND_HELP.msgs = COMMAND_HELP.messages;
COMMAND_HELP.s = COMMAND_HELP.search;
COMMAND_HELP.ctx = COMMAND_HELP.context;

// ─── Main ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(a => a !== '--json');

  const cmd = args[0];
  const cmdArgs = args.slice(1);

  if (!cmd) {
    console.error("whatsapp: no command given. Run 'whatsapp --help' for usage.");
    process.exit(1);
  }

  if (COMMAND_HELP[cmd] && (cmdArgs.includes('-h') || cmdArgs.includes('--help'))) {
    console.log(COMMAND_HELP[cmd]);
    return;
  }

  try {
    switch (cmd) {
      case 'daemon':    await cmdDaemon(cmdArgs); break;
      case 'logout':    await cmdLogout(cmdArgs); break;
      case 'chats':     await cmdChats(cmdArgs); break;
      case 'groups':    await cmdGroups(cmdArgs); break;
      case 'contacts':  await cmdContacts(cmdArgs); break;
      case 'messages':
      case 'msgs':      await cmdMessages(cmdArgs); break;
      case 'search':
      case 's':         await cmdSearch(cmdArgs); break;
      case 'send':      await cmdSend(cmdArgs); break;
      case 'outbox':    await cmdOutbox(cmdArgs); break;
      case 'media':     await cmdMedia(cmdArgs); break;
      case 'typing':    await cmdTyping(cmdArgs); break;
      case 'read':      await cmdRead(cmdArgs); break;
      case 'info':      await cmdInfo(cmdArgs); break;
      case 'sync':      await cmdSync(cmdArgs); break;
      case 'alias':     await cmdAlias(cmdArgs); break;
      case 'notify':    await cmdNotify(cmdArgs); break;
      case 'context':
      case 'ctx':       await cmdContext(cmdArgs); break;
      default:
        console.error(`whatsapp: unknown command '${cmd}'`);
        console.error("Run 'whatsapp --help' for usage.");
        process.exit(1);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(err instanceof PayloadUsageError ? 2 : 1);
  }
}

main();
