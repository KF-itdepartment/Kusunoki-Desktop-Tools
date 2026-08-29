const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  WINDOWS_INSTALLER_URL,
  createUpdateService,
  releaseTagUrl
} = require('../electron/update-service');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function setup({
  packaged = true,
  platform = 'win32',
  response = { updateInfo: { version: '1.1.0' } },
  checkForUpdates,
  downloadUpdate,
  quitAndInstall
} = {}) {
  const events = new EventEmitter();
  const calls = [];
  let checkCount = 0;
  let downloadCount = 0;
  let installCount = 0;
  const updater = Object.assign(events, {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: async () => {
      checkCount += 1;
      return checkForUpdates ? checkForUpdates() : response;
    },
    downloadUpdate: async () => {
      downloadCount += 1;
      calls.push('download');
      return downloadUpdate ? downloadUpdate() : undefined;
    },
    quitAndInstall: async (...args) => {
      installCount += 1;
      calls.push(['install', ...args]);
      return quitAndInstall ? quitAndInstall(...args) : undefined;
    }
  });
  const app = { isPackaged: packaged, getVersion: () => '1.0.0' };
  const opened = [];
  const shell = { openExternal: async (url) => { opened.push(url); } };
  const logs = [];
  const service = createUpdateService({
    app,
    autoUpdater: updater,
    shell,
    processPlatform: platform,
    logger: { warn: (...args) => logs.push(args), error: (...args) => logs.push(args) }
  });
  return {
    service,
    updater,
    calls,
    opened,
    logs,
    get checkCount() { return checkCount; },
    get downloadCount() { return downloadCount; },
    get installCount() { return installCount; }
  };
}

test('development builds are disabled and concurrent disabled checks share a promise', async () => {
  const { service } = setup({ packaged: false });
  const first = service.check();
  const second = service.check();
  assert.strictEqual(first, second);
  assert.deepEqual(await first, { status: 'disabled' });
});

test('check returns none for the current release and available for a newer release', async () => {
  const current = setup({ response: { updateInfo: { version: 'v1.0.0' } } });
  assert.deepEqual(await current.service.check(), { status: 'none' });

  const newer = setup({ response: { updateInfo: { version: 'v1.1.0', releaseDate: 'internal' } } });
  assert.deepEqual(await newer.service.check(), { status: 'available', version: '1.1.0', mode: 'automatic' });
  assert.equal(newer.service.getUpdateInfo().version, 'v1.1.0');
});

test('update-available does not start a dialog, download, or install flow', async () => {
  const deferredCheck = deferred();
  const fixture = setup({ checkForUpdates: () => deferredCheck.promise });
  const events = [];
  fixture.service.onEvent((event) => events.push(event));
  const checking = fixture.service.check();
  fixture.updater.emit('update-available', { version: '1.9.9' });
  deferredCheck.resolve({ updateInfo: { version: '1.1.0' } });
  assert.deepEqual(await checking, { status: 'available', version: '1.1.0', mode: 'automatic' });
  assert.equal(fixture.checkCount, 1);
  assert.equal(fixture.downloadCount, 0);
  assert.equal(fixture.installCount, 0);
  assert.deepEqual(events, []);
});

test('concurrent checks share one promise and one updater call', async () => {
  const pending = deferred();
  const fixture = setup({ checkForUpdates: () => pending.promise });
  const first = fixture.service.check();
  const second = fixture.service.check();
  assert.strictEqual(first, second);
  assert.equal(fixture.checkCount, 1);
  pending.resolve({ updateInfo: { version: '1.1.0' } });
  await first;
});

test('Windows installs one downloaded update and reports stable progress events', async () => {
  const fixture = setup({
    downloadUpdate: () => {
      fixture.updater.emit('download-progress', { percent: -10 });
      fixture.updater.emit('download-progress', { percent: 42.5 });
      fixture.updater.emit('download-progress', { percent: 120 });
    }
  });
  await fixture.service.check();
  const events = [];
  fixture.service.onEvent((event) => events.push(event));
  const first = fixture.service.install();
  const second = fixture.service.install();
  assert.strictEqual(first, second);
  assert.deepEqual(await first, { status: 'installing' });
  assert.equal(fixture.downloadCount, 1);
  assert.equal(fixture.installCount, 1);
  assert.deepEqual(fixture.calls, ['download', ['install', false, true]]);
  assert.deepEqual(events, [
    { type: 'downloading' },
    { type: 'progress', percent: 0 },
    { type: 'progress', percent: 42.5 },
    { type: 'progress', percent: 100 },
    { type: 'installing' }
  ]);
});

test('macOS install opens the matching tagged release manually', async () => {
  const fixture = setup({ platform: 'darwin' });
  assert.deepEqual(await fixture.service.check(), { status: 'available', version: '1.1.0', mode: 'manual' });
  assert.deepEqual(await fixture.service.install(), { status: 'manual' });
  assert.deepEqual(fixture.opened, [releaseTagUrl('1.1.0')]);
  assert.equal(fixture.downloadCount, 0);
  assert.equal(fixture.installCount, 0);
});

test('install retry is possible after an error and raw error details stay in the logger', async () => {
  let attempts = 0;
  const failure = new Error('private updater detail');
  const fixture = setup({
    checkForUpdates: () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(failure);
      return Promise.resolve({ updateInfo: { version: '1.1.0' } });
    },
    downloadUpdate: () => Promise.reject(failure)
  });
  const first = await fixture.service.check();
  assert.deepEqual(first, { status: 'error' });
  assert.equal(JSON.stringify(first).includes('private updater detail'), false);
  assert.equal(fixture.logs[0][1], failure);
  assert.deepEqual(await fixture.service.check(), { status: 'available', version: '1.1.0', mode: 'automatic' });
  const events = [];
  fixture.service.onEvent((event) => events.push(event));
  assert.deepEqual(await fixture.service.install(), { status: 'error' });
  assert.deepEqual(events, [{ type: 'downloading' }, { type: 'error' }]);
  assert.equal(JSON.stringify(events).includes('private updater detail'), false);
});

test('latest Windows installer URL opens through the service', async () => {
  const fixture = setup();
  assert.deepEqual(await fixture.service.openInstaller(), { status: 'opened' });
  assert.deepEqual(fixture.opened, [WINDOWS_INSTALLER_URL]);
});

test('release tag URL accepts semver and rejects URL injection', () => {
  assert.equal(releaseTagUrl('v2.3.4'), 'https://github.com/KF-itdepartment/Kusunoki-Desktop-Tools/releases/tag/v2.3.4');
  assert.throws(() => releaseTagUrl('2.3.4/../../evil'), /不正/);
});
