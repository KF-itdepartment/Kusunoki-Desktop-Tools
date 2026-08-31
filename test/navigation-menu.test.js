const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  VIEW_DEFINITIONS,
  assertViewId,
  createMenuTemplate,
  exportAssetsToDialog,
  importAssetsFromDialog,
  writeFileAtomic
} = require('../electron/main');

test('native menu groups five views in the required order with radio accelerators', () => {
  const selected = [];
  const template = createMenuTemplate({
    version: 'test',
    onImport: () => {},
    onExport: () => {},
    onUpdate: () => {},
    onRelease: () => {},
    onView: (viewId) => selected.push(viewId)
  });
  assert.deepEqual(template.map((item) => item.label), ['ファイル', 'ツール', 'ヘルプ']);
  assert.deepEqual(template[0].submenu.map((item) => item.label || item.role), ['素材をインポート…', '素材をエクスポート…', undefined, '終了']);
  const tools = template[1].submenu;
  assert.deepEqual(tools.map((item) => item.label), VIEW_DEFINITIONS.map((item) => item.label));
  assert.deepEqual(tools.map((item) => item.accelerator), ['CmdOrCtrl+1', 'CmdOrCtrl+2', 'CmdOrCtrl+3', 'CmdOrCtrl+4', 'CmdOrCtrl+5']);
  assert.ok(tools.every((item) => item.type === 'radio'));
  tools.forEach((item) => item.click(null, null));
  assert.deepEqual(selected, VIEW_DEFINITIONS.map((item) => item.id));
});

test('view IDs are fixed and renderer has no top navigation buttons', () => {
  assert.equal(assertViewId('pic-view'), 'pic-view');
  assert.throws(() => assertViewId('javascript:evil'), /表示画面/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<nav\b/iu);
  assert.doesNotMatch(html, /class="nav-button"/u);
  assert.match(html, /id="qr-mode-switch"/u);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  assert.match(preload, /navigation:\s*Object\.freeze/u);
  assert.match(preload, /assertViewId/u);
  assert.match(preload, /ipcRenderer\.send\('navigation\.active-view'/u);
  assert.doesNotMatch(preload, /navigation\.set-active-view/u);
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /navigation\.set-active-view/u);
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.doesNotMatch(renderer, /setActiveView\(/u);
});

test('renderer-to-main view changes use one-way fixed-ID notifications', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  assert.match(preload, /notifyActiveView:\s*\(viewId\)\s*=>\s*ipcRenderer\.send/u);
  assert.match(preload, /assertViewId\(viewId\)/u);
  assert.doesNotMatch(preload, /setActiveView:/u);
});

test('native import/export handlers keep cancel and failure paths non-destructive', async () => {
  const events = [];
  const target = { webContents: { send: (channel, payload) => events.push({ channel, payload }) } };
  const imported = await importAssetsFromDialog({
    target,
    dialogApi: { showOpenDialog: async () => ({ canceled: false, filePaths: ['one.png', 'two.webp'] }) },
    store: { importPaths: async (paths) => paths.map((fileName) => ({ fileName })) }
  });
  assert.equal(imported.status, 'imported');
  assert.equal(imported.count, 2);
  assert.equal(events[0].channel, 'navigation.open-view');
  assert.equal(events[0].payload.viewId, 'assets-view');
  assert.equal(events[1].channel, 'assets.changed');
  assert.equal(events[2].channel, 'app.notification');

  let called = false;
  const cancelled = await importAssetsFromDialog({
    target,
    dialogApi: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    store: { importPaths: async () => { called = true; return []; } }
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(called, false);

  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kusunoki-export-'));
  const archivePath = path.join(directory, 'materials.zip');
  const exported = await exportAssetsToDialog({
    target,
    dialogApi: { showSaveDialog: async () => ({ canceled: false, filePath: archivePath }) },
    store: { exportArchive: async () => Buffer.from('archive'), list: async () => [{ id: 'asset' }] }
  });
  assert.equal(exported.status, 'exported');
  assert.deepEqual(await fsp.readFile(archivePath), Buffer.from('archive'));
  const empty = await exportAssetsToDialog({ target, store: { exportArchive: async () => null } });
  assert.equal(empty.status, 'empty');
});

test('atomic archive writes replace existing files and restore them after rename failure', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kusunoki-atomic-'));
  const target = path.join(directory, 'materials.zip');
  await fsp.writeFile(target, Buffer.from('old archive'));
  await writeFileAtomic(target, Buffer.from('new archive'));
  assert.deepEqual(await fsp.readFile(target), Buffer.from('new archive'));

  await fsp.writeFile(target, Buffer.from('stable archive'));
  let failed = false;
  const fsApi = {
    writeFile: (...args) => fsp.writeFile(...args),
    stat: (...args) => fsp.stat(...args),
    rm: (...args) => fsp.rm(...args),
    rename: async (source, destination) => {
      if (!failed && destination === target && String(source).endsWith('.tmp')) {
        failed = true;
        const error = new Error('injected target rename failure');
        error.code = 'EIO';
        throw error;
      }
      return fsp.rename(source, destination);
    }
  };
  await assert.rejects(() => writeFileAtomic(target, Buffer.from('discarded'), { fsApi }), /rename failure/);
  assert.deepEqual(await fsp.readFile(target), Buffer.from('stable archive'));
  assert.equal((await fsp.readdir(directory)).some((name) => /\.tmp$|\.bak$/u.test(name)), false);
});
