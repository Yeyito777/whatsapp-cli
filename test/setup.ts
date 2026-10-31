// Isolate every test run from the live WhatsApp session, DB, daemon socket and
// exocortexd. Every test file imports this module before anything from lib/,
// so isolation holds from any cwd and without the bunfig preload (which only
// applies when bun runs from this directory). The preload stays as a second
// line of defence for tools that read it.
import fs from 'fs';
import os from 'os';
import path from 'path';

const PREFIX = 'whatsapp-cli-test-';

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(fs.realpathSync(parent), child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Throw unless every path lib/paths exports sits inside a temp whatsapp-cli-test dir. */
export function assertIsolatedPaths(paths: Record<string, string>): void {
  const tmp = os.tmpdir();
  for (const [name, value] of Object.entries(paths)) {
    const resolved = path.resolve(value);
    let real = resolved;
    try { real = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)); } catch {}
    const top = isInside(tmp, real) ? path.relative(fs.realpathSync(tmp), real).split(path.sep)[0] : '';
    if (!top.startsWith(PREFIX)) {
      throw new Error(
        `REFUSING TO RUN TESTS: ${name} is ${resolved}, which is not inside a temporary ${PREFIX}* directory. ` +
        'Tests delete and rewrite these paths; running them against the real WhatsApp state would destroy the login.',
      );
    }
  }
}

function existingRoot(): string | null {
  const root = process.env.WHATSAPP_CLI_TEST_ROOT;
  if (!root) return null;
  try {
    if (path.basename(root).startsWith(PREFIX) && isInside(os.tmpdir(), path.resolve(root)) && fs.statSync(root).isDirectory()) return root;
  } catch {}
  return null;
}

function isolate(): void {
  let root = existingRoot();
  if (!root) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
    process.on('exit', () => {
      try { fs.rmSync(root!, { recursive: true, force: true }); } catch {}
    });
  }
  process.env.WHATSAPP_CLI_TEST_ROOT = root;
  process.env.WHATSAPP_CLI_CONFIG_DIR = path.join(root, 'config');
  process.env.WHATSAPP_CLI_RUNTIME_DIR = path.join(root, 'runtime');
  process.env.EXOCORTEX_CONFIG_DIR = path.join(root, 'exocortex');
  process.env.WHATSAPP_CLI_ACK_WAIT_MS = '200';
  fs.mkdirSync(process.env.WHATSAPP_CLI_CONFIG_DIR, { recursive: true });
}

isolate();

// Hard guard: lib/paths may already have been evaluated by something that ran
// before this module, so check what it really resolved, not what we set.
const paths = await import('../lib/paths.js');
assertIsolatedPaths({
  CONFIG_DIR: paths.CONFIG_DIR,
  AUTH_DIR: paths.AUTH_DIR,
  DB_PATH: paths.DB_PATH,
  LOG_FILE: paths.LOG_FILE,
  RUNTIME_DIR: paths.RUNTIME_DIR,
  SOCKET_PATH: paths.SOCKET_PATH,
  PID_FILE: paths.PID_FILE,
  SESSION_LOCK_FILE: (await import('../lib/session-lock.js')).SESSION_LOCK_FILE,
});
