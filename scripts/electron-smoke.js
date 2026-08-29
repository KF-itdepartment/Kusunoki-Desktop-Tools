'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, session } = require('electron');

const root = path.resolve(__dirname, '..');
const rendererIndex = path.join(root, 'renderer', 'index.html');
const externalRequests = [];
const consoleErrors = [];
let smokeWindow = null;

app.disableHardwareAcceleration();

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function inspectRenderer() {
  const script = `(async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const frame = document.getElementById('pdf-editor-frame');
      const childDocument = frame && frame.contentDocument;
      const childWindow = frame && frame.contentWindow;
      const ready = childDocument && childDocument.readyState === 'complete';
      const domReady = ready && childDocument.querySelector('#wm-img-input')
        && childDocument.querySelector('#mode-watermark')
        && childDocument.querySelector('#pdf-viewer');
      const libraries = childWindow && childWindow.PDFLib
        && childWindow.pdfjsLib
        && childWindow.JSZip;
      const bridge = document.documentElement.dataset.pdfFrameReady === 'true';
      if (domReady && libraries && bridge) {
        return {
          frameSrc: frame.getAttribute('src'),
          childReadyState: childDocument.readyState,
          pdfLib: typeof childWindow.PDFLib,
          pdfjsLib: typeof childWindow.pdfjsLib,
          jszip: typeof childWindow.JSZip,
          bridgeReady: bridge,
          bridgeScript: Boolean(childDocument.querySelector('script[src="pdf-frame-bridge.js"]')),
          watermarkInput: Boolean(childDocument.querySelector('#wm-img-input')),
          watermarkMode: Boolean(childDocument.querySelector('#mode-watermark')),
          pdfViewer: Boolean(childDocument.querySelector('#pdf-viewer'))
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('generated PDF iframe did not become ready within 15 seconds');
  })()`;
  return smokeWindow.webContents.executeJavaScript(script, true);
}

async function run() {
  await app.whenReady();
  // The smoke entry point loads renderer/index.html directly (instead of the
  // application's main.js) so it can inspect the exact generated frame. Keep
  // the preload contract complete and prevent an expected app.version invoke
  // from becoming a false renderer-console error.
  ipcMain.handle('app.version', () => app.getVersion());
  const defaultSession = session.defaultSession;
  defaultSession.webRequest.onBeforeRequest({
    urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']
  }, (details, callback) => {
    externalRequests.push(details.url);
    callback({ cancel: true });
  });

  smokeWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(root, 'electron', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: false
    }
  });
  smokeWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) consoleErrors.push(String(message));
  });
  smokeWindow.webContents.on('render-process-gone', (_event, details) => {
    consoleErrors.push(`render-process-gone:${details.reason}`);
  });
  await smokeWindow.loadFile(rendererIndex);
  const result = await inspectRenderer();
  if (!result.bridgeReady || result.frameSrc !== './generated/upstream/pdf/index.html') {
    throw new Error(`unexpected generated PDF iframe result: ${JSON.stringify(result)}`);
  }
  if (externalRequests.length) throw new Error(`external requests detected: ${externalRequests.join(', ')}`);
  if (consoleErrors.length) throw new Error(`renderer console errors: ${consoleErrors.join(' | ')}`);
  console.log(JSON.stringify({ status: 'ok', ...result, externalRequests, consoleErrors }));
}

run().then(() => {
  if (smokeWindow && !smokeWindow.isDestroyed()) smokeWindow.destroy();
  app.exit(0);
}).catch((error) => {
  console.error(`Electron smoke failed: ${error instanceof Error ? error.stack : String(error)}`);
  if (smokeWindow && !smokeWindow.isDestroyed()) smokeWindow.destroy();
  app.exit(1);
});
