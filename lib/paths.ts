/**
 * Canonical path definitions — single source of truth for all file locations.
 */
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');
export const AUTH_DIR = path.join(CONFIG_DIR, 'auth');
export const DB_PATH = path.join(CONFIG_DIR, 'whatsapp.db');
export const LOG_FILE = path.join(CONFIG_DIR, 'daemon.log');

export const RUNTIME_DIR = path.join(process.env.HOME || '/tmp', '.runtime', 'whatsapp-cli');
export const SOCKET_PATH = path.join(RUNTIME_DIR, 'daemon.sock');
export const PID_FILE = path.join(RUNTIME_DIR, 'daemon.pid');
