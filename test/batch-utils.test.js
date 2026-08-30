const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createBatchFileNames,
  decodeCsvBytes,
  parseBatchCsv,
  parseBatchInput,
  sanitizePngFileName
} = require('../renderer/batch-utils-node');

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

test('CSV parser accepts UTF-8 BOM and English/Japanese headers', () => {
  const english = parseBatchCsv('\uFEFFURL,Name\nhttps://example.com/a,a.png');
  assert.equal(english.valid, true);
  assert.deepEqual(english.items, [{ line: 2, url: 'https://example.com/a', name: 'a.png' }]);

  const japanese = parseBatchCsv('URL,ファイル名\r\nhttps://example.com/b,b');
  assert.equal(japanese.valid, true);
  assert.deepEqual(japanese.items, [{ line: 2, url: 'https://example.com/b', name: 'b' }]);
});

test('CSV parser preserves quoted commas and physical lines in quoted newlines', () => {
  const parsed = parseBatchCsv([
    'URL,ファイル名',
    'https://example.com/a,"name,with,commas.png"',
    'https://example.com/b,"first line',
    'second line.png"'
  ].join('\n'));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.items[0].name, 'name,with,commas.png');
  assert.equal(parsed.items[1].line, 3);
  assert.equal(parsed.items[1].name, 'first line\nsecond line.png');
});

test('CSV parser reports extra columns and unclosed quotes with row numbers', () => {
  const extra = parseBatchCsv('https://example.com/a,a,b');
  assert.equal(extra.valid, false);
  assert.equal(extra.errors[0].line, 1);
  assert.match(extra.errors[0].reason, /2列以内/u);

  const unclosed = parseBatchCsv('https://example.com/a,"name');
  assert.equal(unclosed.valid, false);
  assert.equal(unclosed.errors[0].line, 1);
  assert.match(unclosed.errors[0].reason, /閉じられていません/u);
});

test('CSV decoding prefers UTF-8 and falls back to Shift_JIS', () => {
  const utf8 = new TextEncoder().encode('\uFEFFURL,Name\nhttps://example.com/a,name');
  assert.equal(decodeCsvBytes(utf8), 'URL,Name\nhttps://example.com/a,name');

  // 0x83 0x65 is the Shift_JIS sequence for 「テ」 and is invalid UTF-8.
  const ascii = Buffer.from('URL,Name\nhttps://example.com/a,', 'ascii');
  const shiftJis = new Uint8Array(ascii.length + 2);
  shiftJis.set(ascii);
  shiftJis.set([0x83, 0x65], ascii.length);
  assert.equal(decodeCsvBytes(shiftJis), 'URL,Name\nhttps://example.com/a,テ');
});

test('CSV parser enforces the 100-item limit', () => {
  const csv = Array.from({ length: 101 }, (_, index) => `https://example.com/${index},${index}`).join('\n');
  const parsed = parseBatchCsv(csv);
  assert.equal(parsed.items.length, 101);
  assert.equal(parsed.valid, false);
  assert.ok(parsed.errors.some((error) => /100件まで/u.test(error.reason)));
});
