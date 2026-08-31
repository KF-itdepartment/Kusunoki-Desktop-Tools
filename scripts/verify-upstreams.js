'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Text hashes in MANIFEST.json describe canonical UTF-8 text. This keeps a
// checkout made with core.autocrlf=true equivalent to one made on Linux,
// while binary assets (for example logo.png) remain byte-for-byte hashes.
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.csv', '.html', '.htm', '.js', '.jsx', '.json', '.mjs',
  '.map', '.md', '.scss', '.svg', '.ts', '.tsx', '.txt', '.xml', '.yaml',
  '.yml'
]);

const QR_SOURCE_FILES = [
  'index.html',
  'script.js',
  'batch-utils.mjs',
  'logo.png',
  'vendor/fflate.mjs',
  'vendor/fflate.LICENSE.txt'
];
const QR_GENERATED_FILES = [...QR_SOURCE_FILES, 'batch-utils.js'];
const PDF_SOURCE_FILES = ['index.html', 'script.js', 'SPECIFICATION.md'];
const PDF_GENERATED_FILES = [...PDF_SOURCE_FILES, 'pdf-frame-bridge.js', 'pdf-data-url.js'];
const ANALYTICS_COMMIT = 'b65e77c8600572f5ddac80b4bc78dde4476b5380';
const ANALYTICS_SOURCE_FILES = ['src/index.js'];
const URL_GENERATED_FILES = ['config.js', 'adapter.js'];
const INTEGRATION_KEYS = ['qrBatch', 'pdfFrameBridge', 'pdfDataUrl', 'urlConfig', 'urlAdapter'];
const BROWSER_KEYS = ['pdfLib', 'pdfjs', 'worker', 'jszip'];
const ROOT = path.resolve(__dirname, '..');

function canonicalBytes(file) {
  const bytes = fs.readFileSync(file);
  if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) return bytes;
  return Buffer.from(bytes.toString('utf8').replace(/\r\n?/gu, '\n'), 'utf8');
}

function sha256(file) {
  return crypto.createHash('sha256').update(canonicalBytes(file)).digest('hex');
}

function isFile(file) {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(directory) {
  try {
    return fs.existsSync(directory) && fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function inspectSource(root, group, names) {
  const submodule = group === 'qr'
    ? path.join(root, 'vendor', 'qr-generator')
    : group === 'pdf'
      ? path.join(root, 'vendor', 'pdf-editor')
      : path.join(root, 'vendor', 'analytics-url-generator');
  const source = path.join(root, sourceDirectory(root, group));
  // A missing submodule directory is the normal public-CI fallback case. Some
  // gitlink checkouts still leave an empty directory behind, so an empty
  // directory without a .git marker is also unavailable. A .git file (the
  // usual linked-worktree submodule form) and a .git directory both mean that
  // the submodule is initialized; once initialized, a partial source tree
  // must not be silently treated as fallback.
  if (!isDirectory(submodule)) {
    return { available: false, partial: false, missing: [], uninitialized: false };
  }
  const gitMarker = path.join(submodule, '.git');
  if (!fs.existsSync(gitMarker)) {
    let entries;
    try {
      entries = fs.readdirSync(submodule);
    } catch {
      entries = ['<unreadable>'];
    }
    if (entries.length === 0) return { available: false, partial: false, missing: [], uninitialized: false };
    return { available: false, partial: true, missing: [], uninitialized: true };
  }
  const missing = names.filter((name) => !isFile(path.join(source, name)));
  return { available: missing.length === 0, partial: true, missing, uninitialized: false };
}

function relativePath(root, file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function resolveManifestPath(root, value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} has no relative path.`);
  }
  const candidate = path.resolve(root, value);
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} points outside the repository: ${value}`);
  }
  return candidate;
}

function validHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value);
}

function readManifest(root) {
  const manifestPath = path.join(root, 'renderer', 'vendor', 'MANIFEST.json');
  if (!isFile(manifestPath)) {
    throw new Error(`manifest is missing: ${relativePath(root, manifestPath)}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifest must contain a JSON object.');
  }
  return manifest;
}

function sourceDirectory(root, group) {
  return group === 'qr'
    ? path.join('vendor', 'qr-generator', 'public')
    : group === 'pdf'
      ? path.join('vendor', 'pdf-editor')
      : path.join('vendor', 'analytics-url-generator');
}

function generatedDirectory(group) {
  return path.join('renderer', 'generated', 'upstream', group);
}

function addHashCheck(errors, file, expected, label) {
  if (!validHash(expected)) {
    errors.push(`${label}: manifest hash is missing or invalid.`);
    return;
  }
  if (!isFile(file)) {
    errors.push(`${label}: file is missing (${file}).`);
    return;
  }
  let actual;
  try {
    actual = sha256(file);
  } catch (error) {
    errors.push(`${label}: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    errors.push(`${label}: hash mismatch (manifest ${expected}, actual ${actual}) [${file}].`);
  }
}

function entryObject(manifest, group, name, errors) {
  const groupEntries = manifest.upstream?.[group];
  const entry = groupEntries?.[name];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`${group.toUpperCase()} ${name}: manifest entry is missing.`);
    return null;
  }
  return entry;
}

