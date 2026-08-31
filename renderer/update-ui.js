'use strict';

(() => {
  const STATUS = Object.freeze({
    CHECKING: 'checking',
    DISABLED: 'disabled',
    NONE: 'none',
    AVAILABLE: 'available',
    DOWNLOADING: 'downloading',
    INSTALLING: 'installing',
    ERROR: 'error'
  });
  const statuses = new Set(Object.values(STATUS));

  function normalizeStatus(value) {
    const status = String(value || '').toLowerCase();
    if (status === 'progress') return STATUS.DOWNLOADING;
    return statuses.has(status) ? status : STATUS.ERROR;
  }

  function normalizePercent(value) {
    const percent = Number(value);
    if (!Number.isFinite(percent)) return 0;
    return Math.max(0, Math.min(100, percent));
  }

  // Startup checks are intentionally silent unless a newer release exists.
  // Keep this decision separate from the view-model so an updater error (or a
  // development build's disabled result) can never open a dialog by accident.
  function shouldShowAutomaticDialog(result) {
    return normalizeStatus(result?.status) === STATUS.AVAILABLE;
  }

  // Keep one in-flight check for both startup and user-triggered requests.
  // Callers receive a sanitized error result, while the original exception
  // remains available only to the caller's private logging path (if any).
  function createUpdateCheckCoordinator(check, callbacks = {}) {
    if (typeof check !== 'function') throw new TypeError('更新確認関数が不正です。');
    const onStart = typeof callbacks.onStart === 'function' ? callbacks.onStart : () => {};
    const onResult = typeof callbacks.onResult === 'function' ? callbacks.onResult : () => {};
    const onFinally = typeof callbacks.onFinally === 'function' ? callbacks.onFinally : () => {};
    let activePromise = null;

    function run(options = {}) {
      const automatic = options?.automatic === true;
      if (activePromise) {
        if (!automatic) onStart({ automatic: false, shared: true });
        return activePromise;
      }
      if (!automatic) onStart({ automatic: false, shared: false });

      let request;
      try {
        request = check();
      } catch {
        request = Promise.reject(new Error('update-check-failed'));
      }
      const current = Promise.resolve(request)
        .then((result) => {
          onResult(result, { automatic });
          return result;
        })
        .catch(() => {
          const result = { status: STATUS.ERROR };
          onResult(result, { automatic });
          return result;
        })
        .finally(() => {
          if (activePromise === current) activePromise = null;
          onFinally({ automatic });
        });
      activePromise = current;
      return current;
    }

    return Object.freeze({ run, getPromise: () => activePromise });
  }

  function versionText(value) {
    const version = String(value || '').trim().replace(/^v/iu, '');
    return version || '—';
  }

  function action(label, name) {
    return { label, action: name };
  }

  function createUpdateViewModel(input = {}, context = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const type = source.type === 'progress' ? STATUS.DOWNLOADING : source.type;
    const status = normalizeStatus(source.status || type);
    const currentVersion = versionText(source.currentVersion ?? context.currentVersion);
    const latestVersion = versionText(source.version ?? source.latestVersion ?? context.latestVersion);
    const percent = normalizePercent(source.percent ?? context.percent);
    const automatic = source.mode !== 'manual';
    const base = {
      status,
      title: '更新',
      description: '',
      currentVersion,
      latestVersion,
      percent,
      progressLabel: `${Math.round(percent)}%`,
      showProgress: false,
      canClose: true,
      primary: null,
      secondary: null,
      fallback: null,
      ariaLive: ''
    };

    switch (status) {
      case STATUS.CHECKING:
        base.title = '更新を確認中';
        base.description = '新しいバージョンがあるか確認しています';
        break;
      case STATUS.DISABLED:
        base.title = '更新を確認できません';
        base.description = 'この開発版では更新できません。インストール済みの配布版で確認してください';
        break;
      case STATUS.NONE:
        base.title = '更新はありません';
        base.description = 'このアプリは最新版です';
        break;
      case STATUS.AVAILABLE:
        base.title = '新しいバージョンがあります';
        base.description = `現在のバージョン: ${currentVersion} / 最新バージョン: ${latestVersion}`;
        base.primary = automatic
          ? action('今すぐ更新', 'install')
          : action('ダウンロードページを開く', 'install');
        base.secondary = action('あとで', 'close');
        break;
      case STATUS.DOWNLOADING:
        base.title = '更新をダウンロード中';
        base.description = 'ダウンロードしています。そのままお待ちください';
        base.showProgress = true;
        base.canClose = false;
        break;
      case STATUS.INSTALLING:
        base.title = '更新を準備中';
        base.description = '更新を準備しています。アプリは自動で再起動します';
        base.showProgress = true;
        base.canClose = false;
        base.percent = 100;
        base.progressLabel = '100%';
        break;
      case STATUS.ERROR:
      default:
        base.status = STATUS.ERROR;
        base.title = '更新できませんでした';
        base.description = '更新できませんでした。インターネット接続を確認して、もう一度お試しください';
        base.primary = action('もう一度確認', 'check');
        base.fallback = automatic
          ? action('インストーラーをダウンロード', 'open-installer')
          : action('Releaseページを開く', 'open-release');
        break;
    }
    base.ariaLive = base.description;
    return base;
  }

  const api = Object.freeze({
    STATUS,
    normalizeStatus,
    normalizePercent,
    shouldShowAutomaticDialog,
    createUpdateCheckCoordinator,
    createUpdateViewModel,
    getUpdateViewModel: createUpdateViewModel,
    stateToViewModel: createUpdateViewModel
  });

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof globalThis === 'object') globalThis.KusunokiUpdateUI = api;
})();
