'use strict';

// The execution environment used by some CI/agent runners sets
// ELECTRON_RUN_AS_NODE globally. Remove it before spawning the real Electron
// binary so this smoke test exercises BrowserWindow rather than Node.js.
const path = require('node:path');
const { spawn } = require('node:child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const smokeDataDirectory = path.join(__dirname, '..', '.electron-smoke-user-data');
const child = spawn(electron, [
  '--user-data-dir=' + smokeDataDirectory,
  '--disable-gpu',
  path.join(__dirname, 'electron-smoke.js')
], {
  stdio: 'inherit',
  env,
  windowsHide: true
});

child.on('error', (error) => {
  console.error(`Unable to launch Electron smoke test: ${error.stack || error}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Electron smoke test exited with signal ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
