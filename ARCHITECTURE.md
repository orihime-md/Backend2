# Orihime MD architecture — Render edition

## Services

There is one Render Web Service:

- `orihime-md`: Node/Express backend + web panel + WAHA GOWS in the same container.

WAHA listens only on `127.0.0.1:3000` inside the container.
Orihime MD listens on Render's public `$PORT`.

## Why GOWS

GOWS communicates directly with WhatsApp Web over WebSocket and does not require Chromium. Current WAHA documentation lists GOWS support for sessions and pairing-code requests. See https://waha.devlike.pro/docs/engines/gows/ and https://waha.devlike.pro/docs/how-to/sessions/.

## WAHA authentication

`render.yaml` asks Render to generate `WAHA_API_KEY` automatically. The same runtime environment is visible to both WAHA and the Orihime backend, so the backend can call the private WAHA API without requiring a second server.

## Public webhook URL

Render automatically supplies `RENDER_EXTERNAL_URL`. The backend uses:

1. `PUBLIC_BASE_URL`, when explicitly configured;
2. otherwise `RENDER_EXTERNAL_URL` on Render;
3. otherwise `http://localhost:3000` locally.

This lets WAHA send webhooks back to the public Orihime endpoint without manually entering the Render URL in the environment variables.

## Session persistence

WAHA stores session data locally under `/app/.sessions` in this configuration. Render Free web services use ephemeral filesystems, so local session files can be lost after a spin-down, restart, or redeploy. Render explicitly documents that Free services cannot attach persistent disks. See https://render.com/docs/free.

The local Docker Compose setup maps `.sessions` to the host so local authentication can persist.

## Recovery policy

The backend never calls WAHA logout/delete as part of normal recovery. It periodically checks every managed user session:

- `WORKING`: leave alone.
- `STARTING`: leave alone.
- `SCAN_QR_CODE` / `PASSKEY_*`: treat as pending authentication internally.
- `STOPPED` / `FAILED`: attempt restart with a cooldown.
- Explicit user removal: mark session removed and call delete once.

## Phone-number pairing flow

1. The web UI asks for the user's WhatsApp number in full international format, digits only.
2. The backend creates an isolated WAHA session.
3. The backend calls WAHA `POST /api/{session}/auth/request-code` with that phone number.
4. WAHA returns the pairing code.
5. The UI displays the code.
6. The user enters the code in WhatsApp under Linked devices → Link a device → Link with phone number.

No QR code is presented by the Orihime MD web UI.
