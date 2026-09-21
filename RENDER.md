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
3. Render reads `render.yaml`.
4. Use the Free plan when prompted.
5. Set `BOT_OWNER_PHONE` in Environment Variables.
6. Leave `WAHA_API_KEY` alone: Render generates it automatically.
7. Leave `WEBHOOK_SECRET` alone: Render generates it automatically.
8. Deploy.
9. Copy the generated `https://...onrender.com` URL.
10. Put that URL into `public/index.html` as `API_BASE` and publish the page with GitHub Pages.

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
