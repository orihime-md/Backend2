import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendCustomLinkPreview } from './waha.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PREVIEW_IMAGE = path.join(ROOT, 'public', 'assets', 'web-preview.png');
const MAX_BODY_QUERY = 1600;
let imageDataCache = null;

function enabled() {
  return String(process.env.WEB_PREVIEW_ENABLED || 'true').toLowerCase() === 'true';
}

function publicBaseUrl() {
  const base = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '';
  return String(base).replace(/\/$/, '');
}

function clean(text) {
  return String(text || '')
    .replace(/[*_~`]/g, '')
    .replace(/\r/g, '')
    .trim();
}

async function previewImageData(fallbackBuffer = null) {
  if (fallbackBuffer?.length) return fallbackBuffer.toString('base64');
  if (imageDataCache) return imageDataCache;
  try {
    imageDataCache = (await fs.readFile(PREVIEW_IMAGE)).toString('base64');
    return imageDataCache;
  } catch {
    return null;
  }
}

export function webPreviewEnabled() {
  return enabled() && Boolean(publicBaseUrl());
}

export async function sendWebPreviewCard(session, chatId, { command = 'response', title = '', description = '', body = '', imageBuffer = null } = {}) {
  if (!webPreviewEnabled()) return null;

  const safeTitle = clean(title).slice(0, 120) || `Orihime MD · ${command}`;
  const safeDescription = clean(description || body).replace(/\n+/g, ' ').slice(0, 300) || 'A futuristic Orihime MD response.';
  const pageParams = new URLSearchParams({
    command: String(command || 'response').slice(0, 80),
    title: safeTitle.slice(0, 160),
    text: clean(body).slice(0, MAX_BODY_QUERY)
  });
  const url = `${publicBaseUrl()}/preview?${pageParams.toString()}`;
  const imageData = await previewImageData(imageBuffer);

  const payload = {
    text: `${safeTitle}\n${url}`,
    linkPreviewHighQuality: false,
    preview: {
      url,
      title: safeTitle,
      description: safeDescription
    }
  };
  if (imageData) payload.preview.image = { data: imageData };

  try {
    return await sendCustomLinkPreview(session, chatId, payload);
  } catch (error) {
    console.error('[web-preview] custom preview failed:', error?.response?.data || error?.message || error);
    return null;
  }
}
