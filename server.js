import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import {
  getSession,
  startSession,
  restartSession,
  requestPairingCode,
  getMe,
  deleteSession,
  logoutSession,
  listSessions,
  resyncWebhook
} from './waha.js';
import {
  initStore,
  getState,
  upsertSession,
  getSession as getStored,
  listSessions as listStored,
  removeSession,
  wipeAllSessions,
  storageBackend,
  commandLogBackend
} from './store.js';
import { listCommandMedia } from './commandMedia.js';
import { handleWebhookEvent, handleGroupEvent, handleMessageRevoked, handlePollVote, primeOwnerIdentity } from './bot.js';
import { startWatchdog } from './watchdog.js';
import { restoreScheduledGroupActions, resumeSplitGcJobs } from './advancedFeatures.js';
import { getSessionCapacity } from './capacity.js';
import { normalizePhoneNumber, isValidInternationalPhone, createPairingSession, waitForPairingReady } from './pairing.js';

// Every command handler already catches its own errors, but a rejected
// promise that nobody awaited (a fire-and-forget send, a stray .catch()
// that was missed somewhere) would otherwise crash the entire Node
// process on Node 18+, taking down every session and every in-flight job
// (like .split-gc) with it — the exact "backend crash" that a single bad
// command shouldn't be able to cause. Logging instead of exiting is the
// deliberate trade-off for a long-lived, many-sessions bot process: a
// missed catch shouldn't cost every group its running commands.
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection (ignored, process kept running):', reason?.stack || reason);
});
process.on('uncaughtException', (error) => {
  console.error('[process] uncaught exception (ignored, process kept running):', error?.stack || error);
});

const app = express();
const port = Number(process.env.PORT || 3000);
const publicDir = path.join(process.cwd(), 'public');
const hasPublicDir = await fs.access(publicDir).then(() => true).catch(() => false);

app.disable('x-powered-by');
if (String(process.env.TRUST_PROXY).toLowerCase() === 'true') app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' }));

// NOTE: the public routes below (pairing, stats, a user's own session
// management) remain intentionally open — anyone can pair their own
// WhatsApp account and manage the session they created. The /api/admin/*
// routes further down ARE gated, behind ADMIN_PASSWORD (see requireAdmin).

// --- Admin auth -------------------------------------------------------
// Simple password + short-lived bearer token, no extra dependencies.
// Set ADMIN_PASSWORD in the environment to enable the admin panel; if it's
// unset, admin login is refused outright rather than falling back to some
// guessable default.
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const adminTokens = new Map(); // token -> expiresAt

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) {
    // still run timingSafeEqual against a same-length buffer so a length
    // mismatch doesn't itself leak timing information
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function issueAdminToken() {
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
  return token;
}

function pruneAdminTokens() {
  const now = Date.now();
  for (const [token, expiresAt] of adminTokens) {
    if (expiresAt <= now) adminTokens.delete(token);
  }
}

function requireAdmin(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  pruneAdminTokens();
  const expiresAt = token && adminTokens.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    return res.status(401).json({ error: 'Admin session expired or invalid. Log in again.' });
  }
  // sliding expiry
  adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
  next();
}

