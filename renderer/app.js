(() => {
  'use strict';

  const desktop = window.desktop;
  const generated = window.KusunokiGeneratedUpstream;
  if (!generated) throw new Error('Generated upstream adapter is required.');
  const urlUtils = window.KusunokiUrlUtils;
  if (!urlUtils) throw new Error('URL utility module is required.');
  const updateUi = window.KusunokiUpdateUI;
  if (!updateUi) throw new Error('Update UI module is required.');
  const state = {
    view: 'qr-view',
    qr: null,
    qrMode: 'online',
    qrModeReason: '',
    qrBusy: false,
    qrLogo: null,
    qrAngle: 315,
    batchInputMode: 'legacy',
    batchRunning: false,
    batchFileLoading: false,
    csvReadToken: 0,
    pdfFiles: [],
    pendingWatermark: null,
    watermarkFile: null,
    lastPdf: null,
    objectUrls: new Set(),
    draggedPdfIndex: null,
    pdfFrameReady: false,
    urlBusy: false,
    urlLongUrl: '',
    urlShortUrl: '',
    urlRequestPromise: null,
    update: { status: 'checking', currentVersion: '', latestVersion: '', version: '', mode: 'automatic', percent: 0 },
    updateCheckPromise: null,
    updateInstallPromise: null,
    updateInstallerPromise: null,
    updateReleasePromise: null
  };

  const $ = (id) => document.getElementById(id);
  const navButtons = [...document.querySelectorAll('.nav-button')];
  const views = [...document.querySelectorAll('.view')];
  const qrModeButtons = [...document.querySelectorAll('[data-qr-mode]')];

  function setStatus(id, message, error = false) {
    const element = $(id);
    element.textContent = message || '';
    element.classList.toggle('error', error);
  }

  function renderQrMode() {
    qrModeButtons.forEach((button) => {
      const selected = button.dataset.qrMode === state.qrMode;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = state.qrBusy || state.batchRunning;
    });
    const status = $('qr-mode-state');
    if (!status) return;
    status.textContent = state.qrModeReason
      ? `オフライン（${state.qrModeReason}）`
      : state.qrMode === 'online' ? 'オンラインAPIを使用' : 'ローカル生成を使用';
  }

  function setQrMode(mode, reason = '') {
    if (mode !== 'online' && mode !== 'offline') return false;
    state.qrMode = mode;
    state.qrModeReason = mode === 'offline' ? String(reason || '') : '';
    renderQrMode();
    return true;
  }

  function selectQrMode(mode) {
    if (state.qrBusy || state.batchRunning) return;
    if (!setQrMode(mode)) return;
    const message = mode === 'online'
      ? 'オンラインAPIで生成します。'
      : 'ローカルで生成します。通信は行いません。';
    setStatus('qr-status', message);
    setStatus('batch-status', message);
  }

  function onlineFailureReason(error) {
    const code = String(error?.code || '');
    const message = String(error?.message || '');
    if (code === 'timeout') return 'タイムアウト';
    if (code === 'http') return Number.isFinite(Number(error?.status)) ? `HTTP ${Number(error.status)}` : 'HTTPエラー';
    if (code === 'content-type') return '応答形式不正';
    if (code === 'empty') return '空の応答';
    if (code === 'too-large' || code === 'request-too-large') return '応答サイズ超過';
    if (code === 'invalid-svg') return 'SVG不正';
    if (/タイムアウト/u.test(message)) return 'タイムアウト';
    if (/HTTP\s+\d+/iu.test(message)) return `HTTP ${message.match(/HTTP\s+(\d+)/iu)[1]}`;
    if (/応答形式/u.test(message)) return '応答形式不正';
    if (/空の画像|空の応答/u.test(message)) return '空の応答';
    if (/大きすぎ|サイズ超過/u.test(message)) return '応答サイズ超過';
    if (/壊れたSVG|SVG.*不正/u.test(message)) return 'SVG不正';
    return '接続エラー';
  }

  function setView(viewId) {
    if (!views.some((view) => view.id === viewId)) return;
    state.view = viewId;
    views.forEach((view) => { view.hidden = view.id !== viewId; view.classList.toggle('active', view.id === viewId); });
    navButtons.forEach((button) => button.classList.toggle('active', button.dataset.view === viewId));
    if (viewId === 'assets-view') void loadAssets();
  }

  navButtons.forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));

  function setupTabs() {
    const tabs = [$('single-tab'), $('batch-tab')];
    const panels = [$('qr-single'), $('qr-batch')];
    const select = (index, focus = false) => {
      tabs.forEach((tab, tabIndex) => { const selected = tabIndex === index; tab.classList.toggle('active', selected); tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; panels[tabIndex].hidden = !selected; });
      if (focus) tabs[index].focus();
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => select(index));
      tab.addEventListener('keydown', (event) => {
        let next = null;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + tabs.length - 1) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(index); return; }
        if (next !== null) { event.preventDefault(); select(next, true); }
      });
    });
  }

  function setUrlResults(longUrl = '', shortUrl = '') {
    state.urlLongUrl = String(longUrl || '');
    state.urlShortUrl = String(shortUrl || '');
    const longElement = $('long-url');
    const shortElement = $('short-url');
    if (longElement) longElement.textContent = state.urlLongUrl || '未生成';
    if (shortElement) shortElement.textContent = state.urlShortUrl || '未生成';
    [['copy-long-url', state.urlLongUrl], ['open-long-url', state.urlLongUrl], ['qr-long-url', state.urlLongUrl], ['copy-short-url', state.urlShortUrl], ['open-short-url', state.urlShortUrl], ['qr-short-url', state.urlShortUrl]].forEach(([id, value]) => {
      const button = $(id);
      if (button) button.disabled = !value;
    });
  }

  function urlErrorMessage(error) {
    const code = String(error?.code || '');
    if (code === 'timeout') return '短縮サービスへの接続がタイムアウトしました。';
    if (code === 'network') return '短縮サービスに接続できませんでした。';
    if (code === 'content-type' || code === 'invalid-json' || code === 'invalid-response' || code === 'response-read' || code === 'too-large') return '短縮サービスから不正な応答が返りました。';
    if (code === 'http') {
      const status = Number(error?.status);
      if (status === 400) return '短縮するURLまたは短縮IDを確認してください。';
      if (status === 401 || status === 403) return '短縮サービスを利用できません。';
      if (status === 409) return 'その短縮IDは既に使用されています。';
      if (status === 429) return '短縮サービスの利用が集中しています。しばらく待って再試行してください。';
      if (status === 500 || status === 503) return '短縮サービスが一時的に利用できません。';
      return 'URLの短縮に失敗しました。';
    }
    return 'URLの短縮に失敗しました。';
  }

  function unwrapUrlShortenResult(result) {
    if (!result || result.ok !== false) return result;
    const details = result.error && typeof result.error === 'object' ? result.error : {};
    const error = new Error('URLの短縮に失敗しました。');
    error.code = String(details.code || 'unavailable');
    const status = Number(details.status);
    if (Number.isInteger(status)) error.status = status;
    throw error;
  }

  async function copyUrl(value) {
    const text = String(value || '');
    if (!text) return;
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('クリップボードを利用できません。');
    await navigator.clipboard.writeText(text);
    setStatus('url-status', 'URLをクリップボードにコピーしました。');
  }

  async function openUrlExternal(value) {
    const text = String(value || '');
    if (!text) return;
    try {
      await desktop.urls.openExternal(text);
      setStatus('url-status', '外部ブラウザでURLを開きました。');
    } catch {
      setStatus('url-status', 'URLを外部ブラウザで開けません。', true);
    }
  }

  function handoffUrlToQr(value) {
    const text = String(value || '');
    if (!text) return;
    $('qr-text').value = text;
    setView('qr-view');
    void generateQr();
  }

  function toggleUrlCustomField(select, wrapper, input) {
    const isOther = select?.value === 'other';
    if (wrapper) wrapper.hidden = !isOther;
    if (input) {
      input.required = isOther;
      if (!isOther) input.value = '';
    }
  }

  function populateUrlSelect(select, options) {
    if (!select) return;
    select.replaceChildren();
    options.forEach((option) => {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      select.append(element);
    });
  }

  function resetUrlForm() {
    if (state.urlBusy) return;
    const form = $('url-form');
    form?.reset();
    $('base-url').value = urlUtils.DEFAULTS.baseUrl;
    $('utm-source').value = urlUtils.DEFAULTS.source;
    $('utm-medium').value = urlUtils.DEFAULTS.medium;
    $('utm-campaign').value = urlUtils.DEFAULTS.campaign;
    $('shortid').value = '';
    toggleUrlCustomField($('utm-source'), $('source-custom-wrap'), $('utm-source-custom'));
    toggleUrlCustomField($('utm-medium'), $('medium-custom-wrap'), $('utm-medium-custom'));
    setUrlResults();
    setStatus('url-status', '入力を初期化しました。');
  }

  async function generateUrl() {
    if (state.urlBusy) return state.urlRequestPromise;
    const button = $('url-generate-btn');
    state.urlBusy = true;
    if (button) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    }
    const request = (async () => {
      let longUrl;
      try {
        const shortid = urlUtils.validateShortid($('shortid').value);
        longUrl = urlUtils.buildUtmUrl($('base-url').value, {
          source: $('utm-source').value,
          sourceCustom: $('utm-source-custom').value,
          medium: $('utm-medium').value,
          mediumCustom: $('utm-medium-custom').value,
          campaign: $('utm-campaign').value
        });
        // Render the local result before contacting the Worker so it remains
        // available even when shortening fails or times out.
        setUrlResults(longUrl, '');
        setStatus('url-status', '長いURLを生成しました。短縮しています…');
        const shortened = unwrapUrlShortenResult(await desktop.urls.shorten({ longUrl, shortid }));
        if (!shortened || shortened.originalUrl !== longUrl || typeof shortened.shortUrl !== 'string') throw new Error('短縮サービスから不正な応答が返りました。');
        setUrlResults(longUrl, shortened.shortUrl);
        setStatus('url-status', 'URLを生成して短縮しました。');
        return shortened;
      } catch (error) {
        if (longUrl) {
          setUrlResults(longUrl, '');
          setStatus('url-status', `${urlErrorMessage(error)} 長いURLはそのまま利用できます。`, true);
        } else {
          setUrlResults('', '');
          setStatus('url-status', error instanceof Error ? error.message : '入力内容を確認してください。', true);
        }
        return null;
      }
    })();
    state.urlRequestPromise = request;
    try {
      return await request;
    } finally {
      if (state.urlRequestPromise === request) state.urlRequestPromise = null;
      state.urlBusy = false;
      if (button) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
      setUrlResults(state.urlLongUrl, state.urlShortUrl);
    }
  }

  function setupUrlGenerator() {
    const source = $('utm-source');
    const medium = $('utm-medium');
    populateUrlSelect(source, urlUtils.sourceOptions);
    populateUrlSelect(medium, urlUtils.mediumOptions);
    source.value = urlUtils.DEFAULTS.source;
    medium.value = urlUtils.DEFAULTS.medium;
    $('base-url').value = urlUtils.DEFAULTS.baseUrl;
    $('utm-campaign').value = urlUtils.DEFAULTS.campaign;
    source.addEventListener('change', () => toggleUrlCustomField(source, $('source-custom-wrap'), $('utm-source-custom')));
    medium.addEventListener('change', () => toggleUrlCustomField(medium, $('medium-custom-wrap'), $('utm-medium-custom')));
    toggleUrlCustomField(source, $('source-custom-wrap'), $('utm-source-custom'));
    toggleUrlCustomField(medium, $('medium-custom-wrap'), $('utm-medium-custom'));
    $('url-form').addEventListener('submit', (event) => { event.preventDefault(); void generateUrl(); });
    $('url-reset-btn').addEventListener('click', resetUrlForm);
    [['copy-long-url', () => copyUrl(state.urlLongUrl)], ['copy-short-url', () => copyUrl(state.urlShortUrl)], ['open-long-url', () => openUrlExternal(state.urlLongUrl)], ['open-short-url', () => openUrlExternal(state.urlShortUrl)], ['qr-long-url', () => handoffUrlToQr(state.urlLongUrl)], ['qr-short-url', () => handoffUrlToQr(state.urlShortUrl)]].forEach(([id, action]) => $(id)?.addEventListener('click', () => { if (!$(id).disabled) void Promise.resolve(action()).catch((error) => setStatus('url-status', error instanceof Error ? error.message : 'URL操作に失敗しました。', true)); }));
    setUrlResults();
    setStatus('url-status', 'base URLとUTMを入力してURLを生成してください。');
  }

  function bytesToBase64(bytes) {
    const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let result = '';
    const chunk = 0x8000;
    for (let index = 0; index < value.length; index += chunk) result += String.fromCharCode(...value.subarray(index, index + chunk));
    return btoa(result);
  }

  function bytesToDataUrl(bytes, mimeType) { return `data:${mimeType};base64,${bytesToBase64(bytes)}`; }
  async function readFileBytes(file) { return new Uint8Array(await file.arrayBuffer()); }

  async function svgToPng(svg) {
    const image = new Image();
    const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('SVGをPNGに変換できませんでした。')); image.src = source; });
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth || 400; canvas.height = image.naturalHeight || 400;
    const context = canvas.getContext('2d'); if (!context) throw new Error('画像キャンバスを作成できません。');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNGを作成できませんでした。');
    return new Uint8Array(await blob.arrayBuffer());
  }

  function safeDownloadName(value, extension) {
    let stem = String(value || '').trim().replace(/[\u0000-\u001f<>:"/\\|?*]/gu, '_').replace(/\.[^.]*$/u, '').replace(/[. ]+$/u, '');
    if (!stem) stem = 'qr_code';
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu.test(stem)) stem = `_${stem}`;
    return `${[...stem].slice(0, 230).join('')}.${extension}`;
  }

  function downloadBytes(data, fileName, mimeType) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob); state.objectUrls.add(url);
    const link = document.createElement('a'); link.href = url; link.download = fileName; link.rel = 'noopener'; document.body.append(link); link.click(); link.remove();
    setTimeout(() => { URL.revokeObjectURL(url); state.objectUrls.delete(url); }, 1000);
  }

  function setQrResult(result) {
    state.qr = result;
    const image = $('qr-image'); image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}`; image.hidden = false; $('qr-placeholder').hidden = true;
    $('download-btn').disabled = false; $('save-asset-btn').disabled = false; $('use-pdf-btn').disabled = false;
  }

  async function generateQr() {
    if (state.qrBusy || state.batchRunning) return;
    const text = $('qr-text').value.trim();
    if (!text) { setStatus('qr-status', '文字列を入力してください。', true); return; }
    const button = $('generate-btn'); button.disabled = true; setStatus('qr-status', '生成中…');
    state.qrBusy = true;
    renderQrMode();
    const payload = { text, logoDataUrl: $('no-logo-check').checked ? null : state.qrLogo, angle: state.qrAngle, noLogo: $('no-logo-check').checked };
    const requestedMode = state.qrMode;
    try {
      const result = await desktop.qr.generate({ ...payload, mode: requestedMode });
      setQrResult(result);
      setStatus('qr-status', requestedMode === 'online' ? 'オンラインAPIで生成しました。' : 'ローカルで生成しました。');
    } catch (error) {
      if (requestedMode !== 'online') {
        setStatus('qr-status', error instanceof Error ? error.message : 'QR生成に失敗しました。', true);
      } else {
        const reason = onlineFailureReason(error);
        setQrMode('offline', `オンラインAPI失敗: ${reason}`);
        try {
          const result = await desktop.qr.generate({ ...payload, mode: 'offline' });
          setQrResult(result);
          setStatus('qr-status', `オンラインAPIに失敗したため、ローカルで再生成しました。以降はオフラインです（${reason}）。`);
        } catch (fallbackError) {
          setStatus('qr-status', fallbackError instanceof Error ? fallbackError.message : 'ローカルQR生成に失敗しました。', true);
        }
      }
    }
    finally {
      state.qrBusy = false;
      button.disabled = false;
      renderQrMode();
      updateBatchControls();
    }
  }

  async function selectedQrBytes() {
    if (!state.qr) throw new Error('先にQRコードを生成してください。');
    if ($('download-format').value === 'svg') return { data: new TextEncoder().encode(state.qr.svg), mimeType: 'image/svg+xml', extension: 'svg' };
    return { data: await svgToPng(state.qr.svg), mimeType: 'image/png', extension: 'png' };
  }

  async function saveQr() {
    try { const output = await selectedQrBytes(); downloadBytes(output.data, safeDownloadName($('name-text').value, output.extension), output.mimeType); setStatus('qr-status', '画像を保存しました。'); }
    catch (error) { setStatus('qr-status', error instanceof Error ? error.message : '保存に失敗しました。', true); }
  }

  async function saveQrAsset() {
    try {
      const output = await selectedQrBytes();
      await desktop.assets.save({ name: $('name-text').value || 'QR素材', text: state.qr.text, mimeType: output.mimeType, fileName: safeDownloadName($('name-text').value || 'qr_code', output.extension), data: output.data });
      setStatus('qr-status', '素材トレイに保存しました。');
    } catch (error) { setStatus('qr-status', error instanceof Error ? error.message : '素材の保存に失敗しました。', true); }
  }

  async function useQrInPdf() {
    try {
      if (!state.qr) throw new Error('先にQRコードを生成してください。');
      const data = await svgToPng(state.qr.svg);
      state.pendingWatermark = generated.qr.createPdfHandoff(data, state.qr.text);
      setView('pdf-view'); sendPendingWatermark(); if (!state.pdfFrameReady) setStatus('pdf-frame-status', 'PDFエディターの準備後にQRコードを設定します。');
    } catch (error) { setStatus('qr-status', error instanceof Error ? error.message : 'PDFへの受渡しに失敗しました。', true); }
  }

  async function handleLogo(event) {
    const file = event.target.files?.[0]; if (!file) return;
    try { const bytes = await readFileBytes(file); state.qrLogo = bytesToDataUrl(bytes, file.type); state.qrAngle = 0; $('angle-display').textContent = '0'; await generateQr(); }
    catch (error) { setStatus('qr-status', error instanceof Error ? error.message : 'ロゴを読み込めません。', true); }
  }

  function postPdfFrameMessage(message) {
    const frame = $('pdf-editor-frame');
    if (!frame?.contentWindow) throw new Error('PDFエディターを読み込めません。');
    const transfer = message?.payload?.data instanceof ArrayBuffer ? [message.payload.data] : [];
    frame.contentWindow.postMessage(message, '*', transfer);
  }

  function sendPendingWatermark() {
    if (!state.pendingWatermark || !state.pdfFrameReady) return;
    try {
      postPdfFrameMessage(generated.pdfFrame.createWatermarkMessage(state.pendingWatermark));
      setStatus('pdf-frame-status', 'QRコードをウォーターマークに設定しています…');
    } catch (error) {
      setStatus('pdf-frame-status', error instanceof Error ? error.message : 'PDFへの受渡しに失敗しました。', true);
    }
  }

  function handlePdfFrameMessage(event) {
    const frame = $('pdf-editor-frame');
    const message = generated.pdfFrame.validateMessage(event, frame?.contentWindow);
    if (!message) return;
    if (message.type === generated.pdfFrame.types.ready && message.payload.source !== 'generated/upstream/pdf') return;
    if (message.type === generated.pdfFrame.types.ready) {
      state.pdfFrameReady = true;
      document.documentElement.dataset.pdfFrameReady = 'true';
      setStatus('pdf-frame-status', '上流PDFエディターを利用できます。');
      sendPendingWatermark();
    } else if (message.type === generated.pdfFrame.types.applied) {
      state.pendingWatermark = null;
      setStatus('pdf-frame-status', `ウォーターマークを設定しました: ${message.payload.fileName}`);
    } else if (message.type === generated.pdfFrame.types.error) {
      setStatus('pdf-frame-status', message.payload.message || 'PDFへの受渡しに失敗しました。', true);
    }
  }

  function setupPdfFrame() {
    const frame = $('pdf-editor-frame');
    if (!frame) return;
    const ping = () => {
      if (!frame.contentWindow || state.pdfFrameReady) return;
      try { postPdfFrameMessage(generated.pdfFrame.createPing()); } catch { /* frame may still be navigating */ }
    };
    frame.addEventListener('load', () => {
      state.pdfFrameReady = false;
      document.documentElement.dataset.pdfFrameReady = 'false';
      setStatus('pdf-frame-status', '上流PDFエディターを読み込んでいます…');
      ping();
    });
    window.addEventListener('message', handlePdfFrameMessage);
    // The iframe can finish loading while the parent is still parsing local
    // scripts. A one-time ping after listener registration closes that race
    // without allowing any network access or changing the frame contract.
    ping();
  }

  function renderBatchErrors(errors) {
    const element = $('batch-errors'); element.replaceChildren();
    if (!errors.length) { element.hidden = true; return; }
    const list = document.createElement('ul');
    errors.forEach((error) => { const item = document.createElement('li'); item.textContent = `${error.line ? `${error.line}行目: ` : ''}${error.reason}`; list.append(item); });
    element.append(list); element.hidden = false;
  }

  function setBatchInputMode(mode) {
    if (state.qrBusy || state.batchRunning || state.batchFileLoading) return;
    state.batchInputMode = mode === 'csv' ? 'csv' : 'legacy';
    const csvSelected = state.batchInputMode === 'csv';
    document.querySelectorAll('input[name="batch-input-mode"]').forEach((input) => {
      input.checked = input.value === state.batchInputMode;
    });
    const legacy = $('batch-legacy-panel');
    const csv = $('batch-csv-panel');
    if (legacy) {
      legacy.hidden = csvSelected;
      legacy.setAttribute('aria-hidden', String(csvSelected));
    }
    if (csv) {
      csv.hidden = !csvSelected;
      csv.setAttribute('aria-hidden', String(!csvSelected));
    }
    renderBatchErrors([]);
    updateBatchControls();
  }

  function updateBatchControls() {
    const unavailable = state.qrBusy || state.batchRunning || state.batchFileLoading;
    const legacyInactive = unavailable || state.batchInputMode !== 'legacy';
    const csvInactive = unavailable || state.batchInputMode !== 'csv';
    document.querySelectorAll('input[name="batch-input-mode"]').forEach((input) => { input.disabled = unavailable; });
    const batchPanel = $('qr-batch');
    const button = $('batch-generate-btn');
    if (button) {
      button.disabled = unavailable;
      button.setAttribute('aria-busy', String(unavailable));
      button.textContent = state.batchRunning ? '生成中…' : state.batchFileLoading ? 'CSV読込中…' : '一括生成してZIPを保存';
    }
    const urls = $('batch-urls');
    const names = $('batch-names');
    const csv = $('batch-csv');
    const csvFile = $('batch-csv-file');
    if (urls) urls.disabled = legacyInactive;
    if (names) names.disabled = legacyInactive;
    if (csv) csv.disabled = csvInactive;
    if (csvFile) {
      csvFile.disabled = csvInactive;
      csvFile.setAttribute('aria-busy', String(state.batchFileLoading));
    }
    if (batchPanel) batchPanel.setAttribute('aria-busy', String(unavailable));
  }

  async function loadBatchCsvFile(file) {
    if (state.qrBusy || state.batchRunning) return;
    const requestToken = ++state.csvReadToken;
    state.batchFileLoading = true;
    renderBatchErrors([]);
    setStatus('batch-status', 'CSVファイルを読み込み中…');
    updateBatchControls();
    try {
      const bytes = await file.arrayBuffer();
      const decoded = generated.qr.batch.decodeCsvBytes(bytes);
      if (requestToken !== state.csvReadToken) return;
      $('batch-csv').value = decoded;
      setStatus('batch-status', 'CSVファイルを読み込みました。内容を確認して生成してください。');
    } catch (error) {
      if (requestToken !== state.csvReadToken) return;
      const reason = error instanceof Error ? error.message : 'CSVファイルの読み込みに失敗しました。';
      renderBatchErrors([{ line: null, reason }]);
      setStatus('batch-status', 'CSVファイルを読み込めません。', true);
    } finally {
      if (requestToken === state.csvReadToken) {
        state.batchFileLoading = false;
        updateBatchControls();
      }
    }
  }

  function parseCurrentBatchInput() {
    return state.batchInputMode === 'csv'
      ? generated.qr.batch.parseBatchCsv($('batch-csv').value)
      : generated.qr.batch.parseBatchInput($('batch-urls').value, $('batch-names').value);
  }

  async function generateBatchPngs(items, mode, onProgress) {
    const files = new Array(items.length);
    const errors = [];
    let nextIndex = 0;
    let completed = 0;
    async function worker() {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        const item = items[index];
        try {
          const result = await desktop.qr.generate({ text: item.url, angle: 315, noLogo: false, mode });
          files[index] = { name: item.fileName, data: await svgToPng(result.svg) };
        } catch (error) {
          errors.push({ line: item.line, reason: error instanceof Error ? error.message : '生成に失敗しました。', cause: error });
        } finally {
          completed += 1;
          onProgress?.(completed, items.length);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, () => worker()));
    errors.sort((a, b) => (a.line ?? 999999) - (b.line ?? 999999));
    return { files: files.filter(Boolean), errors, completed };
  }

  async function generateBatchZip() {
    if (state.qrBusy || state.batchRunning || state.batchFileLoading) return;
    const parsed = parseCurrentBatchInput();
    if (!parsed.items.length && !parsed.errors.length) {
      renderBatchErrors([{ line: null, reason: '生成するURLを1件以上入力してください。' }]);
      setStatus('batch-status', '入力を確認してください。', true);
      return;
    }
    if (!parsed.valid) {
      renderBatchErrors(parsed.errors);
      setStatus('batch-status', '入力を確認してください。', true);
      return;
    }
    const items = generated.qr.batch.assignBatchFileNames(parsed.items);
    const requestedMode = state.qrMode;
    state.batchRunning = true;
    state.qrBusy = true;
    renderQrMode();
    renderBatchErrors([]);
    const progress = $('batch-progress');
    if (progress) { progress.hidden = false; progress.max = items.length; progress.value = 0; }
    updateBatchControls();
    setStatus('batch-status', `生成中… 0/${items.length}件`);
    const updateProgress = (completed, total) => {
      if (progress) progress.value = completed;
      setStatus('batch-status', `生成中… ${completed}/${total}件`);
    };
    try {
      let result = await generateBatchPngs(items, requestedMode, updateProgress);
      let fallbackUsed = false;
      if (result.errors.length && requestedMode === 'online') {
        const reason = onlineFailureReason(result.errors[0]?.cause);
        setQrMode('offline', `オンラインAPI失敗: ${reason}`);
        fallbackUsed = true;
        if (progress) progress.value = 0;
        setStatus('batch-status', 'オンラインAPIに失敗したため、全件をローカルで再生成中…');
        result = await generateBatchPngs(items, 'offline', updateProgress);
      }
      if (result.errors.length) {
        renderBatchErrors(result.errors);
        setStatus('batch-status', '生成に失敗したためZIPは作成しません。', true);
        return;
      }
      if (!window.JSZip) throw new Error('ZIPライブラリを読み込めません。');
      const zip = new window.JSZip(); result.files.forEach((file) => zip.file(file.name, file.data));
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      downloadBytes(blob, `qr_codes_${formatTimestamp(new Date())}.zip`, 'application/zip');
      const prefix = fallbackUsed ? 'オンラインAPI失敗後、全件をローカルで生成し' : requestedMode === 'online' ? 'オンラインAPIで' : 'ローカルで';
      setStatus('batch-status', `${prefix}${result.files.length}件をZIPで保存しました。`);
    } catch (error) { setStatus('batch-status', error instanceof Error ? error.message : '一括生成に失敗しました。', true); }
    finally { state.batchRunning = false; state.qrBusy = false; updateBatchControls(); renderQrMode(); }
  }

  function formatTimestamp(date) { const pad=(value)=>String(value).padStart(2,'0'); return `${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`; }

  function movePdfFile(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= state.pdfFiles.length) return;
    const [file] = state.pdfFiles.splice(index, 1);
    state.pdfFiles.splice(target, 0, file);
    renderPdfFiles();
  }

  function renderPdfFiles() {
    const list = $('pdf-file-list'); list.replaceChildren();
    state.pdfFiles.forEach((file, index) => {
      const item = document.createElement('li');
      item.dataset.index = String(index);
      item.draggable = true;
      const label = document.createElement('span');
      label.textContent = `${index + 1}. ${file.name}`;
      const actions = document.createElement('span');
      actions.className = 'pdf-file-actions';
      [['pdf-preview-file', 'プレビュー'], ['pdf-up', '↑'], ['pdf-down', '↓']].forEach(([action, text]) => {
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.pdfAction = action; button.dataset.index = String(index);
        button.textContent = text;
        button.disabled = action === 'pdf-up' ? index === 0 : action === 'pdf-down' ? index === state.pdfFiles.length - 1 : false;
        actions.append(button);
      });
      item.append(label, actions); list.append(item);
    });
    $('pdf-action-btn').disabled = state.pdfFiles.length === 0;
    $('pdf-preview-btn').disabled = !state.lastPdf;
  }

  function configureWatermarkPanel() {
    const enabled = $('mode-watermark').checked; $('watermark-options').hidden = !enabled; $('wm-source-status').textContent = state.pendingWatermark ? `QR素材を使用: ${state.pendingWatermark.fileName}` : state.watermarkFile ? `画像を使用: ${state.watermarkFile.name}` : '';
    $('wm-type').value = state.pendingWatermark || state.watermarkFile ? 'image' : $('wm-type').value;
    $('wm-text-fields').hidden = $('wm-type').value !== 'text'; $('wm-image-field').hidden = $('wm-type').value === 'text';
  }

  async function processPdf() {
    if (!state.pdfFiles.length) { setStatus('pdf-status', 'PDFを1件以上選択してください。', true); return; }
    const button=$('pdf-action-btn'); button.disabled=true; setStatus('pdf-status','PDFを処理中…');
    try {
      let watermark;
      if ($('mode-watermark').checked) {
        if ($('wm-type').value === 'text') watermark={ type:'text', text:$('wm-text').value, fontSize:Number($('wm-font-size').value), color:$('wm-text-color').value, opacity:Number($('wm-opacity').value)/100, rotation:Number($('wm-rotation').value) };
        else {
          const source=state.pendingWatermark || state.watermarkFile; if (!source) throw new Error('ウォーターマーク画像を選択してください。');
          watermark={ type:'image', data:source.data, mimeType:source.mimeType || 'image/png', width:0, height:0, scale:Number($('wm-scale').value), opacity:Number($('wm-opacity').value)/100, rotation:Number($('wm-rotation').value) };
        }
      }
      const operation=$('mode-split').checked ? 'split' : $('mode-watermark').checked && !$('mode-merge').checked ? 'watermark' : 'merge';
      const config={ range:$('split-range').value, pageNumbers:$('page-number-check').checked ? { style:$('page-number-style').value, fontSize:Number($('page-number-size').value), startPage:Number($('page-number-start').value) } : null, pageSize:$('page-size-check').checked ? { preset:$('page-size-target').value, dimension:$('page-size-dimension').value, orientation:$('page-size-orientation').value, width:Number($('page-size-width').value), height:Number($('page-size-height').value) } : null, spreadSplit:$('spread-split-check').checked, spreadOrder:$('spread-split-order').value, watermark };
      const bytes=normalizeBytes(await generated.pdf.process({ files:state.pdfFiles.map((file)=>file.data), operation, config })); state.lastPdf=bytes; renderPdfFiles(); previewPdf(bytes);
      if (!$('output-pdf-check').checked && !$('output-webp-check').checked) throw new Error('保存形式を1つ以上選択してください。');
      if ($('output-pdf-check').checked) downloadBytes(bytes, 'processed.pdf', 'application/pdf');
      if ($('output-webp-check').checked) await saveWebpZip(bytes);
      setStatus('pdf-status','PDFの処理が完了しました。');
    } catch (error) { setStatus('pdf-status', error instanceof Error ? error.message : 'PDF処理に失敗しました。', true); }
    finally { button.disabled=state.pdfFiles.length===0; }
  }

  function normalizeBytes(value) { if (value instanceof Uint8Array) return value; if (value instanceof ArrayBuffer) return new Uint8Array(value); if (value?.buffer instanceof ArrayBuffer) return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength); throw new Error('バイナリ結果が不正です。'); }
  function previewPdf(bytes) { const blob=new Blob([bytes],{type:'application/pdf'}); const url=URL.createObjectURL(blob); state.objectUrls.add(url); $('pdf-viewer').src=url; $('pdf-viewer').hidden=false; $('pdf-preview-empty').hidden=true; }
  async function saveWebpZip(bytes) {
    if (!window.pdfjsLib || !window.JSZip) throw new Error('PDF画像変換ライブラリを読み込めません。');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc='./vendor/pdf.worker.min.js'; const pdf=await window.pdfjsLib.getDocument({ data:bytes }).promise; const zip=new window.JSZip(); const quality={small:.55,standard:.8,high:.95}[$('webp-quality').value] || .8;
    for (let pageNumber=1; pageNumber<=pdf.numPages; pageNumber += 1) { const page=await pdf.getPage(pageNumber); const viewport=page.getViewport({scale:1.5}); const canvas=document.createElement('canvas'); canvas.width=viewport.width; canvas.height=viewport.height; await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise; const blob=await new Promise((resolve)=>canvas.toBlob(resolve,'image/webp',quality)); if (!blob) throw new Error('WebPを作成できません。'); zip.file(`page-${String(pageNumber).padStart(3,'0')}.webp`,await blob.arrayBuffer()); }
    downloadBytes(await zip.generateAsync({type:'blob',compression:'STORE'}),'processed_pages.zip','application/zip');
  }

  async function loadAssets() {
    const list=$('asset-list'); list.replaceChildren(); $('asset-empty').hidden=true;
    try {
      const assets=await desktop.assets.list(); $('asset-empty').hidden=assets.length!==0;
      for (const asset of assets) {
        const card=document.createElement('article'); card.className='asset-card'; card.dataset.id=asset.id; const thumb=document.createElement('div'); thumb.className='asset-thumb';
        try { const loaded=await desktop.assets.read(asset.id); const image=document.createElement('img'); image.alt=asset.name; image.src=bytesToDataUrl(normalizeBytes(loaded.data),asset.mimeType); thumb.append(image); } catch { thumb.textContent='読み込み失敗'; }
        const info=document.createElement('div'); info.className='asset-info'; const title=document.createElement('p'); title.className='asset-name'; title.textContent=asset.name; const meta=document.createElement('p'); meta.className='asset-meta'; meta.textContent=`${asset.mimeType} · ${new Date(asset.createdAt).toLocaleString()}`; const actions=document.createElement('div'); actions.className='asset-actions';
        [['asset-use','PDFへ設定'],['asset-download','ダウンロード'],['asset-rename','名前変更'],['asset-delete','削除']].forEach(([action,label])=>{const button=document.createElement('button');button.type='button';button.dataset.action=action;button.textContent=label;if(action==='asset-delete')button.classList.add('danger');actions.append(button);}); info.append(title,meta,actions); card.append(thumb,info); list.append(card);
      }
    } catch (error) { setStatus('pdf-status', error instanceof Error ? error.message : '素材を読み込めません。', true); }
  }

  async function assetAction(event) {
    const button=event.target.closest('button[data-action]'); if (!button) return; const card=button.closest('.asset-card'); const id=card?.dataset.id; if (!id) return;
    try {
      if (button.dataset.action==='asset-delete') { if (!window.confirm('この素材を削除しますか？')) return; await desktop.assets.delete(id); await loadAssets(); return; }
      if (button.dataset.action==='asset-rename') { const name=window.prompt('新しい名前',card.querySelector('.asset-name').textContent); if (name) { await desktop.assets.rename(id,name); await loadAssets(); } return; }
      const loaded=await desktop.assets.read(id); const data=normalizeBytes(loaded.data);
      if (button.dataset.action==='asset-download') { downloadBytes(data,safeDownloadName(loaded.metadata.fileName,loaded.metadata.mimeType==='image/svg+xml'?'svg':loaded.metadata.mimeType==='image/jpeg'?'jpg':'png'),loaded.metadata.mimeType); return; }
      state.pendingWatermark=generated.qr.createPdfHandoff(data, loaded.metadata.text, loaded.metadata.fileName, loaded.metadata.mimeType); setView('pdf-view'); sendPendingWatermark(); if (!state.pdfFrameReady) setStatus('pdf-frame-status','PDFエディターの準備後に素材を設定します。');
    } catch (error) { setStatus('pdf-status', error instanceof Error ? error.message : '素材操作に失敗しました。', true); }
  }

  function updateIsBusy() {
    return state.update.status === 'downloading' || state.update.status === 'installing';
  }

  function updateActionButton(element, descriptor) {
    if (!element) return;
    element.hidden = !descriptor;
    element.disabled = !descriptor;
    element.textContent = descriptor?.label || '';
    element.dataset.updateAction = descriptor?.action || '';
  }

  function renderUpdateDialog() {
    const dialog = $('update-dialog');
    if (!dialog) return;
    const model = updateUi.createUpdateViewModel(state.update, {
      currentVersion: state.update.currentVersion,
      latestVersion: state.update.latestVersion,
      percent: state.update.percent
    });
    $('update-dialog-title').textContent = model.title;
    $('update-dialog-description').textContent = model.description;
    $('update-current-version').textContent = model.currentVersion === '—' ? '—' : `v${model.currentVersion}`;
    $('update-latest-version').textContent = model.latestVersion === '—' ? '—' : `v${model.latestVersion}`;
    const progress = $('update-progress');
    progress.hidden = !model.showProgress;
    progress.value = model.percent;
    $('update-progress-label').textContent = model.showProgress ? model.progressLabel : '';
    $('update-status').textContent = model.ariaLive;
    $('update-dialog').classList.toggle('update-error', model.status === updateUi.STATUS.ERROR);
    const close = $('update-close');
    close.disabled = !model.canClose;
    close.setAttribute('aria-disabled', String(!model.canClose));
    updateActionButton($('update-primary'), model.primary);
    updateActionButton($('update-secondary'), model.secondary);
    updateActionButton($('update-fallback'), model.fallback);
    if (model.status === updateUi.STATUS.ERROR && state.updateInstallerPromise) $('update-fallback').disabled = true;
  }

  function showUpdateDialog(nextState = {}) {
    state.update = { ...state.update, ...nextState };
    renderUpdateDialog();
    const dialog = $('update-dialog');
    if (dialog && !dialog.open) dialog.showModal();
  }

  function setUpdateState(nextState) {
    state.update = { ...state.update, ...nextState };
    renderUpdateDialog();
  }

  function applyUpdateResult(result) {
    const status = ['disabled', 'none', 'available', 'error'].includes(result?.status) ? result.status : 'error';
    const mode = result?.mode === 'manual' || result?.mode === 'automatic'
      ? result.mode
      : status === 'error' ? state.update.mode : 'automatic';
    setUpdateState({
      status,
      version: result?.version || '',
      latestVersion: result?.version || '',
      mode,
      percent: 0
    });
  }

  function applyUpdateEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'downloading') {
      setUpdateState({ status: 'downloading', percent: 0 });
    } else if (event.type === 'progress') {
      setUpdateState({ status: 'downloading', percent: updateUi.normalizePercent(event.percent) });
    } else if (event.type === 'installing') {
      setUpdateState({ status: 'installing', percent: 100 });
    } else if (event.type === 'error') {
      setUpdateState({ status: 'error' });
    } else {
      return;
    }
    const dialog = $('update-dialog');
    if ((event.type === 'downloading' || event.type === 'installing') && dialog && !dialog.open) dialog.showModal();
  }

  function checkUpdates() {
    if (state.updateCheckPromise) return state.updateCheckPromise;
    const button = $('check-update');
    if (button) button.disabled = true;
    showUpdateDialog({ status: 'checking', percent: 0 });
    let request;
    try {
      request = desktop.updates.check();
    } catch {
      request = Promise.reject(new Error('update-check-failed'));
    }
    state.updateCheckPromise = Promise.resolve(request)
      .then((result) => {
        applyUpdateResult(result);
        return result;
      })
      .catch(() => {
        const result = { status: 'error' };
        applyUpdateResult(result);
        return result;
      })
      .finally(() => {
        state.updateCheckPromise = null;
        if (button) button.disabled = false;
      });
    return state.updateCheckPromise;
  }

  function closeUpdateDialog() {
    const dialog = $('update-dialog');
    if (!dialog || updateIsBusy()) return;
    dialog.close();
  }

  function installUpdate() {
    if (state.updateInstallPromise) return state.updateInstallPromise;
    const mode = state.update.mode;
    if (mode === 'automatic') setUpdateState({ status: 'downloading', percent: 0 });
    const request = Promise.resolve().then(() => desktop.updates.install());
    state.updateInstallPromise = request
      .then((result) => {
        if (result?.status === 'error') setUpdateState({ status: 'error' });
        else if (mode === 'manual') closeUpdateDialog();
        else setUpdateState({ status: 'installing', percent: 100 });
        return result;
      })
      .catch(() => {
        setUpdateState({ status: 'error' });
        return { status: 'error' };
      })
      .finally(() => { state.updateInstallPromise = null; });
    return state.updateInstallPromise;
  }

  function openInstaller() {
    if (state.updateInstallerPromise) return state.updateInstallerPromise;
    $('update-fallback').disabled = true;
    state.updateInstallerPromise = Promise.resolve()
      .then(() => desktop.updates.openInstaller())
      .then((result) => {
        if (result?.status === 'error') setUpdateState({ status: 'error' });
        return result;
      })
      .catch(() => {
        setUpdateState({ status: 'error' });
        return { status: 'error' };
      })
      .finally(() => {
        state.updateInstallerPromise = null;
        renderUpdateDialog();
      });
    return state.updateInstallerPromise;
  }

  function openReleasePage() {
    if (state.updateReleasePromise) return state.updateReleasePromise;
    state.updateReleasePromise = Promise.resolve()
      .then(() => desktop.updates.openRelease())
      .then((result) => {
        if (result?.status === 'error') setUpdateState({ status: 'error' });
        return result;
      })
      .catch(() => {
        setUpdateState({ status: 'error' });
        return { status: 'error' };
      })
      .finally(() => {
        state.updateReleasePromise = null;
        renderUpdateDialog();
      });
    return state.updateReleasePromise;
  }

  function setupQrMode() {
    qrModeButtons.forEach((button) => button.addEventListener('click', () => selectQrMode(button.dataset.qrMode)));
    renderQrMode();
  }

  function setupBatchInput() {
    document.querySelectorAll('input[name="batch-input-mode"]').forEach((input) => {
      input.addEventListener('change', () => setBatchInputMode(input.value));
    });
    $('batch-csv-file').addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      if (!file || state.batchRunning) return;
      void loadBatchCsvFile(file);
    });
    setBatchInputMode('legacy');
  }

  function updateAction(event) {
    const button = event.target.closest('button[data-update-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.updateAction;
    if (action === 'close') closeUpdateDialog();
    else if (action === 'check') void checkUpdates();
    else if (action === 'install') void installUpdate();
    else if (action === 'open-installer') void openInstaller();
    else if (action === 'open-release') void openReleasePage();
  }

  function setupUpdateDialog() {
    const dialog = $('update-dialog');
    if (!dialog) return;
    dialog.addEventListener('cancel', (event) => {
      if (updateIsBusy()) event.preventDefault();
    });
    dialog.addEventListener('click', updateAction);
    $('update-close').addEventListener('click', (event) => {
      if (updateIsBusy()) event.preventDefault();
    });
    if (typeof desktop.updates.onStatus === 'function') desktop.updates.onStatus(applyUpdateEvent);
    if (typeof desktop.updates.onOpenRequested === 'function') desktop.updates.onOpenRequested(() => { void checkUpdates(); });
  }

  function wireEvents() {
    setupPdfFrame();
    setupUpdateDialog();
    setupQrMode(); setupBatchInput();
    setupUrlGenerator();
    setupTabs(); $('generate-btn').addEventListener('click',()=>void generateQr()); $('qr-text').addEventListener('keydown',(event)=>{if(event.key==='Enter')void generateQr();}); $('rotate-btn').addEventListener('click',()=>{state.qrAngle=(state.qrAngle+45)%360;$('angle-display').textContent=state.qrAngle;void generateQr();}); $('logo-upload').addEventListener('change',(event)=>void handleLogo(event)); $('no-logo-check').addEventListener('change',()=>{ $('logo-controls').style.opacity=$('no-logo-check').checked?'.45':'1'; $('rotate-btn').disabled=$('no-logo-check').checked; $('logo-upload').disabled=$('no-logo-check').checked; if (state.qr)void generateQr(); }); $('download-btn').addEventListener('click',()=>void saveQr()); $('save-asset-btn').addEventListener('click',()=>void saveQrAsset()); $('use-pdf-btn').addEventListener('click',()=>void useQrInPdf()); $('batch-generate-btn').addEventListener('click',()=>void generateBatchZip()); $('refresh-assets').addEventListener('click',()=>void loadAssets()); $('asset-list').addEventListener('click',(event)=>void assetAction(event)); $('check-update').addEventListener('click',()=>void checkUpdates()); $('release-link').addEventListener('click',async()=>{try{await desktop.updates.openRelease();}catch{setStatus('qr-status','Releaseページを開けません。',true);}});
    $('pdf-file-list').addEventListener('click',(event)=>{const button=event.target.closest('button[data-pdf-action]');if(!button)return;const index=Number(button.dataset.index);if(button.dataset.pdfAction==='pdf-up')movePdfFile(index,-1);else if(button.dataset.pdfAction==='pdf-down')movePdfFile(index,1);else if(button.dataset.pdfAction==='pdf-preview-file'&&state.pdfFiles[index])previewPdf(state.pdfFiles[index].data);});
    $('pdf-file-list').addEventListener('dragstart',(event)=>{const item=event.target.closest('li[data-index]');if(!item)return;state.draggedPdfIndex=Number(item.dataset.index);event.dataTransfer?.setData('text/plain',item.dataset.index);if(event.dataTransfer)event.dataTransfer.effectAllowed='move';});
    $('pdf-file-list').addEventListener('dragover',(event)=>{if(state.draggedPdfIndex!==null)event.preventDefault();});
    $('pdf-file-list').addEventListener('drop',(event)=>{event.preventDefault();const item=event.target.closest('li[data-index]');const from=state.draggedPdfIndex;state.draggedPdfIndex=null;if(!item||from===null)return;const to=Number(item.dataset.index);if(from===to)return;const [file]=state.pdfFiles.splice(from,1);state.pdfFiles.splice(to,0,file);renderPdfFiles();});
    $('pdf-inputs').addEventListener('change',async(event)=>{state.pdfFiles=[];for(const file of event.target.files||[]){state.pdfFiles.push({name:file.name,data:await readFileBytes(file)});}renderPdfFiles();}); $('mode-split').addEventListener('change',()=>{if($('mode-split').checked)$('mode-merge').checked=false;$('split-options').hidden=!$('mode-split').checked;}); $('mode-merge').addEventListener('change',()=>{if($('mode-merge').checked)$('mode-split').checked=false;$('split-options').hidden=!$('mode-split').checked;}); $('mode-watermark').addEventListener('change',configureWatermarkPanel); $('wm-type').addEventListener('change',configureWatermarkPanel); $('wm-img-input').addEventListener('change',async(event)=>{const file=event.target.files?.[0];if(!file)return;try{const raw=await readFileBytes(file);const isSvg=file.type==='image/svg+xml'||/\.svg$/iu.test(file.name);state.watermarkFile={name:file.name,data:isSvg?await svgToPng(new TextDecoder().decode(raw)):raw,mimeType:isSvg?'image/png':file.type};state.pendingWatermark=null;configureWatermarkPanel();}catch(error){setStatus('pdf-status',error instanceof Error?error.message:'画像を読み込めません。',true);}}); $('output-webp-check').addEventListener('change',()=>{$('webp-quality-wrap').hidden=!$('output-webp-check').checked;}); $('pdf-action-btn').addEventListener('click',()=>void processPdf()); $('pdf-preview-btn').addEventListener('click',()=>{if(state.lastPdf)previewPdf(state.lastPdf);}); $('pdf-clear-btn').addEventListener('click',()=>{state.pdfFiles=[];state.lastPdf=null;state.pendingWatermark=null;state.watermarkFile=null;$('pdf-inputs').value='';$('pdf-handoff').hidden=true;renderPdfFiles();setStatus('pdf-status','クリアしました。');});
  }

  wireEvents();
  desktop.app.getVersion().then((version) => {
    $('app-version').textContent=`v${version}`;
    state.update.currentVersion = String(version || '');
    renderUpdateDialog();
  }).catch(()=>{});
})();
