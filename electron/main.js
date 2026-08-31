const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require('electron');
const { AssetStore } = require('./asset-store');
const { ALLOWED_QR_MODES, QR_MODES, generateQrByMode } = require('./qr-service');
const { processPdf } = require('./pdf-service');
const { createUpdateService } = require('./update-service');
const { createUrlService } = require('./url-service');

const RENDERER_DIRECTORY = path.resolve(__dirname, '..', 'renderer');
const RELEASE_URL = 'https://github.com/KF-itdepartment/Kusunoki-Desktop-Tools/releases';
const VIEW_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'qr-view', label: 'QRコード', accelerator: 'CmdOrCtrl+1' }),
  Object.freeze({ id: 'pdf-view', label: 'PDFエディター', accelerator: 'CmdOrCtrl+2' }),
  Object.freeze({ id: 'pic-view', label: '画像エディター', accelerator: 'CmdOrCtrl+3' }),
  Object.freeze({ id: 'url-view', label: 'UTM URL生成・短縮', accelerator: 'CmdOrCtrl+4' }),
  Object.freeze({ id: 'assets-view', label: '素材トレイ', accelerator: 'CmdOrCtrl+5' })
]);
const ALLOWED_VIEW_IDS = new Set(VIEW_DEFINITIONS.map((item) => item.id));
const MATERIAL_IMPORT_FILTERS = Object.freeze([{ name: '画像・素材アーカイブ', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'zip'] }]);
let mainWindow;
let assetStore;
let updateService;
let urlService;
let registered = false;
let activeView = 'qr-view';

function isTrustedSender(event) {
  const url = String(event?.senderFrame?.url || event?.sender?.getURL?.() || '');
  if (!url.startsWith('file://')) return false;
  try {
    const parsed = new URL(url);
    if (parsed.host || parsed.search || parsed.hash) return false;
    const decodedPathname = decodeURIComponent(parsed.pathname);
    const windowsPath = /^\/[A-Za-z]:/u.test(decodedPathname)
      ? decodedPathname.slice(1).replaceAll('/', path.sep)
      : decodedPathname.replaceAll('/', path.sep);
    const senderPath = path.resolve(windowsPath);
    const indexPath = path.resolve(RENDERER_DIRECTORY, 'index.html');
    return senderPath.toLowerCase() === indexPath.toLowerCase();
  } catch {
    return false;
  }
}

function requireTrustedSender(event) {
  if (!isTrustedSender(event)) throw new Error('許可されていない送信元です。');
}

function assertViewId(value) {
  if (typeof value !== 'string' || !ALLOWED_VIEW_IDS.has(value)) throw new TypeError('表示画面が不正です。');
  return value;
}

function webContentsFor(target) {
  if (target?.webContents) return target.webContents;
  return target || null;
}

function updateMenuChecked(viewId) {
  let menu;
  try { menu = Menu.getApplicationMenu?.(); } catch { menu = null; }
  if (!menu) return;
  const visit = (items) => {
    for (const item of items || []) {
      if (typeof item.id === 'string' && item.id.startsWith('view-')) item.checked = item.id === `view-${viewId}`;
      if (item.submenu) visit(item.submenu.items || item.submenu);
    }
  };
  visit(menu.items);
}

function setActiveView(viewId, target = mainWindow, { notify = true } = {}) {
  const accepted = assertViewId(viewId);
  activeView = accepted;
  updateMenuChecked(accepted);
  if (notify) webContentsFor(target)?.send?.('navigation.open-view', { viewId: accepted });
  return accepted;
}

function getActiveView() {
  return activeView;
}

function sendRendererEvent(channel, payload, target = mainWindow) {
  const contents = webContentsFor(target);
  if (!contents || contents.isDestroyed?.()) return false;
  contents.send(channel, payload);
  return true;
}

function notificationPayload(message, kind = 'info') {
  return { message: String(message || ''), kind: ['info', 'success', 'error'].includes(kind) ? kind : 'info' };
}

function sendNotification(message, kind = 'info', target = mainWindow) {
  if (!message) return false;
  return sendRendererEvent('app.notification', notificationPayload(message, kind), target);
}

function errorMessage(error, fallback = '処理に失敗しました。') {
  const message = error instanceof Error ? error.message : String(error || '');
  return message && message.length <= 240 ? message : fallback;
}

