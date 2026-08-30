const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');

const MAX_TEXT_LENGTH = 4096;
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml']);
const ONLINE_API_URL = 'https://qr-generator.kf-itdepartment.workers.dev/api/qr';
const ONLINE_TIMEOUT_MS = 10_000;
const MAX_ONLINE_RESPONSE_BYTES = 2 * 1024 * 1024;
// Cloudflare and intermediary request-line limits are much smaller than the
// local logo limit. Refuse an oversized query before making a request.
const MAX_ONLINE_REQUEST_LENGTH = 64 * 1024;
const QR_MODES = Object.freeze({ ONLINE: 'online', OFFLINE: 'offline' });
const ALLOWED_QR_MODES = new Set(Object.values(QR_MODES));

class OnlineQrError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'OnlineQrError';
    this.code = code;
    if (status !== null) this.status = status;
  }
}

function onlineError(code, status = null) {
  switch (code) {
    case 'timeout':
      return new OnlineQrError(code, 'オンラインQR APIがタイムアウトしました。', status);
    case 'http':
      return new OnlineQrError(code, `オンラインQR APIがエラーを返しました（HTTP ${status}）。`, status);
    case 'content-type':
      return new OnlineQrError(code, 'オンラインQR APIの応答形式が不正です。', status);
    case 'empty':
      return new OnlineQrError(code, 'オンラインQR APIから空の画像を受信しました。', status);
    case 'too-large':
      return new OnlineQrError(code, 'オンラインQR APIの応答が大きすぎます。', status);
    case 'invalid-svg':
      return new OnlineQrError(code, 'オンラインQR APIから壊れたSVGを受信しました。', status);
    case 'request-too-large':
      return new OnlineQrError(code, '入力がオンラインQR APIの上限を超えています。', status);
    case 'unavailable':
    default:
      return new OnlineQrError('network', 'オンラインQR APIに接続できませんでした。', status);
  }
}

function dataUriFromBytes(mimeType, bytes) {
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
    throw new TypeError('ロゴはPNG、JPEG、またはSVGのみ使用できます。');
  }
  const value = Buffer.from(bytes);
  if (value.length === 0 || value.length > MAX_LOGO_BYTES) {
    throw new RangeError('ロゴ画像のサイズが大きすぎます。');
  }
  return `data:${mimeType};base64,${value.toString('base64')}`;
}

function parseDataUri(value) {
  const match = /^data:(image\/(?:png|jpeg|svg\+xml));(?:base64,([\s\S]*)|([\s\S]*))$/iu.exec(value);
  if (!match) throw new TypeError('ロゴには画像のdata URLを指定してください。');
  let bytes;
  if (match[2] !== undefined) {
    const encoded = match[2].replace(/\s+/gu, '');
    if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 === 1) {
      throw new TypeError('ロゴのdata URLを読み込めません。');
    }
    try {
      bytes = Buffer.from(encoded, 'base64');
    } catch {
      throw new TypeError('ロゴのdata URLを読み込めません。');
    }
  } else {
    try {
      bytes = Buffer.from(decodeURIComponent(match[3]), 'utf8');
    } catch {
      throw new TypeError('ロゴのdata URLを読み込めません。');
    }
  }
  return dataUriFromBytes(match[1].toLowerCase(), bytes);
}

function loadDefaultLogo(rootDirectory) {
  const candidates = [
    path.join(rootDirectory, 'vendor', 'qr-generator', 'public', 'logo.png'),
    // Keep the generated copy as a package fallback for source archives that
    // omit submodule working trees. The submodule path above is canonical.
    path.join(rootDirectory, 'renderer', 'generated', 'upstream', 'qr', 'logo.png'),
    path.join(rootDirectory, 'renderer', 'assets', 'logo.png')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return dataUriFromBytes('image/png', fs.readFileSync(candidate));
  }
  return null;
}

function normaliseAngle(value, fallback = 315) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const angle = Number.isFinite(parsed) ? parsed : fallback;
  return ((angle % 360) + 360) % 360;
}

function escapeText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function normaliseQrMode(value) {
  if (!ALLOWED_QR_MODES.has(value)) throw new TypeError('QR生成モードが不正です。');
  return value;
}

