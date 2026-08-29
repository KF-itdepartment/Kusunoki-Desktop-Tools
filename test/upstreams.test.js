const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { sha256, verifyUpstreams } = require('../scripts/verify-upstreams.js');
const { ENTRIES, main: syncUpstreams } = require('../scripts/sync-upstreams.js');

function copyRendererFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kusunoki-upstreams-'));
  fs.cpSync(path.join(root, 'renderer'), path.join(fixture, 'renderer'), { recursive: true });
  return fixture;
}

function copySourceFixture() {
  const fixture = copyRendererFixture();
  fs.mkdirSync(path.join(fixture, 'vendor'), { recursive: true });
  fs.cpSync(path.join(root, 'vendor', 'qr-generator'), path.join(fixture, 'vendor', 'qr-generator'), { recursive: true });
  fs.cpSync(path.join(root, 'vendor', 'pdf-editor'), path.join(fixture, 'vendor', 'pdf-editor'), { recursive: true });
  return fixture;
}

function readFixtureManifest(fixture) {
  const file = path.join(fixture, 'renderer', 'vendor', 'MANIFEST.json');
  return { file, manifest: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('verify detects a stale QR source manifest and passes after the hash is restaged', () => {
  const fixture = copySourceFixture();
  try {
    const { file, manifest } = readFixtureManifest(fixture);
    manifest.upstream.qr['script.js'].sha256 = '0'.repeat(64);
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    assert.throws(
      () => verifyUpstreams({ root: fixture }),
      /QR source script\.js: hash mismatch/iu
    );

    const source = path.join(fixture, 'vendor', 'qr-generator', 'public', 'script.js');
    const current = sha256(source);
    const repaired = JSON.parse(fs.readFileSync(file, 'utf8'));
    repaired.upstream.qr['script.js'].sha256 = current;
    fs.writeFileSync(file, `${JSON.stringify(repaired, null, 2)}\n`, 'utf8');
    assert.doesNotThrow(() => verifyUpstreams({ root: fixture }));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify uses committed generated fallback read-only when upstream sources are unavailable', () => {
  const fixture = copyRendererFixture();
  try {
    fs.mkdirSync(path.join(fixture, 'vendor', 'qr-generator'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'vendor', 'pdf-editor'), { recursive: true });
    const before = fs.readFileSync(path.join(fixture, 'renderer', 'vendor', 'MANIFEST.json'));
    const result = verifyUpstreams({ root: fixture });
    assert.deepEqual(result.sourceChecks, { qr: false, pdf: false });
    assert.deepEqual(fs.readFileSync(path.join(fixture, 'renderer', 'vendor', 'MANIFEST.json')), before);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify rejects a partially checked-out upstream source tree instead of using fallback', () => {
  const fixture = copySourceFixture();
  try {
    assert.equal(fs.existsSync(path.join(fixture, 'vendor', 'qr-generator', '.git')), true);
    const missing = path.join(fixture, 'vendor', 'qr-generator', 'public', 'script.js');
    fs.rmSync(missing);
    assert.throws(
      () => verifyUpstreams({ root: fixture }),
      /QR source tree is present but required files are missing: .*script\.js/iu
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function makeSyncFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kusunoki-sync-'));
  for (const entry of ENTRIES) {
    const directory = path.join(fixture, entry.relative);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, '.git'), 'gitdir: fixture\n', 'utf8');
  }
  return fixture;
}

function fakeGitFactory(calls, options = {}) {
  return (directory, args) => {
    calls.push({ directory, args: [...args] });
    if (args[0] === 'status') {
      if (args[1] === '--porcelain=v1' && options.dirtyDirectory === directory) return ' M public/script.js\n';
      if (args[1] === '--porcelain=v1' && args.includes('--') && options.managedDirtyRoot === directory) {
        return ' M renderer/generated/upstream/qr/script.js\n';
      }
      return '';
    }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return directory;
    if (args[0] === 'fetch') {
      if (options.fetchFailureDirectory === directory) throw new Error('fixture fetch failed');
      return '';
    }
    if (args[0] === 'rev-parse' && args[2] === 'FETCH_HEAD^{commit}') {
      return directory.includes('qr-generator') ? '1111111111111111111111111111111111111111\n' : '2222222222222222222222222222222222222222\n';
    }
    if (args[0] === 'checkout') return '';
    throw new Error(`unexpected git fixture command: ${args.join(' ')}`);
  };
}

test('sync fetches both upstreams before checkout and stages without commit or push', () => {
  const fixture = makeSyncFixture();
  try {
    const calls = [];
    let staged = false;
    syncUpstreams({
      root: fixture,
      runGit: fakeGitFactory(calls),
      runStage: () => { staged = true; }
    });
    const fetchIndexes = calls.map((call, index) => call.args[0] === 'fetch' ? index : -1).filter((index) => index >= 0);
    const checkoutIndexes = calls.map((call, index) => call.args[0] === 'checkout' ? index : -1).filter((index) => index >= 0);
    assert.equal(fetchIndexes.length, 2);
    assert.equal(checkoutIndexes.length, 2);
    assert.ok(Math.max(...fetchIndexes) < Math.min(...checkoutIndexes));
    assert.ok(staged);
    assert.equal(calls.some((call) => ['commit', 'push'].includes(call.args[0])), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('sync fails before checkout on missing, dirty, and fetch-failing fixtures', () => {
  const missing = makeSyncFixture();
  try {
    fs.rmSync(path.join(missing, 'vendor', 'pdf-editor'), { recursive: true, force: true });
    const calls = [];
    assert.throws(
      () => syncUpstreams({ root: missing, runGit: fakeGitFactory(calls), runStage: () => {} }),
      /pdf-editor: submodule is not initialized/iu
    );
    assert.equal(calls.some((call) => call.args[0] === 'fetch' || call.args[0] === 'checkout'), false);
  } finally {
    fs.rmSync(missing, { recursive: true, force: true });
  }

  const dirty = makeSyncFixture();
  try {
    const qrDirectory = path.join(dirty, 'vendor', 'qr-generator');
    const calls = [];
    assert.throws(
      () => syncUpstreams({ root: dirty, runGit: fakeGitFactory(calls, { dirtyDirectory: qrDirectory }), runStage: () => {} }),
      /qr-generator: submodule working tree is dirty/iu
    );
    assert.equal(calls.some((call) => call.args[0] === 'fetch' || call.args[0] === 'checkout'), false);
  } finally {
    fs.rmSync(dirty, { recursive: true, force: true });
  }

  const fetchFailure = makeSyncFixture();
  try {
    const pdfDirectory = path.join(fetchFailure, 'vendor', 'pdf-editor');
    const calls = [];
    assert.throws(
      () => syncUpstreams({ root: fetchFailure, runGit: fakeGitFactory(calls, { fetchFailureDirectory: pdfDirectory }), runStage: () => {} }),
      /pdf-editor: fetch origin\/main failed/iu
    );
    assert.equal(calls.some((call) => call.args[0] === 'checkout'), false);
  } finally {
    fs.rmSync(fetchFailure, { recursive: true, force: true });
  }
});

test('sync rejects dirty parent managed paths before fetch, checkout, or stage', () => {
  const fixture = makeSyncFixture();
  try {
    const calls = [];
    let staged = false;
    assert.throws(
      () => syncUpstreams({
        root: fixture,
        runGit: fakeGitFactory(calls, { managedDirtyRoot: fixture }),
        runStage: () => { staged = true; }
      }),
      /parent repository managed paths are dirty/iu
    );
    assert.equal(calls.some((call) => call.args[0] === 'fetch' || call.args[0] === 'checkout'), false);
    assert.equal(staged, false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
