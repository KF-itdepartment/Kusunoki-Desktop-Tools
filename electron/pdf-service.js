const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument, StandardFonts, PDFArray, PDFDict, PDFName, PDFNumber, degrees, rgb } = require('pdf-lib');

let fontkit = null;
try {
  // Optional at development time; package.json includes it for packaged
  // builds. Helvetica remains a safe fallback when a system CJK font is not
  // installed on a minimal Linux image.
  fontkit = require('@pdf-lib/fontkit');
} catch {
  fontkit = null;
}

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
    const areas = pages.map((page) => {
      const layout = getVisiblePageLayout(page);
      return layout.displayedWidth * layout.displayedHeight;
    });
    const index = preset === 'largest'
      ? areas.indexOf(Math.max(...areas))
      : areas.indexOf(Math.min(...areas));
    const layout = getVisiblePageLayout(pages[index]);
    return [layout.displayedWidth, layout.displayedHeight];
  }
  if (preset === 'custom') dimensions = [Number(config.width), Number(config.height)];
  if (!dimensions) dimensions = PAPER_SIZES.A4;
  let [width, height] = dimensions.map(mmToPoints);
  if (config.orientation === 'landscape') [width, height] = [height, width];
  return [width, height];
}

function normalizePageRotation(value) {
  const angle = ((Number(value) || 0) % 360 + 360) % 360;
  return [0, 90, 180, 270].includes(angle) ? angle : 0;
}

/** Return the visual (viewer-facing) dimensions, matching upstream PDF UI. */
function getVisiblePageLayout(page) {
  const cropBox = typeof page.getCropBox === 'function'
    ? page.getCropBox()
    : { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() };
  const rotation = normalizePageRotation(page.getRotation?.().angle);
  const swapsAxes = rotation === 90 || rotation === 270;
  return {
    cropBox: { ...cropBox },
    rotation,
    displayedWidth: swapsAxes ? cropBox.height : cropBox.width,
    displayedHeight: swapsAxes ? cropBox.width : cropBox.height,
    isLandscape: (swapsAxes ? cropBox.height : cropBox.width) > (swapsAxes ? cropBox.width : cropBox.height)
  };
}

function getDisplayedPageSize(page) {
  const rawWidth = page.getWidth();
  const rawHeight = page.getHeight();
  const rotation = normalizePageRotation(page.getRotation?.().angle);
  const swapsAxes = rotation === 90 || rotation === 270;
  return {
    rawWidth,
    rawHeight,
    rotation,
    width: swapsAxes ? rawHeight : rawWidth,
    height: swapsAxes ? rawWidth : rawHeight
  };
}

function lookupArray(context, dict, key) {
  const value = dict?.get(PDFName.of(key));
  if (!value) return null;
  try {
    const resolved = context.lookup(value);
    return resolved instanceof PDFArray ? resolved : null;
  } catch {
    return null;
  }
}

function setArrayNumber(array, index, value) {
  if (!array || !Number.isFinite(value)) return;
  const item = array.lookup(index, PDFNumber);
  if (item) array.set(index, PDFNumber.of(value));
}

function transformCoordinateArray(array, scale, offsetX, offsetY) {
  for (let index = 0; index + 1 < array.size(); index += 2) {
    const x = array.lookup(index, PDFNumber);
    const y = array.lookup(index + 1, PDFNumber);
    if (x && y) {
      setArrayNumber(array, index, (x.asNumber() * scale) + offsetX);
      setArrayNumber(array, index + 1, (y.asNumber() * scale) + offsetY);
    }
  }
}

function scaleDistanceArray(array, scale) {
  for (let index = 0; index < array.size(); index += 1) {
    const value = array.lookup(index, PDFNumber);
    if (value) setArrayNumber(array, index, value.asNumber() * scale);
  }
}

/**
 * Keep annotations, links, and form geometry attached to content after a
 * page transform. This mirrors the upstream editor's PDFDict/PDFArray pass
 * and supplements pdf-lib's page.scale() for fields it does not expose.
 */
