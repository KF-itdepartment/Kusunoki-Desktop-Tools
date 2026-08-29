const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require('electron');
const { AssetStore } = require('./asset-store');
const { generateQr } = require('./qr-service');
const { processPdf } = require('./pdf-service');
const { createUpdateService } = require('./update-service');

const RENDERER_DIRECTORY = path.resolve(__dirname, '..', 'renderer');
const RELEASE_URL = 'https://github.com/KF-itdepartment/Kusunoki-Desktop-Tools/releases';
let mainWindow;
let assetStore;
let updateService;
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
    return generateQr(payload, path.resolve(__dirname, '..'));
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
  isTrustedSender,
  installSecurityPolicy
};