function validateQrText(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError('QRコード化する文字列を入力してください。');
  if (text.length > MAX_TEXT_LENGTH) throw new RangeError('入力は4096文字以内にしてください。');
  return text;
}

function validateSvgResponse(value) {
  const svg = String(value ?? '').trim();
  if (!svg) throw onlineError('empty');
  if (Buffer.byteLength(svg, 'utf8') > MAX_ONLINE_RESPONSE_BYTES) throw onlineError('too-large');

  // The API is expected to return one complete SVG document. This lightweight
  // validation deliberately avoids a parser dependency while rejecting common
  // truncated responses and active/external content before renderer display.
  const complete = /^(?:<\?xml[^>]*>\s*)?(?:<!--(?:[^-]|-(?!->))*-->\s*)*<svg\b[\s\S]*<\/svg>\s*$/iu.test(svg);
  if (!complete || /<!doctype\b|<\/?(?:script|foreignObject)\b|\bon[\w:-]+\s*=|(?:href|xlink:href)\s*=\s*["'](?:https?:|\/\/)/iu.test(svg)) {
    throw onlineError('invalid-svg');
  }
  return svg;
}

function getResponseHeader(response, name) {
  const headers = response?.headers;
  if (headers && typeof headers.get === 'function') {
    const direct = headers.get(name);
    if (direct !== null && direct !== undefined && direct !== '') return String(direct);
    const titleCase = name.replace(/(^|-)([a-z])/gu, (_match, separator, character) => `${separator}${character.toUpperCase()}`);
    const titled = headers.get(titleCase);
    if (titled !== null && titled !== undefined && titled !== '') return String(titled);
  }
  if (headers instanceof Map) {
    const wanted = name.toLowerCase();
    for (const [key, value] of headers.entries()) {
      if (String(key).toLowerCase() === wanted) return String(value || '');
    }
  }
  if (headers && typeof headers === 'object') {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() === wanted) return String(value || '');
    }
  }
  return '';
}

async function readOnlineResponseText(response) {
  const contentLength = Number.parseInt(getResponseHeader(response, 'content-length'), 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_ONLINE_RESPONSE_BYTES) throw onlineError('too-large');

  let body;
  try {
    if (typeof response?.text === 'function') body = await response.text();
    else if (typeof response?.arrayBuffer === 'function') body = Buffer.from(await response.arrayBuffer()).toString('utf8');
    else throw onlineError('content-type');
  } catch (error) {
    if (error instanceof OnlineQrError) throw error;
    throw onlineError('network');
  }
  if (typeof body !== 'string') throw onlineError('invalid-svg');
  return validateSvgResponse(body);
}

function onlineRequestUrl({ text, logoDataUrl, angle, noLogo = false } = {}) {
  const value = validateQrText(text);
  const url = new URL(ONLINE_API_URL);
  url.searchParams.set('text', value);
  url.searchParams.set('angle', String(normaliseAngle(angle, logoDataUrl ? 0 : 315)));
  if (noLogo) url.searchParams.set('noLogo', 'true');
  else if (logoDataUrl) url.searchParams.set('logoUrl', parseDataUri(String(logoDataUrl)));
  if (url.toString().length > MAX_ONLINE_REQUEST_LENGTH) throw onlineError('request-too-large');
  return url;
}

