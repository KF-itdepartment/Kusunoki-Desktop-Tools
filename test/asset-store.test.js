const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AssetStore } = require('../electron/asset-store');

test('asset store persists CRUD metadata and binary files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kusunoki-assets-'));
  const store = new AssetStore(directory);
  const saved = await store.save({ name: 'Demo QR', text: 'https://example.com', mimeType: 'image/png', fileName: 'demo.png', data: new Uint8Array([137, 80, 78, 71]) });
  assert.equal((await store.list()).length, 1);
  const loaded = await store.read(saved.id);
  assert.deepEqual([...loaded.data], [137, 80, 78, 71]);
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
