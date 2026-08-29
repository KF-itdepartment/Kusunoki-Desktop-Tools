const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'renderer', 'vendor');
fs.mkdirSync(vendor, { recursive: true });

function copyIfPresent(source, target) {
  if (!fs.existsSync(source)) return false;
  fs.copyFileSync(source, target);
  return true;
}

const pdfjsRoot = path.join(root, 'node_modules', 'pdfjs-dist');
const pdfjsCandidates = [
  ['build', 'pdf.min.js'],
  ['legacy', 'build', 'pdf.min.js']
];
const workerCandidates = [
  ['build', 'pdf.worker.min.js'],
  ['legacy', 'build', 'pdf.worker.min.js']
];

const pdfjs = pdfjsCandidates.find((parts) => fs.existsSync(path.join(pdfjsRoot, ...parts)));
const worker = workerCandidates.find((parts) => fs.existsSync(path.join(pdfjsRoot, ...parts)));
if (pdfjs) copyIfPresent(path.join(pdfjsRoot, ...pdfjs), path.join(vendor, 'pdf.min.js'));
if (worker) copyIfPresent(path.join(pdfjsRoot, ...worker), path.join(vendor, 'pdf.worker.min.js'));

copyIfPresent(
  path.join(root, 'node_modules', 'jszip', 'dist', 'jszip.min.js'),
  path.join(vendor, 'jszip.min.js')
);

// The application never loads a remote script. Keep a small manifest so a
// packaged build can be audited without inspecting node_modules.
fs.writeFileSync(path.join(vendor, 'MANIFEST.json'), JSON.stringify({
  pdfjs: 'pdfjs-dist@3.11.174',
  jszip: 'jszip@3.10.1'
}, null, 2) + '\n', 'utf8');
