const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const JSZip = require('jszip');

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
const RAW_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
const EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg'
};
const ID_PATTERN = /^[a-f0-9-]{36}$/iu;
const MAX_NAME_LENGTH = 160;
const MAX_TEXT_LENGTH = 4096;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_COUNT = 100;
const MAX_IMPORT_TOTAL_BYTES = 100 * 1024 * 1024;
const ARCHIVE_FORMAT = 'kusunoki-material-archive';
const ARCHIVE_VERSION = 1;
const ARCHIVE_MANIFEST_NAME = 'manifest.json';
const ARCHIVE_EPOCH = new Date(0);

function assertImportBudget(count, totalBytes) {
  if (!Number.isInteger(count) || count < 0 || count > MAX_IMPORT_COUNT) throw new RangeError('一度にインポートできる素材は100件までです。');
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_IMPORT_TOTAL_BYTES) throw new RangeError('一度にインポートできる展開後サイズは100MiBまでです。');
  return true;
}

function assertSafeId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new TypeError('不正な素材IDです。');
  return id.toLowerCase();
}

function safeName(value, fallback = 'QR素材') {
  const name = String(value ?? '').trim().replace(/[\u0000-\u001f<>:"/\\|?*]/gu, '_');
  if (!name) return fallback;
  return [...name].slice(0, MAX_NAME_LENGTH).join('').trim() || fallback;
}

function safeFileName(value, mimeType) {
  const fallback = `qr-material${EXTENSIONS[mimeType] || '.bin'}`;
  const raw = String(value ?? '').trim();
  const basename = path.basename(raw);
  if (!raw || basename !== raw || raw.includes('/') || raw.includes('\\') || raw.includes('..') || /[\u0000-\u001f<>:"|?*]/u.test(raw)) return fallback;
  const extension = path.extname(basename).toLowerCase();
  const allowed = mimeType === 'image/jpeg' ? new Set(['.jpg', '.jpeg']) : new Set([EXTENSIONS[mimeType]]);
  const withoutExtension = basename.slice(0, basename.length - extension.length);
  if (!allowed.has(extension)) return `${safeName(withoutExtension, 'qr-material')}${EXTENSIONS[mimeType] || '.bin'}`;
  return `${safeName(withoutExtension, 'qr-material')}${extension}`;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof value === 'string') {
    // IPC callers may use a base64 string, but reject ambiguous long text.
    return Buffer.from(value, 'base64');
  }
  throw new TypeError('素材データの形式が不正です。');
}

function normalizeMimeType(value, fileName = '') {
  const mimeType = String(value || '').toLowerCase().trim();
  if (RAW_IMAGE_TYPES.has(mimeType)) return mimeType;
  const extension = path.extname(String(fileName)).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.svg') return 'image/svg+xml';
  return '';
}

function hasPrefix(data, bytes) {
  return data.length >= bytes.length && bytes.every((value, index) => data[index] === value);
}

function codePointLength(value) {
  return [...String(value)].length;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function validatePngStructure(data) {
  const value = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!hasPrefix(value, signature)) throw new TypeError('PNGの形式が不正です。');
  let offset = signature.length;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  while (offset < value.length) {
    if (value.length - offset < 12) throw new TypeError('PNGが途中で切れています。');
    const chunkLength = value.readUInt32BE(offset);
    const chunkType = value.subarray(offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/u.test(chunkType.toString('ascii'))) throw new TypeError('PNGチャンクが不正です。');
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    const crcOffset = chunkEnd;
    if (chunkEnd < chunkStart || crcOffset + 4 > value.length) throw new TypeError('PNGチャンクの長さが不正です。');
    const chunkData = value.subarray(chunkStart, chunkEnd);
    if (crc32(Buffer.concat([chunkType, chunkData])) !== value.readUInt32BE(crcOffset)) throw new TypeError('PNGのCRCが不正です。');
    const type = chunkType.toString('ascii');
    if (!sawHeader) {
      if (type !== 'IHDR' || chunkLength !== 13) throw new TypeError('PNGのIHDRが不正です。');
      if (chunkData.readUInt32BE(0) === 0 || chunkData.readUInt32BE(4) === 0) throw new TypeError('PNGの画像サイズが不正です。');
      sawHeader = true;
    } else if (type === 'IHDR') {
      throw new TypeError('PNGに重複したIHDRがあります。');
    }
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') {
      if (chunkLength !== 0) throw new TypeError('PNGのIENDが不正です。');
      sawEnd = true;
      offset = crcOffset + 4;
      break;
    }
    offset = crcOffset + 4;
  }
  if (!sawHeader || !sawData || !sawEnd || offset !== value.length) throw new TypeError('PNGの終端または画像データが不正です。');
  return true;
}

function isJpegStandaloneMarker(marker) {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

function isJpegStartOfFrame(marker) {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf);
}

function validateJpegStructure(data) {
  const value = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (value.length < 4 || value[0] !== 0xff || value[1] !== 0xd8) throw new TypeError('JPEGの形式が不正です。');
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  let sawEnd = false;
  while (offset < value.length) {
    if (value[offset++] !== 0xff) throw new TypeError('JPEGのマーカーが不正です。');
    while (offset < value.length && value[offset] === 0xff) offset += 1;
    if (offset >= value.length) throw new TypeError('JPEGが途中で切れています。');
    const marker = value[offset++];
    if (marker === 0x00) throw new TypeError('JPEGのマーカーが不正です。');
    if (marker === 0xd9) {
      sawEnd = true;
      break;
    }
    if (marker === 0xd8) throw new TypeError('JPEGに不正なSOIがあります。');
    if (isJpegStandaloneMarker(marker)) continue;
    if (offset + 2 > value.length) throw new TypeError('JPEGセグメントが途中で切れています。');
    const segmentLength = value.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > value.length) throw new TypeError('JPEGセグメントの長さが不正です。');
    const segmentStart = offset + 2;
    const segmentEnd = offset + segmentLength;
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 8 || value[segmentStart] === 0 || value.readUInt16BE(segmentStart + 1) === 0 || value.readUInt16BE(segmentStart + 3) === 0 || value[segmentStart + 5] === 0) throw new TypeError('JPEGの画像サイズが不正です。');
      sawFrame = true;
    }
    offset = segmentEnd;
    if (marker === 0xda) {
      sawScan = true;
      let nextMarkerOffset = null;
      while (offset < value.length) {
        if (value[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const candidateOffset = offset;
        offset += 1;
        while (offset < value.length && value[offset] === 0xff) offset += 1;
        if (offset >= value.length) throw new TypeError('JPEGの画像データが途中で切れています。');
        const candidate = value[offset++];
        if (candidate === 0x00 || (candidate >= 0xd0 && candidate <= 0xd7)) continue;
        if (candidate === 0xd9) {
          sawEnd = true;
          break;
        }
        nextMarkerOffset = candidateOffset;
        break;
      }
      if (sawEnd) break;
      if (nextMarkerOffset === null) throw new TypeError('JPEGにEOIがありません。');
      offset = nextMarkerOffset;
    }
  }
  if (!sawFrame || !sawScan || !sawEnd || offset !== value.length) throw new TypeError('JPEGの終端または画像構造が不正です。');
  return true;
}

function validateWebpStructure(data) {
  const value = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (value.length < 20 || value.toString('ascii', 0, 4) !== 'RIFF' || value.toString('ascii', 8, 12) !== 'WEBP') throw new TypeError('WebPの形式が不正です。');
  if (value.readUInt32LE(4) !== value.length - 8) throw new TypeError('WebPのRIFF長が不正です。');
  let offset = 12;
  let sawImage = false;
  while (offset < value.length) {
    if (value.length - offset < 8) throw new TypeError('WebPチャンクが途中で切れています。');
    const chunkType = value.toString('ascii', offset, offset + 4);
    if (!/^[ -~]{4}$/u.test(chunkType)) throw new TypeError('WebPチャンクが不正です。');
    const chunkLength = value.readUInt32LE(offset + 4);
    const chunkEnd = offset + 8 + chunkLength;
    const paddedEnd = chunkEnd + (chunkLength & 1);
    if (chunkEnd < offset + 8 || paddedEnd > value.length) throw new TypeError('WebPチャンクの長さが不正です。');
    const chunkData = value.subarray(offset + 8, chunkEnd);
    if (chunkType === 'VP8 ') {
      if (chunkLength < 10 || !hasPrefix(chunkData.subarray(3), [0x9d, 0x01, 0x2a]) || (chunkData.readUInt16LE(6) & 0x3fff) === 0 || (chunkData.readUInt16LE(8) & 0x3fff) === 0) throw new TypeError('WebPのVP8ヘッダーが不正です。');
      sawImage = true;
    } else if (chunkType === 'VP8L') {
      if (chunkLength < 5 || chunkData[0] !== 0x2f) throw new TypeError('WebPのVP8Lヘッダーが不正です。');
      const dimensions = chunkData.readUInt32LE(1);
      const width = (dimensions & 0x3fff) + 1;
      const height = ((dimensions >>> 14) & 0x3fff) + 1;
      if (width < 1 || height < 1) throw new TypeError('WebPのVP8L画像サイズが不正です。');
      sawImage = true;
    } else if (chunkType === 'VP8X') {
      const width = (chunkData[4] | (chunkData[5] << 8) | (chunkData[6] << 16)) + 1;
      const height = (chunkData[7] | (chunkData[8] << 8) | (chunkData[9] << 16)) + 1;
      if (chunkLength < 10 || width < 1 || height < 1) throw new TypeError('WebPのVP8Xヘッダーが不正です。');
      sawImage = true;
    }
    if ((chunkLength & 1) && value[chunkEnd] !== 0) throw new TypeError('WebPのパディングが不正です。');
    offset = paddedEnd;
  }
  if (!sawImage || offset !== value.length) throw new TypeError('WebPの画像チャンクが不正です。');
  return true;
}

function detectImageMime(data) {
  const value = Buffer.isBuffer(data) ? data : Buffer.from(data);
  try {
    if (hasPrefix(value, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
      validatePngStructure(value);
      return 'image/png';
    }
    if (hasPrefix(value, [0xff, 0xd8])) {
      validateJpegStructure(value);
      return 'image/jpeg';
    }
    if (hasPrefix(value, [0x52, 0x49, 0x46, 0x46]) && value.length >= 12 && value.subarray(8, 12).toString('ascii') === 'WEBP') {
      validateWebpStructure(value);
      return 'image/webp';
    }
  } catch {
    return '';
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(value).replace(/^\uFEFF/u, '').trimStart();
    if (/<svg(?:\s|>)/iu.test(text)) {
      validateSvgData(value);
      return 'image/svg+xml';
    }
  } catch {
    // Binary data is handled by the signatures above.
  }
  return '';
}

function findTagEnd(text, start) {
  let quote = '';
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function validateSvgDataReference(value) {
  const reference = String(value).trim();
  if (reference.startsWith('#')) return;
  const dataMatch = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/iu.exec(reference);
  if (dataMatch) {
    if (dataMatch[2].length % 4 === 1) throw new TypeError('SVGの埋め込み画像が不正です。');
    const decoded = Buffer.from(dataMatch[2], 'base64');
    if (!decoded.length || decoded.toString('base64') !== dataMatch[2]) throw new TypeError('SVGの埋め込み画像が不正です。');
    validateImageData(decoded, `image/${dataMatch[1].toLowerCase()}`);
    return;
  }
  throw new TypeError('SVGの外部参照は使用できません。');
}

function validateSvgAttributes(source) {
  let offset = 0;
  while (offset < source.length) {
    while (/\s/u.test(source[offset] || '')) offset += 1;
    if (offset >= source.length) return;
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/u.exec(source.slice(offset));
    if (!nameMatch) throw new TypeError('SVG属性が不正です。');
    const name = nameMatch[0];
    offset += name.length;
    while (/\s/u.test(source[offset] || '')) offset += 1;
    if (source[offset] !== '=') throw new TypeError('SVG属性が不正です。');
    offset += 1;
    while (/\s/u.test(source[offset] || '')) offset += 1;
    if (offset >= source.length) throw new TypeError('SVG属性値がありません。');
    let value;
    if (source[offset] === '"' || source[offset] === "'") {
      const quote = source[offset++];
      const end = source.indexOf(quote, offset);
      if (end < 0) throw new TypeError('SVG属性の引用符が不正です。');
      value = source.slice(offset, end);
      offset = end + 1;
    } else {
      const valueMatch = /^[^\s"'=<>`]+/u.exec(source.slice(offset));
      if (!valueMatch) throw new TypeError('SVG属性値が不正です。');
      value = valueMatch[0];
      offset += value.length;
    }
    if (/^on[a-z][A-Za-z0-9_.:-]*$/u.test(name)) throw new TypeError('SVGのイベント属性は使用できません。');
    if (/@import\b/iu.test(value)) throw new TypeError('SVGの外部参照は使用できません。');
    if (/^(?:href|src|xlink:href)$/iu.test(name)) validateSvgDataReference(value);
    if (/^style$/iu.test(name)) {
      const urls = [...value.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/giu)];
      for (const match of urls) validateSvgDataReference(match[2]);
      if (/\bdata:/iu.test(value) && urls.length === 0) throw new TypeError('SVGのデータ参照が不正です。');
    }
    if (/^(?:javascript|vbscript|file):/iu.test(value)) throw new TypeError('SVGの外部参照は使用できません。');
  }
}

function validateSvgData(data) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/u, '').trim();
  } catch {
    throw new TypeError('SVGはUTF-8である必要があります。');
  }
  if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new TypeError('SVGの形式が不正です。');
  if (/<!DOCTYPE\b|<!ENTITY\b/iu.test(text)) throw new TypeError('SVGのDOCTYPEまたはENTITYは使用できません。');
  if (/@import\b|url\(\s*["']?(?:https?:|file:|\/\/)/iu.test(text)) throw new TypeError('SVGの外部参照は使用できません。');
  let source = text;
  if (/^<\?xml\b/iu.test(source)) {
    const declarationEnd = source.indexOf('?>');
    if (declarationEnd < 0) throw new TypeError('SVGのXML宣言が不正です。');
    source = source.slice(declarationEnd + 2).trimStart();
  }
  const stack = [];
  let position = 0;
  let rootSeen = false;
  while (position < source.length) {
    const start = source.indexOf('<', position);
    if (start < 0) {
      if (stack.length === 0 && source.slice(position).trim()) throw new TypeError('SVGの末尾が不正です。');
      break;
    }
    if (source.slice(position, start).includes('<')) throw new TypeError('SVGのテキストが不正です。');
    if (source.slice(position, start).trim() && stack.length === 0) throw new TypeError('SVGのルートが不正です。');
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/iu.test(source.slice(position, start))) throw new TypeError('SVGの文字参照が不正です。');
    if (source.startsWith('<!--', start)) {
      const commentEnd = source.indexOf('-->', start + 4);
      if (commentEnd < 0) throw new TypeError('SVGコメントが不正です。');
      position = commentEnd + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', start)) {
      if (stack.length === 0) throw new TypeError('SVGのCDATA位置が不正です。');
      const cdataEnd = source.indexOf(']]>', start + 9);
      if (cdataEnd < 0) throw new TypeError('SVGのCDATAが不正です。');
      position = cdataEnd + 3;
      continue;
    }
    if (source.startsWith('<?', start) || source.startsWith('<!', start)) throw new TypeError('SVGの宣言が不正です。');
    const end = findTagEnd(source, start);
    if (end < 0) throw new TypeError('SVGタグが途中で切れています。');
    let body = source.slice(start + 1, end).trim();
    if (!body) throw new TypeError('SVGタグが空です。');
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(name) || stack.pop() !== name) throw new TypeError('SVGタグの対応関係が不正です。');
    } else {
      const selfClosing = /\/\s*$/u.test(body);
      if (selfClosing) body = body.replace(/\/\s*$/u, '').trimEnd();
      const nameMatch = /^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/u.exec(body);
      if (!nameMatch) throw new TypeError('SVGタグ名が不正です。');
      const name = nameMatch[1];
      if (!rootSeen && name !== 'svg') throw new TypeError('SVGのルート要素が必要です。');
      if (rootSeen && stack.length === 0) throw new TypeError('SVGに複数のルートがあります。');
      if (['script', 'iframe', 'object', 'embed', 'foreignObject'].includes(name)) throw new TypeError('安全でないSVG要素は使用できません。');
      validateSvgAttributes(nameMatch[2]);
      if (!rootSeen) rootSeen = true;
      if (!selfClosing) stack.push(name);
    }
    position = end + 1;
  }
  if (!rootSeen || stack.length !== 0) throw new TypeError('SVGタグの対応関係が不正です。');
  return text;
}

