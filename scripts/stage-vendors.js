const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');

// Git checkouts can materialize text files with either LF or CRLF line
// endings (notably when a developer stages the vendors on Windows and CI
// validates the committed fallback on Ubuntu). Manifest hashes therefore
// describe canonical UTF-8 text, while binary assets such as PNGs remain
// byte-for-byte hashes.
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.csv', '.html', '.htm', '.js', '.jsx', '.json', '.mjs',
  '.map', '.md', '.scss', '.svg', '.ts', '.tsx', '.txt', '.xml', '.yaml',
  '.yml'
]);

function canonicalBytes(file) {
  const bytes = fs.readFileSync(file);
  if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) return bytes;
  return Buffer.from(bytes.toString('utf8').replace(/\r\n?/gu, '\n'), 'utf8');
}

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
const analyticsRoot = path.join(root, 'vendor', 'analytics-url-generator');
const analyticsSource = path.join(analyticsRoot, 'src', 'index.js');
const urlGenerated = path.join(generated, 'url');
const ANALYTICS_COMMIT = 'b65e77c8600572f5ddac80b4bc78dde4476b5380';

fs.mkdirSync(vendor, { recursive: true });
fs.mkdirSync(path.join(generated, 'qr'), { recursive: true });
fs.mkdirSync(path.join(generated, 'pdf'), { recursive: true });
fs.mkdirSync(urlGenerated, { recursive: true });

function requireFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`upstream staging source is missing: ${path.relative(root, file)}`);
  }
  return file;
}

function copy(source, target) {
  requireFile(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Avoid touching already identical tracked assets. This keeps staging
  // idempotent even when a security scanner has the generated browser bundle
  // open, and still replaces the target whenever the source hash changes.
  if (fs.existsSync(target) && fs.statSync(target).isFile() && hash(source) === hash(target)) return target;
  fs.copyFileSync(source, target);
  return target;
}

function hash(file) {
  return crypto.createHash('sha256').update(canonicalBytes(file)).digest('hex');
}

function writeUtf8(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const current = fs.readFileSync(file, 'utf8');
    if (current === value) return file;
  }
  fs.writeFileSync(file, value, 'utf8');
  return file;
}

