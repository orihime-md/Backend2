import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import Redis from 'ioredis';

const { Pool } = pg;

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const REDIS_URL = process.env.REDIS_URL || '';

// Command history is by far the hottest write path — it fires on every
// single command, from every session. Routing it through Redis (a single
// fast round trip, LPUSH+LTRIM) instead of the Postgres `state` blob means
// a busy session's log writes can never pile up behind another session's
// writes and delay them. If REDIS_URL isn't set, it falls back to living
// inside `state` like everything else (see appendCommandLog/commandHistory).
const COMMAND_LOG_KEY = 'orihime:commands';
const COMMAND_LOG_MAX = 5000;
const redis = REDIS_URL ? new Redis(REDIS_URL, { maxRetriesPerRequest: 2 }) : null;
if (redis) {
  redis.on('error', (error) => console.error('[store] Redis error:', error?.message || error));
}

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
  version: 4,
  sessions: {},
  groups: {},
  commands: [],
  languageModes: {},
  customLanguages: {},
  animations: {}
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


function groupKey(session, groupId) {
  return `${String(session || 'legacy')}::${String(groupId || '')}`;
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
  state.languageModes ||= {};
  state.customLanguages ||= {};
  state.animations ||= {};
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
    state.languageModes ||= {};
    state.customLanguages ||= {};
    state.animations ||= {};
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

// Debounce writes: many callers can mutate `state` and call persist() within
// the same tick or two (e.g. a burst of group updates). Instead of firing one
// full-state Postgres write per call — each queued strictly behind the last —
// we collapse everything that lands within PERSIST_DEBOUNCE_MS into a single
// flush. Every caller still gets a promise that resolves once THEIR change
// has actually been written.
const PERSIST_DEBOUNCE_MS = 250;
let persistTimer = null;
let pendingWaiters = [];

function flushPersist() {
  persistTimer = null;
  const waiters = pendingWaiters;
  pendingWaiters = [];
  writeQueue = writeQueue
    .then(async () => {
      if (usingPostgres) {
        await pool.query(
          `INSERT INTO orihime_state (id, data, updated_at) VALUES (1, $1, now())
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [state]
        );
      } else {
        await persistToFile();
      }
    })
    .then(
      () => waiters.forEach((w) => w.resolve()),
      (error) => {
        console.error('[store] persist failed:', error?.message || error);
        // Don't reject callers just because a flush failed — a dropped write
        // shouldn't crash whatever command triggered it. It'll be retried on
        // the next mutation anyway, since `state` still holds the change.
        waiters.forEach((w) => w.resolve());
      }
    );
}

async function persist() {
  return new Promise((resolve) => {
    pendingWaiters.push({ resolve });
    if (!persistTimer) {
      persistTimer = setTimeout(flushPersist, PERSIST_DEBOUNCE_MS);
    }
  });
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

// Expose a persistence trigger for feature modules that mutate the in-memory
// state directly (custom languages, generated animations, scheduled actions).
export async function persistState() {
  await persist();
}

export function storageBackend() {
  return usingPostgres ? 'postgres' : 'file';
}

export function commandLogBackend() {
  return redis ? 'redis' : storageBackend();
}

export async function upsertSession(name, patch = {}) {
  state.sessions[name] = {
    ...(state.sessions[name] || {
      name,
      createdAt: new Date().toISOString(),
      removed: false,
      recoveryAttempts: 0,
      lastRecoveryAt: 0,
      status: 'UNKNOWN',
      ownerAdminGroups: {},
      ownerAdminScan: null
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

// Full reset used by the admin "wipe all sessions" action. This only clears
// the local session/group records — the caller is responsible for logging
// out and deleting each session on the WAHA side FIRST (see
// wipeAllWahaSessions in server.js), otherwise WhatsApp stays linked on
// WAHA's side while Orihime forgets about it.
export async function wipeAllSessions() {
  const names = Object.keys(state.sessions);
  state.sessions = {};
  state.groups = {};
  state.languageModes = {};
  state.customLanguages = {};
  state.animations = {};
  await persist();
  return names;
}

function defaultGroup(groupId) {
  return {
    groupId,
    mode: 'PRIVATE',
    antilink: false,
    antibot: false,
    antichannel: false,
    killSale: false,
    killSaleKeywords: [],
    welcome: false,
    left: false,
    antidemote: false,
    antipromote: false,
    autoDeleteUsers: [],
    antispam: false,
    antidelete: false,
    badwords: [],
    warnLimit: 3,
    warns: {}
  };
}

export async function setGroup(session, groupId, patch = {}) {
  const key = groupKey(session, groupId);
  state.groups[key] = {
    ...(state.groups[key] || defaultGroup(groupId)),
    ...patch,
    groupId,
    session: String(session || '')
  };
  await persist();
  return state.groups[key];
}

export function getGroup(session, groupId) {
  const key = groupKey(session, groupId);
  return state.groups[key] || defaultGroup(groupId);
}


export async function appendCommandLog(entry) {
  const record = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    timestamp: Date.now(),
    ...entry
  };
  if (redis) {
    try {
      await redis
        .multi()
        .lpush(COMMAND_LOG_KEY, JSON.stringify(record))
        .ltrim(COMMAND_LOG_KEY, 0, COMMAND_LOG_MAX - 1)
        .exec();
      return record;
    } catch (error) {
      console.error('[store] Redis command log write failed, falling back to state:', error?.message || error);
    }
  }
  state.commands.unshift(record);
  state.commands = state.commands.slice(0, COMMAND_LOG_MAX);
  await persist();
  return record;
}

export async function commandHistory(filter = {}) {
  const limit = filter.limit || 20;
  if (redis) {
    try {
      // Pull a generous window and filter in-process — command lookups are
      // per-chat and rare (an admin/.orihime-history command), never hot.
      const raw = await redis.lrange(COMMAND_LOG_KEY, 0, 499);
      let rows = raw.map((r) => {
        try { return JSON.parse(r); } catch { return null; }
      }).filter(Boolean);
      if (filter.session) rows = rows.filter((r) => r.session === filter.session);
      if (filter.chatId) rows = rows.filter((r) => r.chatId === filter.chatId);
      return rows.slice(0, limit);
    } catch (error) {
      console.error('[store] Redis command history read failed, falling back to state:', error?.message || error);
    }
  }
  let rows = state.commands;
  if (filter.session) rows = rows.filter((r) => r.session === filter.session);
  if (filter.chatId) rows = rows.filter((r) => r.chatId === filter.chatId);
  return rows.slice(0, limit);
}

export async function clearHistory({ session, chatId } = {}) {
  if (redis) {
    try {
      const raw = await redis.lrange(COMMAND_LOG_KEY, 0, -1);
      const kept = raw.filter((r) => {
        let parsed;
        try { parsed = JSON.parse(r); } catch { return true; }
        if (session && parsed.session !== session) return true;
        if (chatId && parsed.chatId !== chatId) return true;
        return false;
      });
      const multi = redis.multi().del(COMMAND_LOG_KEY);
      if (kept.length) multi.rpush(COMMAND_LOG_KEY, ...kept.slice().reverse());
      await multi.exec();
      return;
    } catch (error) {
      console.error('[store] Redis command history clear failed, falling back to state:', error?.message || error);
    }
  }
  state.commands = state.commands.filter((r) => {
    if (session && r.session !== session) return true;
    if (chatId && r.chatId !== chatId) return true;
    return false;
  });
  await persist();
}