app.post('/api/admin/login', (req, res) => {
  const configured = process.env.ADMIN_PASSWORD || '';
  if (!configured) {
    return res.status(503).json({ error: 'Admin panel is disabled: ADMIN_PASSWORD is not set on the server.' });
  }
  const supplied = String(req.body?.password ?? '');
  if (!safeEqual(supplied, configured)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  res.json({ token: issueAdminToken(), expiresInMs: ADMIN_TOKEN_TTL_MS });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  adminTokens.delete(token);
  res.json({ ok: true });
});

function sanitizeSessionPublic(s) {
  return {
    name: s.name,
    status: s.status || 'UNKNOWN',
    ownerJid: s.ownerJid || null,
    prefix: s.prefix || '.',
    mode: s.mode || 'PRIVATE',
    engine: s.engine || process.env.WHATSAPP_ENGINE || 'GOWS',
    createdAt: s.createdAt,
    updatedAt: s.updatedAt || null,
    recoveryAttempts: s.recoveryAttempts || 0,
    pairingPending: Boolean(s.pairingPending),
    pairingError: s.pairingError || null,
    removed: Boolean(s.removed),
    recoveryError: s.recoveryError || null
  };
}

app.get('/api/health', async (_req, res) => {
  res.json({
    ok: true,
    service: 'Orihime MD',
    uptime: process.uptime(),
    time: new Date().toISOString()
  });
});

app.get('/api/stats', async (_req, res) => {
  const sessions = listStored().filter((s) => !s.removed);
  const working = sessions.filter((s) => s.status === 'WORKING');
  res.json({
    userCount: sessions.length,
    connectedCount: working.length,
    commandImages: Object.keys(listCommandMedia()).length,
    storageBackend: storageBackend(),
    commandLogBackend: commandLogBackend(),
    uptime: process.uptime(),
    capacity: getSessionCapacity()
  });
});

app.get('/api/sessions', requireAdmin, async (_req, res) => {
  res.json(listStored().map(sanitizeSessionPublic));
});

app.get('/api/capacity', async (_req, res) => {
  res.json(getSessionCapacity());
});

app.post('/api/link', async (req, res) => {
  const result = await createPairingSession(req.body?.phoneNumber);
  if (!result.ok) {
    const code = result.status === 'WORKING' || result.capacity ? 409 : (result.details ? 502 : 400);
    return res.status(code).json({ error: result.error, details: result.details, session: result.session, status: result.status });
  }
  return res.status(201).json(result);
});

app.get('/api/link/:session/status', async (req, res) => {
  const session = req.params.session;
  const stored = getStored(session);
  if (!stored || stored.removed) return res.status(404).json({ error: 'Session not found' });
  try {
    const remote = await getSession(session);
    await upsertSession(session, {
      status: remote?.status || stored.status,
      engine: remote?.engine?.engine || stored.engine,
      updatedAt: Date.now()
    });
    let me = null;
    if (remote?.status === 'WORKING') {
      try { me = await getMe(session); } catch {}
      if (me?.id) await upsertSession(session, { ownerJid: me.id });
      primeOwnerIdentity(session); // fire-and-forget: resolves BOT_OWNER_PHONE's jid+lid, if set
    }
    const latest = getStored(session);
    res.json({ session: sanitizeSessionPublic(latest), me });
  } catch (error) {
    res.status(502).json({ error: 'Could not query WAHA session', details: error?.response?.data || error?.message || String(error) });
  }
});

app.post('/api/link/:session/pairing-code', async (req, res) => {
  const session = req.params.session;
  const stored = getStored(session);
  if (!stored || stored.removed) return res.status(404).json({ error: 'Session not found' });
  const phoneNumber = normalizePhoneNumber(req.body?.phoneNumber);
  if (!isValidInternationalPhone(phoneNumber)) {
    return res.status(400).json({ error: 'Enter your full phone number in international format, digits only. Example: 2348163201351' });
  }

  try {
    let remote = await getSession(session);
    let status = String(remote?.status || '').toUpperCase();

    if (status === 'WORKING') {
      return res.status(409).json({ error: 'This WhatsApp session is already connected.', session, status });
    }

    // Re-start only a session that is actually stopped/failed. Do not issue a
    // PUT /api/sessions/{name} update here — on GOWS that can rebuild the
    // client while a pairing attempt is in progress.
    if (status === 'STOPPED' || status === 'FAILED' || status === 'UNKNOWN') {
      try { await startSession(session); } catch (error) {
        const code = error?.response?.status;
        if (code !== 409 && code !== 422) throw error;
      }
    }

    remote = await waitForPairingReady(session);
    status = String(remote?.status || '').toUpperCase();

    if (status === 'WORKING') {
      await upsertSession(session, { pairingPending: false, updatedAt: Date.now() });
      return res.status(409).json({ error: 'This WhatsApp session is already connected.', session, status });
    }
    if (status === 'PASSKEY_REQUIRED' || status === 'PASSKEY_CONFIRMATION_REQUIRED') {
      return res.status(409).json({
        error: status === 'PASSKEY_REQUIRED'
          ? 'WhatsApp requires a passkey to finish this pairing.'
          : 'WhatsApp is waiting for confirmation on the phone.',
        session,
        status
      });
    }
    if (status === 'FAILED') {
      return res.status(502).json({
        error: 'WAHA reported this pairing session as FAILED.',
        session,
        status,
        details: remote?.error || remote?.message || null
      });
    }
    if (status !== 'SCAN_QR_CODE') {
      return res.status(504).json({
        error: `WAHA is not ready for a pairing code yet (status: ${status || 'UNKNOWN'}).`,
        session,
        status: status || 'UNKNOWN'
      });
    }

    const result = await requestPairingCode(session, phoneNumber);
    if (!result?.code) {
      return res.status(502).json({ error: 'WAHA returned no pairing code.', session, status });
    }

    await upsertSession(session, {
      pairingPhone: phoneNumber.slice(-4).padStart(4, '*'),
      pairingPending: true,
      pairingRequestedAt: Date.now(),
      updatedAt: Date.now()
    });
    console.log(`[pairing] new code requested for ${session}; phone ending ${phoneNumber.slice(-4)}`);
    res.json({ code: result.code, phoneLast4: phoneNumber.slice(-4), session, status: 'SCAN_QR_CODE' });
  } catch (error) {
    const details = error?.response?.data || error?.message || String(error);
    console.error(`[pairing] code request failed for ${session}:`, details);
    res.status(502).json({ error: 'Could not request pairing code', session, status: 'FAILED', details });
  }
});

app.post('/api/link/:session/remove', async (req, res) => {
  const session = req.params.session;
  const stored = getStored(session);
  if (!stored) return res.status(404).json({ error: 'Session not found' });
  try {
    // Explicit removal is the ONLY path in this application that logs out and deletes the session.
    try { await logoutSession(session); } catch {}
    try { await deleteSession(session); } catch {}
    await removeSession(session);
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({ error: 'Could not remove session', details: error?.response?.data || error?.message || String(error) });
  }
});


// --- Admin routes (require a valid token from /api/admin/login) -------

app.get('/api/admin/overview', requireAdmin, async (_req, res) => {
  const sessions = listStored();
  const working = sessions.filter((s) => s.status === 'WORKING' && !s.removed);
  res.json({
    userCount: sessions.filter((s) => !s.removed).length,
    connectedCount: working.length,
    sessions: sessions.map(sanitizeSessionPublic),
    storageBackend: storageBackend(),
    commandLogBackend: commandLogBackend(),
    uptime: process.uptime(),
    capacity: getSessionCapacity()
  });
});

app.post('/api/admin/sessions/:session/restart', requireAdmin, async (req, res) => {
  const session = req.params.session;
  try {
    await restartSession(session);
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({ error: 'Could not restart session', details: error?.response?.data || error?.message || String(error) });
  }
});

app.post('/api/admin/sessions/:session/remove', requireAdmin, async (req, res) => {
  const session = req.params.session;
  try {
    try { await logoutSession(session); } catch {}
    try { await deleteSession(session); } catch {}
    await removeSession(session);
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({ error: 'Could not remove session', details: error?.response?.data || error?.message || String(error) });
  }
});

app.post('/api/admin/resync-webhooks', requireAdmin, async (_req, res) => {
  const sessions = listStored().filter((s) => !s.removed);
  const results = [];
  for (const s of sessions) {
    try {
      await resyncWebhook(s.name);
      results.push({ session: s.name, ok: true });
    } catch (error) {
      results.push({ session: s.name, ok: false, error: error?.response?.data || error?.message || String(error) });
    }
  }
  res.json({ results });
});

// Wipes every linked WhatsApp session: logs each one out and deletes it on
// the WAHA side, then clears Orihime's own session/group records. This is
// destructive and cannot be undone — every user currently linked will need
// to re-pair their WhatsApp account from scratch afterward.
app.post('/api/admin/wipe-all', requireAdmin, async (_req, res) => {
  const sessions = listStored();
  const results = [];
  for (const s of sessions) {
    try { await logoutSession(s.name); } catch {}
    try { await deleteSession(s.name); } catch {}
    results.push(s.name);
  }
  const cleared = await wipeAllSessions();
  res.json({ ok: true, wahaSessionsProcessed: results, storeSessionsCleared: cleared.length });
});

app.get('/api/assets/slides', async (_req, res) => {
  const dir = path.join(publicDir, 'assets', 'slides');
  await fs.mkdir(dir, { recursive: true });
  const files = (await fs.readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(e.name))
    .map((e) => `/assets/slides/${encodeURIComponent(e.name)}`);
  res.json(files);
});

app.post('/webhooks/waha', async (req, res) => {
  const supplied = String(req.query.secret || '').trim();
  const expected = String(process.env.WEBHOOK_SECRET || 'change-me').trim();
  if (!safeEqual(supplied, expected)) return res.status(401).json({ error: 'Invalid webhook secret' });
  res.sendStatus(200);
  const event = req.body;
  const session = event?.session;
  if (!session) return;
  try {
    if (event.event === 'session.status') {
      const status = event?.payload?.status || event?.payload?.payload?.status || 'UNKNOWN';
      const storedBefore = getStored(session);
      const ownerJid = event?.me?.id || storedBefore?.ownerJid || null;
      const normalizedStatus = String(status).toUpperCase();
      await upsertSession(session, {
        status: normalizedStatus,
        updatedAt: Date.now(),
        ownerJid,
        pairingPending: normalizedStatus === 'WORKING' ? false : (storedBefore?.pairingPending || false)
      });
      if (normalizedStatus === 'WORKING') primeOwnerIdentity(session); // fire-and-forget
    }
    if (event.event === 'group.v2.participants' || event.event === 'group.v2.join' || event.event === 'group.v2.leave' || event.event === 'group.v2.update') {
      await handleGroupEvent(session, event.event, event.payload);
    }
    if (event.event === 'message') {
      const payload = event?.payload;
      await handleWebhookEvent(session, payload);
    }
    if (event.event === 'poll.vote') {
      await handlePollVote(session, event?.payload);
    }
    if (event.event === 'message.revoked') {
      await handleMessageRevoked(session, event?.payload);
    }
  } catch (error) {
    console.error('[webhook]', error?.response?.data || error?.message || error);
  }
});

// admin.html now lives in public/ next to index.html — express.static below
// serves it directly, so no separate route is needed for it.

if (hasPublicDir) {
  app.use(express.static(publicDir, { extensions: ['html'] }));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
} else {
  app.get('/', (_req, res) => res.json({ ok: true, service: 'Orihime MD', message: 'Backend is running.' }));
}

await initStore();
console.log(`[storage] backend: ${storageBackend()}, command log: ${commandLogBackend()}`);

// Re-register WAHA sessions that pre-existed a backend restart.
try {
  const remotes = await listSessions();
  const list = Array.isArray(remotes) ? remotes : (remotes?.sessions || remotes?.data || []);
  for (const s of list) {
    if (!String(s?.name || '').startsWith('orihime_')) continue;
    await upsertSession(s.name, {
      status: s.status,
      engine: s.engine?.engine || s.engine || process.env.WHATSAPP_ENGINE || 'GOWS',
      updatedAt: Date.now(),
      removed: false
    });
    if (String(s.status || '').toUpperCase() === 'WORKING') primeOwnerIdentity(s.name); // fire-and-forget
  }
} catch (error) {
  console.error('[startup] could not reconcile WAHA sessions:', error?.message || error);
}

try {
  await restoreScheduledGroupActions();
} catch (error) {
  console.error('[startup] scheduled group-action restore failed:', error?.message || error);
}

try {
  // Picks back up any .split-gc job that was mid-flight when the process
  // last stopped (redeploy, restart, crash) instead of leaving it stuck at
  // whatever batch it reached. See resumeSplitGcJobs() for details.
  await resumeSplitGcJobs();
} catch (error) {
  console.error('[startup] split-gc job resume failed:', error?.message || error);
}

startWatchdog();

app.listen(port, () => {
  console.log(`Orihime MD listening on port ${port}`);
  console.log('[owner-admin] full group scan disabled');
});
