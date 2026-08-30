const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isTrustedSender, RENDERER_DIRECTORY } = require('../electron/main');

test('renderer has local-only CSP and no CDN references', () => {
  const html=fs.readFileSync(path.join(__dirname,'..','renderer','index.html'),'utf8');
  assert.match(html,/connect-src 'none'/); assert.match(html,/script-src 'self'/); assert.doesNotMatch(html,/unpkg|cdnjs|<script[^>]+src=["']https?:/iu);
  assert.match(html,/id="qr-online-mode"[^>]+data-qr-mode="online"[^>]+aria-pressed="true"/u);
  assert.match(html,/URL短縮（準備中）/u);
  assert.match(html,/<button[^>]+disabled[^>]+aria-disabled="true"[^>]*>URL短縮（準備中）<\/button>/u);
  const preload=fs.readFileSync(path.join(__dirname,'..','electron','preload.js'),'utf8');
  assert.match(preload,/contextBridge/); assert.doesNotMatch(preload,/readFile|writeFile|shell\.openExternal/);
  const main=fs.readFileSync(path.join(__dirname,'..','electron','main.js'),'utf8'); assert.match(main,/nodeIntegration:\s*false/); assert.match(main,/contextIsolation:\s*true/); assert.match(main,/sandbox:\s*true/);
});

test('QR mode starts online, is not persisted, and online API stays in main process', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'electron', 'qr-service.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
  assert.match(app, /qrMode:\s*['"]online['"]/u);
  assert.doesNotMatch(`${html}\n${app}`, /localStorage|sessionStorage/u);
  assert.match(main, /assertQrMode/u);
  assert.match(service, /https:\/\/qr-generator\.kf-itdepartment\.workers\.dev\/api\/qr/u);
  assert.doesNotMatch(`${html}\n${app}`, /qr-generator\.kf-itdepartment\.workers\.dev/u);
});

test('renderer prevents QR mode changes while single/batch work runs and guards CSV file races', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.match(app, /qrBusy:\s*false/u);
  assert.match(app, /button\.disabled\s*=\s*state\.qrBusy\s*\|\|\s*state\.batchRunning/u);
  assert.match(app, /state\.qrBusy\s*=\s*true/u);
  assert.match(app, /state\.qrBusy\s*=\s*false/u);
  assert.match(app, /const requestToken = \+\+state\.csvReadToken/u);
  assert.match(app, /requestToken !== state\.csvReadToken/u);
});

test('IPC sender validation accepts only the renderer entry document', () => {
  const entry = pathToFileURL(path.join(RENDERER_DIRECTORY, 'index.html')).toString();
  assert.equal(isTrustedSender({ senderFrame: { url: entry } }), true);
  assert.equal(isTrustedSender({ senderFrame: { url: `${entry}?evil=1` } }), false);
  assert.equal(isTrustedSender({ senderFrame: { url: 'https://example.com/renderer/index.html' } }), false);
});
