const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_INPUT_FILES = 32;

function asBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new TypeError('PDFデータの形式が不正です。');
}

function assertFiles(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_INPUT_FILES) {
    throw new RangeError(`PDFは1〜${MAX_INPUT_FILES}件指定してください。`);
  }
  return files.map((file) => {
    const bytes = asBytes(file);
    if (bytes.length === 0 || bytes.length > MAX_PDF_BYTES) throw new RangeError('PDFファイルのサイズが不正です。');
    return bytes;
  });
}

function parsePageRange(value, pageCount) {
  const text = String(value ?? '').trim();
  if (!text) return Array.from({ length: pageCount }, (_, index) => index);
  const pages = new Set();
  for (const token of text.split(',')) {
    const part = token.trim();
    if (!part) continue;
    const range = /^(\d+)(?:\s*-\s*(\d+))?$/u.exec(part);
    if (!range) throw new TypeError(`ページ範囲が不正です: ${part}`);
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : start;
    if (start < 1 || end < start || end > pageCount) throw new RangeError(`ページ範囲が不正です: ${part}`);
    for (let page = start; page <= end; page += 1) pages.add(page - 1);
  }
  return [...pages].sort((left, right) => left - right);
}

function mmToPoints(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new RangeError('用紙サイズが不正です。');
  return number * 72 / 25.4;
}

const PAPER_SIZES = {
  A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297], A5: [148, 210], A6: [105, 148],
  B0: [1030, 1456], B1: [728, 1030], B2: [515, 728], B3: [364, 515], B4: [257, 364], B5: [182, 257], B6: [128, 182]
};

function targetPageSize(config, pages) {
  const preset = String(config?.preset || config?.target || 'A4');
  let dimensions = PAPER_SIZES[preset];
  if (preset === 'largest' || preset === 'smallest') {
    const areas = pages.map((page) => page.getWidth() * page.getHeight());
    const index = preset === 'largest'
      ? areas.indexOf(Math.max(...areas))
      : areas.indexOf(Math.min(...areas));
    return [pages[index].getWidth(), pages[index].getHeight()];
  }
  if (preset === 'custom') dimensions = [Number(config.width), Number(config.height)];
  if (!dimensions) dimensions = PAPER_SIZES.A4;
  let [width, height] = dimensions.map(mmToPoints);
  if (config.orientation === 'landscape') [width, height] = [height, width];
  return [width, height];
}

async function copyAllPages(output, documents) {
  for (const document of documents) {
    const pages = await output.copyPages(document, document.getPageIndices());
    pages.forEach((page) => output.addPage(page));
  }
}

async function copySelectedPages(output, document, indices) {
  const pages = await output.copyPages(document, indices);
  pages.forEach((page) => output.addPage(page));
}

/**
 * Split a landscape/spread page into two real PDF pages. Copying the page
 * twice and changing each MediaBox/CropBox keeps the original vector content
 * intact while clipping the left or right half at display time.
 */
async function splitWidePages(document, order = 'right-first') {
  const splitDocument = await PDFDocument.create();
  for (let index = 0; index < document.getPageCount(); index += 1) {
    const source = document.getPage(index);
    const width = source.getWidth();
    const height = source.getHeight();
    if (width <= height * 1.15) {
      const [page] = await splitDocument.copyPages(document, [index]);
      splitDocument.addPage(page);
      continue;
    }
    const half = width / 2;
    const halves = order === 'left-first' ? [0, half] : [half, 0];
    for (const x of halves) {
      const [page] = await splitDocument.copyPages(document, [index]);
      page.setMediaBox(x, 0, half, height);
      page.setCropBox(x, 0, half, height);
      splitDocument.addPage(page);
    }
  }
  return splitDocument;
}

function applyPageNumbers(document, config = {}) {
  const style = ['dash', 'bracket', 'fraction'].includes(config.style) ? config.style : 'dash';
  const fontSize = Math.min(300, Math.max(8, Number(config.fontSize) || 10));
  const startPage = Math.max(1, Number(config.startPage) || 1);
  const font = document.embedStandardFont(StandardFonts.Helvetica);
  const total = document.getPageCount() - startPage + 1;
  document.getPages().forEach((page, index) => {
    if (index + 1 < startPage) return;
    const number = index + 1 - startPage + 1;
    const label = style === 'fraction' ? `${number} / ${total}` : style === 'bracket' ? `< ${number} >` : `- ${number} -`;
    const width = page.getWidth();
    const labelWidth = font.widthOfTextAtSize(label, fontSize);
    page.drawText(label, {
      x: (width - labelWidth) / 2,
      y: 18,
      size: fontSize,
      font,
      color: rgb(0.25, 0.25, 0.25)
    });
  });
}

