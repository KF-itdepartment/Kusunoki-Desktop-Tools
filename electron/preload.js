const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  app: Object.freeze({
    getVersion: () => invoke('app.version')
  }),
  qr: Object.freeze({
    generate: (payload) => invoke('qr.generate', payload)
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
    download: () => invoke('updates.download'),
    install: () => invoke('updates.install'),
    openRelease: () => invoke('updates.open-release'),
    releaseUrl: () => invoke('updates.release-url')
  })
}));
