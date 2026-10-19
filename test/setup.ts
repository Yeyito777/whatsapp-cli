// Isolate every test run from the live WhatsApp session, DB, daemon socket and
// exocortexd. Must run before any lib module computes its paths.
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-cli-test-'));
process.env.WHATSAPP_CLI_CONFIG_DIR = path.join(root, 'config');
process.env.WHATSAPP_CLI_RUNTIME_DIR = path.join(root, 'runtime');
process.env.EXOCORTEX_CONFIG_DIR = path.join(root, 'exocortex');
fs.mkdirSync(process.env.WHATSAPP_CLI_CONFIG_DIR, { recursive: true });

process.on('exit', () => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