function applyPageSizes(document, config = {}) {
  const pages = document.getPages();
  const [width, height] = targetPageSize(config, pages);
  for (const page of pages) {
    if (config.dimension === 'width') page.setWidth(width);
    else page.setSize(width, height);
  }
}

async function applyWatermark(document, watermark = {}) {
  const opacity = Math.min(1, Math.max(0, Number(watermark.opacity ?? 0.5)));
  const rotation = Number(watermark.rotation) || 0;
  const scale = Math.max(0.01, Math.min(10, Number(watermark.scale ?? 1)));
  if (watermark.type === 'text' || watermark.text) {
    const font = document.embedStandardFont(StandardFonts.Helvetica);
    const text = String(watermark.text || 'CONFIDENTIAL').slice(0, 200);
    const size = Math.min(300, Math.max(8, Number(watermark.fontSize) || 48));
    for (const page of document.getPages()) {
      const textWidth = font.widthOfTextAtSize(text, size);
      page.drawText(text, {
        x: (page.getWidth() - textWidth) / 2,
        y: page.getHeight() / 2,
        size,
        font,
        color: parseColor(watermark.color),
        opacity,
        rotate: degrees(rotation)
      });
    }
    return;
  }
  const imageBytes = asBytes(watermark.data);
  if (imageBytes.length === 0 || imageBytes.length > MAX_PDF_BYTES) throw new RangeError('ウォーターマーク画像のサイズが不正です。');
  let image;
  const mime = String(watermark.mimeType || 'image/png').toLowerCase();
  if (mime === 'image/png') image = await document.embedPng(imageBytes);
  else if (mime === 'image/jpeg' || mime === 'image/jpg') image = await document.embedJpg(imageBytes);
  else throw new TypeError('ウォーターマーク画像はPNGまたはJPEGを指定してください。');
  const base = image.scale(scale);
  const requestedWidth = Number(watermark.width);
  const requestedHeight = Number(watermark.height);
  const imageWidth = Number.isFinite(requestedWidth) && requestedWidth > 0 ? requestedWidth : base.width;
  const imageHeight = Number.isFinite(requestedHeight) && requestedHeight > 0 ? requestedHeight : base.height;
  for (const page of document.getPages()) {
    page.drawImage(image, {
      x: (page.getWidth() - imageWidth) / 2,
      y: (page.getHeight() - imageHeight) / 2,
      width: imageWidth,
      height: imageHeight,
      opacity,
      rotate: degrees(rotation)
    });
  }
}

function parseColor(value) {
  const text = String(value || '#808080');
  const match = /^#?([\da-f]{6})$/iu.exec(text);
  if (!match) return rgb(0.5, 0.5, 0.5);
  return rgb(
    Number.parseInt(match[1].slice(0, 2), 16) / 255,
    Number.parseInt(match[1].slice(2, 4), 16) / 255,
    Number.parseInt(match[1].slice(4, 6), 16) / 255
  );
}

async function processPdf(input) {
  const files = assertFiles(input?.files);
  const config = input?.config && typeof input.config === 'object' ? input.config : {};
  const operation = String(input?.operation || config.operation || 'merge');
  let output = await PDFDocument.create();
  const documents = await Promise.all(files.map((bytes) => PDFDocument.load(bytes)));

  if (operation === 'split') {
    const first = documents[0];
    await copySelectedPages(output, first, parsePageRange(config.range, first.getPageCount()));
  } else {
    await copyAllPages(output, documents);
  }

  if (operation === 'spread' || config.spreadSplit) {
    output = await splitWidePages(output, config.spreadOrder || 'right-first');
  }
  if (operation === 'pageNumbers' || config.pageNumbers) applyPageNumbers(output, config.pageNumbers || config);
  if (operation === 'size' || config.pageSize) applyPageSizes(output, config.pageSize || config);
  if (config.watermark || operation === 'watermark') await applyWatermark(output, config.watermark || input.watermark || {});
  return new Uint8Array(await output.save({ useObjectStreams: false }));
}

module.exports = {
  MAX_INPUT_FILES,
  MAX_PDF_BYTES,
  PAPER_SIZES,
  applyPageNumbers,
  applyPageSizes,
  applyWatermark,
  parseColor,
  parsePageRange,
  processPdf,
  splitWidePages,
  targetPageSize
};
