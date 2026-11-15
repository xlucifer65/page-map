import os from 'node:os';
import path from 'node:path';

// All runtime files live in one private dir (0700). PAGEMAP_DIR overrides it (tests).
export function runtimeDir() {
  return process.env.PAGEMAP_DIR || path.join(os.homedir(), '.page-map');
}

// One socket per agent session (MCP server); the native host connects to all of them.
export function sessionsDir() {
  return path.join(runtimeDir(), 'sessions');
}

export function sessionSocket(id = process.pid) {
  return path.join(sessionsDir(), `${id}.sock`);
}