function transformAnnotationGeometry(page, scale, offsetX, offsetY) {
  const context = page.doc?.context;
  if (!context) return;
  const annotations = lookupArray(context, page.node, 'Annots');
  if (!annotations) return;
  for (let index = 0; index < annotations.size(); index += 1) {
    const annotation = context.lookup(annotations.get(index), PDFDict);
    if (!annotation) continue;
    const rect = lookupArray(context, annotation, 'Rect');
    // PDFPage.scale() already updates /Rect. Applying the explicit offset
    // only prevents a second scale of the annotation bounding box.
    if (rect) transformCoordinateArray(rect, 1, offsetX, offsetY);
    ['QuadPoints', 'Vertices', 'L', 'CL'].forEach((key) => {
      const coordinates = lookupArray(context, annotation, key);
      if (coordinates) transformCoordinateArray(coordinates, scale, offsetX, offsetY);
    });
    const inkList = lookupArray(context, annotation, 'InkList');
    if (inkList) {
      for (let strokeIndex = 0; strokeIndex < inkList.size(); strokeIndex += 1) {
        const stroke = context.lookup(inkList.get(strokeIndex), PDFArray);
        if (stroke) transformCoordinateArray(stroke, scale, offsetX, offsetY);
      }
    }
    ['RD', 'Border'].forEach((key) => {
      const distances = lookupArray(context, annotation, key);
      if (distances) scaleDistanceArray(distances, scale);
    });
  }
}

function rectangleValues(rectangle) {
  if (!rectangle || rectangle.size() < 4) return null;
  const values = [0, 1, 2, 3].map((index) => rectangle.lookup(index, PDFNumber));
  if (values.some((value) => !value)) return null;
  return values.map((value) => value.asNumber());
}

function clipAnnotationsToPage(page, width, height) {
  const context = page.doc?.context;
  if (!context) return;
  const annotations = lookupArray(context, page.node, 'Annots');
  if (!annotations) return;
  for (let index = annotations.size() - 1; index >= 0; index -= 1) {
    const annotation = context.lookup(annotations.get(index), PDFDict);
    const rectangle = annotation ? lookupArray(context, annotation, 'Rect') : null;
    const values = rectangleValues(rectangle);
    if (!rectangle || !values) continue;
    const [x1, y1, x2, y2] = values;
    const clippedX1 = Math.max(0, Math.min(x1, x2));
    const clippedY1 = Math.max(0, Math.min(y1, y2));
    const clippedX2 = Math.min(width, Math.max(x1, x2));
    const clippedY2 = Math.min(height, Math.max(y1, y2));
    if (clippedX2 <= clippedX1 || clippedY2 <= clippedY1) {
      annotations.remove(index);
      continue;
    }
    setArrayNumber(rectangle, 0, clippedX1);
    setArrayNumber(rectangle, 1, clippedY1);
    setArrayNumber(rectangle, 2, clippedX2);
    setArrayNumber(rectangle, 3, clippedY2);
  }
}

function visualHalfRegions(layout) {
  const { cropBox, rotation } = layout;
  const lowerX = { x: cropBox.x, y: cropBox.y, width: cropBox.width / 2, height: cropBox.height };
  const upperX = { x: cropBox.x + cropBox.width / 2, y: cropBox.y, width: cropBox.width / 2, height: cropBox.height };
  const lowerY = { x: cropBox.x, y: cropBox.y, width: cropBox.width, height: cropBox.height / 2 };
  const upperY = { x: cropBox.x, y: cropBox.y + cropBox.height / 2, width: cropBox.width, height: cropBox.height / 2 };
  if (rotation === 90) return { left: lowerY, right: upperY };
  if (rotation === 180) return { left: upperX, right: lowerX };
  if (rotation === 270) return { left: upperY, right: lowerY };
  return { left: lowerX, right: upperX };
}

function configureSpreadHalfPage(page, region) {
  const offsetX = -region.x;
  const offsetY = -region.y;
  page.translateContent(offsetX, offsetY);
  page.resetPosition();
  transformAnnotationGeometry(page, 1, offsetX, offsetY);
  clipAnnotationsToPage(page, region.width, region.height);
  page.setMediaBox(0, 0, region.width, region.height);
  page.setCropBox(0, 0, region.width, region.height);
  page.setBleedBox(0, 0, region.width, region.height);
  page.setTrimBox(0, 0, region.width, region.height);
  page.setArtBox(0, 0, region.width, region.height);
}