function verifyGroup(root, manifest, group, sourceAvailable, errors) {
  const generatedNames = group === 'qr' ? QR_GENERATED_FILES : PDF_GENERATED_FILES;
  const sourceNames = group === 'qr' ? QR_SOURCE_FILES : PDF_SOURCE_FILES;
  const generatedRoot = path.join(root, generatedDirectory(group));
  const sourceRoot = path.join(root, sourceDirectory(root, group));
  const label = group === 'qr' ? 'QR' : 'PDF';

  for (const name of generatedNames) {
    const entry = entryObject(manifest, group, name, errors);
    if (!entry) continue;
    const generatedExpected = entry.generatedSha256 || entry.sha256;
    addHashCheck(
      errors,
      path.join(generatedRoot, name),
      generatedExpected,
      `${label} generated ${name}`
    );

    // bridge/data-url are generated integration units whose manifest source
    // is stage-vendors.js. They are checked against their generated hash, but
    // are not mistaken for source files from a submodule.
    if (!sourceAvailable || !sourceNames.includes(name)) continue;
    if (typeof entry.source !== 'string' || !entry.source.trim()) {
      errors.push(`${label} ${name}: manifest source path is missing.`);
      continue;
    }
    let source;
    try {
      source = resolveManifestPath(root, entry.source, `${label} ${name} source`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    addHashCheck(errors, source, entry.sha256, `${label} source ${name}`);
  }
}

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
    return '';
  }
  return '';
}

function verifyUrl(root, manifest, sourceAvailable, errors) {
  const entries = manifest.upstream?.url;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    errors.push('URL upstream manifest section is missing.');
    return;
  }
  const generatedRoot = path.join(root, generatedDirectory('url'));
  for (const name of URL_GENERATED_FILES) {
    const entry = entryObject(manifest, 'url', name, errors);
    if (!entry) continue;
    addHashCheck(errors, path.join(generatedRoot, name), entry.generatedSha256 || entry.sha256, `URL generated ${name}`);
    if (entry.commit !== ANALYTICS_COMMIT) errors.push(`URL ${name}: manifest commit must be ${ANALYTICS_COMMIT}.`);
  }
  const sourceEntry = entries['src/index.js'];
  if (!sourceEntry || typeof sourceEntry !== 'object' || Array.isArray(sourceEntry)) {
    errors.push('URL src/index.js: manifest entry is missing.');
  } else {
    if (sourceEntry.commit !== ANALYTICS_COMMIT) errors.push(`URL source src/index.js: manifest commit must be ${ANALYTICS_COMMIT}.`);
    if (sourceAvailable) {
      let source;
      try {
        source = resolveManifestPath(root, sourceEntry.source, 'URL src/index.js source');
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      if (source) addHashCheck(errors, source, sourceEntry.sha256, 'URL source src/index.js');
      const actualCommit = readSubmoduleCommit(path.join(root, 'vendor', 'analytics-url-generator'));
      if (actualCommit !== ANALYTICS_COMMIT) errors.push(`URL source commit must be ${ANALYTICS_COMMIT} (found ${actualCommit || '(unknown)'}).`);
    }
  }
  const configEntry = entries['config.js'];
  if (configEntry && configEntry.source !== 'vendor/analytics-url-generator/src/index.js') errors.push('URL config.js: manifest source path is invalid.');
}

function verifyIntegration(root, manifest, errors) {
  const integration = manifest.integration;
  if (!integration || typeof integration !== 'object' || Array.isArray(integration)) {
    errors.push('integration: manifest section is missing.');
    return;
  }
  const expectedUpstream = {
    qrBatch: manifest.upstream?.qr?.['batch-utils.js'],
    pdfFrameBridge: manifest.upstream?.pdf?.['pdf-frame-bridge.js'],
    pdfDataUrl: manifest.upstream?.pdf?.['pdf-data-url.js'],
    urlConfig: manifest.upstream?.url?.['config.js'],
    urlAdapter: manifest.upstream?.url?.['adapter.js']
  };
  for (const key of INTEGRATION_KEYS) {
    const entry = integration[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`integration.${key}: manifest entry is missing.`);
      continue;
    }
    let file;
    try {
      file = resolveManifestPath(root, entry.file, `integration.${key}.file`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    addHashCheck(errors, file, entry.sha256, `integration.${key}`);

    const upstream = expectedUpstream[key];
    const expectedHash = upstream?.generatedSha256 || upstream?.sha256;
    if (validHash(expectedHash) && validHash(entry.sha256) && entry.sha256.toLowerCase() !== expectedHash.toLowerCase()) {
      errors.push(`integration.${key}: hash does not match upstream manifest entry.`);
    }
  }
}

function verifyAdapter(root, manifest, errors) {
  const adapter = manifest.adapter;
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    errors.push('adapter: manifest section is missing.');
    return;
  }
  let file;
  try {
    file = resolveManifestPath(root, adapter.file, 'adapter.file');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return;
  }
  addHashCheck(errors, file, adapter.sha256, 'generated upstream adapter');
}

