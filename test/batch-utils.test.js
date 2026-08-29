const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBatchInput, createBatchFileNames, sanitizePngFileName } = require('../renderer/batch-utils-node');

test('batch parser preserves physical line correspondence and URL rules', () => {
  const parsed = parseBatchInput('https://example.com/a\n\nnot-a-url', 'a\nname-only\nthird');
  assert.equal(parsed.valid, false);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.errors.length, 2);
  assert.equal(parsed.errors[0].line, 2);
  assert.equal(parsed.errors[1].line, 3);
  assert.equal(parseBatchInput('https:example.com', '').valid, false);
});

test('batch file names are portable, bounded, and case-insensitively unique', () => {
  assert.equal(sanitizePngFileName('CON.PNG'), '_CON.png');
  assert.equal(sanitizePngFileName('a<>:"/\\|?*'), 'a_________.png');
  const names = createBatchFileNames([{ url: 'https://example.com/a', name: 'same.png' }, { url: 'https://example.com/b', name: 'same.PNG' }]);
  assert.deepEqual(names, ['same.png', 'same_2.png']);
  assert.ok(names.every((name) => name.length <= 240));
});
