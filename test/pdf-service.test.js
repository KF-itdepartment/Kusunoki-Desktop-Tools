const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, PDFName, degrees } = require('pdf-lib');
const { findCjkFont, getDisplayedPageSize, getVisiblePageLayout, parsePageRange, processPdf, visualHalfRegions } = require('../electron/pdf-service');

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

test('PDF size transforms content-facing dimensions and keeps rotated pages visual', async () => {
  const sourceDoc = await PDFDocument.create();
  const page = sourceDoc.addPage([600, 1200]);
  page.setRotation(degrees(90));
  page.drawText('rotated content', { x: 40, y: 40, size: 18 });
  const source = new Uint8Array(await sourceDoc.save({ useObjectStreams: false }));
  const loaded = await PDFDocument.load(source);
  assert.deepEqual(getDisplayedPageSize(loaded.getPage(0)), { rawWidth: 600, rawHeight: 1200, rotation: 90, width: 1200, height: 600 });
  const layout = getVisiblePageLayout(loaded.getPage(0));
  assert.equal(layout.isLandscape, true);
  const halves = visualHalfRegions(layout);
  assert.equal(halves.left.height, 600);
  const output = await processPdf({ files: [source], operation: 'spread', config: { spreadSplit: true, spreadOrder: 'left-first' } });
  const result = await PDFDocument.load(output);
  assert.equal(result.getPageCount(), 2);
  assert.equal(result.getPage(0).getRotation().angle, 90);
  assert.equal(Math.round(result.getPage(0).getWidth()), 600);

  const resized = await processPdf({ files: [source], operation: 'size', config: { pageSize: { preset: 'A4', dimension: 'page', orientation: 'portrait' } } });
  const resizedPage = (await PDFDocument.load(resized)).getPage(0);
  assert.equal(Math.round(resizedPage.getWidth()), 842);
  assert.equal(Math.round(resizedPage.getHeight()), 595);
});

test('page-size transform keeps link annotation geometry in sync', async () => {
  const sourceDoc = await PDFDocument.create();
  const page = sourceDoc.addPage([200, 100]);
  const context = sourceDoc.context;
  const annotation = context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [20, 20, 80, 60], Border: [0, 0, 1],
    A: { S: 'URI', URI: 'https://example.com' }
  });
  const annotationRef = context.register(annotation);
  page.node.set(PDFName.of('Annots'), context.obj([annotationRef]));
  const source = new Uint8Array(await sourceDoc.save({ useObjectStreams: false }));
  const output = await processPdf({ files: [source], operation: 'size', config: { pageSize: { preset: 'custom', width: 400, height: 200, dimension: 'page' } } });
  const result = await PDFDocument.load(output);
  const resultPage = result.getPage(0);
  const annots = result.context.lookup(resultPage.node.get(PDFName.of('Annots')));
  const rect = result.context.lookup(annots.get(0)).get(PDFName.of('Rect'));
  const values = [0, 1, 2, 3].map((index) => result.context.lookup(rect).get(index).asNumber());
  assert.deepEqual(values.map((value) => Math.round(value)), [113, 113, 454, 340]);
});

test('Japanese text watermark is embedded when a platform CJK font is available', async (t) => {
  if (!findCjkFont()) {
    t.skip('No supported platform CJK font is installed in this test environment.');
    return;
  }
  const source = await makePdf(1);
  const marked = await processPdf({ files: [source], operation: 'watermark', config: { watermark: { type: 'text', text: '社内確認', fontSize: 18, opacity: .5 } } });
  assert.equal((await PDFDocument.load(marked)).getPageCount(), 1);
});

test('page-size transform follows form widget geometry', async () => {
  const sourceDoc = await PDFDocument.create();
  const page = sourceDoc.addPage([200, 100]);
  const field = sourceDoc.getForm().createTextField('customer-name');
  field.addToPage(page, { x: 20, y: 20, width: 60, height: 30 });
  const source = new Uint8Array(await sourceDoc.save({ useObjectStreams: false }));
  const output = await processPdf({ files: [source], operation: 'size', config: { pageSize: { preset: 'custom', width: 400, height: 200, dimension: 'page' } } });
  const result = await PDFDocument.load(output);
  const rectangle = result.getForm().getTextField('customer-name').acroField.getWidgets()[0].getRectangle();
  assert.ok(rectangle.x > 100 && rectangle.x < 130);
  assert.ok(rectangle.y > 100 && rectangle.y < 130);
  assert.ok(rectangle.width > 330 && rectangle.width < 360);
  assert.ok(rectangle.height > 160 && rectangle.height < 190);
});
