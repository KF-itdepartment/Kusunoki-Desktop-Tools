const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// This is the only build-time boundary between the read-only upstream
// submodules and the desktop shell. It copies source units into the package,
// rewrites CDN references to local npm assets, and generates the bridge used
// by the renderer. The output is deterministic and can be audited offline.
const root = path.resolve(__dirname, '..');
const renderer = path.join(root, 'renderer');
const vendor = path.join(renderer, 'vendor');
const generated = path.join(renderer, 'generated', 'upstream');
const qrSource = path.join(root, 'vendor', 'qr-generator', 'public');
const pdfSource = path.join(root, 'vendor', 'pdf-editor');

fs.mkdirSync(vendor, { recursive: true });
fs.mkdirSync(path.join(generated, 'qr'), { recursive: true });
fs.mkdirSync(path.join(generated, 'pdf'), { recursive: true });

function requireFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`upstream staging source is missing: ${path.relative(root, file)}`);
  }
  return file;
}

function copy(source, target) {
  requireFile(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return target;
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeUtf8(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, 'utf8');
}

function findFirst(rootDirectory, candidates) {
  for (const candidate of candidates) {
    const file = path.join(rootDirectory, ...candidate);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Stage browser dependencies from npm. The generated upstream PDF page is
// transformed below to use these exact local filenames.
const pdfjsRoot = path.join(root, 'node_modules', 'pdfjs-dist');
const pdfjs = findFirst(pdfjsRoot, [['build', 'pdf.min.js'], ['legacy', 'build', 'pdf.min.js']]);
const worker = findFirst(pdfjsRoot, [['build', 'pdf.worker.min.js'], ['legacy', 'build', 'pdf.worker.min.js']]);
const pdfLib = path.join(root, 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.min.js');
const jszip = path.join(root, 'node_modules', 'jszip', 'dist', 'jszip.min.js');
if (!pdfjs || !worker || !fs.existsSync(pdfLib) || !fs.existsSync(jszip)) {
  throw new Error('npm browser assets are missing; run npm install before staging vendors.');
}
copy(pdfjs, path.join(vendor, 'pdf.min.js'));
copy(worker, path.join(vendor, 'pdf.worker.min.js'));
copy(pdfLib, path.join(vendor, 'pdf-lib.min.js'));
copy(jszip, path.join(vendor, 'jszip.min.js'));

// Stage the complete QR source unit. The shell uses the generated source
// hash and batch adapter below, so a submodule update cannot be a no-op.
const qrFiles = [
  'index.html',
  'script.js',
  'batch-utils.mjs',
  'logo.png',
  'vendor/fflate.mjs',
  'vendor/fflate.LICENSE.txt'
];
const qrManifest = {};
for (const name of qrFiles) {
  const source = path.join(qrSource, name);
  copy(source, path.join(generated, 'qr', name));
  qrManifest[name] = {
    source: path.relative(root, source).replaceAll(path.sep, '/'),
    sha256: hash(source)
  };
}

// Convert the upstream ESM batch helper into the classic global module that
// the shell can load before app.js. This is deliberately generated from the
// staged source (rather than maintaining a second hand-written copy), so a
// submodule update changes the functions used by the packaged renderer.
const batchOriginalPath = path.join(qrSource, 'batch-utils.mjs');
const batchSourcePath = path.join(generated, 'qr', 'batch-utils.mjs');
const batchSource = fs.readFileSync(batchSourcePath, 'utf8');
const batchBody = batchSource.replace(/\bexport\s+(?=(?:const|function)\b)/gu, '');
const batchClassic = `'use strict';\n\n// Generated from vendor/qr-generator/public/batch-utils.mjs. Do not edit by hand.\n(function exposeGeneratedBatch(global) {\n${batchBody}\n  global.BatchUtils = Object.freeze({\n    MAX_BATCH_ITEMS,\n    MAX_FILENAME_LENGTH,\n    splitInputLines,\n    validateHttpUrl,\n    isValidHttpUrl,\n    parseBatchInput,\n    sanitizePngFileName,\n    sanitisePngFileName,\n    sanitizeFileName,\n    createBatchFileNames,\n    makeUniqueFileNames,\n    assignBatchFileNames\n  });\n})(window);\n`;
const batchClassicPath = path.join(generated, 'qr', 'batch-utils.js');
writeUtf8(batchClassicPath, batchClassic);
qrManifest['batch-utils.js'] = {
  source: path.relative(root, batchOriginalPath).replaceAll(path.sep, '/'),
  sha256: hash(batchOriginalPath),
  generatedSha256: hash(batchClassicPath)
};

// Copy the upstream PDF page and rewrite all three CDN script references.
// Keep source and generated hashes so CI can prove that this exact source is
// what the packaged bridge represents.
const pdfHtmlSource = requireFile(path.join(pdfSource, 'index.html'));
const pdfScriptSource = requireFile(path.join(pdfSource, 'script.js'));
const pdfSpecSource = requireFile(path.join(pdfSource, 'SPECIFICATION.md'));
const pdfHtml = fs.readFileSync(pdfHtmlSource, 'utf8')
  .replaceAll('https://unpkg.com/pdf-lib/dist/pdf-lib.min.js', '../../../vendor/pdf-lib.min.js')
  .replaceAll('https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js', '../../../vendor/pdf.min.js')
  .replaceAll('https://unpkg.com/jszip@3.10.1/dist/jszip.min.js', '../../../vendor/jszip.min.js');
const pdfScript = fs.readFileSync(pdfScriptSource, 'utf8')
  .replaceAll('https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js', '../../../vendor/pdf.worker.min.js');
const pdfFrameBridge = `'use strict';\n\n// Generated by scripts/stage-vendors.js. Runs inside the sandboxed PDF iframe.\n(() => {\n  const VERSION = 1;\n  const MAX_BYTES = 20 * 1024 * 1024;\n  const SET_WATERMARK = 'kusunoki:pdf:set-watermark';\n  const PING = 'kusunoki:pdf:ping';\n  const READY = 'kusunoki:pdf:ready';\n  const APPLIED = 'kusunoki:pdf:watermark-applied';\n  const ERROR = 'kusunoki:pdf:error';\n  const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml']);\n\n  const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);\n  const bytesFrom = (value) => {\n    if (value instanceof ArrayBuffer) return value.slice(0);\n    if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);\n    return null;\n  };\n  const originAllowed = (event) => {\n    if (!event || event.source !== window.parent) return false;\n    const origin = String(event.origin || '');\n    const ownOrigin = String(window.location?.origin || 'null');\n    return origin === 'null' || origin === ownOrigin;\n  };\n  const safeFileName = (value) => {\n    const fileName = String(value || 'qr-watermark.png');\n    if (!fileName || fileName.length > 160 || fileName === '.' || fileName === '..' || /[\\u0000-\\u001f<>:\"/\\\\|?*]/u.test(fileName)) return null;\n    return fileName;\n  };\n  const post = (type, payload) => {\n    window.parent.postMessage({ version: VERSION, type, payload }, '*');\n  };\n  const validate = (event) => {\n    if (!originAllowed(event)) return null;\n    const message = event.data;\n    if (!isRecord(message) || message.version !== VERSION || typeof message.type !== 'string') return null;\n    if (message.type === PING) return { type: PING, payload: {} };\n    if (message.type !== SET_WATERMARK || !isRecord(message.payload)) return null;\n    const raw = bytesFrom(message.payload.data);\n    const fileName = safeFileName(message.payload.fileName);\n    const mimeType = String(message.payload.mimeType || 'image/png');\n    const text = String(message.payload.text || '');\n    if (!raw || raw.byteLength < 1 || raw.byteLength > MAX_BYTES || !fileName || !MIME_TYPES.has(mimeType) || text.length > 4096) return null;\n    return { type: SET_WATERMARK, payload: { data: raw, fileName, mimeType, text } };\n  };\n  const applyWatermark = (payload) => {\n    const input = document.getElementById('wm-img-input');\n    const mode = document.getElementById('mode-watermark');\n    if (!input || !mode || typeof File !== 'function' || typeof DataTransfer !== 'function') throw new Error('PDFウォーターマーク入力欄を利用できません。');\n    const file = new File([payload.data], payload.fileName, { type: payload.mimeType });\n    const transfer = new DataTransfer();\n    transfer.items.add(file);\n    input.files = transfer.files;\n    if (!mode.checked) {\n      mode.checked = true;\n      mode.dispatchEvent(new Event('change', { bubbles: true }));\n    }\n    input.dispatchEvent(new Event('input', { bubbles: true }));\n    input.dispatchEvent(new Event('change', { bubbles: true }));\n    post(APPLIED, { fileName: payload.fileName, mimeType: payload.mimeType, byteLength: payload.data.byteLength });\n  };\n  window.addEventListener('message', (event) => {\n    if (!originAllowed(event)) return;\n    const checked = validate(event);\n    if (!checked) {\n      if (event.data && event.data.type === SET_WATERMARK) post(ERROR, { code: 'invalid-message', message: 'PDF受渡しメッセージが不正です。' });\n      return;\n    }\n    if (checked.type === PING) {\n      post(READY, { source: 'generated/upstream/pdf', version: VERSION, capabilities: ['watermark-file'] });\n      return;\n    }\n    try {\n      applyWatermark(checked.payload);\n    } catch (error) {\n      post(ERROR, { code: 'apply-failed', message: error instanceof Error ? error.message : String(error) });\n    }\n  });\n  window.addEventListener('DOMContentLoaded', () => {\n    post(READY, { source: 'generated/upstream/pdf', version: VERSION, capabilities: ['watermark-file'] });\n  });\n})();\n`;
const pdfFrameBridgePath = path.join(generated, 'pdf', 'pdf-frame-bridge.js');
writeUtf8(pdfFrameBridgePath, pdfFrameBridge);
const injectedCsp = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; font-src \'self\' data:; connect-src \'self\' data: blob:; worker-src \'self\' blob:; frame-src \'self\' blob:; object-src \'none\'; base-uri \'none\'; form-action \'self\'">';
const generatedPdfHtml = pdfHtml
  .replace(/<head>/iu, `<head>\n    ${injectedCsp}`)
  .replace(/<script src="script\.js"><\/script>/iu, '<script src="pdf-frame-bridge.js"></script>\n<script src="script.js"></script>');
if (!generatedPdfHtml.includes('pdf-frame-bridge.js')) throw new Error('upstream PDF bridge injection failed.');
writeUtf8(path.join(generated, 'pdf', 'index.html'), generatedPdfHtml);
writeUtf8(path.join(generated, 'pdf', 'script.js'), pdfScript);
copy(pdfSpecSource, path.join(generated, 'pdf', 'SPECIFICATION.md'));

const pdfManifest = {
  'index.html': {
    source: path.relative(root, pdfHtmlSource).replaceAll(path.sep, '/'),
    sha256: hash(pdfHtmlSource),
    generatedSha256: hash(path.join(generated, 'pdf', 'index.html'))
  },
  'script.js': {
    source: path.relative(root, pdfScriptSource).replaceAll(path.sep, '/'),
    sha256: hash(pdfScriptSource),
    generatedSha256: hash(path.join(generated, 'pdf', 'script.js'))
  },
  'SPECIFICATION.md': {
    source: path.relative(root, pdfSpecSource).replaceAll(path.sep, '/'),
    sha256: hash(pdfSpecSource)
  }
};
pdfManifest['pdf-frame-bridge.js'] = {
  source: 'scripts/stage-vendors.js',
  sha256: hash(pdfFrameBridgePath)
};

const adapter = `'use strict';\n\n// Generated by scripts/stage-vendors.js. Do not edit by hand.\n(() => {\n  const metadata = ${JSON.stringify({
  generatedBy: 'scripts/stage-vendors.js',
  qr: qrManifest,
  pdf: pdfManifest,
  browser: {
    pdfLib: 'renderer/vendor/pdf-lib.min.js',
    pdfjs: 'renderer/vendor/pdf.min.js',
    worker: 'renderer/vendor/pdf.worker.min.js',
    jszip: 'renderer/vendor/jszip.min.js'
  }
}, null, 2)};\n\n  const batch = window.BatchUtils;\n  if (!batch) {\n    throw new Error('生成済みQR batch adapterの前にgenerated/upstream/qr/batch-utils.jsを読み込んでください。');\n  }\n  const FRAME_VERSION = 1;\n  const FRAME_SET_WATERMARK = 'kusunoki:pdf:set-watermark';\n  const FRAME_PING = 'kusunoki:pdf:ping';\n  const FRAME_READY = 'kusunoki:pdf:ready';\n  const FRAME_APPLIED = 'kusunoki:pdf:watermark-applied';\n  const FRAME_ERROR = 'kusunoki:pdf:error';\n  const FRAME_MAX_BYTES = 20 * 1024 * 1024;\n  const FRAME_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml']);\n  const copyBytes = (value) => {\n    if (value instanceof Uint8Array) return new Uint8Array(value);\n    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));\n    if (value && value.buffer instanceof ArrayBuffer) return new Uint8Array(value.buffer.slice(value.byteOffset || 0, (value.byteOffset || 0) + value.byteLength));\n    throw new TypeError('画像データの形式が不正です。');\n  };\n  const createPdfHandoff = (data, text, fileName = 'qr-watermark.png', mimeType = 'image/png') => ({\n    data: copyBytes(data),\n    text: String(text || ''),\n    fileName: String(fileName || 'qr-watermark.png'),\n    mimeType: String(mimeType || 'image/png')\n  });\n  const validateFrameHandoff = (handoff) => {\n    const data = copyBytes(handoff?.data);\n    const fileName = String(handoff?.fileName || 'qr-watermark.png');\n    const mimeType = String(handoff?.mimeType || 'image/png');\n    const text = String(handoff?.text || '');\n    if (!data.byteLength || data.byteLength > FRAME_MAX_BYTES || fileName.length > 160 || fileName === '.' || fileName === '..' || /[\\u0000-\\u001f<>:\"/\\\\|?*]/u.test(fileName) || !FRAME_MIMES.has(mimeType) || text.length > 4096) throw new TypeError('PDF受渡しデータが不正です。');\n    return { data, fileName, mimeType, text };\n  };\n  const createFramePing = () => ({ version: FRAME_VERSION, type: FRAME_PING, payload: {} });\n  const createWatermarkMessage = (handoff) => {\n    const checked = validateFrameHandoff(handoff);\n    return { version: FRAME_VERSION, type: FRAME_SET_WATERMARK, payload: { data: checked.data.buffer, fileName: checked.fileName, mimeType: checked.mimeType, text: checked.text } };\n  };\n  const validateFrameMessage = (event, frameWindow) => {\n    if (!event || event.source !== frameWindow) return null;\n    const origin = String(event.origin || '');\n    const ownOrigin = String(window.location?.origin || 'null');\n    if (origin !== 'null' && origin !== ownOrigin) return null;\n    const message = event.data;\n    if (!message || typeof message !== 'object' || Array.isArray(message) || message.version !== FRAME_VERSION) return null;\n    if (![FRAME_READY, FRAME_APPLIED, FRAME_ERROR].includes(message.type) || !message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) return null;\n    if (message.type === FRAME_READY) return { type: message.type, payload: { source: String(message.payload.source || ''), capabilities: Array.isArray(message.payload.capabilities) ? message.payload.capabilities.map(String).slice(0, 16) : [] } };\n    if (message.type === FRAME_APPLIED) {\n      const byteLength = Number(message.payload.byteLength);\n      if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > FRAME_MAX_BYTES) return null;\n      return { type: message.type, payload: { fileName: String(message.payload.fileName || ''), mimeType: String(message.payload.mimeType || ''), byteLength } };\n    }\n    return { type: message.type, payload: { code: String(message.payload.code || 'unknown'), message: String(message.payload.message || '').slice(0, 500) } };\n  };\n  const processPdf = (payload) => window.desktop.pdf.process(payload);\n  window.KusunokiGeneratedUpstream = Object.freeze({\n    metadata: Object.freeze(metadata),\n    qr: Object.freeze({\n      source: 'generated/upstream/qr/script.js',\n      sourceHash: metadata.qr['script.js'].sha256,\n      batchSource: 'generated/upstream/qr/batch-utils.mjs',\n      batchSourceHash: metadata.qr['batch-utils.mjs'].sha256,\n      batch,\n      createPdfHandoff\n    }),\n    pdf: Object.freeze({\n      source: 'generated/upstream/pdf/script.js',\n      sourceHash: metadata.pdf['script.js'].sha256,\n      html: 'generated/upstream/pdf/index.html',\n      process: processPdf\n    }),\n    pdfFrame: Object.freeze({\n      version: FRAME_VERSION,\n      types: Object.freeze({ ready: FRAME_READY, applied: FRAME_APPLIED, error: FRAME_ERROR, setWatermark: FRAME_SET_WATERMARK, ping: FRAME_PING }),\n      createPing: createFramePing,\n      createWatermarkMessage,\n      validateMessage: validateFrameMessage\n    })\n  });\n})();\n`;
const hardenedAdapter = adapter.replace(
  'if (!event || event.source !== frameWindow) return null;',
  'if (!frameWindow || !event || event.source !== frameWindow) return null;'
);
writeUtf8(path.join(renderer, 'generated', 'upstream-adapter.js'), hardenedAdapter);

const manifest = {
  schema: 2,
  generatedBy: 'scripts/stage-vendors.js',
  upstream: {
    qr: qrManifest,
    pdf: pdfManifest
  },
  browser: {
    pdfLib: { package: 'pdf-lib', file: 'pdf-lib.min.js', sha256: hash(path.join(vendor, 'pdf-lib.min.js')) },
    pdfjs: { package: 'pdfjs-dist@3.11.174', file: 'pdf.min.js', sha256: hash(path.join(vendor, 'pdf.min.js')) },
    worker: { package: 'pdfjs-dist@3.11.174', file: 'pdf.worker.min.js', sha256: hash(path.join(vendor, 'pdf.worker.min.js')) },
    jszip: { package: 'jszip', file: 'jszip.min.js', sha256: hash(path.join(vendor, 'jszip.min.js')) }
  },
  adapter: {
    file: 'renderer/generated/upstream-adapter.js',
    sha256: hash(path.join(renderer, 'generated', 'upstream-adapter.js'))
  },
  integration: {
    qrBatch: {
      file: 'renderer/generated/upstream/qr/batch-utils.js',
      source: 'vendor/qr-generator/public/batch-utils.mjs',
      sha256: hash(batchClassicPath)
    },
    pdfFrameBridge: {
      file: 'renderer/generated/upstream/pdf/pdf-frame-bridge.js',
      sha256: hash(pdfFrameBridgePath)
    }
  }
};
writeUtf8(path.join(vendor, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Staged ${Object.keys(qrManifest).length} QR and ${Object.keys(pdfManifest).length} PDF upstream files plus local browser assets.`);
