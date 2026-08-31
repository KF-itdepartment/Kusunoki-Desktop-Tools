const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require('electron');
const { AssetStore } = require('./asset-store');
const { ALLOWED_QR_MODES, QR_MODES, generateQrByMode } = require('./qr-service');
const { processPdf } = require('./pdf-service');
const { createUpdateService } = require('./update-service');
const { createUrlService } = require('./url-service');

const RENDERER_DIRECTORY = path.resolve(__dirname, '..', 'renderer');
const RELEASE_URL = 'https://github.com/KF-itdepartment/Kusunoki-Desktop-Tools/releases';
let mainWindow;
let assetStore;
let updateService;
let urlService;
let registered = false;

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
  mainWindow.loadFile(path.join(RENDERER_DIRECTORY, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function registerIpc() {
  if (registered) return;
  registered = true;
  ipcMain.handle('app.version', (event) => {
    requireTrustedSender(event);
    return app.getVersion();
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
    return assetStore.save(assertObject(input));
  });
  ipcMain.handle('assets.read', async (event, input) => {
    requireTrustedSender(event);
    return assetStore.read(assertObject(input).id);
  });
  ipcMain.handle('assets.rename', async (event, input) => {
    requireTrustedSender(event);
    const payload = assertObject(input);
    return assetStore.rename(payload.id, payload.name);
  });
  ipcMain.handle('assets.delete', async (event, input) => {
    requireTrustedSender(event);
    return assetStore.delete(assertObject(input).id);
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
  const template = [
    {
      label: 'ファイル',
      submenu: [{ role: 'quit', label: '終了' }]
    },
    {
      label: 'ヘルプ',
      submenu: [
        { label: '更新を確認', click: openUpdateDialog },
        { type: 'separator' },
        { label: `Kusunoki Desktop Tools v${app.getVersion()}`, enabled: false },
        { label: 'Releaseページを開く', click: () => shell.openExternal(RELEASE_URL) }
      ]
    }
  ];
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
  RELEASE_URL,
  RENDERER_DIRECTORY,
  assertObject,
  assertQrMode,
  assertHttpUrl,
  createUrlShortenHandler,
  serializeUrlShortenError,
  isTrustedSender,
  installSecurityPolicy
};
