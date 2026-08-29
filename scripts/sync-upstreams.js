'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENTRIES = Object.freeze([
  Object.freeze({ relative: 'vendor/qr-generator', url: 'https://github.com/KF-itdepartment/QR-Generator.git' }),
  Object.freeze({ relative: 'vendor/pdf-editor', url: 'https://github.com/KF-itdepartment/pdf-editor.git' })
]);

// These are the only parent-repository paths this command may update. A
// developer can keep unrelated work in the parent repository while syncing,
// but an existing change in one of these paths is rejected before any fetch or
// checkout so generated output is never silently overwritten.
const MANAGED_PATHS = Object.freeze([
  'vendor/qr-generator',
  'vendor/pdf-editor',
  'renderer/generated',
  'renderer/vendor'
]);

function defaultGit(directory, args, options = {}) {
  return execFileSync('git', ['-C', directory, ...args], options);
}

function defaultStage(root) {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'stage-vendors.js')], {
    cwd: root,
    stdio: 'inherit'
  });
}

function commandError(error) {
  if (!error) return '';
  const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : String(error.stderr || '');
  const stdout = Buffer.isBuffer(error.stdout) ? error.stdout.toString('utf8') : String(error.stdout || '');
  const detail = (stderr || stdout || error.message || String(error)).trim();
  return detail ? `: ${detail.replace(/\s+/gu, ' ')}` : '';
}

function invokeGit(runGit, directory, args, label, options = {}) {
  try {
    return runGit(directory, args, options);
  } catch (error) {
    throw new Error(`${label}${commandError(error)}`);
  }
}

function ensureSubmoduleReady(root, entry, runGit) {
  const directory = path.join(root, entry.relative);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`${entry.relative}: submodule is not initialized (directory is missing); run git submodule update --init --recursive.`);
  }
  if (!fs.existsSync(path.join(directory, '.git'))) {
    throw new Error(`${entry.relative}: submodule is not initialized (.git is missing); run git submodule update --init --recursive.`);
  }
  invokeGit(runGit, directory, ['rev-parse', '--show-toplevel'], `${entry.relative}: submodule is not initialized`);
  const status = String(invokeGit(
    runGit,
    directory,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    `${entry.relative}: cannot inspect submodule status`,
    { encoding: 'utf8' }
  ) || '');
  if (status.trim()) {
    throw new Error(`${entry.relative}: submodule working tree is dirty; commit or stash its changes before syncing:\n${status.trim()}`);
  }
  return directory;
}

function ensureParentPathsClean(root, runGit) {
  const status = String(invokeGit(
    runGit,
    root,
    ['status', '--porcelain=v1', '--untracked-files=all', '--', ...MANAGED_PATHS],
    'parent repository managed paths are unavailable',
    { encoding: 'utf8' }
  ) || '');
  if (status.trim()) {
    throw new Error(`parent repository managed paths are dirty; commit or stash these paths before syncing:\n${status.trim()}`);
  }
}

function fetchedSha(entry, directory, runGit) {
  const value = String(invokeGit(
    runGit,
    directory,
    ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'],
    `${entry.relative}: fetched origin/main has no commit`,
    { encoding: 'utf8' }
  ) || '').trim();
  // rev-parse returns a full object id. Keep this check deliberately broad so
  // repositories using SHA-1 and SHA-256 object formats both work.
  if (!/^[a-f0-9]{7,128}$/iu.test(value)) {
    throw new Error(`${entry.relative}: fetched origin/main returned an invalid commit id: ${value || '(empty)'}`);
  }
  return value;
}

function main(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const entries = options.entries || ENTRIES;
  const runGit = options.runGit || defaultGit;
  const runStage = options.runStage || defaultStage;

  if (!Array.isArray(entries) || entries.length !== 2) {
    throw new Error('sync-upstreams requires exactly the QR and PDF upstream entries.');
  }

  const directories = new Map();
  // Validate every submodule and every parent path before contacting either
  // remote. In particular, an unrelated parent change is not in this scoped
  // status check and remains untouched.
  for (const entry of entries) {
    if (!entry || typeof entry.relative !== 'string' || !entry.relative) {
      throw new Error('sync-upstreams has an invalid submodule entry.');
    }
    directories.set(entry.relative, ensureSubmoduleReady(root, entry, runGit));
  }
  ensureParentPathsClean(root, runGit);

  const fetched = [];
  // Fetch both remotes before checking out either one. A failure in the
  // second fetch therefore cannot leave the first checkout half-updated.
  for (const entry of entries) {
    const directory = directories.get(entry.relative);
    console.log(`${entry.relative}: fetching origin/main (${entry.url || 'configured origin'})`);
    invokeGit(
      runGit,
      directory,
      ['fetch', '--quiet', 'origin', 'main'],
      `${entry.relative}: fetch origin/main failed`,
      { stdio: 'inherit' }
    );
    const sha = fetchedSha(entry, directory, runGit);
    fetched.push({ entry, directory, sha });
    console.log(`${entry.relative}: fetched ${sha}`);
  }

  for (const item of fetched) {
    console.log(`${item.entry.relative}: checking out ${item.sha} detached`);
    invokeGit(
      runGit,
      item.directory,
      ['checkout', '--detach', item.sha],
      `${item.entry.relative}: detached checkout failed`,
      { stdio: 'inherit' }
    );
  }

  console.log('Staging upstream source and generated integration artifacts...');
  try {
    runStage(root);
  } catch (error) {
    throw new Error(`stage-vendors.js failed${commandError(error)}`);
  }

  console.log('sync-upstreams: working-tree changes (no commit or push performed):');
  invokeGit(
    runGit,
    root,
    ['status', '--short', '--untracked-files=all'],
    'unable to display sync result',
    { stdio: 'inherit' }
  );
  return { fetched };
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`sync-upstreams: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  ENTRIES,
  MANAGED_PATHS,
  commandError,
  ensureParentPathsClean,
  ensureSubmoduleReady,
  main
};
