import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import {
  createSession,
  getSession,
  startSession,
  requestPairingCode,
  getMe,
  deleteSession,
  logoutSession,
  listSessions
} from './waha.js';
import {
  initStore,
  getState,
  upsertSession,
  getSession as getStored,
  listSessions as listStored,
  removeSession,
  listChannelImages
} from './store.js';
import { handleWebhookEvent, handleGroupEvent } from './bot.js';
import { ingestChannelEvent, syncChannelImages } from './channelSync.js';
import { startWatchdog } from './watchdog.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const publicDir = path.join(process.cwd(), 'public');
const hasPublicDir = await fs.access(publicDir).then(() => true).catch(() => false);

app.disable('x-powered-by');
if (String(process.env.TRUST_PROXY).toLowerCase() === 'true') app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' }));

function guardDashboard(req, res, next) {
  const expected = process.env.DASHBOARD_TOKEN;
  if (!expected) return next();
  const supplied = req.get('x-dashboard-token') || req.query.token;
  if (supplied !== expected) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function safeSessionName() {
  return `orihime_${crypto.randomUUID().replace(/-/g, '').slice(0, 22)}`;
}

function sanitizeSessionPublic(s) {
  return {
    name: s.name,
    status: s.status || 'UNKNOWN',
    ownerJid: s.ownerJid || null,
    prefix: s.prefix || '.',
    mode: s.mode || 'PRIVATE',
    engine: s.engine || process.env.WHATSAPP_ENGINE || 'GOWS',
    channelId: s.channelId || null,
    channelName: s.channelName || null,
    channelImageCount: s.channelImageCount || 0,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt || null,
    recoveryAttempts: s.recoveryAttempts || 0,
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

app.get('/api/stats', guardDashboard, async (_req, res) => {
  const sessions = listStored().filter((s) => !s.removed);
  const working = sessions.filter((s) => s.status === 'WORKING');
  res.json({
    userCount: sessions.length,
    connectedCount: working.length,
    sessions: sessions.map(sanitizeSessionPublic),
    commandImages: Object.keys(listChannelImages()).length,
    uptime: process.uptime()
  });
});

app.get('/api/sessions', guardDashboard, async (_req, res) => {
  res.json(listStored().map(sanitizeSessionPublic));
});

function normalizePhoneNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function isValidInternationalPhone(phoneNumber) {
  return /^[1-9]\d{6,14}$/.test(phoneNumber);
}

async function waitForPairingReady(name, timeoutMs = 20000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = await getSession(name);
      const status = String(last?.status || '').toUpperCase();
      // STOPPED is excluded here: WAHA reports STOPPED momentarily right after
      // POST /start while the engine spins up, which is not a real failure.
      // Waiting it out avoids requesting a pairing code before the session exists.
      if (status === 'SCAN_QR_CODE' || status === 'WORKING' || status === 'FAILED') return last;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return last;
}

app.post('/api/link', guardDashboard, async (req, res) => {
  const phoneNumber = normalizePhoneNumber(req.body?.phoneNumber);
  if (!isValidInternationalPhone(phoneNumber)) {
    return res.status(400).json({ error: 'Enter your full phone number in international format, digits only. Example: 2348163201351' });
  }

  const name = safeSessionName();
  try {
    const created = await createSession(name);
    await upsertSession(name, {
      status: created?.status || 'STARTING',
      engine: created?.engine?.engine || process.env.WHATSAPP_ENGINE || 'GOWS',
      mode: 'PRIVATE',
      prefix: '.',
      createdAt: new Date().toISOString(),
      pairingPhone: phoneNumber.slice(-4).padStart(4, '*'),
      removed: false
    });

    // WAHA's POST /api/sessions only saves the session config — it does NOT
    // start it. Without this call, /auth/request-code 404s with "start it
    // first", which is exactly the failure being fixed here.
    try {
      await startSession(name);
    } catch (error) {
      const status = error?.response?.status;
      // Some WAHA builds auto-start on create and reject a second /start
      // call (409/422) — that's fine and not a real failure.
      if (status !== 409 && status !== 422) throw error;
    }

    const ready = await waitForPairingReady(name);
    if (String(ready?.status || '').toUpperCase() === 'WORKING') {
      return res.status(409).json({ error: 'This session is already connected. Remove it before generating a new pairing code.', session: name, status: 'WORKING' });
    }

    const result = await requestPairingCode(name, phoneNumber);
    await upsertSession(name, { status: ready?.status || created?.status || 'STARTING', updatedAt: Date.now() });
    return res.status(201).json({
      session: name,
      status: ready?.status || created?.status || 'STARTING',
      code: result?.code || null,
      phoneLast4: phoneNumber.slice(-4)
    });
  } catch (error) {
    // Avoid leaving a half-created session behind when pairing code generation fails.
    try { await logoutSession(name); } catch {}
    try { await deleteSession(name); } catch {}
    await removeSession(name);
    return res.status(502).json({ error: 'Could not generate pairing code', details: error?.response?.data || error?.message || String(error) });
  }
});

app.get('/api/link/:session/status', guardDashboard, async (req, res) => {
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
    }
    const latest = getStored(session);
    res.json({ session: sanitizeSessionPublic(latest), me });
  } catch (error) {
    res.status(502).json({ error: 'Could not query WAHA session', details: error?.response?.data || error?.message || String(error) });
  }
});

app.post('/api/link/:session/pairing-code', guardDashboard, async (req, res) => {
  const session = req.params.session;
  const stored = getStored(session);
  if (!stored || stored.removed) return res.status(404).json({ error: 'Session not found' });
  const phoneNumber = normalizePhoneNumber(req.body?.phoneNumber);
  if (!isValidInternationalPhone(phoneNumber)) {
    return res.status(400).json({ error: 'Enter your full phone number in international format, digits only. Example: 2348163201351' });
  }
  try {
    const remote = await getSession(session);
    const remoteStatus = String(remote?.status || '').toUpperCase();
    if (remoteStatus === 'WORKING') {
      return res.status(409).json({ error: 'This WhatsApp session is already connected.' });
    }
    // A session can be STOPPED between attempts (WAHA restart, cold container, etc.).
    // Restart it before asking for a new code, or request-code 404s the same way
    // the original bug did.
    if (remoteStatus === 'STOPPED' || remoteStatus === 'FAILED' || remoteStatus === 'UNKNOWN') {
      try { await startSession(session); } catch (error) {
        const status = error?.response?.status;
        if (status !== 409 && status !== 422) throw error;
      }
      await waitForPairingReady(session);
    }
    const result = await requestPairingCode(session, phoneNumber);
    await upsertSession(session, { pairingPhone: phoneNumber.slice(-4).padStart(4, '*'), updatedAt: Date.now() });
    res.json({ code: result?.code || null, phoneLast4: phoneNumber.slice(-4) });
  } catch (error) {
    res.status(502).json({ error: 'Could not request pairing code', details: error?.response?.data || error?.message || String(error) });
  }
});

app.post('/api/link/:session/remove', guardDashboard, async (req, res) => {
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

app.get('/api/channel-images', guardDashboard, (_req, res) => {
  const images = listChannelImages();
  res.json(Object.values(images).map((x) => ({
    key: x.key,
    messageId: x.messageId,
    updatedAt: x.updatedAt,
    hasLocal: Boolean(x.localPath)
  })));
});

app.post('/api/channel/sync/:session', guardDashboard, async (req, res) => {
  try {
    res.json(await syncChannelImages(req.params.session));
  } catch (error) {
    res.status(502).json({ error: 'Channel sync failed', details: error?.response?.data || error?.message || String(error) });
  }
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
  const supplied = req.query.secret || '';
  const expected = process.env.WEBHOOK_SECRET || 'change-me';
  if (supplied !== expected) return res.status(401).json({ error: 'Invalid webhook secret' });
  res.sendStatus(200);
  const event = req.body;
  const session = event?.session;
  if (!session) return;
  try {
    if (event.event === 'session.status') {
      const status = event?.payload?.status || event?.payload?.payload?.status || 'UNKNOWN';
      await upsertSession(session, { status, updatedAt: Date.now(), ownerJid: event?.me?.id || getStored(session)?.ownerJid || null });
    }
    if (event.event === 'group.v2.participants' || event.event === 'group.v2.join' || event.event === 'group.v2.leave') {
      await handleGroupEvent(session, event.event, event.payload);
    }
    if (event.event === 'message' || event.event === 'message.any') {
      const payload = event?.payload;
      await ingestChannelEvent(session, payload);
      await handleWebhookEvent(session, payload);
    }
  } catch (error) {
    console.error('[webhook]', error?.response?.data || error?.message || error);
  }
});

if (hasPublicDir) {
  app.use(express.static(publicDir, { extensions: ['html'] }));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
} else {
  app.get('/', (_req, res) => res.json({ ok: true, service: 'Orihime MD', message: 'Backend is running.' }));
}

await initStore();

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
  }
} catch (error) {
  console.error('[startup] could not reconcile WAHA sessions:', error?.message || error);
}

startWatchdog();

app.listen(port, () => {
  console.log(`Orihime MD listening on port ${port}`);
});
