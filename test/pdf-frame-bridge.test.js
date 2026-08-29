const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const bridgePath = path.join(root, 'renderer', 'generated', 'upstream', 'pdf', 'pdf-frame-bridge.js');

function loadFrameBridge() {
  if (!fs.existsSync(bridgePath)) require('../scripts/stage-vendors');
  const listeners = new Map();
  const parentMessages = [];
  const parent = { postMessage: (message) => parentMessages.push(message) };
  const inputEvents = [];
  const input = { files: null, dispatchEvent: (event) => inputEvents.push(event.type) };
  const mode = { checked: false, dispatchEvent: (event) => inputEvents.push(`mode:${event.type}`) };
  const document = {
    getElementById(id) {
      if (id === 'wm-img-input') return input;
      if (id === 'mode-watermark') return mode;
      return null;
    }
  };
  class FakeFile {
    constructor(parts, name, options) {
      this.name = name;
      this.type = options.type;
      this.bytes = new Uint8Array(parts[0]);
    }
  }
  class FakeDataTransfer {
    constructor() {
      this.items = { files: [], add: (file) => this.items.files.push(file) };
      this.files = this.items.files;
    }
  }
  const context = {
    window: {
      parent,
      location: { origin: 'null' },
      addEventListener: (type, listener) => listeners.set(type, listener)
    },
    document,
    ArrayBuffer,
    Uint8Array,
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    Event: class { constructor(type) { this.type = type; } }
  };
  vm.runInNewContext(fs.readFileSync(bridgePath, 'utf8'), context, { filename: bridgePath });
  return { listeners, parent, parentMessages, input, inputEvents, mode };
}

test('generated PDF frame bridge sends ready and applies only validated parent handoffs', () => {
  const fixture = loadFrameBridge();
  fixture.listeners.get('DOMContentLoaded')();
  assert.equal(fixture.parentMessages.at(-1).type, 'kusunoki:pdf:ready');

  const message = {
    version: 1,
    type: 'kusunoki:pdf:set-watermark',
    payload: {
      data: new Uint8Array([9, 8, 7]).buffer,
      fileName: 'from-qr.png',
      mimeType: 'image/png',
      text: 'https://example.com'
    }
  };
  fixture.listeners.get('message')({ source: {}, origin: 'null', data: message });
  assert.equal(fixture.input.files, null);
  fixture.listeners.get('message')({ source: fixture.parent, origin: 'https://attacker.invalid', data: message });
  assert.equal(fixture.input.files, null);

  fixture.listeners.get('message')({ source: fixture.parent, origin: 'null', data: message });
  assert.equal(fixture.mode.checked, true);
  assert.equal(fixture.input.files.length, 1);
  assert.equal(fixture.input.files[0].name, 'from-qr.png');
  assert.deepEqual(Array.from(fixture.input.files[0].bytes), [9, 8, 7]);
  assert.deepEqual(fixture.inputEvents, ['mode:change', 'input', 'change']);
  assert.equal(fixture.parentMessages.at(-1).type, 'kusunoki:pdf:watermark-applied');

  const before = fixture.input.files;
  fixture.listeners.get('message')({
    source: fixture.parent,
    origin: 'null',
    data: { version: 99, type: 'kusunoki:pdf:set-watermark', payload: message.payload }
  });
  assert.equal(fixture.input.files, before);
  fixture.listeners.get('message')({
    source: fixture.parent,
    origin: 'null',
    data: { version: 1, type: 'kusunoki:pdf:set-watermark', payload: { ...message.payload, fileName: '../escape.png' } }
  });
  assert.equal(fixture.input.files, before);
});
