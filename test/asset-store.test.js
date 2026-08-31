const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { AssetStore, MAX_IMPORT_TOTAL_BYTES } = require('../electron/asset-store');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const WEBP = Buffer.from('UklGRhYAAABXRUJQVlA4IAoAAAAQAACdASoBAAEA', 'base64');
const VALID_JPEG = Buffer.concat([
  Buffer.from('ffd8ffe000064a464946ffdb004300', 'hex'),
  Buffer.alloc(64, 1),
  Buffer.from('ffc0000b080001000101011100ffda0008010100003f00', 'hex'),
  Buffer.from([0]),
  Buffer.from('ffd9', 'hex')
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

const ARCHIVE_BASE = Object.freeze({
  name: 'x',
  fileName: 'x.png',
  mimeType: 'image/png',
  text: '',
  createdAt: new Date(0).toISOString(),
  path: 'assets/0001.png'
});

async function makeTestArchive(manifest, files = { 'assets/0001.png': PNG }) {
  const zip = new JSZip();
  const options = { createFolders: false, date: new Date(0) };
  zip.file('manifest.json', JSON.stringify(manifest), options);
  for (const [fileName, data] of Object.entries(files)) zip.file(fileName, data, options);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE', platform: 'DOS' });
}

function createFsApiWithRenameFault(targetPath, message = 'metadata replacement failed') {
  let failed = false;
  const methods = ['mkdir', 'readFile', 'writeFile', 'stat', 'rename', 'rm'];
  return Object.fromEntries(methods.map((method) => [method, async (...args) => {
    if (method === 'rename' && args[1] === targetPath && String(args[0]).endsWith('.tmp') && !failed) {
      failed = true;
      const error = new Error(message);
      error.code = 'EIO';
      throw error;
    }
    return fs[method](...args);
  }]));
}

test('asset store persists CRUD metadata and binary files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusunoki-assets-'));
  const store = new AssetStore(directory);
  const saved = await store.save({ name: 'Demo QR', text: 'https://example.com', mimeType: 'image/png', fileName: 'demo.png', data: PNG });
  assert.equal((await store.list()).length, 1);
  const loaded = await store.read(saved.id);
  assert.deepEqual([...loaded.data], [...PNG]);
  const renamed = await store.rename(saved.id, 'Renamed');
  assert.equal(renamed.name, 'Renamed');
  const restored = new AssetStore(directory);
  assert.equal((await restored.list())[0].name, 'Renamed');
  await restored.delete(saved.id);
  assert.deepEqual(await restored.list(), []);
});

test('asset store rejects traversal, unsupported types, and invalid ids', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusunoki-assets-'));
  const store = new AssetStore(directory);
  await assert.rejects(() => store.save({ name: 'x', mimeType: 'text/html', data: 'AAAA' }), /PNG/);
  await assert.rejects(() => store.read('../metadata.json'), /ID/);
  await assert.rejects(() => store.delete('not-an-id'), /ID/);
});

test('asset store imports multiple raw PNG/JPEG/WebP/SVG files atomically', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusunoki-assets-'));
  const store = new AssetStore(directory);
  const imported = await store.importFiles([
    { fileName: 'same.png', data: PNG },
    { fileName: 'same.jpeg', data: VALID_JPEG },
    { fileName: 'same.webp', data: WEBP },
    { fileName: 'icon.svg', data: SVG }
  ]);
  assert.equal(imported.length, 4);
  assert.equal(new Set(imported.map((item) => item.id)).size, 4);
  assert.deepEqual(imported.map((item) => item.mimeType).sort(), ['image/jpeg', 'image/png', 'image/svg+xml', 'image/webp']);
  assert.deepEqual(imported.map((item) => item.name).sort(), ['icon.svg', 'same.jpeg', 'same.png', 'same.webp']);
  assert.deepEqual(imported.map((item) => item.fileName).sort(), ['icon.svg', 'same.jpeg', 'same.png', 'same.webp']);
  await assert.rejects(() => store.importFiles([{ fileName: 'good.png', data: PNG }, { fileName: 'spoof.webp', mimeType: 'image/webp', data: PNG }]), /一致|MIME|形式/);
  assert.equal((await store.list()).length, 4, 'failed batch must not partially import');
});

