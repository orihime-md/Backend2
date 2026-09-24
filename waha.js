import axios from 'axios';

const WAHA_URL = (process.env.WAHA_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const API_KEY = process.env.WAHA_API_KEY || '';

function headers(extra = {}) {
  return {
    ...(API_KEY ? { 'X-Api-Key': API_KEY } : {}),
    ...extra
  };
}

async function request(method, url, options = {}) {
  const response = await axios({
    method,
    url: `${WAHA_URL}${url}`,
    timeout: options.timeout || 30000,
    headers: headers(options.headers),
    ...options,
    headers: headers(options.headers)
  });
  return response.data;
}

export function wahaPublicUrl(url) {
  if (!url) return url;
  if (url.startsWith('http://localhost:3000')) return `${WAHA_URL}${url.slice('http://localhost:3000'.length)}`;
  if (url.startsWith('http://127.0.0.1:3000')) return `${WAHA_URL}${url.slice('http://127.0.0.1:3000'.length)}`;
  return url;
}

// Shared by createSession() and resyncWebhook() so a session's webhook
// config is always built from whatever WEBHOOK_SECRET currently holds.
// If WEBHOOK_SECRET is ever changed (rotated in Render, or regenerated),
// any session created under the OLD secret keeps posting to a URL with the
// stale secret baked in, and every webhook delivery 401s forever until the
// session is re-registered — that's the "Retrying 15/15" WEBHOOK_SECRET
// mismatch loop. resyncWebhook() below re-PUTs this config so existing
// sessions pick up the current secret without needing to be recreated.
export function buildWebhookConfig() {
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
  const webhookUrl = `${publicBaseUrl.replace(/\/$/, '')}/webhooks/waha?secret=${encodeURIComponent(process.env.WEBHOOK_SECRET || 'change-me')}`;
  return {
    webhooks: [
      {
        url: webhookUrl,
        events: ['message', 'message.revoked', 'session.status', 'group.v2.participants', 'group.v2.join', 'group.v2.leave', 'group.v2.update', 'poll.vote', 'poll.vote.failed']
      }
    ]
  };
}

export async function createSession(name) {
  return request('post', '/api/sessions', {
    data: { name, start: false, config: buildWebhookConfig() }
  });
}

// Re-pushes the current webhook URL/secret to an already-existing WAHA
// session. Call this any time WEBHOOK_SECRET may be out of sync with what a
// session was registered with (startup reconciliation, or the admin "Fix
// webhook secrets" action).
export async function resyncWebhook(name) {
  return updateSession(name, buildWebhookConfig());
}

export async function getSession(name) {
  return request('get', `/api/sessions/${encodeURIComponent(name)}`, { timeout: 15000 });
}

export async function updateSession(name, config) {
  return request('put', `/api/sessions/${encodeURIComponent(name)}`, {
    data: { name, ...(config || {}) },
    timeout: 60000
  });
}

export async function listSessions() {
  return request('get', '/api/sessions?all=true', { timeout: 15000 });
}

export async function startSession(name) {
  return request('post', `/api/sessions/${encodeURIComponent(name)}/start`);
}

export async function restartSession(name) {
  return request('post', `/api/sessions/${encodeURIComponent(name)}/restart`, { timeout: 60000 });
}

export async function logoutSession(name) {
  return request('post', `/api/sessions/${encodeURIComponent(name)}/logout`, { timeout: 60000 });
}

export async function deleteSession(name) {
  return request('delete', `/api/sessions/${encodeURIComponent(name)}`, { timeout: 60000 });
}

export async function getMe(name) {
  return request('get', `/api/sessions/${encodeURIComponent(name)}/me`, { timeout: 15000 });
}

export async function requestPairingCode(name, phoneNumber) {
  return request('post', `/api/${encodeURIComponent(name)}/auth/request-code`, {
    data: { phoneNumber: String(phoneNumber).replace(/\D/g, '') },
    timeout: 30000
  });
}

export async function sendText(name, chatId, text, extra = {}) {
  return request('post', '/api/sendText', {
    data: {
      session: name,
      chatId,
      text,
      ...extra
    }
  });
}

// Interactive messages (buttons / lists). WAHA has changed this endpoint's
// exact request shape across versions and it is NOWEB-engine only — before
// relying on this in production, check the running WAHA instance's own
// Swagger docs at {WAHA_URL}/api/docs (or POST /api/{session}/... if your
// version moved it there) and adjust the payload shape if it 422s.
// `extra` is passed through as-is so callers (menu.js) control the exact
// header/body/footer/buttons or sections structure WAHA expects.
export async function sendButtons(name, chatId, extra = {}) {
  return request('post', '/api/sendButtons', {
    data: { session: name, chatId, ...extra },
    timeout: 30000
  });
}

export async function sendPoll(name, chatId, extra = {}) {
  return request('post', '/api/sendPoll', {
    data: { session: name, chatId, ...extra },
    timeout: 30000
  });
}

export async function sendList(name, chatId, extra = {}) {
  return request('post', '/api/sendList', {
    data: { session: name, chatId, ...extra },
    timeout: 30000
  });
}

export async function sendCustomLinkPreview(name, chatId, extra = {}) {
  return request('post', '/api/send/link-custom-preview', {
    data: { session: name, chatId, ...extra },
    timeout: 60000
  });
}

export async function sendImage(name, chatId, file, caption = '') {
  return request('post', '/api/sendImage', {
    data: {
      session: name,
      chatId,
      file,
      caption
    },
    timeout: 120000
  });
}

// WAHA's dedicated sticker endpoint expects an actual WebP payload; it does
// not convert JPEG/PNG for us. Keep this wrapper strict so a failed sticker
// conversion cannot silently turn into a normal image message.
export async function sendSticker(name, chatId, file) {
  return request('post', '/api/sendSticker', {
    data: { session: name, chatId, file },
    timeout: 120000
  });
}

// Fetch ONE message by id (used to read the message someone replied to).
// downloadMedia=true asks WAHA to fetch the media so media.url is populated.
export async function getMessage(name, chatId, messageId) {
  return request('get', `/api/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}?downloadMedia=true`, { timeout: 90000 });
}

export async function sendVideo(name, chatId, file, caption = '') {
  return request('post', '/api/sendVideo', { data: { session: name, chatId, file, caption }, timeout: 180000 });
}

export async function sendVoice(name, chatId, file) {
  return request('post', '/api/sendVoice', { data: { session: name, chatId, file }, timeout: 120000 });
}

export async function sendFile(name, chatId, file, caption = '') {
  return request('post', '/api/sendFile', { data: { session: name, chatId, file, caption }, timeout: 180000 });
}

// Edits a message's text in place (used for the "moving" .menu animation
// below). Not every WAHA engine/version supports this — NOWEB does, WEBJS
// does not, and even on NOWEB it only works on the account's own recent
// messages — so callers should be ready for this to throw and fall back.
export async function editMessage(name, chatId, messageId, text) {
  return request('put', `/api/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, {
    data: { text },
    timeout: 20000
  });
}

export async function deleteMessage(name, chatId, messageId) {
  return request('delete', `/api/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, { timeout: 30000 });
}

export async function getParticipants(name, groupId) {
  return request('get', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/participants`, { timeout: 30000 });
}

export async function getParticipantsV2(name, groupId) {
  return request('get', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/participants/v2`, { timeout: 30000 });
}

function participantBody(participants) {
  return (Array.isArray(participants) ? participants : []).map((participant) => {
    if (typeof participant === 'string') return { id: participant };
    if (participant && typeof participant === 'object' && participant.id) return { id: participant.id };
    return { id: participant };
  });
}

export async function getGroups(name, params = {}) {
  return request('get', `/api/${encodeURIComponent(name)}/groups`, { params, timeout: 30000 });
}

export async function getGroup(name, groupId) {
  return request('get', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}`, { timeout: 30000 });
}

export async function createGroup(name, subject, participants = []) {
  return request('post', `/api/${encodeURIComponent(name)}/groups`, {
    data: { name: String(subject || 'New Group').slice(0, 100), participants: participantBody(participants) },
    timeout: 60000
  });
}

export async function setGroupSubject(name, groupId, subject) {
  return request('put', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/subject`, {
    data: { subject: String(subject || '').slice(0, 100) }, timeout: 30000
  });
}