async function writeFileAtomic(filePath, data, { fsApi = fs.promises } = {}) {
  const target = path.resolve(String(filePath));
  const temporary = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const backup = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.bak`;
  let movedOriginal = false;
  try {
    await fsApi.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    try {
      await fsApi.stat(target);
      await fsApi.rename(target, backup);
      movedOriginal = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fsApi.rename(temporary, target);
    if (movedOriginal) await fsApi.rm(backup, { force: true }).catch(() => {});
  } catch (error) {
    await fsApi.rm(temporary, { force: true }).catch(() => {});
    if (movedOriginal) {
      await fsApi.rm(target, { force: true }).catch(() => {});
      await fsApi.rename(backup, target).catch(() => {});
    }
    throw error;
  }
}

function assertObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('入力形式が不正です。');
  return value;
}

function assertQrMode(value) {
  const mode = value ?? QR_MODES.OFFLINE;
  if (!ALLOWED_QR_MODES.has(mode)) throw new TypeError('QR生成モードが不正です。');
  return mode;
}

function assertHttpUrl(value, label = 'URL') {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label}が不正です。`);
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new TypeError(`${label}が不正です。`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new TypeError(`${label}が不正です。`);
  return parsed.toString();
}

const URL_SHORTEN_STATUS_MESSAGES = Object.freeze({
  400: '短縮するURLまたは短縮IDを確認してください。',
  401: '短縮サービスを利用できません。',
  403: '短縮サービスを利用できません。',
  409: 'その短縮IDは既に使用されています。',
  429: '短縮サービスの利用が集中しています。しばらく待って再試行してください。',
  500: '短縮サービスが一時的に利用できません。',
  503: '短縮サービスが一時的に利用できません。'
});

function serializeUrlShortenError(error) {
  const code = String(error?.code || '');
  if (code === 'http') {
    const status = Number(error?.status);
    if (Object.prototype.hasOwnProperty.call(URL_SHORTEN_STATUS_MESSAGES, status)) {
      return { code, status, message: URL_SHORTEN_STATUS_MESSAGES[status] };
    }
  }
  if (code === 'timeout') return { code, message: '短縮サービスへの接続がタイムアウトしました。' };
  if (code === 'network') return { code, message: '短縮サービスに接続できませんでした。' };
  if (code === 'invalid-input') return { code, message: '短縮する入力内容を確認してください。' };
  if (['content-type', 'invalid-json', 'invalid-response', 'response-read', 'too-large'].includes(code)) {
    return { code: 'invalid-response', message: '短縮サービスから不正な応答が返りました。' };
  }
  return { code: 'unavailable', message: 'URLの短縮に失敗しました。' };
}

function createUrlShortenHandler(serviceProvider = () => urlService) {
  const getService = typeof serviceProvider === 'function' ? serviceProvider : () => serviceProvider;
  return async (event, input) => {
    requireTrustedSender(event);
    try {
      const service = getService();
      if (!service || typeof service.shorten !== 'function') {
        return { ok: false, error: serializeUrlShortenError({ code: 'unavailable' }) };
      }
      return await service.shorten(assertObject(input));
    } catch (error) {
      return { ok: false, error: serializeUrlShortenError(error) };
    }
  };
}

function installSecurityPolicy() {
  const defaultSession = session.defaultSession;
  defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => {
    callback({ cancel: true });
  });
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    headers['Content-Security-Policy'] = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'none'",
      "worker-src 'self' blob:",
      "frame-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'"
    ].join('; ');
    callback({ responseHeaders: headers });
  });
}

function createApplicationWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Kusunoki Desktop Tools',
    icon: path.join(RENDERER_DIRECTORY, 'app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    sendRendererEvent('navigation.open-view', { viewId: activeView }, mainWindow);
  });
  mainWindow.loadFile(path.join(RENDERER_DIRECTORY, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function importAssetsFromDialog({ dialogApi = dialog, store = assetStore, target = mainWindow } = {}) {
  let result;
  try {
    result = await dialogApi.showOpenDialog(target, {
      title: '素材をインポート',
      properties: ['openFile', 'multiSelections'],
      filters: MATERIAL_IMPORT_FILTERS
    });
  } catch (error) {
    const message = errorMessage(error, '素材のインポートダイアログを開けません。');
    dialogApi.showErrorBox?.('素材のインポートに失敗しました', message);
    sendNotification(message, 'error', target);
    return { status: 'error', count: 0, message };
  }
  if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) return { status: 'cancelled', count: 0 };
  try {
    if (!store || typeof store.importPaths !== 'function') throw new Error('素材ストアを利用できません。');
    const imported = await store.importPaths(result.filePaths);
    setActiveView('assets-view', target);
    sendRendererEvent('assets.changed', { action: 'import', count: imported.length }, target);
    sendNotification(`${imported.length}件の素材をインポートしました。`, 'success', target);
    return { status: 'imported', count: imported.length };
  } catch (error) {
    const message = errorMessage(error, '素材をインポートできません。');
    dialogApi.showErrorBox?.('素材のインポートに失敗しました', message);
    sendNotification(message, 'error', target);
    return { status: 'error', count: 0, message };
  }
}

async function exportAssetsToDialog({ dialogApi = dialog, store = assetStore, target = mainWindow } = {}) {
  try {
    if (!store || typeof store.exportArchive !== 'function') throw new Error('素材ストアを利用できません。');
    const listedAssets = typeof store.list === 'function' ? await store.list() : null;
    const archive = await store.exportArchive();
    if (!archive) {
      const message = 'エクスポートする素材がありません。';
      sendNotification(message, 'info', target);
      return { status: 'empty', count: 0 };
    }
    const result = await dialogApi.showSaveDialog(target, {
      title: '素材をエクスポート',
      defaultPath: 'kusunoki-materials.zip',
      filters: [{ name: '素材アーカイブ', extensions: ['zip'] }]
    });
    if (!result || result.canceled || !result.filePath) return { status: 'cancelled', count: 0 };
    await writeFileAtomic(result.filePath, archive);
    sendNotification('素材をエクスポートしました。', 'success', target);
    return { status: 'exported', count: Array.isArray(listedAssets) ? listedAssets.length : 0, filePath: result.filePath };
  } catch (error) {
    const message = errorMessage(error, '素材をエクスポートできません。');
    dialogApi.showErrorBox?.('素材のエクスポートに失敗しました', message);
    sendNotification(message, 'error', target);
    return { status: 'error', count: 0, message };
  }
}

function registerIpc() {
  if (registered) return;
  registered = true;
  ipcMain.handle('app.version', (event) => {
    requireTrustedSender(event);
    return app.getVersion();
  });
  ipcMain.on('navigation.active-view', (event, input) => {
    try {
      requireTrustedSender(event);
      const payload = assertObject(input);
      setActiveView(assertViewId(payload.viewId), event.sender, { notify: false });
    } catch {
      // One-way renderer notifications have no error channel by design.
    }
  });
  ipcMain.handle('qr.generate', async (event, input) => {
    requireTrustedSender(event);
    const payload = assertObject(input);
    const mode = assertQrMode(payload.mode);
    return generateQrByMode({ ...payload, mode }, path.resolve(__dirname, '..'));
  });
  ipcMain.handle('urls.shorten', createUrlShortenHandler());
  ipcMain.handle('urls.open-external', async (event, input) => {
    requireTrustedSender(event);
    const payload = assertObject(input);
    const url = assertHttpUrl(payload.url, '開くURL');
    await shell.openExternal(url);
    return { status: 'opened', url };
  });
  ipcMain.handle('assets.list', async (event) => {
    requireTrustedSender(event);
    return assetStore.list();
  });
  ipcMain.handle('assets.save', async (event, input) => {
    requireTrustedSender(event);
    const [saved] = await assetStore.saveBatch([assertObject(input)]);
    sendRendererEvent('assets.changed', { action: 'save', count: 1 }, event.sender);
    return saved;
  });
  ipcMain.handle('assets.read', async (event, input) => {
    requireTrustedSender(event);
    return assetStore.read(assertObject(input).id);
  });
  ipcMain.handle('assets.rename', async (event, input) => {
    requireTrustedSender(event);
    const payload = assertObject(input);
    const renamed = await assetStore.rename(payload.id, payload.name);
    sendRendererEvent('assets.changed', { action: 'rename', count: 1 }, event.sender);
    return renamed;
  });
  ipcMain.handle('assets.delete', async (event, input) => {
    requireTrustedSender(event);
    const deleted = await assetStore.delete(assertObject(input).id);
    sendRendererEvent('assets.changed', { action: 'delete', count: 1 }, event.sender);
    return deleted;
  });
  ipcMain.handle('pdf.process', async (event, input) => {
    requireTrustedSender(event);
    return processPdf(assertObject(input));
  });
  ipcMain.handle('updates.check', async (event) => {
    requireTrustedSender(event);
    return updateService.check();
  });
  ipcMain.handle('updates.install', (event) => {
    requireTrustedSender(event);
    return updateService.install();
  });
  ipcMain.handle('updates.open-installer', (event) => {
    requireTrustedSender(event);
    return updateService.openInstaller();
  });
  ipcMain.handle('updates.open-release', async (event) => {
    requireTrustedSender(event);
    await shell.openExternal(RELEASE_URL);
    return { status: 'opened' };
  });
}

function createMenuTemplate({
  version = app.getVersion(),
  onImport = () => { void importAssetsFromDialog(); },
  onExport = () => { void exportAssetsToDialog(); },
  onView = (viewId, browserWindow) => { setActiveView(viewId, browserWindow || mainWindow); },
  onUpdate = () => {},
  onRelease = () => shell.openExternal(RELEASE_URL)
} = {}) {
  return [
    {
      label: 'ファイル',
      submenu: [
        { label: '素材をインポート…', click: onImport },
        { label: '素材をエクスポート…', click: onExport },
        { type: 'separator' },
        { role: 'quit', label: '終了' }
      ]
    },
    {
      label: 'ツール',
      submenu: VIEW_DEFINITIONS.map((view) => ({
        id: `view-${view.id}`,
        label: view.label,
        type: 'radio',
        checked: view.id === activeView,
        accelerator: view.accelerator,
        click: (_menuItem, browserWindow) => onView(view.id, browserWindow)
      }))
    },
    {
      label: 'ヘルプ',
      submenu: [
        { label: '更新を確認', click: onUpdate },
        { type: 'separator' },
        { label: `Kusunoki Desktop Tools v${version}`, enabled: false },
        { label: 'Releaseページを開く', click: onRelease }
      ]
    }
  ];
}

function configureMenu() {
  const openUpdateDialog = () => {
    if (!mainWindow || mainWindow.isDestroyed?.()) createApplicationWindow();
    if (!mainWindow || mainWindow.isDestroyed?.()) return;
    if (mainWindow.isMinimized?.()) mainWindow.restore?.();
    mainWindow.show?.();
    mainWindow.focus?.();
    const sendRequest = () => {
      if (!mainWindow || mainWindow.isDestroyed?.()) return;
      mainWindow.webContents.send('updates.open-dialog');
    };
    if (mainWindow.webContents.isLoading?.() && typeof mainWindow.webContents.once === 'function') {
      mainWindow.webContents.once('did-finish-load', sendRequest);
    } else {
      sendRequest();
    }
  };
  const template = createMenuTemplate({ onUpdate: openUpdateDialog });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function start() {
  await app.whenReady();
  installSecurityPolicy();
  assetStore = new AssetStore(path.join(app.getPath('userData'), 'assets'));
  await assetStore.init();
  const { autoUpdater } = require('electron-updater');
  updateService = createUpdateService({ app, autoUpdater, dialog, shell });
  urlService = createUrlService();
  updateService.onEvent((event) => {
    if (!mainWindow || mainWindow.isDestroyed?.()) return;
    mainWindow.webContents.send('updates.status', event);
  });
  registerIpc();
  configureMenu();
  createApplicationWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createApplicationWindow();
  });
}

if (require.main === module) {
  start().catch((error) => {
    dialog.showErrorBox('起動エラー', error instanceof Error ? error.message : String(error));
    app.quit();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

module.exports = {
  ALLOWED_VIEW_IDS,
  MATERIAL_IMPORT_FILTERS,
  RELEASE_URL,
  RENDERER_DIRECTORY,
  VIEW_DEFINITIONS,
  assertObject,
  assertViewId,
  assertQrMode,
  assertHttpUrl,
  createMenuTemplate,
  createUrlShortenHandler,
  exportAssetsToDialog,
  getActiveView,
  importAssetsFromDialog,
  serializeUrlShortenError,
  setActiveView,
  writeFileAtomic,
  isTrustedSender,
  installSecurityPolicy
};
