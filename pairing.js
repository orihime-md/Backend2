import crypto from 'node:crypto';
import {
  createSession,
  getSession,
  startSession,
  requestPairingCode
} from './waha.js';
import { upsertSession } from './store.js';
import { reserveSessionSlot, releaseSessionSlot } from './capacity.js';

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

const PAIRING_IN_FLIGHT = new Map();

export async function waitForPairingReady(name, timeoutMs = Number(process.env.PAIRING_READY_TIMEOUT_MS || 90000)) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = await getSession(name);
      const status = String(last?.status || '').toUpperCase();
      if (status === 'SCAN_QR_CODE' || status === 'PASSKEY_REQUIRED' || status === 'PASSKEY_CONFIRMATION_REQUIRED' || status === 'WORKING' || status === 'FAILED') {
        return last;
      }
    } catch (error) {
      last = { status: 'UNKNOWN', error: error?.response?.data || error?.message || String(error) };
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return last || { status: 'STARTING' };
}

function wahaError(error) {
  return error?.response?.data || error?.message || String(error);
}

// Creates a brand-new Orihime session for `phoneNumber` and returns a pairing
// code for it. Pairing is deliberately isolated from all group/admin scanning.
export async function createPairingSession(phoneNumber) {
  const digits = normalizePhoneNumber(phoneNumber);
  if (!isValidInternationalPhone(digits)) {
    return { ok: false, error: 'Enter a full phone number in international format, digits only. Example: 2348163201351' };
  }

  const existing = PAIRING_IN_FLIGHT.get(digits);
  if (existing) return existing;

  const task = (async () => {
    const name = safeSessionName();
    const token = generateSessionToken();
    const reservation = reserveSessionSlot(name);
    if (!reservation.ok) {
      return { ok: false, error: reservation.error, capacity: reservation.capacity };
    }

    try {
      console.log(`[pairing] creating session ${name} for phone ending ${digits.slice(-4)}`);
      const created = await createSession(name);
      await upsertSession(name, {
        status: created?.status || 'STOPPED',
        engine: created?.engine?.engine || process.env.WHATSAPP_ENGINE || 'GOWS',
        mode: 'PRIVATE',
        prefix: '.',
        token,
        createdAt: new Date().toISOString(),
        pairingPhone: digits.slice(-4).padStart(4, '*'),
        pairingPending: true,
        removed: false
      });

      // createSession() uses start:false, so there is no start race.
      await startSession(name);
      console.log(`[pairing] session ${name} started; waiting for WhatsApp pairing state`);

      const ready = await waitForPairingReady(name);
      const status = String(ready?.status || '').toUpperCase();
      console.log(`[pairing] session ${name} reached ${status || 'UNKNOWN'}`);

      if (status === 'WORKING') {
        await upsertSession(name, { pairingPending: false, updatedAt: Date.now() });
        return { ok: false, error: 'That session became connected before a pairing code was requested.', session: name, status };
      }
      if (status === 'PASSKEY_REQUIRED' || status === 'PASSKEY_CONFIRMATION_REQUIRED') {
        await upsertSession(name, { pairingPending: true, updatedAt: Date.now() });
        return {
          ok: false,
          error: 'WhatsApp requires an additional passkey confirmation for this pairing. The session is waiting for that step.',
          session: name,
          status
        };
      }
      if (status === 'FAILED') {
        await upsertSession(name, { pairingPending: false, pairingError: ready?.error || ready?.message || null, updatedAt: Date.now() });
        return {
          ok: false,
          error: 'WAHA reported the new session as FAILED before a pairing code could be requested.',
          session: name,
          status,
          details: ready?.error || ready?.message || null
        };
      }
      if (status !== 'SCAN_QR_CODE') {
        await upsertSession(name, { pairingPending: true, pairingError: `WAHA status: ${status || 'UNKNOWN'}`, updatedAt: Date.now() });
        return {
          ok: false,
          error: `WAHA did not reach SCAN_QR_CODE in time (current status: ${status || 'UNKNOWN'}). Try again once the service is stable.`,
          session: name,
          status: status || 'UNKNOWN'
        };
      }

      const result = await requestPairingCode(name, digits);
      const code = result?.code || null;
      if (!code) throw new Error('WAHA returned no pairing code.');

      await upsertSession(name, {
        status: 'SCAN_QR_CODE',
        pairingPending: true,
        pairingRequestedAt: Date.now(),
        updatedAt: Date.now()
      });

      console.log(`[pairing] code generated for ${name}; phone ending ${digits.slice(-4)}`);
      return {
        ok: true,
        session: name,
        token,
        status: 'SCAN_QR_CODE',
        code,
        phoneLast4: digits.slice(-4)
      };
    } catch (error) {
      console.error(`[pairing] failed for phone ending ${digits.slice(-4)}:`, wahaError(error));
      // Keep the session record for diagnostics if WAHA created it. Do not
      // logout/delete automatically; a transient WAHA error should not turn
      // into a destructive re-pair loop. The explicit Remove action deletes it.
      const details = wahaError(error);
      await upsertSession(name, {
        status: 'FAILED',
        pairingPending: false,
        pairingError: details,
        updatedAt: Date.now()
      }).catch(() => {});
      return { ok: false, error: 'Could not generate pairing code', session: name, status: 'FAILED', details };
    } finally {
      releaseSessionSlot(name);
    }
  })();

  PAIRING_IN_FLIGHT.set(digits, task);
  try {
    return await task;
  } finally {
    PAIRING_IN_FLIGHT.delete(digits);
  }
}
