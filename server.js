import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import cors from 'cors';
import {
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
  listChannelImages,
  storageBackend
} from './store.js';
import { handleWebhookEvent, handleGroupEvent } from './bot.js';
import { ingestChannelEvent, syncChannelImages, ensureChannelFollow, startChannelWatcher } from './channelSync.js';
import { startWatchdog } from './watchdog.js';
import { normalizePhoneNumber, isValidInternationalPhone, createPairingSession, waitForPairingReady } from './pairing.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const publicDir = path.join(process.cwd(), 'public');
const hasPublicDir = await fs.access(publicDir).then(() => true).catch(() => false);

app.disable('x-powered-by');
if (String(process.env.TRUST_PROXY).toLowerCase() === 'true') app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' }));

// NOTE: there is intentionally no dashboard-token / auth gate anywhere in this
// file anymore. Every route below — including the stats and session-management
// endpoints — is open. Anyone can open the site, pair their own WhatsApp
// account, and manage the session they created. If you need to keep this
// backend private, put it behind your own reverse-proxy auth instead.

function sanitizeSessionPublic(s) {
  return {
    name: s.name,
    token: s.token || null,
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

app.get('/api/stats', async (_req, res) => {
  const sessions = listStored().filter((s) => !s.removed);
  const working = sessions.filter((s) => s.status === 'WORKING');
  res.json({
    userCount: sessions.length,
    connectedCount: working.length,
    sessions: sessions.map(sanitizeSessionPublic),
    commandImages: Object.keys(listChannelImages()).length,
    storageBackend: storageBackend(),
    uptime: process.uptime()
  });
});

app.get('/api/sessions', async (_req, res) => {
  res.json(listStored().map(sanitizeSessionPublic));
});

app.post('/api/link', async (req, res) => {
  const result = await createPairingSession(req.body?.phoneNumber);
  if (!result.ok) {
    const code = result.status === 'WORKING' ? 409 : (result.details ? 502 : 400);
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

app.get('/api/channel-images', (_req, res) => {
  const images = listChannelImages();
  res.json(Object.values(images).map((x) => ({
    key: x.key,
    messageId: x.messageId,
    updatedAt: x.updatedAt,
    hasLocal: Boolean(x.localPath)
  })));
});

app.post('/api/channel/sync/:session', async (req, res) => {
  try {
    // ?deep=true forces a full re-walk of the channel's entire history
    // (back to its creation) instead of the fast recent-messages pass.
    const deep = String(req.query.deep || '').toLowerCase() === 'true';
    res.json(await syncChannelImages(req.params.session, { deep }));
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
      const wasWorking = String(getStored(session)?.status || '').toUpperCase() === 'WORKING';
      await upsertSession(session, { status, updatedAt: Date.now(), ownerJid: event?.me?.id || getStored(session)?.ownerJid || null });
      // The moment a user finishes linking (session flips to WORKING), join the
      // channel and pull its media right away instead of waiting on the
      // watchdog's next poll — so freshly-linked users can use commands immediately.
      if (String(status).toUpperCase() === 'WORKING' && !wasWorking) {
        // deep:true walks the channel's FULL history right away (back to
        // its creation), so commands work immediately even for media that
        // was posted long before this session linked/followed.
        ensureChannelFollow(session)
          .then(() => syncChannelImages(session, { deep: true }))
          .catch((error) => console.error('[webhook] auto-join channel:', error?.message || error));
      }
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
console.log(`[storage] backend: ${storageBackend()}`);

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
startChannelWatcher();

app.listen(port, () => {
  console.log(`Orihime MD listening on port ${port}`);
});
