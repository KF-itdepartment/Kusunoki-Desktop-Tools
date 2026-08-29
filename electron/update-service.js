const RELEASE_URL = 'https://github.com/KF-itdepartment/Kusunoki-Desktop-Tools/releases';

function releaseTagUrl(version) {
  const normalized = String(version || '').replace(/^v/iu, '').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(normalized)) {
    throw new TypeError('更新バージョンが不正です。');
  }
  return `https://github.com/KF-itdepartment/Kusunoki-Desktop-Tools/releases/tag/v${normalized}`;
}

function formatVersion(info) {
  return String(info?.version || info?.releaseName || '').replace(/^v/iu, '') || '不明';
}

function createUpdateService({ app, autoUpdater, dialog, shell, processPlatform = process.platform, logger = console } = {}) {
  if (!app || !autoUpdater || !dialog || !shell) throw new TypeError('更新サービスの依存関係が不足しています。');
  let refusedThisLaunch = false;
  let lastProgress = null;
  const listeners = new Set();
  const promptedVersions = new Set();

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  const notify = (event) => {
    lastProgress = event;
    for (const listener of listeners) listener(event);
  };
  autoUpdater.on?.('download-progress', (progress) => notify({ type: 'progress', percent: progress.percent, transferred: progress.transferred, total: progress.total }));
  autoUpdater.on?.('update-downloaded', (info) => notify({ type: 'downloaded', version: formatVersion(info) }));
  autoUpdater.on?.('update-available', (info) => { void askOnce(info); });
  autoUpdater.on?.('error', (error) => {
    logger.warn?.('更新確認に失敗しました:', error);
    notify({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  });

  async function ask(info) {
    const version = formatVersion(info);
    const answer = await dialog.showMessageBox({
      type: 'info',
      title: '更新があります',
      message: `新しいバージョン ${version} に更新しますか？`,
      detail: processPlatform === 'darwin'
        ? 'macOS版はGitHub Releaseからダウンロードします。'
        : 'ダウンロード後、アプリを再起動して適用します。',
      buttons: ['はい', 'いいえ'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (answer.response !== 0) {
      refusedThisLaunch = true;
      notify({ type: 'refused', version });
      return { status: 'refused', version };
    }
    if (processPlatform === 'darwin') {
      const url = releaseTagUrl(version);
      await shell.openExternal(url);
      notify({ type: 'manual', version, url });
      return { status: 'manual', version, url };
    }
    try {
      notify({ type: 'downloading', version });
      await autoUpdater.downloadUpdate();
      notify({ type: 'installing', version });
      autoUpdater.quitAndInstall(false, true);
      return { status: 'installing', version };
    } catch (error) {
      logger.warn?.('更新ダウンロードに失敗しました:', error);
      notify({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      return { status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  async function askOnce(info) {
    const version = formatVersion(info);
    if (!version || promptedVersions.has(version)) return { status: 'skipped', version };
    promptedVersions.add(version);
    return ask(info);
  }

  async function check() {
    if (!app.isPackaged) return { status: 'disabled', reason: 'development' };
    if (refusedThisLaunch) return { status: 'skipped', reason: 'refused-this-launch' };
    try {
      const result = await autoUpdater.checkForUpdates();
      const info = result?.updateInfo;
      if (!info || !info.version || info.version === app.getVersion?.()) return { status: 'none' };
      return askOnce(info);
    } catch (error) {
      logger.warn?.('更新確認に失敗しました:', error);
      return { status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  function onEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('更新イベント購読関数が不正です。');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    check,
    getLastProgress: () => lastProgress,
    onEvent,
    releaseUrl: RELEASE_URL
  };
}

module.exports = { RELEASE_URL, createUpdateService, formatVersion, releaseTagUrl };