test('asset archive roundtrip preserves metadata while issuing new IDs', async () => {
  const sourceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusunoki-assets-'));
  const targetDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusunoki-assets-'));
  const source = new AssetStore(sourceDirectory);
  const first = await source.importFiles([{ fileName: 'logo.webp', data: WEBP, text: 'webp' }]);
  const second = await source.importFiles([{ fileName: 'logo.svg', data: SVG, text: 'svg' }]);
  const archive = await source.exportArchive();
  assert.ok(Buffer.isBuffer(archive));
  assert.deepEqual(await source.exportArchive(), archive, 'archive bytes are deterministic');
  const zip = await JSZip.loadAsync(archive);
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(manifest.format, 'kusunoki-material-archive');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.assets.length, 2);
  assert.deepEqual(manifest.assets.map((item) => item.path), ['assets/0001.svg', 'assets/0002.webp']);
  const target = new AssetStore(targetDirectory);
  const restored = await target.importFiles([{ fileName: 'backup.zip', data: archive }]);
  assert.equal(restored.length, 2);
  assert.notEqual(restored[0].id, first[0].id);
  assert.notEqual(restored[1].id, second[0].id);
  assert.deepEqual(restored.map((item) => item.text).sort(), ['svg', 'webp']);
});

test('asset archive rejects malformed manifest, traversal, extra files, active SVG, and size limits', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusunoki-assets-'));
  const store = new AssetStore(directory);
  const base = { name: 'x', fileName: 'x.png', mimeType: 'image/png', text: '', createdAt: new Date(0).toISOString(), path: 'assets/0001.png' };
  async function makeArchive(manifest, files = { 'assets/0001.png': PNG }) {
    const zip = new JSZip();
    const options = { createFolders: false, date: new Date(0) };
    zip.file('manifest.json', JSON.stringify(manifest), options);
    for (const [fileName, data] of Object.entries(files)) zip.file(fileName, data, options);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE', platform: 'DOS' });
  }
  const wrongArchive = await makeArchive({ format: 'wrong', version: 1, assets: [base] });
  const traversalArchive = await makeArchive({ format: 'kusunoki-material-archive', version: 1, assets: [{ ...base, path: '../escape.png' }] });
  const extraArchive = await makeArchive({ format: 'kusunoki-material-archive', version: 1, assets: [base] }, { 'assets/0001.png': PNG, 'extra.bin': Buffer.from('x') });
  await assert.rejects(() => store.importFiles([{ fileName: 'bad.zip', data: wrongArchive }]), /形式|バージョン/);
  await assert.rejects(() => store.importFiles([{ fileName: 'bad.zip', data: traversalArchive }]), /パス/);
  await assert.rejects(() => store.importFiles([{ fileName: 'bad.zip', data: extraArchive }]), /不足|余分/);
  await assert.rejects(() => store.importFiles([{ fileName: 'unsafe.svg', data: Buffer.from('<svg><script>alert(1)</script></svg>') }]), /安全|スクリプト/);
  await assert.rejects(() => store.importFiles([{ fileName: 'remote.svg', data: Buffer.from('<svg><image href=http://evil.test/x></image></svg>') }]), /外部参照/);
  const xmlSvg = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const xmlImported = await store.importFiles([{ fileName: 'xml.svg', data: xmlSvg }]);
  assert.equal(xmlImported[0].mimeType, 'image/svg+xml');
  await assert.rejects(() => store.importFiles([{ fileName: 'too-large.png', data: Buffer.alloc(10 * 1024 * 1024 + 1, 0) }]), /10MiB/);
  assert.equal((await store.list()).length, 1);
});