async function generateQrOnline(input = {}, rootDirectory, options = {}) {
  const payload = input && typeof input === 'object' ? input : {};
  const requestUrl = onlineRequestUrl(payload);
  const dependencies = typeof options === 'function'
    ? { fetchImpl: options }
    : typeof options === 'number' && Number.isFinite(options)
    ? { timeoutMs: Number(options) }
    : rootDirectory && typeof rootDirectory === 'object' && !Array.isArray(rootDirectory)
    && options && typeof options === 'object' && Object.keys(options).length === 0
    ? rootDirectory
    : options && typeof options === 'object' ? options : {};
  const fetchImpl = dependencies.fetchImpl || dependencies.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw onlineError('network');
  const timeoutMs = Number.isFinite(Number(dependencies.timeoutMs))
    ? Math.max(1, Number(dependencies.timeoutMs))
    : ONLINE_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  let response;
  try {
    const request = Promise.resolve().then(() => fetchImpl(requestUrl.toString(), {
      method: 'GET',
      headers: { Accept: 'image/svg+xml' },
      signal: controller?.signal
    }));
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(onlineError('timeout'));
      }, timeoutMs);
    });
    response = await Promise.race([request, timeout]);
  } catch (error) {
    if (error instanceof OnlineQrError) throw error;
    if (error?.name === 'AbortError') throw onlineError('timeout');
    throw onlineError('network');
  } finally {
    if (timer) clearTimeout(timer);
  }

  const status = Number(response?.status);
  if (status !== 200) throw onlineError('http', Number.isFinite(status) ? status : 0);
  const contentType = getResponseHeader(response, 'content-type').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'image/svg+xml') throw onlineError('content-type', status);
  const svg = await readOnlineResponseText(response);
  return { svg, text: validateQrText(payload.text), mimeType: 'image/svg+xml' };
}

async function generateQrLocal({ text, logoDataUrl, angle, noLogo = false } = {}, rootDirectory) {
  const value = validateQrText(text);

  const qrSvg = await QRCode.toString(value, {
    type: 'svg',
    width: 400,
    margin: 2,
    errorCorrectionLevel: 'H'
  });
  let finalSvg = qrSvg;
  if (!noLogo) {
    const logo = logoDataUrl
      ? parseDataUri(String(logoDataUrl))
      : loadDefaultLogo(rootDirectory || process.cwd());
    if (logo) {
      const match = /viewBox=["']0 0 ([\d.]+) ([\d.]+)["']/iu.exec(qrSvg);
      const size = match ? Number.parseFloat(match[1]) : 400;
      const center = size / 2;
      const logoSize = size * 0.3;
      const half = logoSize / 2;
      const safeLogo = escapeText(logo);
      const defaultAngle = logoDataUrl ? 0 : 315;
      const group = `  <g transform="translate(${center}, ${center}) rotate(${normaliseAngle(angle, defaultAngle)})">\n` +
        `    <rect x="-${half}" y="-${half}" width="${logoSize}" height="${logoSize}" fill="white" />\n` +
        `    <image href="${safeLogo}" x="-${half}" y="-${half}" width="${logoSize}" height="${logoSize}" />\n` +
        '  </g>\n</svg>';
      finalSvg = qrSvg.replace('</svg>', group);
    }
  }
  return { svg: finalSvg, text: value, mimeType: 'image/svg+xml' };
}

async function generateQrByMode(input = {}, rootDirectory, options = {}) {
  const payload = input && typeof input === 'object' ? input : {};
  const mode = normaliseQrMode(payload.mode ?? QR_MODES.OFFLINE);
  if (mode === QR_MODES.ONLINE) return generateQrOnline(payload, rootDirectory, options);
  return generateQrLocal(payload, rootDirectory);
}

// Keep the historical local `generateQr` API intact for callers that do not
// provide a mode, while allowing tests/integrators to exercise the mode-aware
// path through the same service entry point.
async function generateQr(input = {}, rootDirectory, options = {}) {
  if (input && Object.prototype.hasOwnProperty.call(input, 'mode')) return generateQrByMode(input, rootDirectory, options);
  return generateQrLocal(input, rootDirectory);
}

module.exports = {
  ALLOWED_IMAGE_TYPES,
  ALLOWED_QR_MODES,
  QR_MODES,
  ONLINE_API_URL,
  ONLINE_TIMEOUT_MS,
  MAX_ONLINE_RESPONSE_BYTES,
  MAX_ONLINE_REQUEST_LENGTH,
  MAX_LOGO_BYTES,
  MAX_TEXT_LENGTH,
  OnlineQrError,
  dataUriFromBytes,
  generateQr,
  generateQrByMode,
  generateQrLocal,
  generateQrOnline,
  normaliseQrMode,
  buildOnlineRequestUrl: onlineRequestUrl,
  normaliseAngle,
  parseDataUri,
  validateSvgResponse
};