function verifyBrowserAssets(root, manifest, errors) {
  // Older manifests may not carry browser entries. When present, verify them
  // too because they are generated package inputs and are read-only here.
  if (!manifest.browser || typeof manifest.browser !== 'object' || Array.isArray(manifest.browser)) return;
  for (const key of BROWSER_KEYS) {
    const entry = manifest.browser[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`browser.${key}: manifest entry is missing.`);
      continue;
    }
    let file;
    try {
      file = resolveManifestPath(root, path.join('renderer', 'vendor', entry.file), `browser.${key}.file`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    addHashCheck(errors, file, entry.sha256, `browser.${key}`);
  }
}

function verifyUpstreams(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const manifest = readManifest(root);
  const errors = [];
  if (manifest.schema !== 3) errors.push(`manifest schema must be 3 (found ${String(manifest.schema)}).`);
  if (!manifest.upstream || typeof manifest.upstream !== 'object' || Array.isArray(manifest.upstream)) {
    errors.push('upstream: manifest section is missing.');
  }

  const sourceStates = {
    qr: inspectSource(root, 'qr', QR_SOURCE_FILES),
    pdf: inspectSource(root, 'pdf', PDF_SOURCE_FILES),
    url: inspectSource(root, 'url', ANALYTICS_SOURCE_FILES)
  };
  const sourceChecks = {
    qr: sourceStates.qr.available,
    pdf: sourceStates.pdf.available,
    url: sourceStates.url.available
  };
  for (const group of ['qr', 'pdf', 'url']) {
    const state = sourceStates[group];
    if (state.partial && !state.available) {
      const label = group === 'qr' ? 'QR' : group === 'pdf' ? 'PDF' : 'URL';
      if (state.uninitialized) {
        errors.push(`${label} source tree is present but submodule is not initialized (.git is missing).`);
      } else {
        errors.push(`${label} source tree is present but required files are missing: ${state.missing.join(', ')}.`);
      }
    }
  }
  if (manifest.upstream && typeof manifest.upstream === 'object') {
    verifyGroup(root, manifest, 'qr', sourceChecks.qr, errors);
    verifyGroup(root, manifest, 'pdf', sourceChecks.pdf, errors);
    verifyUrl(root, manifest, sourceChecks.url, errors);
  }
  verifyIntegration(root, manifest, errors);
  verifyAdapter(root, manifest, errors);
  verifyBrowserAssets(root, manifest, errors);

  if (errors.length) {
    const error = new Error(`upstream verification failed:\n${errors.map((item) => `- ${item}`).join('\n')}`);
    error.sourceChecks = sourceChecks;
    error.sourceStates = sourceStates;
    throw error;
  }
  return { root, sourceChecks, sourceStates };
}

function describeSourceCheck(group, available, state = null) {
  const label = group === 'qr' ? 'QR' : group === 'pdf' ? 'PDF' : 'URL';
  if (state?.partial && !state.available) {
    return state.uninitialized
      ? `${label} source checks failed (source tree is present but submodule is not initialized).`
      : `${label} source checks failed (source tree is present but incomplete).`;
  }
  if (available) return `${label} source checks passed (submodule source is available).`;
  return `${label} source checks skipped (submodule source unavailable); committed generated fallback verified.`;
}

function main() {
  try {
    const result = verifyUpstreams();
    console.log(describeSourceCheck('qr', result.sourceChecks.qr, result.sourceStates.qr));
    console.log(describeSourceCheck('pdf', result.sourceChecks.pdf, result.sourceStates.pdf));
    console.log(describeSourceCheck('url', result.sourceChecks.url, result.sourceStates.url));
    console.log('verify:upstreams: generated files match renderer/vendor/MANIFEST.json.');
    return result;
  } catch (error) {
    if (error && error.sourceChecks) {
      console.log(describeSourceCheck('qr', error.sourceChecks.qr, error.sourceStates?.qr));
      console.log(describeSourceCheck('pdf', error.sourceChecks.pdf, error.sourceStates?.pdf));
      console.log(describeSourceCheck('url', error.sourceChecks.url, error.sourceStates?.url));
    }
    console.error(`verify:upstreams: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return null;
  }
}

if (require.main === module) main();

module.exports = {
  TEXT_EXTENSIONS,
  canonicalBytes,
  sha256,
  ANALYTICS_COMMIT,
  ANALYTICS_SOURCE_FILES,
  URL_GENERATED_FILES,
  inspectSource,
  verifyUrl,
  verifyUpstreams,
  describeSourceCheck
};
