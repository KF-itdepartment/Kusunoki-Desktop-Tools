'use strict';

// The desktop application deliberately knows only this integration endpoint.
// The x.gd API key is held by the Worker and never crosses this process
// boundary.
const SHORTEN_ENDPOINT = 'https://analytics-url-generator.kf-itdepartment.workers.dev/api/shorten';
const SHORT_URL_ORIGIN = 'https://x.gd';
const SHORT_URL_HOST = 'x.gd';
const SHORTEN_TIMEOUT_MS = 12_000;
const MAX_REQUEST_URL_LENGTH = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SHORTID_PATTERN = /^[0-9a-zA-Z_]{6,15}$/u;

class UrlServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'UrlServiceError';
    this.code = code;
    if (Number.isInteger(details.status)) this.status = details.status;
    this.cause = undefined;
  }
}

function safeError(code, message, status) {
  return new UrlServiceError(code, message, status === undefined ? {} : { status });
}

function parseHttpUrl(value, label = 'URL') {
  if (typeof value !== 'string') throw safeError('invalid-input', `${label}を入力してください。`);
  const text = value.trim();
  if (!text || text.length > MAX_REQUEST_URL_LENGTH) {
    throw safeError('invalid-input', `${label}が長すぎるか、入力されていません。`);
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw safeError('invalid-input', `${label}の形式が不正です。`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw safeError('invalid-input', `${label}はHTTPまたはHTTPSで入力してください。`);
  }
  return { text, parsed };
}

function validateShortenInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw safeError('invalid-input', '短縮リクエストの形式が不正です。');
  }
  const { text: longUrl } = parseHttpUrl(input.longUrl, '長いURL');
  const shortid = input.shortid == null ? '' : String(input.shortid).trim();
  if (shortid && !SHORTID_PATTERN.test(shortid)) {
    throw safeError('invalid-input', 'shortidは6〜15文字の英数字または_で入力してください。');
  }
  return Object.freeze({ longUrl, shortid });
}

function responseStatus(response) {
  const value = Number(response?.status);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : 0;
}

function isJsonContentType(value) {
  return /^application\/json(?:\s*;|\s*$)/iu.test(String(value || '').trim());
}

function responseContentType(response) {
  const headers = response?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get('content-type') || '');
  if (typeof headers === 'object') {
    const key = Object.keys(headers).find((name) => name.toLowerCase() === 'content-type');
    return key ? String(headers[key] || '') : '';
  }
  return '';
}

function byteLength(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

async function readResponseText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const body = response?.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (!part || part.done) break;
        const chunk = part.value instanceof Uint8Array
          ? part.value
          : part.value instanceof ArrayBuffer
            ? new Uint8Array(part.value)
            : new Uint8Array(part.value || []);
        size += chunk.byteLength;
        if (size > maxBytes) {
          try { await reader.cancel(); } catch { /* best effort */ }
          throw safeError('too-large', '短縮サービスの応答が大きすぎます。');
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof UrlServiceError) throw error;
      throw safeError('response-read', '短縮サービスの応答を読み取れませんでした。');
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw safeError('invalid-response', '短縮サービスから不正な応答が返りました。');
    }
  }
  if (!response || typeof response.text !== 'function') {
    throw safeError('invalid-response', '短縮サービスから不正な応答が返りました。');
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw safeError('response-read', '短縮サービスの応答を読み取れませんでした。');
  }
  if (byteLength(text) > maxBytes) throw safeError('too-large', '短縮サービスの応答が大きすぎます。');
  return String(text);
}

function messageForStatus(status) {
  switch (status) {
    case 400: return '短縮リクエストの内容を確認してください。';
    case 401: return '短縮サービスの認証に失敗しました。';
    case 403: return '短縮サービスへのアクセスが拒否されました。';
    case 409: return '指定したshortidは既に使用されています。';
    case 429: return '短縮サービスの利用制限に達しました。時間をおいて再試行してください。';
    case 500: return '短縮サービスでエラーが発生しました。';
    case 503: return '短縮サービスが一時的に利用できません。時間をおいて再試行してください。';
    default: return status >= 400 ? 'URLの短縮に失敗しました。' : '短縮サービスから不正な応答が返りました。';
  }
}

function errorForStatus(status) {
  return safeError('http', messageForStatus(status), status);
}

function validateShortUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw safeError('invalid-response', '短縮サービスから不正な応答が返りました。');
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw safeError('invalid-response', '短縮サービスから不正な応答が返りました。');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || (hostname !== SHORT_URL_HOST && !hostname.endsWith(`.${SHORT_URL_HOST}`)) || !parsed.pathname || parsed.pathname === '/') {
    throw safeError('invalid-response', '短縮サービスから不正な応答が返りました。');
  }
  if (parsed.username || parsed.password) throw safeError('invalid-response', '短縮サービスから不正な応答が返りました。');
  return parsed.toString();
}

function validateResponsePayload(payload, longUrl, status) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw safeError('invalid-response', '短縮サービスから不正な応答が返りました。', status);
  }
  // A Worker error is represented as JSON even when its HTTP status is 200;
  // map only the numeric status and never forward its message/body.
  if (payload.ok !== true) {
    const workerStatus = Number(payload.status);
    if (Number.isInteger(workerStatus) && workerStatus >= 400 && workerStatus <= 599) throw errorForStatus(workerStatus);
    throw safeError('invalid-response', '短縮サービスから不正な応答が返りました。', status);
  }
  const shortUrl = validateShortUrl(payload.shortUrl);
  if (typeof payload.originalUrl !== 'string' || payload.originalUrl !== longUrl) {
    throw safeError('invalid-response', '短縮サービスの応答URLが一致しません。', status);
  }
  if (typeof payload.analytics !== 'boolean' || typeof payload.filterbots !== 'boolean') {
    throw safeError('invalid-response', '短縮サービスから不正な応答が返りました。', status);
  }
  return Object.freeze({
    shortUrl,
    originalUrl: longUrl,
    analytics: payload.analytics,
    filterbots: payload.filterbots
  });
}

async function fetchWithTimeout(fetchImpl, endpoint, options, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const requestOptions = controller ? { ...options, signal: controller.signal } : options;
  let timer;
  try {
    const request = Promise.resolve().then(() => fetchImpl(endpoint, requestOptions));
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { controller?.abort(); } catch { /* best effort */ }
        reject(safeError('timeout', '短縮サービスへの接続がタイムアウトしました。'));
      }, timeoutMs);
    });
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (error instanceof UrlServiceError) throw error;
    throw safeError('network', '短縮サービスに接続できませんでした。');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function shortenUrl(input, options = {}) {
  const { longUrl, shortid } = validateShortenInput(input);
  const dependencies = typeof options === 'function' ? { fetch: options } : options && typeof options === 'object' ? options : {};
  const fetchImpl = dependencies.fetchImpl || dependencies.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw safeError('network', '短縮サービスに接続できませんでした。');
  const endpoint = SHORTEN_ENDPOINT;
  const timeoutMs = Number.isFinite(Number(dependencies.timeoutMs)) && Number(dependencies.timeoutMs) > 0
    ? Number(dependencies.timeoutMs)
    : SHORTEN_TIMEOUT_MS;
  const response = await fetchWithTimeout(fetchImpl, endpoint, {
    method: 'POST',
    headers: Object.freeze({ 'content-type': 'application/json', accept: 'application/json' }),
    body: JSON.stringify({ longUrl, shortid })
  }, timeoutMs);
  const status = responseStatus(response);
  if (!status) throw safeError('invalid-response', '短縮サービスから不正な応答が返りました。');
  const contentType = responseContentType(response);
  if (status < 200 || status >= 300) throw errorForStatus(status);
  if (!isJsonContentType(contentType)) throw safeError('content-type', '短縮サービスの応答形式が不正です。', status);
  const text = await readResponseText(response, Number(dependencies.maxResponseBytes) || MAX_RESPONSE_BYTES);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw safeError('invalid-json', '短縮サービスから不正な応答が返りました。', status);
  }
  return validateResponsePayload(payload, longUrl, status);
}

function createUrlService(options = {}) {
  const serviceOptions = { ...options };
  return Object.freeze({
    shorten: (input) => shortenUrl(input, serviceOptions)
  });
}

module.exports = {
  SHORTEN_ENDPOINT,
  URL_SHORTEN_ENDPOINT: SHORTEN_ENDPOINT,
  SHORT_URL_ORIGIN,
  SHORTEN_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  SHORTID_PATTERN,
  UrlServiceError,
  UrlShortenError: UrlServiceError,
  parseHttpUrl,
  validateShortenInput,
  validateShortUrl,
  readResponseText,
  shortenUrl,
  createUrlService
};
