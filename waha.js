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

export async function createSession(name) {
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
  const webhookUrl = `${publicBaseUrl.replace(/\/$/, '')}/webhooks/waha?secret=${encodeURIComponent(process.env.WEBHOOK_SECRET || 'change-me')}`;
  return request('post', '/api/sessions', {
    data: {
      name,
      config: {
        webhooks: [
          {
            url: webhookUrl,
            events: ['message', 'message.any', 'session.status', 'group.v2.participants', 'group.v2.join', 'group.v2.leave']
          }
        ]
      }
    }
  });
}

export async function getSession(name) {
  return request('get', `/api/sessions/${encodeURIComponent(name)}`, { timeout: 15000 });
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

export async function listChannels(name) {
  return request('get', `/api/${encodeURIComponent(name)}/channels`, { timeout: 30000 });
}

export async function getChannel(name, ref) {
  return request('get', `/api/${encodeURIComponent(name)}/channels/${encodeURIComponent(ref)}`, { timeout: 30000 });
}

export async function followChannel(name, id) {
  return request('post', `/api/${encodeURIComponent(name)}/channels/${encodeURIComponent(id)}/follow`, { timeout: 30000 });
}

export async function getChannelMessages(name, channelId, limit = 100) {
  return request('get', `/api/${encodeURIComponent(name)}/chats/${encodeURIComponent(channelId)}/messages?downloadMedia=true&limit=${limit}`, { timeout: 60000 });
}

export async function getChannelPreview(name, ref, limit = 100) {
  return request('get', `/api/${encodeURIComponent(name)}/channels/${encodeURIComponent(ref)}/messages/preview?downloadMedia=true&limit=${limit}`, { timeout: 60000 });
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

export async function deleteMessage(name, chatId, messageId) {
  return request('delete', `/api/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, { timeout: 30000 });
}

export async function getParticipants(name, groupId) {
  return request('get', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/participants`, { timeout: 30000 });
}

export async function getGroup(name, groupId) {
  return request('get', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}`, { timeout: 30000 });
}

export async function setGroupMessagesAdminOnly(name, groupId, adminsOnly) {
  return request('put', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/settings/security/messages-admin-only`, {
    data: { adminsOnly: Boolean(adminsOnly) }
  });
}

export async function removeParticipants(name, groupId, participants) {
  return request('post', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/participants/remove`, {
    data: { participants }
  });
}

export async function addParticipants(name, groupId, participants) {
  return request('post', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/participants/add`, {
    data: { participants }
  });
}

export async function promoteParticipants(name, groupId, participants) {
  return request('post', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/admin/promote`, {
    data: { participants }
  });
}

export async function demoteParticipants(name, groupId, participants) {
  return request('post', `/api/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/admin/demote`, {
    data: { participants }
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
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    headers: headers()
  });
  return {
    buffer: Buffer.from(response.data),
    contentType: response.headers['content-type'] || 'application/octet-stream'
  };
}

export { WAHA_URL };
