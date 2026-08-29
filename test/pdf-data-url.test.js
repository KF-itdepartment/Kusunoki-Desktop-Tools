const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const helperPath = path.join(root, 'renderer', 'generated', 'upstream', 'pdf', 'pdf-data-url.js');
const scriptPath = path.join(root, 'renderer', 'generated', 'upstream', 'pdf', 'script.js');

function loadConverter() {
  if (!fs.existsSync(helperPath)) require('../scripts/stage-vendors');
  const context = {
    window: {},
    Uint8Array,
    TextEncoder,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    decodeURIComponent
  };
  vm.runInNewContext(fs.readFileSync(helperPath, 'utf8'), context, { filename: helperPath });
  return context.window.KusunokiPdfDataUrlToArrayBuffer;
}

test('generated PDF data URL converter decodes base64 and percent payloads locally', () => {
  const convert = loadConverter();
  assert.deepEqual(
    Array.from(new Uint8Array(convert('data:application/octet-stream;base64,AAEC/w=='))),
    [0, 1, 2, 255]
  );
  assert.deepEqual(
    Array.from(new Uint8Array(convert('data:text/plain;charset=utf-8,hello%20%E3%81%82'))),
    Array.from(new TextEncoder().encode('hello あ'))
  );
  assert.throws(() => convert('https://example.com/remote'), /data URL/);
  assert.doesNotMatch(fs.readFileSync(scriptPath, 'utf8'), /fetch\s*\(/iu);
});
