import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DATABASE_URL = process.env.DATABASE_URL || '';

// Render's managed Postgres requires SSL but uses a certificate chain that
// Node won't validate by default. PGSSL=false can disable this entirely for
// local/self-hosted Postgres that has no TLS at all.
const sslMode = String(process.env.PGSSL || '').toLowerCase();
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: sslMode === 'false' ? false : { rejectUnauthorized: false }
    })
  : null;

const defaultState = () => ({
  version: 2,
  sessions: {},
  groups: {},
  commands: []
});

// The rest of this module (bot.js, server.js, watchdog.js)
// reads this in-memory object SYNCHRONOUSLY on every command. Keeping that
// contract intact — rather than making every call site `await` a DB round
// trip — is why persistence is a write-behind: mutate `state` immediately,
// then flush the whole thing to Postgres (or the local file) in the
// background, serialized through writeQueue so writes can't race each other.
let state = defaultState();
let writeQueue = Promise.resolve();
let usingPostgres = false;

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orihime_state (
      id INT PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}


function cleanLoadedState(value) {
  const next = { ...defaultState(), ...(value || {}) };
  // Drop media/channel state from older Orihime versions. Command media now
  // ships as repository-root files and must never depend on persisted channel data.
  delete next.channelImages;
  delete next.mediaHashes;
  delete next.channelId;
  delete next.channelName;
  delete next.channelImageCount;
  delete next.channelDeepSyncCompletedAt;
  delete next.lastChannelSyncAt;
  delete next.links;
  return next;
}

async function loadFromPostgres() {
  const { rows } = await pool.query('SELECT data FROM orihime_state WHERE id = 1');
  if (rows.length) {
    state = cleanLoadedState(rows[0].data);
  } else {
    state = defaultState();
    await pool.query('INSERT INTO orihime_state (id, data) VALUES (1, $1)', [state]);
  }
  state.sessions ||= {};
  state.groups ||= {};
  state.commands ||= [];
}

async function loadFromFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state = cleanLoadedState(parsed);
    state.sessions ||= {};
    state.groups ||= {};
    state.commands ||= [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await persistToFile();
  }
}

async function persistToFile() {
  const tmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, STATE_FILE);
}

async function persist() {
  writeQueue = writeQueue.then(async () => {
    if (usingPostgres) {
      await pool.query(
        `INSERT INTO orihime_state (id, data, updated_at) VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [state]
      );
    } else {
      await persistToFile();
    }
  }).catch((error) => {
    console.error('[store] persist failed:', error?.message || error);
  });
  return writeQueue;
}

export async function initStore() {
  if (pool) {
    try {
      await ensureSchema();
      await loadFromPostgres();
      usingPostgres = true;
      console.log('[store] Connected to Postgres — session/group/command data will survive restarts and redeploys.');
      return state;
    } catch (error) {
      console.error('[store] Postgres unavailable, falling back to local file storage:', error?.message || error);
    }
  } else {
    console.warn('[store] DATABASE_URL is not set — using local file storage. On Render this data will NOT survive a redeploy. Add a Postgres database and set DATABASE_URL to fix this.');
  }
  await loadFromFile();
  usingPostgres = false;
  return state;
}

export function getState() {
  return state;
}

export function storageBackend() {
  return usingPostgres ? 'postgres' : 'file';
}

export async function upsertSession(name, patch = {}) {
  state.sessions[name] = {
    ...(state.sessions[name] || {
      name,
      createdAt: new Date().toISOString(),
      removed: false,
      recoveryAttempts: 0,
      lastRecoveryAt: 0,
      status: 'UNKNOWN'
    }),
    ...patch,
    name
  };
  await persist();
  return state.sessions[name];
}

export async function patchSession(name, patch) {
  return upsertSession(name, patch);
}

export async function removeSession(name) {
  if (state.sessions[name]) {
    state.sessions[name].removed = true;
    state.sessions[name].removedAt = new Date().toISOString();
    await persist();
  }
}

export function getSession(name) {
  return state.sessions[name] || null;
}

export function listSessions() {
  return Object.values(state.sessions);
}

export async function setGroup(groupId, patch = {}) {
  state.groups[groupId] = {
    ...(state.groups[groupId] || {
      mode: 'PRIVATE',
      antilink: false,
      antibot: false,
      antichannel: false,
      killSale: false,
      welcome: false,
      left: false,
      antidemote: false,
      antipromote: false,
      autoDeleteUsers: [],
      createdAt: new Date().toISOString()
    }),
    ...patch,
    groupId
  };
  await persist();
  return state.groups[groupId];
}

export function getGroup(groupId) {
  return state.groups[groupId] || {
    groupId,
    mode: 'PRIVATE',
    antilink: false,
    antibot: false,
    antichannel: false,
    killSale: false,
    welcome: false,
    left: false,
    antidemote: false,
    antipromote: false,
    autoDeleteUsers: []
  };
}


export async function appendCommandLog(entry) {
  state.commands.unshift({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    timestamp: Date.now(),
    ...entry
  });
  state.commands = state.commands.slice(0, 5000);
  await persist();
}

export function commandHistory(filter = {}) {
  let rows = state.commands;
  if (filter.session) rows = rows.filter((r) => r.session === filter.session);
  if (filter.chatId) rows = rows.filter((r) => r.chatId === filter.chatId);
  return rows.slice(0, filter.limit || 20);
}



export async function clearHistory({ session, chatId } = {}) {
  state.commands = state.commands.filter((r) => {
    if (session && r.session !== session) return true;
    if (chatId && r.chatId !== chatId) return true;
    return false;
  });
  await persist();
}