function transformDestinationNumber(destination, index, scale, offset) {
  const value = destination.lookup(index, PDFNumber);
  if (value) destination.set(index, PDFNumber.of(value.asNumber() * scale + offset));
}

function transformDestination(context, destination, pageTransforms) {
  if (!destination || destination.size() < 2) return;
  const pageReference = destination.get(0);
  const transform = pageTransforms.get(pageReference.toString());
  const fitType = destination.lookup(1, PDFName);
  if (!transform || !fitType) return;
  const type = fitType.decodeText();
  if (type === 'XYZ') {
    transformDestinationNumber(destination, 2, transform.scale, transform.offsetX);
    transformDestinationNumber(destination, 3, transform.scale, transform.offsetY);
  } else if (type === 'FitH' || type === 'FitBH') {
    transformDestinationNumber(destination, 2, transform.scale, transform.offsetY);
  } else if (type === 'FitV' || type === 'FitBV') {
    transformDestinationNumber(destination, 2, transform.scale, transform.offsetX);
  } else if (type === 'FitR') {
    transformDestinationNumber(destination, 2, transform.scale, transform.offsetX);
    transformDestinationNumber(destination, 3, transform.scale, transform.offsetY);
    transformDestinationNumber(destination, 4, transform.scale, transform.offsetX);
    transformDestinationNumber(destination, 5, transform.scale, transform.offsetY);
  }
}

