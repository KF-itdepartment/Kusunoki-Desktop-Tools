const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_VIEW_IDS = Object.freeze(['qr-view', 'pdf-view', 'pic-view', 'url-view', 'assets-view']);
const ALLOWED_VIEW_ID_SET = new Set(ALLOWED_VIEW_IDS);

function assertViewId(value) {
  if (typeof value !== 'string' || !ALLOWED_VIEW_ID_SET.has(value)) throw new TypeError('表示画面が不正です。');
  return value;
}

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

function subscribe(channel, listener) {
  if (typeof listener !== 'function') throw new TypeError('イベント購読関数が不正です。');
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

function subscribeView(listener) {
  return subscribe('navigation.open-view', (payload) => {
    try {
      listener({ viewId: assertViewId(payload?.viewId) });
    } catch {
      // Ignore malformed events from untrusted renderer messages.
    }
  });
}

function subscribeNotification(listener) {
  return subscribe('app.notification', (payload) => {
    if (!payload || typeof payload !== 'object' || typeof payload.message !== 'string') return;
    listener({ message: payload.message.slice(0, 240), kind: ['info', 'success', 'error'].includes(payload.kind) ? payload.kind : 'info' });
  });
}

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  app: Object.freeze({
    getVersion: () => invoke('app.version')
  }),
  navigation: Object.freeze({
    notifyActiveView: (viewId) => ipcRenderer.send('navigation.active-view', { viewId: assertViewId(viewId) }),
    onOpenView: (listener) => subscribeView(listener)
  }),
  events: Object.freeze({
    onAssetsChanged: (listener) => subscribe('assets.changed', listener),
    onNotification: (listener) => subscribeNotification(listener)
  }),
  qr: Object.freeze({
    generate: (payload) => invoke('qr.generate', payload)
  }),
  urls: Object.freeze({
    shorten: (payload) => invoke('urls.shorten', payload),
    openExternal: (url) => invoke('urls.open-external', { url })
  }),
  assets: Object.freeze({
    list: () => invoke('assets.list'),
    save: (payload) => invoke('assets.save', payload),
    read: (id) => invoke('assets.read', { id }),
    rename: (id, name) => invoke('assets.rename', { id, name }),
    delete: (id) => invoke('assets.delete', { id })
  }),
  pdf: Object.freeze({
    process: (payload) => invoke('pdf.process', payload)
  }),
  updates: Object.freeze({
    check: () => invoke('updates.check'),
    install: () => invoke('updates.install'),
    openInstaller: () => invoke('updates.open-installer'),
    openRelease: () => invoke('updates.open-release'),
    onStatus: (listener) => subscribe('updates.status', listener),
    onOpenRequested: (listener) => subscribe('updates.open-dialog', listener)
  })
}));
