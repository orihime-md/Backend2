import { listSessions as listStored } from './store.js';

// A Render Free instance is intentionally kept conservative: one active
// WhatsApp GOWS account by default when WAHA runs in the same container.
// Set MAX_ACTIVE_SESSIONS=0 for unlimited (recommended only when WAHA is
// hosted separately on a machine with enough RAM/CPU).
const DEFAULT_LOCAL_LIMIT = 1;
const reservations = new Set();

function readLimit() {
  const raw = String(process.env.MAX_ACTIVE_SESSIONS ?? '').trim();
  if (!raw) return DEFAULT_LOCAL_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : DEFAULT_LOCAL_LIMIT;
}

function activeStoredSessions() {
  return listStored().filter((s) => !s?.removed).length;
}

export function getSessionCapacity() {
  const limit = readLimit();
  const active = activeStoredSessions();
  const reserved = reservations.size;
  const used = active + reserved;
  return {
    limit,
    active,
    reserved,
    used,
    unlimited: limit === 0,
    available: limit === 0 ? null : Math.max(0, limit - used),
    runLocalWaha: String(process.env.RUN_LOCAL_WAHA ?? 'true').toLowerCase() !== 'false'
  };
}

export function reserveSessionSlot(name) {
  if (!name) throw new Error('A session name is required for capacity reservation.');
  if (reservations.has(name)) return { ok: true, reserved: true, capacity: getSessionCapacity() };

  const capacity = getSessionCapacity();
  if (capacity.limit > 0 && capacity.used >= capacity.limit) {
    return {
      ok: false,
      reserved: false,
      capacity,
      error: `Session capacity is full (${capacity.limit} active slot${capacity.limit === 1 ? '' : 's'}). Remove an existing session or move WAHA to a larger/external host for multi-user mode.`
    };
  }

  reservations.add(name);
  return { ok: true, reserved: true, capacity: getSessionCapacity() };
}

export function releaseSessionSlot(name) {
  if (name) reservations.delete(name);
}