function validateImageData(data, mimeType) {
  const value = toBuffer(data);
  const normalized = normalizeMimeType(mimeType);
  if (!RAW_IMAGE_TYPES.has(normalized)) throw new TypeError('素材はPNG、JPEG、WebP、またはSVGのみ保存できます。');
  if (value.length === 0 || value.length > MAX_FILE_BYTES) throw new RangeError('素材ファイルは10MiB以下にしてください。');
  if (normalized === 'image/svg+xml') validateSvgData(value);
  if (detectImageMime(value) !== normalized) throw new TypeError('素材のMIMEタイプと実データが一致しません。');
  return value;
}

function isZipData(data) {
  const value = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return hasPrefix(value, [0x50, 0x4b, 0x03, 0x04]) || hasPrefix(value, [0x50, 0x4b, 0x05, 0x06]) || hasPrefix(value, [0x50, 0x4b, 0x07, 0x08]);
}

function isSafeArchivePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && value === value.normalize('NFC')
    && !value.includes('\\')
    && !value.includes('\u0000')
    && !value.startsWith('/')
    && !/^[A-Za-z]:/u.test(value)
    && !value.split('/').some((part) => !part || part === '.' || part === '..');
}

function assertArchiveFileName(value, mimeType) {
  if (typeof value !== 'string' || !value.trim() || value !== path.basename(value) || value.includes('/') || value.includes('\\') || value.includes('..') || /[\u0000-\u001f<>:"|?*]/u.test(value)) throw new TypeError('アーカイブ内のファイル名が不正です。');
  const extension = path.extname(value).toLowerCase();
  const allowed = mimeType === 'image/jpeg' ? new Set(['.jpg', '.jpeg']) : new Set([EXTENSIONS[mimeType]]);
  if (!allowed.has(extension)) throw new TypeError('アーカイブ内のファイル名と形式が一致しません。');
  const baseName = value.slice(0, value.length - extension.length);
  if (codePointLength(baseName) > MAX_NAME_LENGTH || safeFileName(value, mimeType) !== value) throw new RangeError('アーカイブ内のファイル名が長すぎます。');
  return value;
}

function assertCreatedAt(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError('アーカイブ内の作成日時が不正です。');
  return new Date(value).toISOString();
}

function validateArchiveManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new TypeError('素材アーカイブのmanifestが不正です。');
  if (Object.keys(manifest).some((key) => !['format', 'version', 'assets'].includes(key))) throw new TypeError('素材アーカイブのmanifestに未知の項目があります。');
  if (manifest.format !== ARCHIVE_FORMAT || manifest.version !== ARCHIVE_VERSION) throw new TypeError('素材アーカイブの形式またはバージョンが不正です。');
  if (!Array.isArray(manifest.assets) || manifest.assets.length < 1 || manifest.assets.length > MAX_IMPORT_COUNT) throw new RangeError('素材アーカイブの件数が不正です。');
  const paths = new Set();
  return manifest.assets.map((asset) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) throw new TypeError('素材アーカイブの項目が不正です。');
    if (Object.keys(asset).some((key) => !['name', 'fileName', 'mimeType', 'text', 'createdAt', 'path'].includes(key))) throw new TypeError('アーカイブ内の項目に未知のキーがあります。');
    if (typeof asset.name !== 'string' || !asset.name.trim() || codePointLength(asset.name) > MAX_NAME_LENGTH || safeName(asset.name, '') !== asset.name) throw new TypeError('アーカイブ内の素材名が不正です。');
    if (typeof asset.text !== 'string' || asset.text.length > MAX_TEXT_LENGTH) throw new TypeError('アーカイブ内のテキストが不正です。');
    const mimeType = normalizeMimeType(asset.mimeType);
    if (!RAW_IMAGE_TYPES.has(mimeType) || asset.mimeType !== mimeType) throw new TypeError('アーカイブ内のMIMEタイプが不正です。');
    const fileName = assertArchiveFileName(asset.fileName, mimeType);
    const createdAt = assertCreatedAt(asset.createdAt);
    if (!isSafeArchivePath(asset.path) || asset.path === ARCHIVE_MANIFEST_NAME || !asset.path.startsWith('assets/') || path.extname(asset.path).toLowerCase() !== path.extname(fileName).toLowerCase()) throw new TypeError('アーカイブ内の素材パスが不正です。');
    const key = asset.path.toLowerCase();
    if (paths.has(key)) throw new TypeError('アーカイブ内の素材パスが重複しています。');
    paths.add(key);
    return { name: asset.name, fileName, mimeType, text: asset.text, createdAt, path: asset.path };
  });
}

