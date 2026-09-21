import crypto from 'node:crypto';
import {
  createSession,
  getSession,
  startSession,
  requestPairingCode,
  logoutSession,
  deleteSession
} from './waha.js';
import { upsertSession, removeSession } from './store.js';

export function normalizePhoneNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

export function isValidInternationalPhone(phoneNumber) {
  return /^[1-9]\d{6,14}$/.test(phoneNumber);
}

export function generateSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function safeSessionName() {
  return `orihime_${crypto.randomUUID().replace(/-/g, '').slice(0, 22)}`;
}

export async function waitForPairingReady(name, timeoutMs = 20000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = await getSession(name);
      const status = String(last?.status || '').toUpperCase();
      // STOPPED is excluded here: WAHA reports STOPPED momentarily right after
      // POST /start while the engine spins up, which is not a real failure.
      if (status === 'SCAN_QR_CODE' || status === 'WORKING' || status === 'FAILED') return last;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return last;
}

// Creates a brand-new Orihime session for `phoneNumber` and returns a pairing
// code for it. This is the ONE place that logic lives — the web dashboard
// (POST /api/link) and the in-chat `.pair <number>` command both call this,
// so pairing behaves identically no matter which door someone walks through.
// No admin/dashboard token is required to call this: anyone with a phone
// number can pair their own account to their own fresh Orihime session.
export async function createPairingSession(phoneNumber) {
  const digits = normalizePhoneNumber(phoneNumber);
  if (!isValidInternationalPhone(digits)) {
    return { ok: false, error: 'Enter a full phone number in international format, digits only. Example: 2348163201351' };
  }

  const name = safeSessionName();
  const token = generateSessionToken();
  try {
    const created = await createSession(name);
    await upsertSession(name, {
      status: created?.status || 'STARTING',
      engine: created?.engine?.engine || process.env.WHATSAPP_ENGINE || 'GOWS',
      mode: 'PRIVATE',
      prefix: '.',
      token,
      createdAt: new Date().toISOString(),
      pairingPhone: digits.slice(-4).padStart(4, '*'),
      removed: false
    });

    try {
      await startSession(name);
    } catch (error) {
      const status = error?.response?.status;
      if (status !== 409 && status !== 422) throw error;
    }

    const ready = await waitForPairingReady(name);
    if (String(ready?.status || '').toUpperCase() === 'WORKING') {
      return { ok: false, error: 'That session is already connected. Remove it before generating a new pairing code.', session: name, status: 'WORKING' };
    }

    const result = await requestPairingCode(name, digits);
    await upsertSession(name, { status: ready?.status || created?.status || 'STARTING', updatedAt: Date.now() });
    return {
      ok: true,
      session: name,
      token,
      status: ready?.status || created?.status || 'STARTING',
      code: result?.code || null,
      phoneLast4: digits.slice(-4)
    };
  } catch (error) {
    try { await logoutSession(name); } catch {}
    try { await deleteSession(name); } catch {}
    try { await removeSession(name); } catch {}
    return { ok: false, error: 'Could not generate pairing code', details: error?.response?.data || error?.message || String(error) };
  }
}