test('image validators reject truncated, corrupt, zero-dimension, and malformed data', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusunoki-assets-'));
  const store = new AssetStore(directory);
  await assert.rejects(() => store.importFiles([{ fileName: 'truncated.png', data: PNG.subarray(0, -1) }]), /PNG|MIME/);
  await assert.rejects(() => store.importFiles([{ fileName: 'truncated.jpg', data: VALID_JPEG.subarray(0, -2) }]), /JPEG|MIME/);
  await assert.rejects(() => store.importFiles([{ fileName: 'truncated.webp', data: WEBP.subarray(0, -1) }]), /WebP|MIME/);
  const badPng = Buffer.from(PNG);
  badPng[badPng.length - 6] ^= 0xff;
  await assert.rejects(() => store.importFiles([{ fileName: 'crc.png', data: badPng }]), /PNG|MIME/);
  const zeroWebp = Buffer.from(WEBP);
  zeroWebp.writeUInt32LE(0, 16);
  await assert.rejects(() => store.importFiles([{ fileName: 'zero.webp', data: zeroWebp }]), /WebP|MIME/);
  const zeroDimensionWebp = Buffer.from(WEBP);
  zeroDimensionWebp[26] = 0;
  zeroDimensionWebp[27] = 0;
  await assert.rejects(() => store.importFiles([{ fileName: 'zero-dimension.webp', data: zeroDimensionWebp }]), /WebP|MIME/);
  const badWebp = Buffer.from(WEBP);
  badWebp[23] = 0;
  await assert.rejects(() => store.importFiles([{ fileName: 'header.webp', data: badWebp }]), /WebP|MIME/);
  await assert.rejects(() => store.importFiles([{ fileName: 'broken.svg', data: Buffer.from('<svg><g></svg>') }]), /SVG/);
  await assert.rejects(() => store.importFiles([{ fileName: 'svg-data.svg', data: Buffer.from('<svg><image href="data:image/svg+xml;base64,PHN2Zy8+"/></svg>') }]), /外部参照|埋め込み|データ/);
  const selfContained = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,${PNG.toString('base64')}"/></svg>`);
  const accepted = await store.importFiles([{ fileName: 'embedded.svg', data: selfContained }]);
  assert.equal(accepted[0].mimeType, 'image/svg+xml');
  await assert.rejects(() => store.importFiles([{ fileName: 'style.svg', data: Buffer.from('<svg><style>@import "http://evil.test/a.css";</style></svg>') }]), /外部参照/);
});

test('archive manifest rejects duplicate, missing, spoofed, and unknown fields', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusunoki-assets-'));
  const store = new AssetStore(directory);
  const validManifest = { format: 'kusunoki-material-archive', version: 1, assets: [ARCHIVE_BASE] };
  const duplicateManifest = { ...validManifest, assets: [ARCHIVE_BASE, { ...ARCHIVE_BASE, name: 'y' }] };
  const duplicateArchive = await makeTestArchive(duplicateManifest);
  const missingArchive = await makeTestArchive(validManifest, {});
  const spoofManifest = {
    ...validManifest,
    assets: [{ ...ARCHIVE_BASE, fileName: 'x.jpg', mimeType: 'image/jpeg', path: 'assets/0001.jpg' }]
  };
  const spoofArchive = await makeTestArchive(spoofManifest, { 'assets/0001.jpg': PNG });
  const unknownTopArchive = await makeTestArchive({ ...validManifest, extra: true });
  const unknownAssetArchive = await makeTestArchive({ ...validManifest, assets: [{ ...ARCHIVE_BASE, extra: true }] });
  await assert.rejects(() => store.importArchive(duplicateArchive), /重複/);
  await assert.rejects(() => store.importArchive(missingArchive), /不足|余分|件数/);
  await assert.rejects(() => store.importArchive(spoofArchive), /一致|MIME|形式/);
  await assert.rejects(() => store.importArchive(unknownTopArchive), /未知/);
  await assert.rejects(() => store.importArchive(unknownAssetArchive), /未知/);
});

test('Unicode code-point names survive export and import', async () => {
  const sourceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusunoki-assets-'));
  const targetDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusunoki-assets-'));
  const name = '😀'.repeat(160);
  const fileName = `${name}.png`;
  const source = new AssetStore(sourceDirectory);
  await source.save({ name, fileName, mimeType: 'image/png', data: PNG });
  const archive = await source.exportArchive();
  const target = new AssetStore(targetDirectory);
  const [restored] = await target.importArchive(archive);
  assert.equal(restored.name, name);
  assert.equal(restored.fileName, fileName);
});