async function readArchiveEntries(data) {
  const value = toBuffer(data);
  if (!isZipData(value)) throw new TypeError('素材ZIPの形式が不正です。');
  if (value.length > MAX_IMPORT_TOTAL_BYTES) throw new RangeError('素材ZIPの圧縮サイズが100MiBを超えています。');
  let zip;
  try {
    zip = await JSZip.loadAsync(value, { checkCRC32: true, createFolders: false });
  } catch {
    throw new TypeError('素材ZIPを読み込めません。暗号化ZIPや破損ZIPは使用できません。');
  }
  const names = Object.keys(zip.files);
  if (names.length < 2 || names.length > MAX_IMPORT_COUNT + 1) throw new RangeError('素材ZIPのファイル件数が不正です。');
  const normalizedNames = new Set();
  for (const name of names) {
    const entry = zip.files[name];
    if (!isSafeArchivePath(name) || normalizedNames.has(name.toLowerCase()) || entry.dir) throw new TypeError('素材ZIPに安全でないエントリがあります。');
    if (entry.unsafeOriginalName && !isSafeArchivePath(entry.unsafeOriginalName)) throw new TypeError('素材ZIPに安全でないエントリがあります。');
    if (entry.unixPermissions && (Number(entry.unixPermissions) & 0xf000) === 0xa000) throw new TypeError('素材ZIPのシンボリックリンクは使用できません。');
    if (entry.options?.encrypted || entry._data?.encrypted) throw new TypeError('暗号化ZIPは使用できません。');
    const declaredSize = Number(entry._data?.uncompressedSize);
    if (Number.isFinite(declaredSize) && (declaredSize < 0 || declaredSize > MAX_FILE_BYTES || declaredSize > MAX_IMPORT_TOTAL_BYTES)) throw new RangeError('素材ZIPの展開サイズが上限を超えています。');
    normalizedNames.add(name.toLowerCase());
  }
  const manifestEntry = zip.files[ARCHIVE_MANIFEST_NAME];
  if (!manifestEntry) throw new TypeError('素材ZIPにmanifest.jsonがありません。');
  let manifest;
  try {
    const manifestText = new TextDecoder('utf-8', { fatal: true }).decode(await manifestEntry.async('nodebuffer'));
    manifest = JSON.parse(manifestText);
  } catch {
    throw new TypeError('素材ZIPのmanifest.jsonが不正です。');
  }
  const assets = validateArchiveManifest(manifest);
  const expected = new Set([ARCHIVE_MANIFEST_NAME.toLowerCase(), ...assets.map((asset) => asset.path.toLowerCase())]);
  if (expected.size !== names.length || names.some((name) => !expected.has(name.toLowerCase()))) throw new TypeError('素材ZIPに不足または余分なファイルがあります。');
  let totalBytes = 0;
  const imported = [];
  for (const asset of assets) {
    const entry = zip.files[asset.path];
    if (!entry) throw new TypeError('素材ZIPの素材ファイルが不足しています。');
    const imageData = await entry.async('nodebuffer');
    totalBytes += imageData.length;
    if (imageData.length > MAX_FILE_BYTES || totalBytes > MAX_IMPORT_TOTAL_BYTES) throw new RangeError('素材ZIPの展開サイズが上限を超えています。');
    validateImageData(imageData, asset.mimeType);
    imported.push({ ...asset, data: imageData });
  }
  return imported;
}