function findFirst(rootDirectory, candidates) {
  for (const candidate of candidates) {
    const file = path.join(rootDirectory, ...candidate);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function isTruthy(value) {
  return /^(?:1|true|yes|on)$/iu.test(String(value || ''));
}

function hasCompleteSource(directory, files) {
  return files.every((file) => {
    const candidate = path.join(directory, file);
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readFallbackManifest() {
  const manifestPath = path.join(vendor, 'MANIFEST.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('upstream submodules are unavailable and renderer/vendor/MANIFEST.json is missing; restore committed generated files.');
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`committed upstream manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!manifest || manifest.schema !== 3 || !manifest.upstream?.qr || !manifest.upstream?.pdf || !manifest.upstream?.url || !manifest.adapter?.sha256) {
    throw new Error('committed upstream manifest is incomplete; cannot safely use generated fallback.');
  }
  return manifest;
}

function assertFallbackHash(relativeFile, expectedHash, label) {
  if (!expectedHash || !/^[a-f0-9]{64}$/iu.test(String(expectedHash))) {
    throw new Error(`committed upstream manifest has no valid hash for ${label}.`);
  }
  const file = path.join(root, relativeFile);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`committed generated upstream file is missing: ${relativeFile}`);
  }
  const actual = hash(file);
  if (actual.toLowerCase() !== String(expectedHash).toLowerCase()) {
    throw new Error(`committed generated upstream file hash mismatch: ${relativeFile}`);
  }
}

function validateFallbackArtifacts(manifest, needQr, needPdf) {
  const qrFiles = ['index.html', 'script.js', 'batch-utils.mjs', 'logo.png', 'vendor/fflate.mjs', 'vendor/fflate.LICENSE.txt', 'batch-utils.js'];
  const pdfFiles = ['index.html', 'script.js', 'SPECIFICATION.md', 'pdf-frame-bridge.js', 'pdf-data-url.js'];
  if (needQr) {
    for (const name of qrFiles) {
      const entry = manifest.upstream.qr[name];
      const expected = name === 'batch-utils.js' ? entry?.generatedSha256 : entry?.sha256;
      assertFallbackHash(`renderer/generated/upstream/qr/${name}`, expected, `QR ${name}`);
    }
  }
  if (manifest.upstream?.url) {
    for (const name of ['config.js', 'adapter.js']) {
      const entry = manifest.upstream.url[name];
      assertFallbackHash(`renderer/generated/upstream/url/${name}`, entry?.generatedSha256 || entry?.sha256, `URL ${name}`);
    }
  }
  if (needPdf) {
    for (const name of pdfFiles) {
      const entry = manifest.upstream.pdf[name];
      const expected = (name === 'index.html' || name === 'script.js') ? entry?.generatedSha256 : entry?.sha256;
      assertFallbackHash(`renderer/generated/upstream/pdf/${name}`, expected, `PDF ${name}`);
    }
  }
  if (needQr || needPdf) {
    assertFallbackHash('renderer/generated/upstream-adapter.js', manifest.adapter.sha256, 'generated upstream adapter');
  }
}

const qrFiles = [
  'index.html',
  'script.js',
  'batch-utils.mjs',
  'logo.png',
  'vendor/fflate.mjs',
  'vendor/fflate.LICENSE.txt'
];
const pdfFiles = ['index.html', 'script.js', 'SPECIFICATION.md'];
const forceFallback = isTruthy(process.env.KUSUNOKI_STAGE_FALLBACK);
const qrSourceReady = !forceFallback && hasCompleteSource(qrSource, qrFiles);
const pdfSourceReady = !forceFallback && hasCompleteSource(pdfSource, pdfFiles);
const analyticsSourceReady = !forceFallback && fs.existsSync(analyticsSource) && fs.statSync(analyticsSource).isFile();
const fallbackManifest = (!qrSourceReady || !pdfSourceReady || !analyticsSourceReady) ? readFallbackManifest() : null;
if (fallbackManifest) validateFallbackArtifacts(fallbackManifest, !qrSourceReady, !pdfSourceReady);

function readSubmoduleCommit(directory) {
  try {
    const marker = path.join(directory, '.git');
    const markerText = fs.readFileSync(marker, 'utf8').trim();
    const gitDirectory = markerText.startsWith('gitdir:')
      ? path.resolve(directory, markerText.slice('gitdir:'.length).trim())
      : marker;
    const head = fs.readFileSync(path.join(gitDirectory, 'HEAD'), 'utf8').trim();
    if (/^[a-f0-9]{40,128}$/iu.test(head)) return head.toLowerCase();
    const ref = head.match(/^ref:\s*(.+)$/u);
    if (ref) return fs.readFileSync(path.join(gitDirectory, ref[1]), 'utf8').trim().toLowerCase();
  } catch {
    // Fall through to git for non-standard submodule layouts.
  }
  try {
    return String(execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }) || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function extractOptionArray(sourceText, constantName) {
  const match = sourceText.match(new RegExp(`\\bconst\\s+${constantName}\\s*=\\s*(\\[[\\s\\S]*?\\]);`));
  if (!match) throw new Error(`analytics upstream contract is missing ${constantName}.`);
  let options;
  try {
    options = vm.runInNewContext(`(${match[1]})`, Object.create(null), { timeout: 1000 });
  } catch {
    throw new Error(`analytics upstream ${constantName} is not a static option array.`);
  }
  if (!Array.isArray(options) || options.length === 0 || options.some((item) => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.value !== 'string' || typeof item.label !== 'string' || !item.value || !item.label)) {
    throw new Error(`analytics upstream ${constantName} has an invalid option shape.`);
  }
  const values = new Set();
  return options.map((item) => {
    if (values.has(item.value)) throw new Error(`analytics upstream ${constantName} contains duplicate option values.`);
    values.add(item.value);
    return { value: item.value, label: item.label };
  });
}

function validateAnalyticsContract(sourceText) {
  const required = [
    [/\bSOURCE_OPTIONS\b/u, 'SOURCE_OPTIONS'],
    [/\bMEDIUM_OPTIONS\b/u, 'MEDIUM_OPTIONS'],
    [/['"]\/api\/shorten['"]/u, '/api/shorten'],
    [/longUrl/u, 'longUrl request field'],
    [/shortid/u, 'shortid request field'],
    [/shortUrl/u, 'shortUrl response field']
  ];
  for (const [pattern, label] of required) {
    if (!pattern.test(sourceText)) throw new Error(`analytics upstream contract is missing ${label}.`);
  }
  if (!/method\s*:\s*['"]POST['"]/u.test(sourceText) || !/JSON\.stringify\s*\(/u.test(sourceText)) {
    throw new Error('analytics upstream /api/shorten request contract is invalid.');
  }
}

let urlManifest;
let urlConfig;
const urlConfigPath = path.join(urlGenerated, 'config.js');
const urlAdapterPath = path.join(urlGenerated, 'adapter.js');
if (analyticsSourceReady) {
  const commit = readSubmoduleCommit(analyticsRoot);
  if (commit !== ANALYTICS_COMMIT) {
    throw new Error(`analytics-url-generator must be pinned to ${ANALYTICS_COMMIT}; found ${commit || '(unknown)'}.`);
  }
  const sourceText = fs.readFileSync(analyticsSource, 'utf8');
  validateAnalyticsContract(sourceText);
  const sourceOptions = extractOptionArray(sourceText, 'SOURCE_OPTIONS');
  const mediumOptions = extractOptionArray(sourceText, 'MEDIUM_OPTIONS');
  urlConfig = {
    sourceOptions,
    mediumOptions,
    SOURCE_OPTIONS: sourceOptions,
    MEDIUM_OPTIONS: mediumOptions,
    upstreamCommit: ANALYTICS_COMMIT,
    source: 'vendor/analytics-url-generator/src/index.js',
    sourceSha256: hash(analyticsSource)
  };
  const configBody = `'use strict';\n\n// Generated from vendor/analytics-url-generator/src/index.js. Do not edit by hand.\n(() => {\n  const sourceOptions = ${JSON.stringify(sourceOptions, null, 2)};\n  const mediumOptions = ${JSON.stringify(mediumOptions, null, 2)};\n  const metadata = ${JSON.stringify({ upstreamCommit: ANALYTICS_COMMIT, source: 'vendor/analytics-url-generator/src/index.js', sourceSha256: hash(analyticsSource) }, null, 2)};\n  const config = { sourceOptions, mediumOptions, SOURCE_OPTIONS: sourceOptions, MEDIUM_OPTIONS: mediumOptions, ...metadata };\n  window.KusunokiUrlConfig = Object.freeze(config);\n})();\n`;
  writeUtf8(urlConfigPath, configBody);
  const adapterBody = `'use strict';\n\n// Generated from the analytics URL upstream config. Do not edit by hand.\n(() => {\n  const config = window.KusunokiUrlConfig;\n  if (!config || !Array.isArray(config.sourceOptions) || !Array.isArray(config.mediumOptions)) throw new Error('生成済みURL設定を読み込めません。');\n  window.KusunokiGeneratedUrl = Object.freeze({ config, source: 'generated/upstream/url/config.js', sourceHash: config.sourceSha256 });\n})();\n`;
  writeUtf8(urlAdapterPath, adapterBody);
  urlManifest = {
    'src/index.js': { source: 'vendor/analytics-url-generator/src/index.js', sha256: hash(analyticsSource), commit: ANALYTICS_COMMIT },
    'config.js': { source: 'vendor/analytics-url-generator/src/index.js', sha256: hash(analyticsSource), generatedSha256: hash(urlConfigPath), commit: ANALYTICS_COMMIT },
    'adapter.js': { source: 'scripts/stage-vendors.js', sha256: hash(urlAdapterPath), generatedSha256: hash(urlAdapterPath), commit: ANALYTICS_COMMIT }
  };
} else {
  urlManifest = clone(fallbackManifest.upstream.url);
  urlConfig = null;
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

// Stage the complete QR source unit when the read-only submodule is present.
// A CI checkout intentionally omits private submodules; in that case the
// committed generated copy is validated above and kept byte-for-byte intact.
let qrManifest;
if (qrSourceReady) {
  qrManifest = {};
  for (const name of qrFiles) {
    const source = path.join(qrSource, name);
    copy(source, path.join(generated, 'qr', name));
    qrManifest[name] = {
      source: path.relative(root, source).replaceAll(path.sep, '/'),
      sha256: hash(source)
    };
  }
} else {
  qrManifest = clone(fallbackManifest.upstream.qr);
}

// Convert the upstream ESM batch helper into the classic global module that
// the shell can load before app.js. This is deliberately generated from the
// staged source (rather than maintaining a second hand-written copy), so a
// submodule update changes the functions used by the packaged renderer.
const batchClassicPath = path.join(generated, 'qr', 'batch-utils.js');
let batchClassic;
if (qrSourceReady) {
  const batchOriginalPath = path.join(qrSource, 'batch-utils.mjs');
  const batchSourcePath = path.join(generated, 'qr', 'batch-utils.mjs');
  const batchSource = fs.readFileSync(batchSourcePath, 'utf8');
  const batchBody = batchSource.replace(/\bexport\s+(?=(?:const|function)\b)/gu, '');
  batchClassic = `'use strict';\n\n// Generated from vendor/qr-generator/public/batch-utils.mjs. Do not edit by hand.\n(function exposeGeneratedBatch(global) {\n${batchBody}\n  global.BatchUtils = Object.freeze({\n    MAX_BATCH_ITEMS,\n    MAX_FILENAME_LENGTH,\n    splitInputLines,\n    validateHttpUrl,\n    isValidHttpUrl,\n    parseBatchInput,\n    parseBatchCsv,\n    decodeCsvBytes,\n    sanitizePngFileName,\n    sanitisePngFileName,\n    sanitizeFileName,\n    createBatchFileNames,\n    makeUniqueFileNames,\n    assignBatchFileNames\n  });\n})(window);\n`;
  writeUtf8(batchClassicPath, batchClassic);
  qrManifest['batch-utils.js'] = {
    source: path.relative(root, batchOriginalPath).replaceAll(path.sep, '/'),
    sha256: hash(batchOriginalPath),
    generatedSha256: hash(batchClassicPath)
  };
} else {
  batchClassic = fs.readFileSync(batchClassicPath, 'utf8');
}

// Copy the upstream PDF page and rewrite all three CDN script references.
// Keep source and generated hashes so CI can prove that this exact source is
// what the packaged bridge represents.
const pdfHtmlSource = pdfSourceReady ? requireFile(path.join(pdfSource, 'index.html')) : path.join(generated, 'pdf', 'index.html');
const pdfScriptSource = pdfSourceReady ? requireFile(path.join(pdfSource, 'script.js')) : path.join(generated, 'pdf', 'script.js');
const pdfSpecSource = pdfSourceReady ? requireFile(path.join(pdfSource, 'SPECIFICATION.md')) : path.join(generated, 'pdf', 'SPECIFICATION.md');
let pdfHtml = fs.readFileSync(pdfHtmlSource, 'utf8')
  .replaceAll('https://unpkg.com/pdf-lib/dist/pdf-lib.min.js', '../../../vendor/pdf-lib.min.js')
  .replaceAll('https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js', '../../../vendor/pdf.min.js')
  .replaceAll('https://unpkg.com/jszip@3.10.1/dist/jszip.min.js', '../../../vendor/jszip.min.js');
if (!pdfSourceReady) {
  // The committed fallback is already transformed. Strip only the generated
  // integration tags before re-injecting them below, keeping stage output
  // byte-for-byte deterministic without duplicating scripts.
  pdfHtml = pdfHtml
    .replace(/<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'">\s*/iu, '')
    .replace(/<script src="pdf-data-url\.js"><\/script>\s*/iu, '')
    .replace(/<script src="pdf-frame-bridge\.js"><\/script>\s*/iu, '');
}
const pdfDataUrlHelper = `'use strict';\n\n// Generated by scripts/stage-vendors.js. Converts data URLs without fetch/network access.\n(() => {\n  const dataUrlToArrayBuffer = (dataUrl) => {\n    const value = String(dataUrl || '');\n    const comma = value.indexOf(',');\n    if (comma <= 4 || !/^data:/iu.test(value.slice(0, comma))) throw new TypeError('data URLが不正です。');\n    const metadata = value.slice(5, comma);\n    const payload = value.slice(comma + 1);\n    if (/;base64(?:;|$)/iu.test(metadata)) {\n      const binary = atob(decodeURIComponent(payload).replace(/\\s+/gu, ''));\n      const bytes = new Uint8Array(binary.length);\n      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);\n      return bytes.buffer;\n    }\n    return new TextEncoder().encode(decodeURIComponent(payload)).buffer;\n  };\n  window.KusunokiPdfDataUrlToArrayBuffer = dataUrlToArrayBuffer;\n})();\n`;
const pdfDataUrlHelperPath = path.join(generated, 'pdf', 'pdf-data-url.js');
if (pdfSourceReady) writeUtf8(pdfDataUrlHelperPath, pdfDataUrlHelper);
const pdfScript = fs.readFileSync(pdfScriptSource, 'utf8')
  .replaceAll('https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js', '../../../vendor/pdf.worker.min.js')
  .replace('const dataUrlToArrayBuffer = async (dataUrl) => fetch(dataUrl).then((response) => response.arrayBuffer());', 'const dataUrlToArrayBuffer = (dataUrl) => window.KusunokiPdfDataUrlToArrayBuffer(dataUrl);');
if (/fetch\s*\(/iu.test(pdfScript)) throw new Error('generated upstream PDF script still contains fetch().');
const pdfFrameBridge = `'use strict';\n\n// Generated by scripts/stage-vendors.js. Runs inside the sandboxed PDF iframe.\n(() => {\n  const VERSION = 1;\n  const MAX_BYTES = 20 * 1024 * 1024;\n  const SET_WATERMARK = 'kusunoki:pdf:set-watermark';\n  const PING = 'kusunoki:pdf:ping';\n  const READY = 'kusunoki:pdf:ready';\n  const APPLIED = 'kusunoki:pdf:watermark-applied';\n  const ERROR = 'kusunoki:pdf:error';\n  const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml']);\n\n  const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);\n  const bytesFrom = (value) => {\n    if (value instanceof ArrayBuffer) return value.slice(0);\n    if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);\n    return null;\n  };\n  const originAllowed = (event) => {\n    if (!event || event.source !== window.parent) return false;\n    const origin = String(event.origin || '');\n    const ownOrigin = String(window.location?.origin || 'null');\n    return origin === 'null' || origin === ownOrigin;\n  };\n  const safeFileName = (value) => {\n    const fileName = String(value || 'qr-watermark.png');\n    if (!fileName || fileName.length > 160 || fileName === '.' || fileName === '..' || /[\\u0000-\\u001f<>:\"/\\\\|?*]/u.test(fileName)) return null;\n    return fileName;\n  };\n  const post = (type, payload) => {\n    window.parent.postMessage({ version: VERSION, type, payload }, '*');\n  };\n  const validate = (event) => {\n    if (!originAllowed(event)) return null;\n    const message = event.data;\n    if (!isRecord(message) || message.version !== VERSION || typeof message.type !== 'string') return null;\n    if (message.type === PING) return { type: PING, payload: {} };\n    if (message.type !== SET_WATERMARK || !isRecord(message.payload)) return null;\n    const raw = bytesFrom(message.payload.data);\n    const fileName = safeFileName(message.payload.fileName);\n    const mimeType = String(message.payload.mimeType || 'image/png');\n    const text = String(message.payload.text || '');\n    if (!raw || raw.byteLength < 1 || raw.byteLength > MAX_BYTES || !fileName || !MIME_TYPES.has(mimeType) || text.length > 4096) return null;\n    return { type: SET_WATERMARK, payload: { data: raw, fileName, mimeType, text } };\n  };\n  const applyWatermark = (payload) => {\n    const input = document.getElementById('wm-img-input');\n    const mode = document.getElementById('mode-watermark');\n    if (!input || !mode || typeof File !== 'function' || typeof DataTransfer !== 'function') throw new Error('PDFウォーターマーク入力欄を利用できません。');\n    const file = new File([payload.data], payload.fileName, { type: payload.mimeType });\n    const transfer = new DataTransfer();\n    transfer.items.add(file);\n    input.files = transfer.files;\n    if (!mode.checked) {\n      mode.checked = true;\n      mode.dispatchEvent(new Event('change', { bubbles: true }));\n    }\n    input.dispatchEvent(new Event('input', { bubbles: true }));\n    input.dispatchEvent(new Event('change', { bubbles: true }));\n    post(APPLIED, { fileName: payload.fileName, mimeType: payload.mimeType, byteLength: payload.data.byteLength });\n  };\n  window.addEventListener('message', (event) => {\n    if (!originAllowed(event)) return;\n    const checked = validate(event);\n    if (!checked) {\n      if (event.data && event.data.type === SET_WATERMARK) post(ERROR, { code: 'invalid-message', message: 'PDF受渡しメッセージが不正です。' });\n      return;\n    }\n    if (checked.type === PING) {\n      post(READY, { source: 'generated/upstream/pdf', version: VERSION, capabilities: ['watermark-file'] });\n      return;\n    }\n    try {\n      applyWatermark(checked.payload);\n    } catch (error) {\n      post(ERROR, { code: 'apply-failed', message: error instanceof Error ? error.message : String(error) });\n    }\n  });\n  window.addEventListener('DOMContentLoaded', () => {\n    post(READY, { source: 'generated/upstream/pdf', version: VERSION, capabilities: ['watermark-file'] });\n  });\n})();\n`;
const pdfFrameBridgePath = path.join(generated, 'pdf', 'pdf-frame-bridge.js');
const generatedPdfFrameBridge = pdfFrameBridge.replace('sandboxed PDF iframe', 'PDF iframe');
if (pdfSourceReady) writeUtf8(pdfFrameBridgePath, generatedPdfFrameBridge);
const injectedCsp = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; font-src \'self\' data:; connect-src \'none\'; worker-src \'self\' blob:; frame-src \'self\' blob:; object-src \'none\'; base-uri \'none\'; form-action \'self\'">';
const generatedPdfHtml = pdfHtml
  .replace(/<head>/iu, `<head>\n    ${injectedCsp}`)
  .replace(/<script src="script\.js"><\/script>/iu, '<script src="pdf-data-url.js"></script>\n<script src="pdf-frame-bridge.js"></script>\n<script src="script.js"></script>');
if (!generatedPdfHtml.includes('pdf-data-url.js') || !generatedPdfHtml.includes('pdf-frame-bridge.js')) throw new Error('upstream PDF bridge injection failed.');
if (pdfSourceReady) {
  writeUtf8(path.join(generated, 'pdf', 'index.html'), generatedPdfHtml);
  writeUtf8(path.join(generated, 'pdf', 'script.js'), pdfScript);
  copy(pdfSpecSource, path.join(generated, 'pdf', 'SPECIFICATION.md'));
}

const pdfManifest = pdfSourceReady ? {
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
} : clone(fallbackManifest.upstream.pdf);
pdfManifest['pdf-frame-bridge.js'] = {
  source: 'scripts/stage-vendors.js',
  sha256: hash(pdfFrameBridgePath)
};
pdfManifest['pdf-data-url.js'] = {
  source: 'scripts/stage-vendors.js',
  sha256: hash(pdfDataUrlHelperPath)
};

const adapter = `'use strict';\n\n// Generated by scripts/stage-vendors.js. Do not edit by hand.\n(() => {\n  const metadata = ${JSON.stringify({
  generatedBy: 'scripts/stage-vendors.js',
  qr: qrManifest,
  pdf: pdfManifest,
  url: urlManifest,
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
  schema: 3,
  generatedBy: 'scripts/stage-vendors.js',
  upstream: {
    qr: qrManifest,
    pdf: pdfManifest,
    url: urlManifest
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
    },
    pdfDataUrl: {
      file: 'renderer/generated/upstream/pdf/pdf-data-url.js',
      sha256: hash(pdfDataUrlHelperPath)
    },
    urlConfig: {
      file: 'renderer/generated/upstream/url/config.js',
      source: 'vendor/analytics-url-generator/src/index.js',
      sha256: hash(urlConfigPath)
    },
    urlAdapter: {
      file: 'renderer/generated/upstream/url/adapter.js',
      source: 'scripts/stage-vendors.js',
      sha256: hash(urlAdapterPath)
    }
  }
};
writeUtf8(path.join(vendor, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Staged ${Object.keys(qrManifest).length} QR, ${Object.keys(pdfManifest).length} PDF, and ${Object.keys(urlManifest).length} URL upstream files plus local browser assets (QR: ${qrSourceReady ? 'submodule' : 'committed fallback'}, PDF: ${pdfSourceReady ? 'submodule' : 'committed fallback'}, URL: ${analyticsSourceReady ? 'submodule' : 'committed fallback'}).`);
