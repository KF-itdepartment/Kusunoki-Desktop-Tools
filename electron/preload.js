const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

function subscribe(channel, listener) {
  if (typeof listener !== 'function') throw new TypeError('イベント購読関数が不正です。');
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  app: Object.freeze({
    getVersion: () => invoke('app.version')
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
