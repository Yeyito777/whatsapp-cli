/**
 * WhatsApp CLI — command dispatcher for daemon and IPC commands.
 *
 * Called from bin/whatsapp as: tsx lib/cli.ts [--json] <cmd> [args...]
 * Login/logout/help are handled in the bash wrapper.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { sendCommand, isDaemonRunning, getDaemonPid } from './client.js';
import { PROJECT_ROOT } from './paths.js';
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

// ─── Commands ──────────────────────────────────────────────

async function cmdDaemon(args: string[]): Promise<void> {
  const subcmd = args[0];

  switch (subcmd) {
    case 'start': {
      if (isDaemonRunning()) {
        const pid = getDaemonPid();
        console.log(`Daemon already running (PID ${pid})`);
        return;
      }

      const daemonScript = path.join(PROJECT_ROOT, 'lib', 'daemon.ts');
      const logFile = path.join(PROJECT_ROOT, 'config', 'daemon.log');
      fs.mkdirSync(path.dirname(logFile), { recursive: true });

      const out = fs.openSync(logFile, 'a');
      const err = fs.openSync(logFile, 'a');

      const child = spawn('npx', ['tsx', daemonScript], {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: ['ignore', out, err],
      });

      child.unref();
      console.log(`Daemon starting (PID ${child.pid})`);

      await new Promise(r => setTimeout(r, 2000));
      if (isDaemonRunning()) {
        console.log('Daemon started successfully');
      } else {
        console.error('Daemon failed to start. Check: whatsapp daemon logs');
        process.exit(1);
      }
      break;
    }

    case 'stop': {
      const pid = getDaemonPid();
      if (!pid) {
        console.log('Daemon not running');
        return;
      }
      try {
        await sendCommand('shutdown');
      } catch {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
      console.log(`Daemon stopped (PID ${pid})`);
      break;
    }

    case 'restart': {
      const pid = getDaemonPid();
      if (pid) {
        try { await sendCommand('shutdown'); } catch {}
        try { process.kill(pid, 'SIGTERM'); } catch {}
        await new Promise(r => setTimeout(r, 2000));
      }
      await cmdDaemon(['start']);
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
      const logFile = path.join(PROJECT_ROOT, 'config', 'daemon.log');
      if (!fs.existsSync(logFile)) {
        console.log('No log file found');
        return;
      }
      if (args.includes('-f')) {
        const child = spawn('tail', ['-f', logFile], { stdio: 'inherit' });
        child.on('exit', (code) => process.exit(code || 0));
      } else {
        const content = fs.readFileSync(logFile, 'utf-8');
        const allLines = content.trim().split('\n');
        console.log(allLines.slice(-30).join('\n'));
      }
      break;
    }

    default:
      die(`Unknown daemon command: ${subcmd}\nUsage: whatsapp daemon start|stop|restart|status|logs`);
  }
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

  const messages = await sendCommand('messages', { target, limit: parseLimit(args) }) as StoredMessage[];
  output(messages, (d) => formatMessages(d as StoredMessage[]));
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

async function cmdSend(args: string[]): Promise<void> {
  requireDaemon();
  const target = args[0];
  if (!target) die('Usage: whatsapp send <name_or_jid> "message"\n       whatsapp send <name_or_jid> ["caption" | --caption "caption"] --file <path>');

  // --file mode
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1) {
    const filePath = args[fileIdx + 1];
    if (!filePath) die('Missing file path after --file');

    let caption: string | undefined;
    const captionIdx = args.indexOf('--caption');
    if (captionIdx !== -1) {
      caption = args[captionIdx + 1];
      if (!caption) die('Missing caption text after --caption');
    } else {
      caption = args.slice(1, fileIdx).join(' ') || undefined;
    }

    const result = await sendCommand('send_file', { target, file: path.resolve(filePath), caption });
    if (jsonMode) {
      console.log(formatJson(result));
    } else {
      console.log(`Sent file to ${target}`);
    }
    return;
  }

  // --reply mode
  let replyTo: string | undefined;
  const replyIdx = args.indexOf('--reply');
  if (replyIdx !== -1) {
    replyTo = args[replyIdx + 1];
    if (!replyTo) die('Missing message ID after --reply');
    args.splice(replyIdx, 2);
  }

  const text = args.slice(1).join(' ');
  if (!text) die('Usage: whatsapp send <name_or_jid> "message"');

  const result = await sendCommand('send', { target, text, reply_to: replyTo });
  if (jsonMode) {
    console.log(formatJson(result));
  } else {
    const r = result as { jid: string; timestamp: string };
    console.log(`Sent to ${r.jid}`);
  }
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

      // Resolve target to JID
      let jid = target;
      if (!target.includes('@')) {
        const digits = target.replace(/[\s\-\+\(\)]/g, '');
        if (/^\d{7,15}$/.test(digits)) {
          jid = `${digits}@s.whatsapp.net`;
        } else {
          die(`"${target}" doesn't look like a phone number or JID. Use digits or a full JID.`);
        }
      }

      // Parse --note flag
      const noteIdx = args.indexOf('--note');
      const notes = noteIdx !== -1 ? args.slice(noteIdx + 1).join(' ') : '';

      const result = await sendCommand('alias_set', { jid, name, notes }) as Alias;
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

// ─── Main ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(a => a !== '--json');

  const cmd = args[0];
  const cmdArgs = args.slice(1);

  if (!cmd) {
    console.error("whatsapp: no command given. Run 'whatsapp --help' for usage.");
    process.exit(1);
  }

  try {
    switch (cmd) {
      case 'daemon':    await cmdDaemon(cmdArgs); break;
      case 'chats':     await cmdChats(cmdArgs); break;
      case 'groups':    await cmdGroups(cmdArgs); break;
      case 'contacts':  await cmdContacts(cmdArgs); break;
      case 'messages':
      case 'msgs':      await cmdMessages(cmdArgs); break;
      case 'search':
      case 's':         await cmdSearch(cmdArgs); break;
      case 'send':      await cmdSend(cmdArgs); break;
      case 'media':     await cmdMedia(cmdArgs); break;
      case 'typing':    await cmdTyping(cmdArgs); break;
      case 'read':      await cmdRead(cmdArgs); break;
      case 'info':      await cmdInfo(cmdArgs); break;
      case 'sync':      await cmdSync(cmdArgs); break;
      case 'alias':     await cmdAlias(cmdArgs); break;
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
    process.exit(1);
  }
}

main();
