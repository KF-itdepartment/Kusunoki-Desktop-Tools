const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml']);
const EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/svg+xml': '.svg'
};
const ID_PATTERN = /^[a-f0-9-]{36}$/iu;
const MAX_NAME_LENGTH = 160;
const MAX_TEXT_LENGTH = 4096;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

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
  if (!raw || basename !== raw || raw.includes('..') || /[\u0000-\u001f<>:"/\\|?*]/u.test(raw)) return fallback;
  const extension = EXTENSIONS[mimeType];
  const withoutExtension = basename.replace(/\.[^.]*$/u, '');
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

class AssetStore {
  constructor(rootDirectory) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.metadataPath = path.join(this.rootDirectory, 'metadata.json');
    this.filesDirectory = path.join(this.rootDirectory, 'files');
    this.ready = null;
  }

  async init() {
    if (!this.ready) {
      this.ready = (async () => {
        await fs.mkdir(this.filesDirectory, { recursive: true });
        try {
          const raw = await fs.readFile(this.metadataPath, 'utf8');
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
      const parsed = JSON.parse(await fs.readFile(this.metadataPath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async #writeMetadata(items) {
    await fs.mkdir(this.rootDirectory, { recursive: true });
    const temp = path.join(this.rootDirectory, `.metadata.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(temp, `${JSON.stringify(items, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await fs.rename(temp, this.metadataPath);
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
      await fs.rm(this.metadataPath, { force: true });
      await fs.rename(temp, this.metadataPath);
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
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  async save(input) {
    await this.init();
    if (!input || typeof input !== 'object') throw new TypeError('素材入力が不正です。');
    const mimeType = String(input.mimeType || 'image/png').toLowerCase();
    if (!IMAGE_TYPES.has(mimeType)) throw new TypeError('素材はPNG、JPEG、またはSVGのみ保存できます。');
    const data = toBuffer(input.data);
    if (data.length === 0 || data.length > MAX_FILE_BYTES) throw new RangeError('素材ファイルのサイズが不正です。');
    const id = randomUUID();
    const metadata = {
      id,
      name: safeName(input.name),
      text: String(input.text ?? '').slice(0, MAX_TEXT_LENGTH),
      createdAt: new Date().toISOString(),
      mimeType,
      fileName: safeFileName(input.fileName, mimeType)
    };
    const target = this.#filePath(id, metadata);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, data, { mode: 0o600 });
    try {
      await fs.rename(temp, target);
      const items = await this.#readMetadata();
      await this.#writeMetadata([...items, metadata]);
    } catch (error) {
      await fs.rm(temp, { force: true });
      await fs.rm(target, { force: true });
      throw error;
    }
    return metadata;
  }

  async read(id) {
    const safeId = assertSafeId(id);
    const item = (await this.#readMetadata()).find((candidate) => candidate.id.toLowerCase() === safeId);
    if (!item) throw new Error('素材が見つかりません。');
    return { metadata: item, data: new Uint8Array(await fs.readFile(this.#filePath(safeId, item))) };
  }

  async rename(id, name) {
    const safeId = assertSafeId(id);
    const items = await this.#readMetadata();
    const index = items.findIndex((item) => item.id.toLowerCase() === safeId);
    if (index < 0) throw new Error('素材が見つかりません。');
    const next = { ...items[index], name: safeName(name) };
    items[index] = next;
    await this.#writeMetadata(items);
    return next;
  }

  async delete(id) {
    const safeId = assertSafeId(id);
    const items = await this.#readMetadata();
    const item = items.find((candidate) => candidate.id.toLowerCase() === safeId);
    if (!item) throw new Error('素材が見つかりません。');
    await fs.rm(this.#filePath(safeId, item), { force: true });
    await this.#writeMetadata(items.filter((candidate) => candidate.id.toLowerCase() !== safeId));
    return { id: safeId };
  }
}

module.exports = {
  AssetStore,
  IMAGE_TYPES,
  MAX_FILE_BYTES,
  assertSafeId,
  safeFileName,
  safeName,
  toBuffer
};