function archiveNameFor(index, fileName) {
  return `assets/${String(index + 1).padStart(4, '0')}${path.extname(fileName).toLowerCase()}`;
}

function makeArchiveManifest(assets) {
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    assets: assets.map((asset, index) => ({
      name: asset.name,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      text: asset.text || '',
      createdAt: asset.createdAt,
      path: archiveNameFor(index, asset.fileName)
    }))
  };
}

class AssetStore {
  constructor(rootDirectory, { fsApi = fs } = {}) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.metadataPath = path.join(this.rootDirectory, 'metadata.json');
    this.filesDirectory = path.join(this.rootDirectory, 'files');
    this.fs = fsApi;
    this.ready = null;
    this.mutationTail = Promise.resolve();
  }

  #enqueueMutation(operation) {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.catch(() => {});
    return run;
  }

  async init() {
    if (!this.ready) {
      this.ready = (async () => {
        await this.fs.mkdir(this.filesDirectory, { recursive: true });
        try {
          const raw = await this.fs.readFile(this.metadataPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) throw new Error('metadata is not an array');
        } catch (error) {
          if (error.code !== 'ENOENT') await this.#writeMetadata([]);
        }
      })();
    }
    return this.ready;
  }

  async #readMetadata() {
    await this.init();
    try {
      const parsed = JSON.parse(await this.fs.readFile(this.metadataPath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async #writeMetadata(items) {
    await this.fs.mkdir(this.rootDirectory, { recursive: true });
    const temp = path.join(this.rootDirectory, `.metadata.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    const backup = path.join(this.rootDirectory, `.metadata.${process.pid}.${Date.now()}.${randomUUID()}.bak`);
    let movedOriginal = false;
    await this.fs.writeFile(temp, `${JSON.stringify(items, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      try {
        await this.fs.stat(this.metadataPath);
        await this.fs.rename(this.metadataPath, backup);
        movedOriginal = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await this.fs.rename(temp, this.metadataPath);
      if (movedOriginal) await this.fs.rm(backup, { force: true }).catch(() => {});
    } catch (error) {
      await this.fs.rm(temp, { force: true }).catch(() => {});
      if (movedOriginal) {
        await this.fs.rm(this.metadataPath, { force: true }).catch(() => {});
        await this.fs.rename(backup, this.metadataPath).catch(() => {});
      }
      throw error;
    }
  }

  #filePath(id, metadata) {
    const safeId = assertSafeId(id);
    const extension = EXTENSIONS[metadata?.mimeType] || '.bin';
    const target = path.resolve(this.filesDirectory, `${safeId}${extension}`);
    if (path.dirname(target) !== path.resolve(this.filesDirectory)) throw new Error('素材パスが不正です。');
    return target;
  }

  async list() {
    return (await this.#readMetadata())
      .filter((item) => ID_PATTERN.test(String(item.id)) && IMAGE_TYPES.has(item.mimeType))
      .sort((left, right) => {
        const dateOrder = String(right.createdAt).localeCompare(String(left.createdAt));
        return dateOrder || String(right.id).localeCompare(String(left.id));
      });
  }

  async saveBatch(inputs) {
    return this.#enqueueMutation(async () => {
      await this.init();
      if (!Array.isArray(inputs)) throw new TypeError('素材入力は配列で指定してください。');
      if (inputs.length > MAX_IMPORT_COUNT) throw new RangeError('一度に保存できる素材は100件までです。');
      if (inputs.length === 0) return [];
      const prepared = [];
      let totalBytes = 0;
      for (const input of inputs) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('素材入力が不正です。');
        const fileName = String(input.fileName || input.name || '').trim();
        const mimeType = normalizeMimeType(input.mimeType || 'image/png', fileName);
        if (!RAW_IMAGE_TYPES.has(mimeType)) throw new TypeError('素材はPNG、JPEG、WebP、またはSVGのみ保存できます。');
        const data = validateImageData(input.data, mimeType);
        if (data.length === 0 || data.length > MAX_FILE_BYTES) throw new RangeError('素材ファイルは10MiB以下にしてください。');
        totalBytes += data.length;
        assertImportBudget(prepared.length + 1, totalBytes);
        const createdAt = input.createdAt === undefined ? new Date().toISOString() : assertCreatedAt(input.createdAt);
        prepared.push({
          data,
          metadata: {
            name: safeName(input.name || path.basename(fileName, path.extname(fileName))),
            text: String(input.text ?? '').slice(0, MAX_TEXT_LENGTH),
            createdAt,
            mimeType,
            fileName: safeFileName(fileName, mimeType)
          }
        });
      }
      const existing = await this.#readMetadata();
      const written = [];
      const temporary = [];
      try {
        for (const item of prepared) {
          const metadata = { id: randomUUID(), ...item.metadata };
          const target = this.#filePath(metadata.id, metadata);
          const temp = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
          temporary.push(temp);
          await this.fs.writeFile(temp, item.data, { flag: 'wx', mode: 0o600 });
          await this.fs.rename(temp, target);
          written.push({ target, metadata });
        }
        await this.#writeMetadata([...existing, ...written.map((item) => item.metadata)]);
        return written.map((item) => item.metadata);
      } catch (error) {
        await Promise.all(temporary.map((file) => this.fs.rm(file, { force: true }).catch(() => {})));
        await Promise.all(written.map((item) => this.fs.rm(item.target, { force: true }).catch(() => {})));
        try { await this.#writeMetadata(existing); } catch { /* preserve the original error */ }
        throw error;
      }
    });
  }

  async save(input) {
    const [metadata] = await this.saveBatch([input]);
    return metadata;
  }

  async importFiles(inputs) {
    if (!Array.isArray(inputs)) throw new TypeError('インポート対象は配列で指定してください。');
    if (inputs.length > MAX_IMPORT_COUNT) throw new RangeError('一度にインポートできる素材は100件までです。');
    const prepared = [];
    let inputBytes = 0;
    let preparedBytes = 0;
    const appendPrepared = (items) => {
      for (const item of items) {
        const size = toBuffer(item.data).length;
        if (size > MAX_FILE_BYTES) throw new RangeError('素材ファイルは10MiB以下にしてください。');
        assertImportBudget(prepared.length + 1, preparedBytes + size);
        preparedBytes += size;
        prepared.push(item);
      }
    };
    for (const input of inputs) {
      if (!input || typeof input !== 'object') throw new TypeError('インポート対象が不正です。');
      const fileName = String(input.fileName || input.name || input.path || '').trim();
      const data = toBuffer(input.data);
      if (data.length > MAX_IMPORT_TOTAL_BYTES) throw new RangeError('一度に読み込めるサイズは100MiBまでです。');
      inputBytes += data.length;
      if (inputBytes > MAX_IMPORT_TOTAL_BYTES) throw new RangeError('一度に読み込めるサイズは100MiBまでです。');
      const suppliedMime = normalizeMimeType(input.mimeType, fileName);
      if (isZipData(data) || path.extname(fileName).toLowerCase() === '.zip' || String(input.mimeType || '').toLowerCase() === 'application/zip') {
        appendPrepared(await readArchiveEntries(data));
        continue;
      }
      const mimeType = suppliedMime || detectImageMime(data);
      if (!RAW_IMAGE_TYPES.has(mimeType)) throw new TypeError('PNG、JPEG、WebP、SVG、または対応ZIPのみインポートできます。');
      validateImageData(data, mimeType);
      appendPrepared([{
        data,
        name: safeName(path.basename(fileName)),
        fileName: safeFileName(path.basename(fileName), mimeType),
        mimeType,
        text: String(input.text ?? ''),
        createdAt: input.createdAt
      }]);
    }
    if (prepared.length > MAX_IMPORT_COUNT) throw new RangeError('一度にインポートできる素材は100件までです。');
    return this.saveBatch(prepared);
  }

  async importArchive(data) {
    const entries = await readArchiveEntries(data);
    return this.saveBatch(entries);
  }

  async importPaths(filePaths) {
    if (!Array.isArray(filePaths)) throw new TypeError('インポート対象のパスが不正です。');
    if (filePaths.length > MAX_IMPORT_COUNT) throw new RangeError('一度にインポートできる素材は100件までです。');
    const descriptors = [];
    let inputBytes = 0;
    for (const filePath of filePaths) {
      const resolvedPath = String(filePath);
      const extension = path.extname(resolvedPath).toLowerCase();
      const stat = await this.fs.stat(resolvedPath);
      if (!stat.isFile()) throw new TypeError('インポート対象はファイルで指定してください。');
      const perFileLimit = extension === '.zip' ? MAX_IMPORT_TOTAL_BYTES : MAX_FILE_BYTES;
      if (stat.size > perFileLimit) throw new RangeError('インポートファイルのサイズ上限を超えています。');
      inputBytes += stat.size;
      if (inputBytes > MAX_IMPORT_TOTAL_BYTES) throw new RangeError('一度に読み込めるサイズは100MiBまでです。');
      descriptors.push({ resolvedPath, perFileLimit });
    }
    const inputs = [];
    for (const { resolvedPath, perFileLimit } of descriptors) {
      const data = await this.fs.readFile(resolvedPath);
      if (data.length > perFileLimit) throw new RangeError('インポートファイルのサイズ上限を超えています。');
      inputs.push({ fileName: path.basename(resolvedPath), data });
    }
    return this.importFiles(inputs);
  }

  async exportArchive() {
    return this.#enqueueMutation(async () => {
      const assets = await this.list();
      if (assets.length === 0) return null;
      if (assets.length > MAX_IMPORT_COUNT) throw new RangeError('エクスポートできる素材は100件までです。');
      const loaded = [];
      let totalBytes = 0;
      for (const asset of assets) {
        const item = await this.read(asset.id);
        if (item.data.length > MAX_FILE_BYTES) throw new RangeError('エクスポート対象の素材が10MiBを超えています。');
        totalBytes += item.data.length;
        if (totalBytes > MAX_IMPORT_TOTAL_BYTES) throw new RangeError('エクスポート対象の合計サイズが100MiBを超えています。');
        validateImageData(item.data, asset.mimeType);
        loaded.push({ ...asset, data: Buffer.from(item.data) });
      }
      const manifest = makeArchiveManifest(loaded);
      const zip = new JSZip();
      const zipOptions = { date: ARCHIVE_EPOCH, createFolders: false, compression: 'STORE' };
      zip.file(ARCHIVE_MANIFEST_NAME, `${JSON.stringify(manifest, null, 2)}\n`, zipOptions);
      loaded.forEach((asset, index) => zip.file(manifest.assets[index].path, asset.data, zipOptions));
      return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE', platform: 'DOS' });
    });
  }

  async exportMaterials() {
    return this.exportArchive();
  }

  async read(id) {
    const safeId = assertSafeId(id);
    const item = (await this.#readMetadata()).find((candidate) => candidate.id.toLowerCase() === safeId);
    if (!item) throw new Error('素材が見つかりません。');
    return { metadata: item, data: new Uint8Array(await this.fs.readFile(this.#filePath(safeId, item))) };
  }

  async rename(id, name) {
    return this.#enqueueMutation(async () => {
      const safeId = assertSafeId(id);
      const items = await this.#readMetadata();
      const index = items.findIndex((item) => item.id.toLowerCase() === safeId);
      if (index < 0) throw new Error('素材が見つかりません。');
      const next = { ...items[index], name: safeName(name) };
      items[index] = next;
      await this.#writeMetadata(items);
      return next;
    });
  }

  async delete(id) {
    return this.#enqueueMutation(async () => {
      const safeId = assertSafeId(id);
      const items = await this.#readMetadata();
      const item = items.find((candidate) => candidate.id.toLowerCase() === safeId);
      if (!item) throw new Error('素材が見つかりません。');
      const target = this.#filePath(safeId, item);
      const backup = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.bak`;
      let moved = false;
      let metadataCommitted = false;
      try {
        // Missing binaries are treated as an integrity error; metadata is left untouched.
        await this.fs.rename(target, backup);
        moved = true;
        await this.#writeMetadata(items.filter((candidate) => candidate.id.toLowerCase() !== safeId));
        metadataCommitted = true;
        await this.fs.rm(backup, { force: true }).catch(() => {});
      } catch (error) {
        if (moved && !metadataCommitted) {
          await this.fs.rm(target, { force: true }).catch(() => {});
          await this.fs.rename(backup, target).catch(() => {});
        }
        throw error;
      }
      return { id: safeId };
    });
  }
}

module.exports = {
  ARCHIVE_FORMAT,
  ARCHIVE_MANIFEST_NAME,
  ARCHIVE_VERSION,
  AssetStore,
  EXTENSIONS,
  IMAGE_TYPES,
  MAX_FILE_BYTES,
  MAX_IMPORT_COUNT,
  MAX_IMPORT_TOTAL_BYTES,
  assertArchiveFileName,
  assertImportBudget,
  assertSafeId,
  codePointLength,
  detectImageMime,
  isSafeArchivePath,
  makeArchiveManifest,
  readArchiveEntries,
  safeFileName,
  safeName,
  toBuffer,
  validateArchiveManifest,
  validateImageData,
  validateJpegStructure,
  validatePngStructure,
  validateSvgData,
  validateWebpStructure
};
