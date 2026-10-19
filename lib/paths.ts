/**
 * Canonical path definitions — single source of truth for all file locations.
 *
 * WHATSAPP_CLI_CONFIG_DIR / WHATSAPP_CLI_RUNTIME_DIR relocate state for tests
 * and isolated instances so they never touch the live session or socket.
 */
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const CONFIG_DIR = process.env.WHATSAPP_CLI_CONFIG_DIR?.trim()
  ? path.resolve(process.env.WHATSAPP_CLI_CONFIG_DIR)
  : path.join(PROJECT_ROOT, 'config');
export const AUTH_DIR = path.join(CONFIG_DIR, 'auth');
export const DB_PATH = path.join(CONFIG_DIR, 'whatsapp.db');
export const LOG_FILE = path.join(CONFIG_DIR, 'daemon.log');

export const RUNTIME_DIR = process.env.WHATSAPP_CLI_RUNTIME_DIR?.trim()
  ? path.resolve(process.env.WHATSAPP_CLI_RUNTIME_DIR)
  : path.join(process.env.HOME || '/tmp', '.runtime', 'whatsapp-cli');
export const SOCKET_PATH = path.join(RUNTIME_DIR, 'daemon.sock');
export const PID_FILE = path.join(RUNTIME_DIR, 'daemon.pid');
