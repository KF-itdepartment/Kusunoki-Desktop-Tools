const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');

const MAX_TEXT_LENGTH = 4096;
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml']);

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
    try {
      bytes = Buffer.from(match[2], 'base64');
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
    path.join(rootDirectory, 'vendor', 'qr-generator', 'logo.png'),
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

async function generateQr({ text, logoDataUrl, angle, noLogo = false }, rootDirectory) {
  const value = String(text ?? '').trim();
  if (!value) throw new TypeError('QRコード化する文字列を入力してください。');
  if (value.length > MAX_TEXT_LENGTH) throw new RangeError('入力は4096文字以内にしてください。');

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
      : loadDefaultLogo(rootDirectory);
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

module.exports = {
  ALLOWED_IMAGE_TYPES,
  MAX_LOGO_BYTES,
  MAX_TEXT_LENGTH,
  dataUriFromBytes,
  generateQr,
  normaliseAngle,
  parseDataUri
};