export async function setGroupDescription(name, groupId, description) {
  return request('put', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/description`, {
    data: { description: String(description || '').slice(0, 512) }, timeout: 30000
  });
}

export async function getGroupPicture(name, groupId) {
  return request('get', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/picture?refresh=false`, { timeout: 30000 });
}

export async function setGroupPicture(name, groupId, file) {
  return request('put', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/picture`, {
    data: { file }, timeout: 60000
  });
}

const SECURITY_PATHS = {
  'info-admin-only': 'info-admin-only',
  'messages-admin-only': 'messages-admin-only',
  'member-add-mode': 'member-add-mode',
  'membership-approval': 'membership-approval'
};

export async function getGroupSecurity(name, groupId, setting) {
  const path = SECURITY_PATHS[setting] || setting;
  return request('get', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/settings/security/${encodeURIComponent(path)}`, { timeout: 30000 });
}

export async function setGroupSecurity(name, groupId, setting, data) {
  const path = SECURITY_PATHS[setting] || setting;
  return request('put', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/settings/security/${encodeURIComponent(path)}`, {
    data, timeout: 30000
  });
}

export async function setGroupMessagesAdminOnly(name, groupId, adminsOnly) {
  return request('put', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/settings/security/messages-admin-only`, {
    data: { adminsOnly: Boolean(adminsOnly) }
  });
}

export async function removeParticipants(name, groupId, participants) {
  return request('post', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/participants/remove`, {
    data: { participants: participantBody(participants) }
  });
}

export async function addParticipants(name, groupId, participants) {
  return request('post', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/participants/add`, {
    data: { participants: participantBody(participants) }
  });
}

export async function promoteParticipants(name, groupId, participants) {
  return request('post', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/admin/promote`, {
    data: { participants: participantBody(participants) }
  });
}

export async function demoteParticipants(name, groupId, participants) {
  return request('post', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/admin/demote`, {
    data: { participants: participantBody(participants) }
  });
}

export async function getInviteCode(name, groupId) {
  return request('get', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/invite-code`, { timeout: 30000 });
}

export async function leaveGroup(name, groupId) {
  return request('post', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/leave`, { timeout: 30000 });
}

export async function downloadMedia(mediaUrl) {
  const url = wahaPublicUrl(mediaUrl);
  const maxBytes = Math.max(5 * 1024 * 1024, Number(process.env.MAX_MEDIA_BYTES || 50 * 1024 * 1024));
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 90000,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    headers: headers()
  });
  return {
    buffer: Buffer.from(response.data),
    contentType: response.headers['content-type'] || 'application/octet-stream'
  };
}

export { WAHA_URL };