test('parallel saves are serialized and retain every asset', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusunoki-assets-'));
  const store = new AssetStore(directory);
  const saved = await Promise.all(Array.from({ length: 10 }, (_, index) => store.save({
    name: `parallel-${index}`,
    fileName: `parallel-${index}.png`,
    mimeType: 'image/png',
    data: PNG
  })));
  assert.equal(saved.length, 10);
  assert.equal((await store.list()).length, 10);
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'metadata.json'), 'utf8'));
  assert.equal(metadata.length, 10);
  const files = await fs.readdir(path.join(directory, 'files'));
  assert.equal(files.length, 10);
});

test('saveBatch metadata replacement failure rolls back files, metadata, and temporary names', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusunoki-assets-'));
  const stable = new AssetStore(directory);
  const original = await stable.save({ name: 'original', fileName: 'original.png', mimeType: 'image/png', data: PNG });
  const failing = new AssetStore(directory, { fsApi: createFsApiWithRenameFault(path.join(directory, 'metadata.json')) });
  await assert.rejects(() => failing.save({ name: 'new', fileName: 'new.png', mimeType: 'image/png', data: PNG }), /metadata replacement/);
  assert.deepEqual((await stable.list()).map((item) => item.id), [original.id]);
  assert.deepEqual([...((await stable.read(original.id)).data)], [...PNG]);
  assert.deepEqual(await fs.readdir(path.join(directory, 'files')), [`${original.id}.png`]);
  assert.equal((await fs.readdir(directory)).some((name) => /\.tmp$|\.bak$/u.test(name)), false);
});

test('delete metadata replacement failure restores the original binary and metadata', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusunoki-assets-'));
  const stable = new AssetStore(directory);
  const original = await stable.save({ name: 'original', fileName: 'original.png', mimeType: 'image/png', data: PNG });
  const failing = new AssetStore(directory, { fsApi: createFsApiWithRenameFault(path.join(directory, 'metadata.json')) });
  await assert.rejects(() => failing.delete(original.id), /metadata replacement/);
  assert.equal((await stable.list()).length, 1);
  assert.deepEqual([...((await stable.read(original.id)).data)], [...PNG]);
  assert.deepEqual(await fs.readdir(path.join(directory, 'files')), [`${original.id}.png`]);
  assert.equal((await fs.readdir(path.join(directory, 'files'))).some((name) => /\.tmp$|\.bak$/u.test(name)), false);
});

test('mixed ZIP imports enforce count and total budgets before batch mutation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusunoki-assets-'));
  const store = new AssetStore(directory);
  const makeManyManifest = (offset) => ({
    format: 'kusunoki-material-archive',
    version: 1,
    assets: Array.from({ length: 60 }, (_, index) => ({
      name: `asset-${offset + index}`,
      fileName: `asset-${offset + index}.png`,
      mimeType: 'image/png',
      text: '',
      createdAt: new Date(0).toISOString(),
      path: `assets/${String(index + 1).padStart(4, '0')}.png`
    }))
  });
  const filesFor = () => Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`assets/${String(index + 1).padStart(4, '0')}.png`, PNG]));
  const first = await makeTestArchive(makeManyManifest(0), filesFor());
  const second = await makeTestArchive(makeManyManifest(60), filesFor());
  await assert.rejects(() => store.importFiles([{ fileName: 'one.zip', data: first }, { fileName: 'two.zip', data: second }]), /100件/);
  assert.equal((await store.list()).length, 0);
  const budget = require('../electron/asset-store').assertImportBudget;
  assert.throws(() => budget(2, MAX_IMPORT_TOTAL_BYTES + 1), /100MiB/);
});

test('export rejects an unimportable metadata set over the item limit', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusunoki-assets-'));
  const records = Array.from({ length: 101 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name: `asset-${index}`,
    text: '',
    createdAt: new Date(0).toISOString(),
    mimeType: 'image/png',
    fileName: `asset-${index}.png`
  }));
  await fs.writeFile(path.join(directory, 'metadata.json'), `${JSON.stringify(records)}\n`);
  const store = new AssetStore(directory);
  await assert.rejects(() => store.exportArchive(), /100件/);
});
