import { listSessions, getSession, startSession } from './waha.js';
import { getSession as getStored, upsertSession, listSessions as listStored } from './store.js';

const interval = Number(process.env.SESSION_WATCH_INTERVAL_MS || 30000);

// Self-heal: a session that WAHA reports as STOPPED/FAILED is started again.
// Never touches SCAN_QR_CODE / STARTING / WORKING, never runs while a pairing
// is pending, and backs off so it can't loop.
const lastStart = new Map();
const START_BACKOFF_MS = Number(process.env.SESSION_RESTART_BACKOFF_MS || 60000);
async function healIfDown(name, status, stored) {
  if (!['STOPPED', 'FAILED'].includes(String(status).toUpperCase())) return;
  if (stored.pairingPending) return;
  const now = Date.now();
  if (now - (lastStart.get(name) || 0) < START_BACKOFF_MS) return;
  lastStart.set(name, now);
  try {
    console.log(`[watchdog] ${name} is ${status}; starting it again`);
    await startSession(name);
  } catch (error) {
    console.error('[watchdog] restart failed:', error?.response?.data || error?.message || error);
  }
}

function isManaged(name) {
  return typeof name === 'string' && name.startsWith('orihime_');
}

async function reconcile() {
  let sessions;
  try {
    sessions = await listSessions();
  } catch (error) {
    console.error('[watchdog] WAHA list sessions failed:', error?.message || error);
    return;
  }

  const apiSessions = Array.isArray(sessions) ? sessions : (sessions?.sessions || sessions?.data || []);
  for (const remote of apiSessions) {
    const name = remote?.name;
    if (!isManaged(name)) continue;
    const stored = getStored(name) || {};
    if (stored.removed) continue;

    const status = remote.status || remote.state || 'UNKNOWN';
    const patch = {
      status,
      engine: remote.engine?.engine || remote.engine || stored.engine,
      updatedAt: Date.now()
    };

    // Monitoring only: never restart, stop, update, or resync a session from
    // this loop. In particular, a PUT /api/sessions/{name} can make GOWS
    // rebuild the WhatsApp client, which is exactly what we don't want during
    // phone-number pairing.
    await upsertSession(name, patch);
    await healIfDown(name, status, stored);
  }

  // Refresh local status for a session that still exists in WAHA but wasn't
  // present in the list response. No recovery calls are made here.
  for (const local of listStored().filter((s) => isManaged(s.name) && !s.removed)) {
    if (apiSessions.some((s) => s?.name === local.name)) continue;
    try {
      const remote = await getSession(local.name);
      if (remote) await upsertSession(local.name, { status: remote.status, updatedAt: Date.now() });
    } catch {}
  }
}

export function startWatchdog() {
  reconcile().catch((e) => console.error('[watchdog] initial:', e));
  const timer = setInterval(() => reconcile().catch((e) => console.error('[watchdog] tick:', e)), interval);
  timer.unref?.();
  return () => clearInterval(timer);
}
