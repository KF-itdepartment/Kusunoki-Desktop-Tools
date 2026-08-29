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
  const batchClassicPath = path.join(upstreamRoot, 'qr', 'batch-utils.js');
  const batchClassic = fs.readFileSync(batchClassicPath, 'utf8');
  const pdfFrameBridgePath = path.join(upstreamRoot, 'pdf', 'pdf-frame-bridge.js');
  const pdfFrameBridge = fs.readFileSync(pdfFrameBridgePath, 'utf8');
  const pdfDataUrlPath = path.join(upstreamRoot, 'pdf', 'pdf-data-url.js');
  const pdfDataUrl = fs.readFileSync(pdfDataUrlPath, 'utf8');
  const pdfHtml = fs.readFileSync(path.join(upstreamRoot, 'pdf', 'index.html'), 'utf8');
  const pdfScript = fs.readFileSync(path.join(upstreamRoot, 'pdf', 'script.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

  assert.equal(manifest.schema, 2);
  assert.equal(manifest.upstream.qr['script.js'].source, 'vendor/qr-generator/public/script.js');
  assert.equal(manifest.upstream.pdf['script.js'].source, 'vendor/pdf-editor/script.js');
  assert.equal(manifest.upstream.pdf['script.js'].sha256, sha256(path.join(root, 'vendor', 'pdf-editor', 'script.js')));
  assert.equal(manifest.upstream.qr['logo.png'].sha256, sha256(path.join(root, 'vendor', 'qr-generator', 'public', 'logo.png')));
  assert.equal(manifest.integration.qrBatch.file, 'renderer/generated/upstream/qr/batch-utils.js');
  assert.equal(manifest.integration.pdfFrameBridge.file, 'renderer/generated/upstream/pdf/pdf-frame-bridge.js');
  assert.equal(manifest.integration.pdfDataUrl.file, 'renderer/generated/upstream/pdf/pdf-data-url.js');
  assert.equal(manifest.integration.qrBatch.source, 'vendor/qr-generator/public/batch-utils.mjs');
  assert.equal(manifest.upstream.qr['batch-utils.js'].source, 'vendor/qr-generator/public/batch-utils.mjs');
  assert.equal(manifest.integration.qrBatch.sha256, sha256(batchClassicPath));
  assert.equal(manifest.integration.pdfFrameBridge.sha256, sha256(pdfFrameBridgePath));
  assert.equal(manifest.integration.pdfDataUrl.sha256, sha256(pdfDataUrlPath));
  assert.match(batchClassic, /Generated from vendor\/qr-generator\/public\/batch-utils\.mjs/);
  assert.match(pdfHtml, /pdf-frame-bridge\.js/);
  assert.match(pdfHtml, /Content-Security-Policy/);
  assert.match(pdfFrameBridge, /kusunoki:pdf:set-watermark/);
  assert.match(pdfFrameBridge, /event\.source !== window\.parent/);
  assert.match(pdfDataUrl, /KusunokiPdfDataUrlToArrayBuffer/);
  assert.doesNotMatch(pdfScript, /fetch\s*\(/iu);
  assert.match(pdfHtml, /connect-src 'none'/);
  assert.ok(pdfHtml.indexOf('pdf-frame-bridge.js') < pdfHtml.lastIndexOf('script.js'));
  assert.match(pdfHtml, /\.\.\/\.\.\/\.\.\/vendor\/pdf-lib\.min\.js/);
  assert.match(pdfHtml, /\.\.\/\.\.\/\.\.\/vendor\/pdf\.min\.js/);
  assert.match(pdfHtml, /\.\.\/\.\.\/\.\.\/vendor\/jszip\.min\.js/);
  assert.match(pdfScript, /\.\.\/\.\.\/\.\.\/vendor\/pdf\.worker\.min\.js/);
  assert.doesNotMatch(pdfHtml, /unpkg|jsdelivr/iu);
  assert.doesNotMatch(pdfScript, /unpkg|jsdelivr/iu);
  assert.match(html, /generated\/upstream-adapter\.js/);
  assert.match(html, /generated\/upstream\/qr\/batch-utils\.js/);
  assert.doesNotMatch(html, /src="\.\/batch-utils\.js"/);
  assert.match(html, /pdf-editor-frame/);
  assert.match(html, /generated\/upstream\/pdf\/index\.html/);
  assert.doesNotMatch(html, /<iframe[^>]+id="pdf-editor-frame"[^>]+sandbox/iu);
  assert.match(html, /legacy-pdf-fallback" hidden/);
  assert.match(app, /generated\.qr\.batch\.parseBatchInput/);
  assert.doesNotMatch(app, /window\.BatchUtils/);
  assert.match(app, /generated\.pdf\.process/);
  assert.match(app, /generated\.qr\.createPdfHandoff/);
  assert.match(app, /generated\.pdfFrame\.createWatermarkMessage/);
  assert.match(app, /generated\.pdfFrame\.validateMessage/);
  assert.match(app, /setupPdfFrame/);

  // Execute the generated classic transform, not a hand-maintained test
  // double. These are the functions used by app.js at runtime.
  const batchSandbox = { window: {}, ArrayBuffer, Uint8Array, URL };
  vm.runInNewContext(batchClassic, batchSandbox, { filename: batchClassicPath });
  const generatedBatch = batchSandbox.window.BatchUtils;
  const parsed = generatedBatch.parseBatchInput('https://example.com/a\nnot-a-url', 'first.png\nsecond.png');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.errors.length, 1);
  assert.deepEqual(generatedBatch.assignBatchFileNames(parsed.items)[0].fileName, 'first.png');

  const sandbox = {
    window: {
      BatchUtils: generatedBatch,
      location: { origin: 'null' },
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
  const frameWindow = {};
  const frameMessage = bridge.pdfFrame.createWatermarkMessage(handoff);
  assert.equal(frameMessage.version, 1);
  assert.equal(frameMessage.type, 'kusunoki:pdf:set-watermark');
  assert.deepEqual(Array.from(new Uint8Array(frameMessage.payload.data)), [1, 2, 3]);
  assert.equal(bridge.pdfFrame.validateMessage({ source: frameWindow, origin: 'null', data: { version: 1, type: 'kusunoki:pdf:ready', payload: { source: 'generated/upstream/pdf', capabilities: ['watermark-file'] } } }, frameWindow).type, 'kusunoki:pdf:ready');
  assert.equal(bridge.pdfFrame.validateMessage({ source: {}, origin: 'null', data: { version: 1, type: 'kusunoki:pdf:ready', payload: {} } }, frameWindow), null);
});

test('generated upstream files remain byte-for-byte stable across staging runs', () => {
  const files = [
    path.join(generatedRoot, 'upstream', 'qr', 'script.js'),
    path.join(generatedRoot, 'upstream', 'qr', 'batch-utils.mjs'),
    path.join(generatedRoot, 'upstream', 'qr', 'batch-utils.js'),
    path.join(generatedRoot, 'upstream', 'qr', 'vendor', 'fflate.mjs'),
    path.join(generatedRoot, 'upstream', 'qr', 'vendor', 'fflate.LICENSE.txt'),
    path.join(generatedRoot, 'upstream', 'qr', 'logo.png'),
    path.join(generatedRoot, 'upstream', 'pdf', 'script.js'),
    path.join(generatedRoot, 'upstream', 'pdf', 'index.html'),
    path.join(generatedRoot, 'upstream', 'pdf', 'pdf-frame-bridge.js'),
    path.join(generatedRoot, 'upstream', 'pdf', 'pdf-data-url.js'),
    path.join(generatedRoot, 'upstream-adapter.js'),
    path.join(root, 'renderer', 'vendor', 'MANIFEST.json')
  ];
  const before = files.map((file) => fs.readFileSync(file));
  runStage();
  files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index], file));
});
