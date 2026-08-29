import { zipSync } from './vendor/fflate.mjs';
import { assignBatchFileNames, parseBatchInput } from './batch-utils.mjs';

document.addEventListener('DOMContentLoaded', () => {
    let currentAngle = 315;
    let uploadedLogoUrl = null; // アップロードされた画像のデータURL
    let batchRunning = false;

    const qrImage = document.getElementById('qr-image');
    const textInput = document.getElementById('qr-text');
    const generateBtn = document.getElementById('generate-btn');
    const rotateBtn = document.getElementById('rotate-btn');
    const angleDisplay = document.getElementById('angle-display');
    const logoUpload = document.getElementById('logo-upload');
    const downloadBtn = document.getElementById('download-btn');
    const downloadFormat = document.getElementById('download-format');

    // 追加要素の取得
    const noLogoCheck = document.getElementById('no-logo-check');
    const logoControlsContainer = document.getElementById('logo-controls-container');

    const tabs = [
        document.getElementById('single-tab'),
        document.getElementById('batch-tab')
    ];
    const panels = [
        document.getElementById('single-panel'),
        document.getElementById('batch-panel')
    ];

    // 一括生成画面
    const batchUrls = document.getElementById('batch-urls');
    const batchNames = document.getElementById('batch-names');
    const batchGenerateBtn = document.getElementById('batch-generate-btn');
    const batchStatus = document.getElementById('batch-status');
    const batchStatusText = document.getElementById('batch-status-text');
    const batchProgress = document.getElementById('batch-progress');
    const batchErrors = document.getElementById('batch-errors');
    const batchErrorList = document.getElementById('batch-error-list');

    // --- ページ内タブ（ARIA tab pattern） ---
    function selectTab(index, moveFocus = false) {
        tabs.forEach((tab, tabIndex) => {
            const selected = tabIndex === index;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            panels[tabIndex].hidden = !selected;
        });

        if (moveFocus) {
            tabs[index].focus();
        }
    }

    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => selectTab(index));
        tab.addEventListener('keydown', (event) => {
            let nextIndex = null;
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                nextIndex = (index + 1) % tabs.length;
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                nextIndex = (index - 1 + tabs.length) % tabs.length;
            } else if (event.key === 'Home') {
                nextIndex = 0;
            } else if (event.key === 'End') {
                nextIndex = tabs.length - 1;
            } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectTab(index);
            }

            if (nextIndex !== null) {
                event.preventDefault();
                selectTab(nextIndex, true);
            }
        });
    });

    // --- ロゴなしチェックの連動処理 ---
    noLogoCheck.addEventListener('change', () => {
        if (noLogoCheck.checked) {
            // ロゴなし時は操作パネルをグレーアウトして無効化
            logoControlsContainer.style.opacity = '0.4';
            rotateBtn.disabled = true;
            logoUpload.disabled = true;
        } else {
            // ロゴあり時は元に戻す
            logoControlsContainer.style.opacity = '1';
            rotateBtn.disabled = false;
            logoUpload.disabled = false;
        }
        // 設定が変わったので即座に再生成
        generateQRCode();
    });

    // --- 画像アップロードの処理 ---
    logoUpload.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (loadEvent) => {
            uploadedLogoUrl = loadEvent.target.result;
            currentAngle = 0;
            angleDisplay.innerText = currentAngle;
            generateQRCode();
        };
        reader.readAsDataURL(file);
    });

    // --- 単体生成 ---
    generateBtn.addEventListener('click', () => {
        generateQRCode();
    });

    rotateBtn.addEventListener('click', () => {
        currentAngle += 45;
        if (currentAngle >= 360) {
            currentAngle = 0;
        }
        angleDisplay.innerText = currentAngle;
        generateQRCode();
    });

    function generateQRCode() {
        const text = textInput.value.trim();
        if (!text) return;

        // API URLの構築
        const apiUrl = new URL('/api/qr', window.location.origin);
        apiUrl.searchParams.set('text', text);
        apiUrl.searchParams.set('angle', currentAngle);

        if (noLogoCheck.checked) {
            apiUrl.searchParams.set('noLogo', 'true');
        } else if (uploadedLogoUrl) {
            // アップロードされたロゴがあればデータURIとしてパラメータに載せる
            apiUrl.searchParams.set('logoUrl', uploadedLogoUrl);
        }
        // logoUrlを指定しない場合、APIがデフォルトの/logo.pngを使用する

        // imgのsrcを更新して画像を表示
        qrImage.src = apiUrl.toString();
        qrImage.style.display = 'inline-block';

        enableDownloadButton();
    }

    downloadBtn.addEventListener('click', async () => {
        const imageUrl = qrImage.src;
        if (!imageUrl) return;

        try {
            const response = await fetch(imageUrl);
            if (!response.ok) {
                throw new Error(`画像の取得に失敗しました (${response.status})`);
            }

            const svgBlob = await response.blob();
            const format = downloadFormat.value;
            const blob = format === 'png'
                ? await convertSvgToPng(svgBlob)
                : svgBlob;
            const blobUrl = URL.createObjectURL(blob);

            const nameInput = document.getElementById('name-text');
            const fileNameValue = nameInput.value.trim();
            const fileName = fileNameValue
                ? `${fileNameValue}.${format}`
                : `qr_code_${new Date().getTime()}.${format}`;

            const link = document.createElement('a');
            link.download = fileName;
            link.href = blobUrl;

            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            // メモリ解放
            URL.revokeObjectURL(blobUrl);
        } catch (error) {
            console.error('画像のダウンロードに失敗しました:', error);
        }
    });

    async function convertSvgToPng(svgBlob) {
        const svgUrl = URL.createObjectURL(svgBlob);
        const image = new Image();

        try {
            await new Promise((resolve, reject) => {
                image.onload = resolve;
                image.onerror = () => reject(new Error('SVGをPNGに変換できませんでした'));
                image.src = svgUrl;
            });

            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth || 400;
            canvas.height = image.naturalHeight || 400;
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0, canvas.width, canvas.height);

            return await new Promise((resolve, reject) => {
                canvas.toBlob((pngBlob) => {
                    if (pngBlob) resolve(pngBlob);
                    else reject(new Error('PNGファイルを作成できませんでした'));
                }, 'image/png');
            });
        } finally {
            URL.revokeObjectURL(svgUrl);
        }
    }

    function enableDownloadButton() {
        downloadBtn.disabled = false;
        downloadBtn.style.backgroundColor = '#4CAF50';
        downloadBtn.style.cursor = 'pointer';
    }

    // --- 一括生成 ---
    batchGenerateBtn.addEventListener('click', () => {
        void generateBatchZip();
    });

    async function generateBatchZip() {
        // Disabled controls cover ordinary clicks; this guard also prevents
        // programmatic/keyboard duplicate submissions while requests run.
        if (batchRunning) return;

        const parsed = parseBatchInput(batchUrls.value, batchNames.value);
        if (!parsed.items.length && !parsed.errors.length) {
            showBatchErrors([{ line: null, reason: '生成するURLを1件以上入力してください。' }]);
            setBatchStatus('入力を確認してください。', 0, 0, true);
            return;
        }

        if (!parsed.valid) {
            showBatchErrors(parsed.errors);
            setBatchStatus('入力を確認してください。', parsed.items.length, 0, true);
            return;
        }

        const items = assignBatchFileNames(parsed.items);
        setBatchBusy(true);
        showBatchErrors([]);
        setBatchStatus(`生成中… 0/${items.length}件`, items.length, 0);

        try {
            const result = await generateBatchPngs(items, 4, (completed, total) => {
                setBatchStatus(`生成中… ${completed}/${total}件`, total, completed);
            });

            if (result.errors.length > 0) {
                showBatchErrors(result.errors);
                setBatchStatus(`生成に失敗しました（${result.errors.length}件）。ZIPは作成されません。`, items.length, result.completed, true);
                return;
            }

            const files = Object.fromEntries(result.files.map((file) => [
                file.name,
                file.data
            ]));
            // level: 0 keeps the already-compressed PNG data uncompressed.
            const zipData = zipSync(files, { level: 0 });
            const zipName = createZipFileName(new Date());
            downloadBytes(zipData, zipName, 'application/zip');
            setBatchStatus(`完了しました。${result.files.length}件をZIPで保存しました。`, items.length, items.length);
        } catch (error) {
            console.error('一括生成に失敗しました:', error);
            showBatchErrors([{ line: null, reason: error instanceof Error ? error.message : '予期しないエラーが発生しました。' }]);
            setBatchStatus('一括生成に失敗しました。ZIPは作成されません。', items.length, 0, true);
        } finally {
            setBatchBusy(false);
        }
    }

    async function generateBatchPngs(items, concurrency, onProgress) {
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
                    const data = await fetchBatchPng(item.url);
                    files[index] = { name: item.fileName, data };
                } catch (error) {
                    errors.push({
                        line: item.line,
                        reason: error instanceof Error ? error.message : '画像の取得に失敗しました。'
                    });
                } finally {
                    completed += 1;
                    onProgress(completed, items.length);
                }
            }
        }

        const workerCount = Math.min(Math.max(1, concurrency), items.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        errors.sort((left, right) => (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER));

        return {
            files: files.filter(Boolean),
            errors,
            completed
        };
    }

    async function fetchBatchPng(text) {
        const apiUrl = new URL('/api/qr', window.location.origin);
        apiUrl.searchParams.set('text', text);
        apiUrl.searchParams.set('angle', '315');

        const response = await fetch(apiUrl.toString(), {
            headers: { Accept: 'image/png' }
        });

        if (!response.ok) {
            throw new Error(`画像の取得に失敗しました（HTTP ${response.status}）。`);
        }

        const data = new Uint8Array(await response.arrayBuffer());
        if (!isPng(data)) {
            throw new Error('サーバーからPNG画像を取得できませんでした。');
        }
        return data;
    }

    function isPng(data) {
        return data.length >= 8
            && data[0] === 0x89
            && data[1] === 0x50
            && data[2] === 0x4E
            && data[3] === 0x47
            && data[4] === 0x0D
            && data[5] === 0x0A
            && data[6] === 0x1A
            && data[7] === 0x0A;
    }

    function setBatchBusy(busy) {
        batchRunning = busy;
        batchGenerateBtn.disabled = busy;
        batchUrls.disabled = busy;
        batchNames.disabled = busy;
        batchGenerateBtn.setAttribute('aria-busy', String(busy));
        batchGenerateBtn.textContent = busy ? '生成中…' : '一括生成してZIPを保存';
    }

    function setBatchStatus(message, total, completed, isError = false) {
        batchStatus.hidden = false;
        batchStatusText.textContent = message;
        batchStatusText.style.color = isError ? '#9b2c2c' : '';
        batchProgress.max = Math.max(1, total);
        batchProgress.value = Math.min(completed, Math.max(1, total));
        batchProgress.textContent = `${completed}/${total}`;
    }

    function showBatchErrors(errors) {
        batchErrorList.replaceChildren();
        if (!errors.length) {
            batchErrors.hidden = true;
            return;
        }

        errors.forEach((error) => {
            const listItem = document.createElement('li');
            const prefix = error.line == null ? '' : `行${error.line}: `;
            listItem.textContent = `${prefix}${error.reason}`;
            batchErrorList.appendChild(listItem);
        });
        batchErrors.hidden = false;
    }

    function downloadBytes(bytes, fileName, contentType) {
        const blob = new Blob([bytes], { type: contentType });
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = fileName;
        link.href = objectUrl;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        // Keep the object URL alive until the browser has started the download.
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }

    function createZipFileName(date) {
        const pad = (value) => String(value).padStart(2, '0');
        return [
            'qr_codes_',
            date.getFullYear(),
            pad(date.getMonth() + 1),
            pad(date.getDate())
        ].join('') + `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.zip`;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const initialUrl = urlParams.get('url');

    if (initialUrl) {
        textInput.value = initialUrl;
        generateQRCode();
    }
});
