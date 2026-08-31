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
      const picFrame = document.getElementById('pic-editor-frame');
      const picDocument = picFrame && picFrame.contentDocument;
      const picWindow = picFrame && picFrame.contentWindow;
      const picReady = picDocument && picDocument.readyState === 'complete';
      const picCanvas = picReady && picDocument.querySelector('#editor-canvas');
      const picControls = picReady && picDocument.querySelector('#addImage')
        && picDocument.querySelector('#addText')
        && picDocument.querySelector('#addRect')
        && picDocument.querySelector('#propsSection')
        && picDocument.querySelector('.layers-section');
      if (domReady && libraries && bridge && picReady && picCanvas && picControls) {
        const japaneseLabels = ['画像', '文字', '長方形', '楕円', '線', '矢印', 'プロパティ', 'レイヤー'];
        const picText = picDocument.body?.textContent || '';
        if (!japaneseLabels.every((label) => picText.includes(label))) throw new Error('pic editor Japanese controls are missing');
        const remoteAsset = Array.from(picDocument.querySelectorAll('script[src], link[href]'))
          .find((element) => /https?:\\/\\//iu.test(element.getAttribute('src') || element.getAttribute('href') || ''));
        if (remoteAsset) throw new Error('pic editor has a remote runtime asset');
        if (picFrame.hasAttribute('sandbox')) throw new Error('pic editor iframe must not have a sandbox attribute');
        const layersBefore = picDocument.querySelectorAll('.layer-row').length;
        picDocument.getElementById('addRect').click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const statusText = picDocument.getElementById('status')?.textContent || '';
        const layersAfter = picDocument.querySelectorAll('.layer-row').length;
        const shapeAdded = layersAfter > layersBefore && (statusText.includes('長方形') || statusText.length > 0);
        if (!shapeAdded) throw new Error('pic editor shape add smoke operation failed (layers ' + layersBefore + '->' + layersAfter + ', status ' + statusText + ')');
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
          pdfViewer: Boolean(childDocument.querySelector('#pdf-viewer')),
          picFrameSrc: picFrame.getAttribute('src'),
          picReadyState: picDocument.readyState,
          picCanvas: Boolean(picCanvas),
          picCanvasFabric: picCanvas.getAttribute('data-fabric') === 'main',
          picJapaneseControls: true,
          picLocalAssets: true,
          picSandboxAttribute: picFrame.hasAttribute('sandbox'),
          picShapeAdded: shapeAdded,
          picWindow: Boolean(picWindow)
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('generated PDF or Pic iframe did not become ready within 15 seconds');
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
  // app.js performs the same one-shot startup check as a packaged renderer.
  // This harness intentionally does not load main.js/update-service.js, so
  // provide the unpacked-build result explicitly instead of logging an IPC
  // "No handler registered" error.
  ipcMain.handle('updates.check', () => ({ status: 'disabled' }));
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
  let result;
  try {
    result = await inspectRenderer();
  } catch (error) {
    if (consoleErrors.length) console.error(`Renderer diagnostics: ${consoleErrors.join(' | ')}`);
    throw error;
  }
  if (!result.bridgeReady || result.frameSrc !== './generated/upstream/pdf/index.html' || result.picFrameSrc !== './generated/upstream/pic/index.html' || !result.picShapeAdded) {
    throw new Error(`unexpected generated upstream iframe result: ${JSON.stringify(result)}`);
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
