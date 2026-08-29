const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isTrustedSender, RENDERER_DIRECTORY } = require('../electron/main');

test('renderer has local-only CSP and no CDN references', () => {
  const html=fs.readFileSync(path.join(__dirname,'..','renderer','index.html'),'utf8');
  assert.match(html,/connect-src 'none'/); assert.match(html,/script-src 'self'/); assert.doesNotMatch(html,/unpkg|cdnjs|<script[^>]+src=["']https?:/iu);
  const preload=fs.readFileSync(path.join(__dirname,'..','electron','preload.js'),'utf8');
  assert.match(preload,/contextBridge/); assert.doesNotMatch(preload,/readFile|writeFile|shell\.openExternal/);
  const main=fs.readFileSync(path.join(__dirname,'..','electron','main.js'),'utf8'); assert.match(main,/nodeIntegration:\s*false/); assert.match(main,/contextIsolation:\s*true/); assert.match(main,/sandbox:\s*true/);
});

test('IPC sender validation accepts only the renderer entry document', () => {
  const entry = pathToFileURL(path.join(RENDERER_DIRECTORY, 'index.html')).toString();
  assert.equal(isTrustedSender({ senderFrame: { url: entry } }), true);
  assert.equal(isTrustedSender({ senderFrame: { url: `${entry}?evil=1` } }), false);
  assert.equal(isTrustedSender({ senderFrame: { url: 'https://example.com/renderer/index.html' } }), false);
});
