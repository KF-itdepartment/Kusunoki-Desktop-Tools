'use strict';

const RELEASE_URL = 'https://github.com/KF-itdepartment/Kusunoki-Desktop-Tools/releases';
const WINDOWS_INSTALLER_URL = 'https://github.com/KF-itdepartment/Kusunoki-Desktop-Tools/releases/latest/download/Kusunoki-Desktop-Tools-Setup.exe';

function normalizeVersion(value) {
  return String(value || '').replace(/^v/iu, '').trim();
}

function formatVersion(info) {
  return normalizeVersion(info?.version || info?.releaseName);
}

function releaseTagUrl(version) {
  const normalized = normalizeVersion(version);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(normalized)) {
    throw new TypeError('更新バージョンが不正です。');
  }
  return `https://github.com/KF-itdepartment/Kusunoki-Desktop-Tools/releases/tag/v${normalized}`;
}

function normalizePercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, percent));
}

function createUpdateService({ app, autoUpdater, shell, processPlatform = process.platform, logger = console } = {}) {
  if (!app || !autoUpdater || !shell) throw new TypeError('更新サービスの依存関係が不足しています。');

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  let checkingPromise = null;
  let installingPromise = null;
  let updateInfo = null;
  const listeners = new Set();
  const disabledPromise = Promise.resolve({ status: 'disabled' });
  let lastError = null;

  function logError(message, error) {
    if (typeof logger?.warn === 'function') logger.warn(message, error);
    else if (typeof logger?.error === 'function') logger.error(message, error);
  }

  function notify(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        logError('更新イベントの通知に失敗しました。', error);
      }
    }
  }

  function notifyError(message, error) {
    if (error && error === lastError) return;
    lastError = error || null;
    logError(message, error);
    if (error) {
      Promise.resolve().then(() => {
        if (lastError === error) lastError = null;
      });
    }
    notify({ type: 'error' });
  }

  // checkForUpdates() is the single source of truth. In particular, an
  // update-available event must never start a second dialog or install flow.
  if (typeof autoUpdater.on === 'function') {
    autoUpdater.on('download-progress', (progress) => {
      notify({ type: 'progress', percent: normalizePercent(progress?.percent) });
    });
    autoUpdater.on('error', (error) => {
      notifyError('更新処理に失敗しました。', error);
    });
  }

  function onEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('更新イベントの購読先が不正です。');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function check() {
    if (!app.isPackaged) return disabledPromise;
    if (checkingPromise) return checkingPromise;

    checkingPromise = (async () => {
      updateInfo = null;
      try {
        const result = await autoUpdater.checkForUpdates();
        const info = result?.updateInfo;
        const version = formatVersion(info);
        const currentVersion = normalizeVersion(app.getVersion?.());
        if (!info || !version || version === currentVersion) return { status: 'none' };
        updateInfo = info;
        return {
          status: 'available',
          version,
          mode: processPlatform === 'darwin' ? 'manual' : 'automatic'
        };
      } catch (error) {
        notifyError('更新確認に失敗しました。', error);
        updateInfo = null;
        return { status: 'error' };
      } finally {
        checkingPromise = null;
      }
    })();
    return checkingPromise;
  }

  function install() {
    if (!app.isPackaged) return disabledPromise;
    if (installingPromise) return installingPromise;

    installingPromise = (async () => {
      if (!updateInfo) {
        notify({ type: 'error' });
        return { status: 'error' };
      }
      const version = formatVersion(updateInfo);
      try {
        if (processPlatform === 'darwin') {
          await shell.openExternal(releaseTagUrl(version));
          return { status: 'manual' };
        }

        notify({ type: 'downloading' });
        await autoUpdater.downloadUpdate();
        notify({ type: 'installing' });
        await autoUpdater.quitAndInstall(false, true);
        return { status: 'installing' };
      } catch (error) {
        notifyError('更新の適用に失敗しました。', error);
        return { status: 'error' };
      } finally {
        installingPromise = null;
      }
    })();
    return installingPromise;
  }

  async function openInstaller() {
    try {
      await shell.openExternal(WINDOWS_INSTALLER_URL);
      return { status: 'opened' };
    } catch (error) {
      notifyError('インストーラーのダウンロードページを開けませんでした。', error);
      return { status: 'error' };
    }
  }

  return {
    check,
    install,
    openInstaller,
    onEvent,
    getUpdateInfo: () => updateInfo
  };
}

module.exports = {
  RELEASE_URL,
  WINDOWS_INSTALLER_URL,
  createUpdateService,
  formatVersion,
  normalizePercent,
  releaseTagUrl
};
