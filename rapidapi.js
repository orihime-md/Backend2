import axios from 'axios';

const RAPIDAPI_KEY = (process.env.RAPIDAPI_KEY || '').trim();
const RAPIDAPI_HOST = (process.env.RAPIDAPI_YOUTUBE_HOST || 'youtube-search-download3.p.rapidapi.com').trim();
const RAPIDAPI_BASE = `https://${RAPIDAPI_HOST}`;
const SEARCH_PATH = process.env.RAPIDAPI_YOUTUBE_SEARCH_PATH || '/search';
const DOWNLOAD_PATH = process.env.RAPIDAPI_YOUTUBE_DOWNLOAD_PATH || '/download';

export function rapidApiConfigured() {
  return Boolean(RAPIDAPI_KEY);
}

function headers() {
  return {
    'X-RapidAPI-Key': RAPIDAPI_KEY,
    'X-RapidAPI-Host': RAPIDAPI_HOST,
    Accept: 'application/json'
  };
}

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstString(obj, keys) {
  for (const key of keys) {
    const value = safeString(obj?.[key]);
    if (value) return value;
  }
  return '';
}

function walkForVideo(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = walkForVideo(item);
      if (hit) return hit;
    }
    return null;
  }

  const videoId = firstString(obj, ['videoId', 'video_id', 'id']);
  const title = firstString(obj, ['title', 'name']);
  if (videoId) return { videoId, title };

  for (const value of Object.values(obj)) {
    const hit = walkForVideo(value);
    if (hit) return hit;
  }
  return null;
}

function collectUrls(obj, path = '') {
  const hits = [];
  if (!obj || typeof obj !== 'object') return hits;
  if (Array.isArray(obj)) {
    obj.forEach((value, index) => hits.push(...collectUrls(value, `${path}[${index}]`)));
    return hits;
  }

  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      const priority = /(^|_)(mp3|audio)(_|$)|audio|download|stream|url/i.test(lower) ? 20 : 1;
      hits.push({ url: value, priority, path: `${path}.${key}` });
    } else if (value && typeof value === 'object') {
      hits.push(...collectUrls(value, `${path}.${key}`));
    }
  }
  return hits;
}

async function rapidGet(path, params) {
  if (!rapidApiConfigured()) throw new Error('RAPIDAPI_KEY is not configured');
  try {
    const response = await axios.get(`${RAPIDAPI_BASE}${path}`, {
      params,
      headers: headers(),
      timeout: 45000,
      validateStatus: () => true
    });
    if (response.status < 200 || response.status >= 300) {
      const detail = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {});
      throw new Error(`RapidAPI HTTP ${response.status}: ${detail.slice(0, 220)}`);
    }
    return response.data;
  } catch (error) {
    if (error?.response?.status) {
      const detail = typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data || {});
      throw new Error(`RapidAPI HTTP ${error.response.status}: ${detail.slice(0, 220)}`);
    }
    throw error;
  }
}

export function extractYoutubeVideoId(input) {
  const value = safeString(input);
  if (!value) return '';
  if (/^[A-Za-z0-9_-]{8,20}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0];
    if (/youtube\.com$/i.test(url.hostname) || /(^|\.)youtube\.com$/i.test(url.hostname)) {
      return url.searchParams.get('v') || '';
    }
  } catch {}
  const match = value.match(/[?&]v=([A-Za-z0-9_-]{8,20})/i);
  return match?.[1] || '';
}

export async function rapidYoutubeSearch(query) {
  const data = await rapidGet(SEARCH_PATH, { query: query.trim() });
  const direct = walkForVideo(data);
  if (direct?.videoId) return direct;
  throw new Error('RapidAPI returned no YouTube result');
}

export async function rapidYoutubeDownload(videoId) {
  const data = await rapidGet(DOWNLOAD_PATH, { video: videoId });
  const urls = collectUrls(data).sort((a, b) => b.priority - a.priority);
  const audio = urls.find((entry) => /audio|mp3/i.test(entry.path)) || urls[0];
  if (!audio?.url) throw new Error('RapidAPI returned no downloadable audio URL');

  const response = await axios.get(audio.url, {
    responseType: 'arraybuffer',
    timeout: 180000,
    maxContentLength: 60 * 1024 * 1024,
    maxBodyLength: 60 * 1024 * 1024,
    validateStatus: (status) => status >= 200 && status < 300
  });

  return {
    buffer: Buffer.from(response.data),
    contentType: String(response.headers['content-type'] || 'audio/mpeg').split(';')[0],
    url: audio.url
  };
}
