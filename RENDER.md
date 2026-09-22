# Render deployment checklist

## What you are deploying

**One service only:**

```text
orihime-md
├── Orihime backend
└── WAHA GOWS
```

No VPS is required by this configuration.

## Render steps

1. Put this project in GitHub.
2. In Render, choose **New → Blueprint** and connect the repository.
3. Render reads `render.yaml`, which now also provisions a free Postgres
   database (`orihime-db`) and wires its connection string into the web
   service as `DATABASE_URL` automatically — no manual setup needed.
4. Use the Free plan when prompted (for both the web service and the database).
5. `BOT_OWNER_PHONE` is now OPTIONAL. Each linked WhatsApp account is
   automatically the owner of its own session (able to run
   `.public`/`.private`/`.setprefix` on itself) — you don't need to set this
   for that to work. Only set it if you want one phone number to have owner
   access across every linked session (e.g. for support).
6. There is no dashboard token to configure — every route, including pairing
   at `/api/link`, is open to anyone with the URL.
7. Leave `WAHA_API_KEY` alone: Render generates it automatically.
8. Leave `WEBHOOK_SECRET` alone: Render generates it automatically.
9. Deploy.
10. Copy the generated `https://...onrender.com` URL.
11. Put that URL into `public/index.html` as `API_BASE` and publish the page with GitHub Pages.

## What the container does

At startup:

```text
Render container
   ├── WAHA GOWS → 127.0.0.1:3000
   └── Orihime MD → $PORT
```

The Orihime backend uses:

```text
WAHA_URL=http://127.0.0.1:3000
```

The webhook callback uses Render's automatic `RENDER_EXTERNAL_URL` unless `PUBLIC_BASE_URL` is explicitly set. WAHA's global webhook covers every linked session in the container, while per-session webhooks remain compatible for already-created sessions; Orihime deduplicates duplicate delivery.

Each linked WhatsApp account receives a unique `orihime_<random-id>` session. Group settings are stored under `session + groupId`, so one user's `.welcome`, `.left`, `.autod`, `.kill-sale`, etc. cannot overwrite another user's group settings. WAHA authentication/session data is pointed at the configured Postgres URL rather than relying only on the ephemeral container filesystem.

## Free-plan warning

Render Free services spin down after 15 minutes with no inbound traffic and use ephemeral local storage. This can interrupt a WhatsApp session and can remove locally stored WAHA authentication data. The package is therefore suitable for testing/hobby deployment on Free, not as a guarantee of permanent 24/7 WhatsApp uptime. The backend watchdog will restart failed/stopped WAHA sessions while the service is running, but Render Free can still spin the whole service down after inactivity; an always-on service plan or an external inbound monitor is required for a true 24/7 guarantee. citehttps://render.com/docs/free

Session/group/prefix/mode/command-history data now lives in Postgres, so
that part survives a redeploy or spin-down. Two things still don't:

- **WAHA's own WhatsApp auth state** (`/app/.sessions`) — a spin-down/redeploy
  can still force a re-pair, same as before. A Render persistent disk mounted
  at that path removes this limitation if you need it.
- **Command images** are committed individually at repository root and are copied into every Docker deploy. They do not depend on a WhatsApp Channel, channel history, or background synchronization.
