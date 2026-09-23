#!/bin/sh
set -eu

# Render supplies PORT and RENDER_EXTERNAL_URL automatically for web services.
export PORT="${PORT:-10000}"
export WHATSAPP_API_PORT="${WHATSAPP_API_PORT:-3000}"
export WHATSAPP_API_HOSTNAME="${WHATSAPP_API_HOSTNAME:-127.0.0.1}"
export WHATSAPP_DEFAULT_ENGINE="${WHATSAPP_DEFAULT_ENGINE:-GOWS}"
export WAHA_LOCAL_STORE_BASE_DIR="${WAHA_LOCAL_STORE_BASE_DIR:-/app/.sessions}"
export WHATSAPP_FILES_FOLDER="${WHATSAPP_FILES_FOLDER:-/app/.media}"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-${RENDER_EXTERNAL_URL:-}}"

# WAHA global webhooks apply to every session in this container. Using only
# message.any avoids processing the same command twice through message + message.any.
if [ -n "${WHATSAPP_HOOK_URL:-}" ]; then
  export WHATSAPP_HOOK_URL="${WHATSAPP_HOOK_URL}"
  export WHATSAPP_HOOK_EVENTS="${WHATSAPP_HOOK_EVENTS:-message.any,message.revoked,session.status,group.v2.participants}"
elif [ -n "${PUBLIC_BASE_URL:-}" ]; then
  export WHATSAPP_HOOK_URL="${PUBLIC_BASE_URL%/}/webhooks/waha?secret=${WEBHOOK_SECRET:-change-me}"
  export WHATSAPP_HOOK_EVENTS="${WHATSAPP_HOOK_EVENTS:-message.any,message.revoked,session.status,group.v2.participants}"
fi

# Store WAHA authentication/session data in Postgres, not Render's ephemeral
# filesystem. WAHA creates a separate logical database per session/namespace.
if [ -z "${WHATSAPP_SESSIONS_POSTGRESQL_URL:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
  export WHATSAPP_SESSIONS_POSTGRESQL_URL="$DATABASE_URL"
fi

export WHATSAPP_RESTART_ALL_SESSIONS="${WHATSAPP_RESTART_ALL_SESSIONS:-true}"

mkdir -p "$WAHA_LOCAL_STORE_BASE_DIR" "$WHATSAPP_FILES_FOLDER" /orihime/data

# Render Blueprints generate WAHA_API_KEY automatically. For local runs without one,
# create a temporary random key so both WAHA and Orihime use the same key.
if [ -z "${WAHA_API_KEY:-}" ]; then
  WAHA_API_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  export WAHA_API_KEY
  echo "[render] Generated an in-container WAHA API key for this run."
fi

# WEBHOOK_SECRET must be stable in Render (render.yaml uses generateValue: true).
# For local development only, generate a temporary value when one is not supplied.
if [ -z "${WEBHOOK_SECRET:-}" ]; then
  WEBHOOK_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  export WEBHOOK_SECRET
  echo "[render] Generated an in-container webhook secret for this run."
fi

RUN_LOCAL_WAHA="${RUN_LOCAL_WAHA:-true}"

if [ "$(printf %s "$RUN_LOCAL_WAHA" | tr '[:upper:]' '[:lower:]')" = "false" ]; then
  echo "[render] External WAHA mode enabled; not starting a local WAHA process."
  echo "[render] Orihime will use WAHA_URL=${WAHA_URL:-<missing>}"
else
  echo "[render] Starting WAHA GOWS on 127.0.0.1:${WHATSAPP_API_PORT} (Render PORT=${PORT})"
  PORT="$WHATSAPP_API_PORT" WHATSAPP_API_PORT="$WHATSAPP_API_PORT" WHATSAPP_API_HOSTNAME="$WHATSAPP_API_HOSTNAME" node /app/dist/main &
  WAHA_PID=$!

  # Give WAHA time to open its HTTP port before the bot starts.
  READY_TIMEOUT="${WAHA_READY_TIMEOUT_S:-120}"
  i=0
  while [ "$i" -lt "$READY_TIMEOUT" ]; do
    if node -e "fetch('http://127.0.0.1:' + process.env.WHATSAPP_API_PORT + '/ping').then(() => process.exit(0)).catch(() => process.exit(1))"; then
      break
    fi
    if ! kill -0 "$WAHA_PID" 2>/dev/null; then
      echo "[render] WAHA exited before becoming ready."
      exit 1
    fi
    i=$((i + 1))
    if [ "$((i % 15))" -eq 0 ]; then
      echo "[render] Still waiting for WAHA to be ready (${i}s elapsed, timeout ${READY_TIMEOUT}s)..."
    fi
    sleep 1
  done

  if [ "$i" -ge "$READY_TIMEOUT" ]; then
    echo "[render] WAHA did not become ready within ${READY_TIMEOUT}s."
    if [ -n "${WAHA_PID:-}" ]; then kill "$WAHA_PID" 2>/dev/null || true; fi
    exit 1
  fi
fi

echo "[render] Starting Orihime MD on port ${PORT}"
node server.js &
BOT_PID=$!

KEEPALIVE_INTERVAL_MS="${KEEPALIVE_INTERVAL_MS:-600000}"
keepalive() {
  while :; do
    sleep "$((KEEPALIVE_INTERVAL_MS / 1000))" || true
    [ -n "${PUBLIC_BASE_URL:-}" ] || continue
    node -e "fetch(process.env.PUBLIC_BASE_URL.replace(/\/$/, '') + '/api/health').catch(() => {})" >/dev/null 2>&1 || true
  done
}
keepalive &
KEEPALIVE_PID=$!

shutdown() {
  echo "[render] Shutting down Orihime MD + WAHA..."
  kill "$BOT_PID" 2>/dev/null || true
  if [ -n "${WAHA_PID:-}" ]; then kill "$WAHA_PID" 2>/dev/null || true; fi
  kill "${KEEPALIVE_PID:-0}" 2>/dev/null || true
  wait "$BOT_PID" 2>/dev/null || true
  if [ -n "${WAHA_PID:-}" ]; then wait "$WAHA_PID" 2>/dev/null || true; fi
}
trap shutdown INT TERM EXIT

# If either process dies, restart the whole container so Render can recover it.
while :; do
  if [ -n "${WAHA_PID:-}" ] && ! kill -0 "$WAHA_PID" 2>/dev/null; then
    echo "[render] WAHA stopped unexpectedly."
    exit 1
  fi
  if ! kill -0 "$BOT_PID" 2>/dev/null; then
    echo "[render] Orihime backend stopped unexpectedly."
    exit 1
  fi
  sleep 5
done
