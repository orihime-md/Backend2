import { listSessions, getSession, restartSession, startSession, getMe } from './waha.js';
import { getSession as getStored, upsertSession, listSessions as listStored } from './store.js';
import { syncChannelImages, ensureChannelFollow } from './channelSync.js';

const interval = Number(process.env.SESSION_WATCH_INTERVAL_MS || 20000);
const cooldown = Number(process.env.RECOVERY_COOLDOWN_MS || 30000);
const maxAttempts = Number(process.env.MAX_RECOVERY_ATTEMPTS || 6);
const pending = new Set();

function isManaged(name) {
  return typeof name === 'string' && name.startsWith('orihime_');
}

function backoffDelay(attempt) {
  return Math.min(15 * 60 * 1000, cooldown * Math.pow(2, Math.max(0, attempt - 1)));
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

    if (status === 'WORKING') {
      patch.recoveryAttempts = 0;
      patch.recoveryError = null;
      await upsertSession(name, patch);
      if (!pending.has(name)) {
        pending.add(name);
        try {
          await ensureChannelFollow(name);
          // Refresh the visual library without blocking the watchdog loop.
          syncChannelImages(name).catch((e) => console.error('[watchdog] channel sync:', e?.message || e));
        } catch (error) {
          console.error('[watchdog] channel follow:', error?.message || error);
        } finally {
          pending.delete(name);
        }
      }
      continue;
    }

    // WAHA can expose these states while a phone-number pairing is still pending.
    if (status === 'SCAN_QR_CODE' || status === 'PASSKEY_REQUIRED' || status === 'PASSKEY_CONFIRMATION_REQUIRED') {
      await upsertSession(name, patch);
      continue;
    }

    if (status !== 'STOPPED' && status !== 'FAILED') {
      await upsertSession(name, patch);
      continue;
    }

    const attempts = Number(stored.recoveryAttempts || 0);
    const last = Number(stored.lastRecoveryAt || 0);
    const wait = attempts >= maxAttempts ? 5 * 60 * 1000 : backoffDelay(attempts + 1);
    if (Date.now() - last < wait) continue;
    if (pending.has(name)) continue;

    pending.add(name);
    try {
      const result = attempts === 0 && status === 'STOPPED'
        ? await startSession(name)
        : await restartSession(name);
      await upsertSession(name, {
        ...patch,
        recoveryAttempts: attempts + 1,
        lastRecoveryAt: Date.now(),
        recoveryResult: result,
        recoveryError: null
      });
      console.log(`[watchdog] recovery attempted for ${name}: ${status}`);
    } catch (error) {
      await upsertSession(name, {
        ...patch,
        recoveryAttempts: attempts + 1,
        lastRecoveryAt: Date.now(),
        recoveryError: error?.response?.data || error?.message || String(error)
      });
      console.error(`[watchdog] recovery failed for ${name}:`, error?.message || error);
    } finally {
      pending.delete(name);
    }
  }

  // Recover local registry entries that WAHA did not return only if they still exist remotely.
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
