# 🌸 Orihime MD — Render Edition

Anime-styled WhatsApp bot control panel + Node.js backend using **WAHA GOWS**.

This edition is arranged specifically for **one Render Web Service** so you do not need a separate VPS or a second WAHA server.

## What this package includes

- `public/index.html` — phone-number pairing page.
- Multiple independent WAHA sessions, one per linked WhatsApp account.
- Phone-number pairing: enter the full international number (for example `2348163201351`) and receive a pairing code.
- Automatic follow of the configured Orihime WhatsApp Channel after a session reaches `WORKING`.
- Channel image synchronizer: exact captions such as `.menu`, `.joke`, `.antilink on`, `.repel` become command-image keys.
- Universal `Santen Kesshun!” — 三天結盾` → delay → delete → image/status response pipeline.
- `.public` / `.private` access mode per linked bot session.
- Group moderation and admin checks.
- `.tagall` sends one mention per group member, in sequence.
- Automatic watchdog recovery for stopped/failed managed sessions.
- Runtime command history and channel media cache.

## 🌐 Render architecture

The Render edition runs everything in **one Docker web service**:

```text
GitHub Pages (website)
        ↓
Render: Orihime MD + WAHA GOWS
        ↓
WhatsApp
```

WAHA runs privately inside the same container on `127.0.0.1:3000`. Orihime MD listens on Render's public `$PORT` (normally `10000`) and talks to WAHA internally.

Render supports Docker-based web services. See https://render.com/docs/docker and https://render.com/docs/blueprint-spec.

## 🔑 Do I need to find a WAHA API token?

**No.** This Render edition uses:

```yaml
generateValue: true
```

for `WAHA_API_KEY` and `WEBHOOK_SECRET` in `render.yaml`.

Render generates and stores those values for the service. You do not put the API key in the website and you do not need to search for it somewhere else.

WAHA authenticates API requests with its API key. This project uses the browser-free GOWS engine. See https://waha.devlike.pro/docs/how-to/config/ and https://waha.devlike.pro/docs/engines/gows/.

## 🚀 Render deployment

### 1. Put the project in GitHub

Upload the **entire contents of this ZIP** to a GitHub repository. Keep `render.yaml`, `Dockerfile`, `render-entrypoint.sh`, `backend/`, `public/`, and the other files in the repository root.

### 2. Create the Render service

In Render:

**New → Blueprint** (or use the repository's `render.yaml` configuration).

Select the GitHub repository containing this project.

The Blueprint creates one service named:

```text
orihime-md
```

Set the service to the **Free** compute plan if Render asks you to choose a plan.

### 3. Fill the owner number

In the Render service environment variables, set:

```text
BOT_OWNER_PHONE=234XXXXXXXXXX
```

Use international digits only, without `+`.

### 4. Do NOT create a separate WAHA service

You do **not** need another Render service for WAHA.

You do **not** need:

- a VPS
- an Ubuntu server
- SSH
- a public WAHA URL

The included Docker image starts WAHA automatically inside the same Render service.

### 5. Get your Render URL

After deployment, Render gives the service an `onrender.com` URL.

Render supplies `RENDER_EXTERNAL_URL` automatically at runtime, so the webhook URL is built from the actual service URL without hard-coding it. See https://render.com/docs/environment-variables.

### 6. Connect GitHub Pages

Open:

```text
public/index.html
```

Find:

```js
const API_BASE = 'https://YOUR-RENDER-BACKEND.onrender.com';
```

Replace it with your actual Render service URL:

```js
const API_BASE = 'https://your-service.onrender.com';
```

Then upload `index.html` to your GitHub Pages repository.

### 7. Test pairing

Open the GitHub Pages website.

Enter a number such as:

```text
2348163201351
```

Tap **Generate pairing code**.

Then on the primary WhatsApp phone:

**WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number**

Enter the code shown by Orihime MD.

WAHA currently exposes `POST /api/{session}/auth/request-code` for pairing-code authentication. See https://waha.devlike.pro/swagger/.

## ⚠️ Important Render Free-plan limitation

This package is configured to work as a **single Render Free Web Service**, but Render Free services spin down after 15 minutes without inbound traffic and have an ephemeral filesystem. When a free service spins down, changes in its local filesystem are lost. Render also provides 750 Free instance hours per workspace each calendar month. See https://render.com/docs/free.

That matters to WAHA because WhatsApp session files are stored locally. The practical result is that a Free Render deployment can require **re-pairing after a sleep/restart/redeploy**. This ZIP does not pretend that Render Free provides permanent WAHA session storage.

For long-term always-on use, you would need a hosting/storage arrangement that keeps the WAHA session data persistent and avoids free-plan sleep.

## 🔄 Recovery behavior

Orihime MD does not call logout/delete during ordinary recovery. It watches the managed sessions and attempts to restart sessions reported by WAHA as `STOPPED` or `FAILED`.

Explicit removal through the panel is the path that logs out and deletes a session.

WhatsApp itself can still invalidate a linked device, in which case fresh pairing may be required.

## 🎨 Add your anime visuals

Put your background at:

```text
public/assets/background.jpg
```

Put slideshow images at:

```text
public/assets/slides/01.jpg
public/assets/slides/02.jpg
public/assets/slides/03.png
```

## 📢 Channel setup

The package is preconfigured for:

```text
https://whatsapp.com/channel/0029VbDOiYGHVvTTnDNd6I2C
```

When a linked account reaches `WORKING`, the backend attempts to follow the channel and synchronize recent command-image messages.

## 🖼️ Command-image rule

Exact command captions are used as image keys:

```text
.menu        -> .menu image
.joke        -> .joke image
.kick        -> .kick image
```

For moderation toggles:

```text
.antilink on   -> .antilink on image
.antilink off  -> .antilink off image
```

## 🧪 Local Docker

For local development:

```bash
cp .env.example .env
docker compose up -d --build
```

The panel is available at:

```text
http://localhost:3000
```

The local Docker startup script runs both WAHA and Orihime MD in the same container.

## 🔐 Security

Do not put `WAHA_API_KEY` in `public/index.html` or any other public website file.

The Render edition binds WAHA to `127.0.0.1` so the WAHA API is not exposed as a separate public service.

## Added group features

- `.welcome on/off` — welcomes new members with the group name and member count; uses the channel image keyed by `.welcom`.
- `.autod @user` — group-admin command that adds a member to the automatic-delete list; incoming messages from that member are immediately deleted when the event/message is received.
- `.left on/off` — enables/disables goodbye messages for members who leave. `.leave` remains the command for making the bot leave a group.
- `.announcement <text>` — sends the announcement while mentioning the current group participants.
- `.close` / `.open` — restricts or allows group member messages.
- `.group-id` — returns the group name, WhatsApp group ID and current member count.
