const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { parsePageRange, processPdf } = require('../electron/pdf-service');

async function makePdf(pageCount, width = 595, height = 842) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) document.addPage([width, height]);
  return new Uint8Array(await document.save({ useObjectStreams: false }));
}

test('page range parsing handles ranges and rejects unsafe values', () => {
  assert.deepEqual(parsePageRange('1-3,5', 5), [0, 1, 2, 4]);
  assert.deepEqual(parsePageRange('', 2), [0, 1]);
  assert.throws(() => parsePageRange('0', 2), /不正/);
  assert.throws(() => parsePageRange('1-9', 2), /不正/);
});

test('PDF merge, split, page numbers, size, and text watermark are local', async () => {
  const first = await makePdf(2); const second = await makePdf(1);
  const merged = await processPdf({ files: [first, second], operation: 'merge', config: { pageNumbers: { style: 'fraction', fontSize: 10, startPage: 1 } } });
  assert.equal((await PDFDocument.load(merged)).getPageCount(), 3);
  const split = await processPdf({ files: [first], operation: 'split', config: { range: '2' } });
  assert.equal((await PDFDocument.load(split)).getPageCount(), 1);
  const resized = await processPdf({ files: [first], operation: 'merge', config: { pageSize: { preset: 'A4', orientation: 'portrait' } } });
  const resizedPage = (await PDFDocument.load(resized)).getPage(0); assert.equal(Math.round(resizedPage.getWidth()), 595); assert.equal(Math.round(resizedPage.getHeight()), 842);
  const marked = await processPdf({ files: [first], operation: 'watermark', config: { watermark: { type: 'text', text: 'TEST', fontSize: 20, opacity: .5 } } });
  assert.equal((await PDFDocument.load(marked)).getPageCount(), 2);
  const spreadSource = await makePdf(1, 1200, 600);
  const spread = await processPdf({ files: [spreadSource], operation: 'spread', config: { spreadSplit: true, spreadOrder: 'right-first' } });
  const spreadDocument = await PDFDocument.load(spread);
  assert.equal(spreadDocument.getPageCount(), 2);
  assert.equal(Math.round(spreadDocument.getPage(0).getWidth()), 600);
});
