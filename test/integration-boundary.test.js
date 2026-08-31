const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { AssetStore } = require('../electron/asset-store');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');

function loadBridge(processPdf = (payload) => payload) {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'renderer', 'generated', 'upstream-adapter.js'), 'utf8');
  const context = {
    window: {
      BatchUtils: { parseBatchInput: () => ({ valid: true }), assignBatchFileNames: (items) => items },
      location: { origin: 'null' },
      desktop: { pdf: { process: processPdf } }
    },
    ArrayBuffer,
    Uint8Array
  };
  vm.runInNewContext(source, context);
  return context.window.KusunokiGeneratedUpstream;
}

test('QR-to-PDF and persistent asset handoff cross the generated bridge', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kusunoki-integration-'));
  const store = new AssetStore(directory);
  const bridge = loadBridge((payload) => payload);
  const saved = await store.save({ name: 'QR素材', text: 'handoff-text', mimeType: 'image/png', fileName: 'handoff.png', data: PNG });
  const loaded = await store.read(saved.id);
  const handoff = bridge.qr.createPdfHandoff(loaded.data, loaded.metadata.text, loaded.metadata.fileName, loaded.metadata.mimeType);
  assert.deepEqual(Array.from(handoff.data), [...PNG]);
  assert.equal(handoff.text, 'handoff-text');
  assert.equal(handoff.fileName, 'handoff.png');
  const result = bridge.pdf.process({ files: [handoff.data], operation: 'watermark', config: { watermark: handoff } });
  assert.deepEqual(result.files[0], handoff.data);
  assert.equal(result.config.watermark.mimeType, 'image/png');

  const frameWindow = {};
  const message = bridge.pdfFrame.createWatermarkMessage(handoff);
  assert.deepEqual(Array.from(new Uint8Array(message.payload.data)), [...PNG]);
  const accepted = bridge.pdfFrame.validateMessage({
    source: frameWindow,
    origin: 'null',
    data: { version: 1, type: 'kusunoki:pdf:watermark-applied', payload: { fileName: 'handoff.png', mimeType: 'image/png', byteLength: PNG.length } }
  }, frameWindow);
  assert.equal(accepted.payload.byteLength, PNG.length);
  assert.equal(bridge.pdfFrame.validateMessage({
    source: {},
    origin: 'null',
    data: message
  }, frameWindow), null);
  assert.throws(() => bridge.pdfFrame.createWatermarkMessage({ data: new Uint8Array(20 * 1024 * 1024 + 1), fileName: 'too-large.png', mimeType: 'image/png' }), /PDF/);
});
