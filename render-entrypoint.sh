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

echo "[render] Starting WAHA GOWS on 127.0.0.1:${WHATSAPP_API_PORT}"
node /app/dist/main &
WAHA_PID=$!

# Give WAHA up to 30 seconds to open its HTTP port before the bot starts.
i=0
while [ "$i" -lt 30 ]; do
  if node -e "fetch('http://127.0.0.1:' + process.env.WHATSAPP_API_PORT + '/').then(() => process.exit(0)).catch(() => process.exit(1))"; then
    break
  fi
  if ! kill -0 "$WAHA_PID" 2>/dev/null; then
    echo "[render] WAHA exited before becoming ready."
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$i" -ge 30 ]; then
  echo "[render] WAHA did not become ready within 30 seconds."
  kill "$WAHA_PID" 2>/dev/null || true
  exit 1
fi

echo "[render] Starting Orihime MD on port ${PORT}"
node /orihime/backend/server.js &
BOT_PID=$!

shutdown() {
  echo "[render] Shutting down Orihime MD + WAHA..."
  kill "$BOT_PID" 2>/dev/null || true
  kill "$WAHA_PID" 2>/dev/null || true
  wait "$BOT_PID" 2>/dev/null || true
  wait "$WAHA_PID" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

# If either process dies, restart the whole container so Render can recover it.
while :; do
  if ! kill -0 "$WAHA_PID" 2>/dev/null; then
    echo "[render] WAHA stopped unexpectedly."
    exit 1
  fi
  if ! kill -0 "$BOT_PID" 2>/dev/null; then
    echo "[render] Orihime backend stopped unexpectedly."
    exit 1
  fi
  sleep 5
done
