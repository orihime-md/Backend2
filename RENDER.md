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

The webhook callback uses Render's automatic `RENDER_EXTERNAL_URL` unless `PUBLIC_BASE_URL` is explicitly set.

## Free-plan warning

Render Free services spin down after 15 minutes with no inbound traffic and use ephemeral local storage. This can interrupt a WhatsApp session and can remove locally stored WAHA authentication data. The package is therefore suitable for testing/hobby deployment on Free, not as a guarantee of permanent 24/7 WhatsApp uptime. citehttps://render.com/docs/free

Session/group/prefix/mode/command-history data now lives in Postgres, so
that part survives a redeploy or spin-down. Two things still don't:

- **WAHA's own WhatsApp auth state** (`/app/.sessions`) — a spin-down/redeploy
  can still force a re-pair, same as before. A Render persistent disk mounted
  at that path removes this limitation if you need it.
- **Locally cached channel command images** (`data/channel-media/`) — these
  are downloaded copies of whatever you post to the Orihime channel. If wiped,
  the backend automatically re-syncs them from the channel the next time a
  session reconnects, so this self-heals but can cause a brief window where a
  command reply falls back to plain text instead of an image.
