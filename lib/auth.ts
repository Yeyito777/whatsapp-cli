/**
 * WhatsApp Authentication — QR code, pairing code, or browser-based.
 *
 * Usage:
 *   whatsapp login                                    # QR code in terminal
 *   whatsapp login --pairing-code --phone 1415...     # Pairing code
 *   whatsapp login --browser                          # QR via local HTTP page
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import readline from 'readline';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';

import { AUTH_DIR } from './paths.js';
import { isDaemonRunning, sendCommand } from './client.js';
import { manageExternalToolDaemon } from './exocortex.js';
import { acquireSessionLock, hasLinkedSession, SessionLockedError } from './session-lock.js';
import type { DaemonStatus } from './types.js';

const logger = pino({ level: 'warn' });

const USAGE = `usage:
  whatsapp login                                  # QR code in terminal
  whatsapp login --pairing-code [--phone 1415...] # pairing code
  whatsapp login --browser                        # QR via http://127.0.0.1:9182

Links this machine as a WhatsApp device. Refuses to run while a linked
session is active (it would knock the running daemon offline).`;

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help') || argv[0] === 'help') {
  console.log(USAGE);
  process.exit(0);
}
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--phone') { i++; continue; }
  if (arg !== '--pairing-code' && arg !== '--browser') {
    console.error(`whatsapp login: unknown argument '${arg}'\n\n${USAGE}`);
    process.exit(2);
  }
}

const usePairingCode = argv.includes('--pairing-code');
const useBrowser = argv.includes('--browser');
const phoneArg = argv.find((_, i, arr) => arr[i - 1] === '--phone');

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// ─── Browser-based auth (--browser) ──────────────────────────

const BROWSER_PORT = 9182;
let currentQrDataUrl = '';
let statusMessage = 'Waiting for QR code...';

function startBrowserServer(): http.Server {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>WhatsApp Auth</title>
<meta http-equiv="refresh" content="3">
<style>
  body { font-family: -apple-system, sans-serif; display: flex; flex-direction: column;
         align-items: center; justify-content: center; min-height: 100vh; margin: 0;
         background: #111; color: #fff; }
  img { width: 400px; height: 400px; border-radius: 12px; }
  .status { margin-top: 20px; font-size: 1.2em; color: #0f0; }
  .instructions { margin-top: 10px; color: #aaa; text-align: center; line-height: 1.6; }
</style></head><body>
  <h1>🔗 WhatsApp Auth</h1>
  ${currentQrDataUrl ? `<img src="${currentQrDataUrl}" alt="QR Code"/>` : '<p>Generating QR code...</p>'}
  <div class="status">${statusMessage}</div>
  <div class="instructions">
    1. Open WhatsApp on your phone<br>
    2. Settings → Linked Devices → Link a Device<br>
    3. Scan the QR code above
  </div>
</body></html>`);
  });

  server.listen(BROWSER_PORT, '127.0.0.1', () => {
    console.log(`\n🌐 QR code page ready at: http://127.0.0.1:${BROWSER_PORT}`);
    console.log('   Opening in browser...\n');
  });

  // Open in browser
  import('child_process').then(({ execSync }) => {
    setTimeout(() => {
      try { execSync(`xdg-open http://127.0.0.1:${BROWSER_PORT}`, { stdio: 'ignore' }); } catch {}
    }, 500);
  });

  return server;
}

// ─── Core connection logic ───────────────────────────────────

async function connectSocket(
  phoneNumber?: string,
  isReconnect = false,
  browserServer?: http.Server,
): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (hasLinkedSession(state.creds) && !isReconnect) {
    console.log('✓ Already authenticated with WhatsApp');
    console.log('  If WhatsApp logged this device out, run: whatsapp logout --yes, then whatsapp login');
    if (browserServer) {
      statusMessage = '✓ Already authenticated!';
      setTimeout(() => { browserServer.close(); process.exit(0); }, 2000);
    } else {
      process.exit(0);
    }
    return;
  }

  const { version } = await fetchLatestWaWebVersion({}).catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
  });

  // Pairing code mode
  if (usePairingCode && phoneNumber && !state.creds.me) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`\n🔗 Your pairing code: ${code}\n`);
        console.log('  1. Open WhatsApp on your phone');
        console.log('  2. Tap Settings → Linked Devices → Link a Device');
        console.log('  3. Tap "Link with phone number instead"');
        console.log(`  4. Enter this code: ${code}\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Failed to request pairing code:', message);
        process.exit(1);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (useBrowser && browserServer) {
        // Browser mode: render QR as data URL
        console.log('📱 New QR code generated — check browser');
        statusMessage = 'Scan this QR code with your phone';
        currentQrDataUrl = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
      } else {
        // Terminal mode: render QR in terminal
        console.log('\nScan this QR code with WhatsApp:\n');
        console.log('  1. Open WhatsApp on your phone');
        console.log('  2. Tap Settings → Linked Devices → Link a Device');
        console.log('  3. Point your camera at the QR code below\n');
        qrTerminal.generate(qr, { small: true });
      }
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        const msg = '✗ Logged out. Run: whatsapp logout && whatsapp login';
        console.log(`\n${msg}`);
        if (browserServer) { statusMessage = '✗ Failed — try again'; setTimeout(() => { browserServer.close(); process.exit(1); }, 2000); }
        else process.exit(1);
      } else if (reason === DisconnectReason.timedOut) {
        const msg = '✗ QR code timed out. Please try again.';
        console.log(`\n${msg}`);
        if (browserServer) { statusMessage = msg; setTimeout(() => { browserServer.close(); process.exit(1); }, 2000); }
        else process.exit(1);
      } else if (reason === 515) {
        console.log('\n⟳ Stream error after pairing — reconnecting...');
        if (browserServer) statusMessage = 'Reconnecting...';
        connectSocket(phoneNumber, true, browserServer);
      } else {
        const msg = `✗ Connection failed (reason: ${reason}). Please try again.`;
        console.log(`\n${msg}`);
        if (browserServer) { statusMessage = msg; setTimeout(() => { browserServer.close(); process.exit(1); }, 2000); }
        else process.exit(1);
      }
    }

    if (connection === 'open') {
      console.log('\n✓ Successfully authenticated with WhatsApp!');
      // Hand the session to the daemon: close ours first so only one connects.
      try { sock.end(undefined); } catch {}
      await restartDaemonAfterLogin();
      if (browserServer) {
        statusMessage = '✓ Authenticated! You can close this page.';
        setTimeout(() => { browserServer.close(); process.exit(0); }, 3000);
      } else {
        setTimeout(() => process.exit(0), 1000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ─── Main ────────────────────────────────────────────────────

async function restartDaemonAfterLogin(): Promise<void> {
  releaseLock?.();
  try {
    const status = await manageExternalToolDaemon('whatsapp', 'restart');
    console.log(`  ${status.message}\n`);
  } catch {
    console.log('  Credentials saved. Start the daemon with: whatsapp daemon start\n');
  }
}

let releaseLock: (() => void) | null = null;

/** Refuse to pair while another process owns this linked-device session. */
async function ensureSessionIsFree(): Promise<void> {
  if (isDaemonRunning()) {
    let status: DaemonStatus | null = null;
    try {
      status = await sendCommand('status', undefined, 5_000) as DaemonStatus;
    } catch {}
    if (status?.connection_state === 'logged_out' && fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
      // WhatsApp revoked these credentials; keep them aside and pair afresh.
      const aside = `${AUTH_DIR}.revoked-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.renameSync(AUTH_DIR, aside);
      fs.chmodSync(aside, 0o700);
      fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
      console.log(`Moved the revoked credentials to ${aside}`);
    }
    if (!status || status.connection_state !== 'logged_out') {
      if (status?.connection_state === 'connected') {
        console.log('✓ Already linked and connected; nothing to do. (whatsapp daemon status)');
        process.exit(0);
      }
      const state = status?.connection_state ?? 'running';
      console.error(`✗ The WhatsApp daemon is ${state}; logging in now would open a second connection and knock it offline.`);
      if (status?.connection_state === 'conflict') {
        console.error('  The session conflict is usually another copy of this client. Stop it, then: whatsapp daemon restart');
      } else {
        console.error('  Check with: whatsapp daemon status');
      }
      process.exit(1);
    }
  }
  try {
    releaseLock = acquireSessionLock('whatsapp login');
  } catch (err) {
    if (err instanceof SessionLockedError) {
      console.error(`✗ ${err.message} Logging in now would knock it offline.`);
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  await ensureSessionIsFree();

  let phoneNumber = phoneArg;
  if (usePairingCode && !phoneNumber) {
    phoneNumber = await askQuestion(
      'Enter your phone number (with country code, no + or spaces, e.g. 14155551234): '
    );
  }

  console.log('Starting WhatsApp authentication...\n');

  let browserServer: http.Server | undefined;
  if (useBrowser) {
    browserServer = startBrowserServer();
  }

  await connectSocket(phoneNumber, false, browserServer);
}

main().catch(err => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
