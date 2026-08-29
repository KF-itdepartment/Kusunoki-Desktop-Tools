const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const generatedRoot = path.join(root, 'renderer', 'generated');
const upstreamRoot = path.join(generatedRoot, 'upstream');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runStage() {
  const script = require.resolve('../scripts/stage-vendors.js');
  delete require.cache[script];
  require(script);
}

test('vendor stage is reproducible and generated output is the renderer input', () => {
  runStage();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'renderer', 'vendor', 'MANIFEST.json'), 'utf8'));
  const adapterPath = path.join(generatedRoot, 'upstream-adapter.js');
  const adapter = fs.readFileSync(adapterPath, 'utf8');
  const pdfHtml = fs.readFileSync(path.join(upstreamRoot, 'pdf', 'index.html'), 'utf8');
  const pdfScript = fs.readFileSync(path.join(upstreamRoot, 'pdf', 'script.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

  assert.equal(manifest.schema, 2);
  assert.equal(manifest.upstream.qr['script.js'].source, 'vendor/qr-generator/public/script.js');
  assert.equal(manifest.upstream.pdf['script.js'].source, 'vendor/pdf-editor/script.js');
  assert.equal(manifest.upstream.pdf['script.js'].sha256, sha256(path.join(root, 'vendor', 'pdf-editor', 'script.js')));
  assert.equal(manifest.upstream.qr['logo.png'].sha256, sha256(path.join(root, 'vendor', 'qr-generator', 'public', 'logo.png')));
  assert.match(pdfHtml, /\.\.\/\.\.\/\.\.\/vendor\/pdf-lib\.min\.js/);
  assert.match(pdfHtml, /\.\.\/\.\.\/\.\.\/vendor\/pdf\.min\.js/);
  assert.match(pdfHtml, /\.\.\/\.\.\/\.\.\/vendor\/jszip\.min\.js/);
  assert.match(pdfScript, /\.\.\/\.\.\/\.\.\/vendor\/pdf\.worker\.min\.js/);
  assert.doesNotMatch(pdfHtml, /unpkg|jsdelivr/iu);
  assert.doesNotMatch(pdfScript, /unpkg|jsdelivr/iu);
  assert.match(html, /generated\/upstream-adapter\.js/);
  assert.match(html, /batch-utils\.js/);
  assert.match(app, /generated\.qr\.batch\.parseBatchInput/);
  assert.match(app, /generated\.pdf\.process/);
  assert.match(app, /generated\.qr\.createPdfHandoff/);

  const sandbox = {
    window: {
      BatchUtils: {
        parseBatchInput: (urls, names) => ({ urls, names }),
        assignBatchFileNames: (items) => items
      },
      desktop: { pdf: { process: (payload) => payload } }
    },
    ArrayBuffer,
    Uint8Array
  };
  vm.runInNewContext(adapter, sandbox, { filename: adapterPath });
  const bridge = sandbox.window.KusunokiGeneratedUpstream;
  const handoff = bridge.qr.createPdfHandoff(new Uint8Array([1, 2, 3]), 'QR text');
  assert.deepEqual([...handoff.data], [1, 2, 3]);
  assert.equal(handoff.mimeType, 'image/png');
  assert.deepEqual(bridge.pdf.process({ operation: 'merge' }), { operation: 'merge' });
});

test('generated upstream files remain byte-for-byte stable across staging runs', () => {
  const files = [
    path.join(generatedRoot, 'upstream', 'qr', 'script.js'),
    path.join(generatedRoot, 'upstream', 'qr', 'batch-utils.mjs'),
    path.join(generatedRoot, 'upstream', 'qr', 'logo.png'),
    path.join(generatedRoot, 'upstream', 'pdf', 'script.js'),
    path.join(generatedRoot, 'upstream', 'pdf', 'index.html'),
    path.join(generatedRoot, 'upstream-adapter.js'),
    path.join(root, 'renderer', 'vendor', 'MANIFEST.json')
  ];
  const before = files.map((file) => fs.readFileSync(file));
  runStage();
  files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index], file));
});
