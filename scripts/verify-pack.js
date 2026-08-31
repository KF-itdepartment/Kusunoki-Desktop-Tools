const fs = require('node:fs');
const path = require('node:path');
const { listPackage } = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const asar = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
if (!fs.existsSync(asar)) {
  throw new Error(`packaged asar is missing: ${path.relative(root, asar)}`);
}
const entries = listPackage(asar).map((entry) => entry.replaceAll('\\', '/').replace(/^\/+/, ''));
const required = [
  'renderer/app-icon.png',
  'renderer/update-ui.js',
  'renderer/generated/upstream-adapter.js',
  'renderer/generated/upstream/qr/index.html',
  'renderer/generated/upstream/qr/batch-utils.js',
  'renderer/generated/upstream/qr/logo.png',
  'renderer/generated/upstream/qr/script.js',
  'renderer/generated/upstream/qr/vendor/fflate.mjs',
  'renderer/generated/upstream/pdf/index.html',
  'renderer/generated/upstream/pdf/script.js',
  'renderer/generated/upstream/pdf/pdf-frame-bridge.js',
  'renderer/generated/upstream/pdf/pdf-data-url.js',
  'renderer/generated/upstream/pic/index.html',
  'renderer/generated/upstream/pic/styles.css',
  'renderer/generated/upstream/pic/app.js',
  'renderer/generated/upstream/pic/SPECIFICATION.md',
  'renderer/generated/upstream/url/config.js',
  'renderer/generated/upstream/url/adapter.js',
  'renderer/vendor/pdf-lib.min.js',
  'renderer/vendor/pdf.worker.min.js'
];
const missing = required.filter((entry) => !entries.includes(entry));
if (missing.length) throw new Error(`packaged files are missing: ${missing.join(', ')}`);
const privateSubmoduleFiles = entries.filter((entry) => /^vendor\/(?:qr-generator|pdf-editor|analytics-url-generator|pic-editor)(?:\/|$)/u.test(entry));
if (privateSubmoduleFiles.length) throw new Error(`private upstream submodule files must not be packaged: ${privateSubmoduleFiles.join(', ')}`);
console.log(`Verified ${required.length} upstream/local assets in ${path.relative(root, asar)}.`);