function transformInternalLinkDestinations(document, pageTransforms) {
  const context = document.context;
  document.getPages().forEach((page) => {
    const annotations = lookupArray(context, page.node, 'Annots');
    if (!annotations) return;
    for (let index = 0; index < annotations.size(); index += 1) {
      const annotation = context.lookup(annotations.get(index), PDFDict);
      if (!annotation) continue;
      const directDestination = lookupArray(context, annotation, 'Dest');
      if (directDestination) transformDestination(context, directDestination, pageTransforms);
      const actionValue = annotation.get(PDFName.of('A'));
      const action = actionValue ? context.lookup(actionValue, PDFDict) : null;
      if (action) {
        const actionDestination = lookupArray(context, action, 'D');
        if (actionDestination) transformDestination(context, actionDestination, pageTransforms);
      }
    }
  });
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

/** Split wide pages with the same rotation-aware clipping pass as upstream. */
async function splitWidePages(document, order = 'right-first') {
  const splitDocument = await PDFDocument.create();
  for (let index = 0; index < document.getPageCount(); index += 1) {
    const source = document.getPage(index);
    const layout = getVisiblePageLayout(source);
    if (!layout.isLandscape) {
      const [page] = await splitDocument.copyPages(document, [index]);
      splitDocument.addPage(page);
      continue;
    }
    const regions = visualHalfRegions(layout);
    const ordered = order === 'left-first'
      ? [regions.left, regions.right]
      : [regions.right, regions.left];
    for (const region of ordered) {
      const [page] = await splitDocument.copyPages(document, [index]);
      configureSpreadHalfPage(page, region);
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

const CJK_FONT_CANDIDATES = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'meiryo.ttc'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'YuGothM.ttc'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'msgothic.ttc'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'NotoSansJP-VF.ttf'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'yumin.ttf'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'NanumGothic-Regular.ttf'),
  '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc',
  '/System/Library/Fonts/ヒラギノ角ゴ ProN W3.otf',
  '/Library/Fonts/Arial Unicode.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJKjp-Regular.otf'
];

function findCjkFont() {
  return CJK_FONT_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;
}

async function embedWatermarkFont(document, text = '') {
  const needsCjk = /[^\u0000-\u00ff]/u.test(text);
  if (needsCjk && fontkit && typeof document.registerFontkit === 'function') {
    for (const candidate of CJK_FONT_CANDIDATES) {
      if (!fs.existsSync(candidate)) continue;
      try {
        document.registerFontkit(fontkit);
        return await document.embedFont(fs.readFileSync(candidate), { subset: true });
      } catch {
        // Some platform fonts are collections unsupported by this fontkit.
      }
    }
  }
  if (needsCjk) throw new Error('日本語ウォーターマークにはMeiryo、Noto Sans CJK等のフォントが必要です。');
  return document.embedStandardFont(StandardFonts.Helvetica);
}

function centeredDrawPosition(centerX, centerY, width, height, angleDegrees) {
  const radians = angleDegrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: centerX - (width / 2) * cos + (height / 2) * sin,
    y: centerY - (width / 2) * sin - (height / 2) * cos
  };
}

function applyPageSizes(document, config = {}) {
  const pages = document.getPages();
  if (!pages.length) return;
  const [width, height] = targetPageSize(config, pages);
  const infos = pages.map(getDisplayedPageSize);
  const transforms = new Map();
  for (const [index, page] of pages.entries()) {
    const info = infos[index];
    const scale = config.dimension === 'width'
      ? width / info.width
      : Math.min(width / info.width, height / info.height);
    if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('ページサイズの倍率が不正です。');
    // PDFPage.scale scales the page content and form annotation appearance;
    // the explicit geometry pass below also covers links/quad points.
    page.scale(scale, scale);
    let offsetX = 0;
    let offsetY = 0;
    if (config.dimension !== 'width') {
      const targetRawWidth = info.rotation === 90 || info.rotation === 270 ? height : width;
      const targetRawHeight = info.rotation === 90 || info.rotation === 270 ? width : height;
      const scaledRawWidth = info.rawWidth * scale;
      const scaledRawHeight = info.rawHeight * scale;
      offsetX = (targetRawWidth - scaledRawWidth) / 2;
      offsetY = (targetRawHeight - scaledRawHeight) / 2;
      page.setSize(targetRawWidth, targetRawHeight);
      page.translateContent(offsetX, offsetY);
    }
    transformAnnotationGeometry(page, scale, offsetX, offsetY);
    transforms.set(page.ref.toString(), { scale, offsetX, offsetY });
  }
  transformInternalLinkDestinations(document, transforms);
}

async function applyWatermark(document, watermark = {}) {
  const opacity = Math.min(1, Math.max(0, Number(watermark.opacity ?? 0.5)));
  const rotation = Number(watermark.rotation) || 0;
  const scale = Math.max(0.01, Math.min(10, Number(watermark.scale ?? 1)));
  if (watermark.type === 'text' || watermark.text) {
    const text = String(watermark.text || 'CONFIDENTIAL').slice(0, 200);
    const font = await embedWatermarkFont(document, text);
    const size = Math.min(300, Math.max(8, Number(watermark.fontSize) || 48));
    for (const page of document.getPages()) {
      const textWidth = font.widthOfTextAtSize(text, size);
      const position = centeredDrawPosition(page.getWidth() / 2, page.getHeight() / 2, textWidth, size, rotation);
      page.drawText(text, {
        x: position.x,
        y: position.y,
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
    const position = centeredDrawPosition(page.getWidth() / 2, page.getHeight() / 2, imageWidth, imageHeight, rotation);
    page.drawImage(image, {
      x: position.x,
      y: position.y,
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
  const documents = await Promise.all(files.map((bytes) => PDFDocument.load(bytes)));
  let output = null;

  if (operation === 'split') {
    const first = documents[0];
    const selected = parsePageRange(config.range, first.getPageCount());
    const allPages = selected.length === first.getPageCount()
      && selected.every((page, index) => page === index);
    // Keeping a single source document intact preserves its AcroForm tree;
    // pdf-lib cannot copy that tree through copyPages(). A true subset still
    // uses a new document and is handled as a page-only extraction.
    if (documents.length === 1 && allPages) output = first;
    else {
      output = await PDFDocument.create();
      await copySelectedPages(output, first, selected);
    }
  } else {
    if (documents.length === 1) output = documents[0];
    else {
      output = await PDFDocument.create();
      await copyAllPages(output, documents);
    }
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
  centeredDrawPosition,
  getDisplayedPageSize,
  getVisiblePageLayout,
  normalizePageRotation,
  parseColor,
  parsePageRange,
  processPdf,
  splitWidePages,
  targetPageSize,
  visualHalfRegions
};
