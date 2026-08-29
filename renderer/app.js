(() => {
  'use strict';

  const desktop = window.desktop;
  const generated = window.KusunokiGeneratedUpstream;
  if (!generated) throw new Error('Generated upstream adapter is required.');
  const state = {
    view: 'qr-view',
    qr: null,
    qrLogo: null,
    qrAngle: 315,
    pdfFiles: [],
    pendingWatermark: null,
    watermarkFile: null,
    lastPdf: null,
    objectUrls: new Set(),
    draggedPdfIndex: null
  };

  const $ = (id) => document.getElementById(id);
  const navButtons = [...document.querySelectorAll('.nav-button')];
  const views = [...document.querySelectorAll('.view')];

  function setStatus(id, message, error = false) {
    const element = $(id);
    element.textContent = message || '';
    element.classList.toggle('error', error);
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
    const text = $('qr-text').value.trim();
    if (!text) { setStatus('qr-status', '文字列を入力してください。', true); return; }
    const button = $('generate-btn'); button.disabled = true; setStatus('qr-status', '生成中…');
    try {
      const result = await desktop.qr.generate({ text, logoDataUrl: $('no-logo-check').checked ? null : state.qrLogo, angle: state.qrAngle, noLogo: $('no-logo-check').checked });
      setQrResult(result); setStatus('qr-status', 'ローカルで生成しました。');
    } catch (error) { setStatus('qr-status', error instanceof Error ? error.message : 'QR生成に失敗しました。', true); }
    finally { button.disabled = false; }
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
      setView('pdf-view'); configureWatermarkPanel(); setStatus('pdf-status', 'QRコードをウォーターマークに設定しました。'); $('pdf-handoff').hidden = false;
    } catch (error) { setStatus('qr-status', error instanceof Error ? error.message : 'PDFへの受渡しに失敗しました。', true); }
  }

  async function handleLogo(event) {
    const file = event.target.files?.[0]; if (!file) return;
    try { const bytes = await readFileBytes(file); state.qrLogo = bytesToDataUrl(bytes, file.type); state.qrAngle = 0; $('angle-display').textContent = '0'; await generateQr(); }
    catch (error) { setStatus('qr-status', error instanceof Error ? error.message : 'ロゴを読み込めません。', true); }
  }

  function renderBatchErrors(errors) {
    const element = $('batch-errors'); element.replaceChildren();
    if (!errors.length) { element.hidden = true; return; }
    const list = document.createElement('ul');
    errors.forEach((error) => { const item = document.createElement('li'); item.textContent = `${error.line ? `${error.line}行目: ` : ''}${error.reason}`; list.append(item); });
    element.append(list); element.hidden = false;
  }

  async function generateBatchZip() {
    const parsed = generated.qr.batch.parseBatchInput($('batch-urls').value, $('batch-names').value);
    renderBatchErrors(parsed.errors);
    if (!parsed.items.length && !parsed.errors.length) { renderBatchErrors([{ line:null, reason:'生成するURLを1件以上入力してください。' }]); return; }
    if (!parsed.valid) { setStatus('batch-status', '入力を確認してください。', true); return; }
    const items = generated.qr.batch.assignBatchFileNames(parsed.items); const button = $('batch-generate-btn'); button.disabled = true; $('batch-progress').hidden = false; $('batch-progress').max = items.length; $('batch-progress').value = 0;
    const files = []; const errors = []; let next = 0; let completed = 0;
    async function worker() {
      while (true) {
        const index = next++; if (index >= items.length) return; const item = items[index];
        try { const result = await desktop.qr.generate({ text:item.url, angle:315, noLogo:false }); files[index] = { name:item.fileName, data:await svgToPng(result.svg) }; }
        catch (error) { errors.push({ line:item.line, reason:error instanceof Error ? error.message : '生成に失敗しました。' }); }
        completed += 1; $('batch-progress').value = completed; setStatus('batch-status', `生成中… ${completed}/${items.length}件`);
      }
    }
    try {
      await Promise.all(Array.from({ length:Math.min(4, items.length) }, () => worker()));
      if (errors.length) { errors.sort((a,b)=>(a.line ?? 999999)-(b.line ?? 999999)); renderBatchErrors(errors); setStatus('batch-status', '生成に失敗したためZIPは作成しません。', true); return; }
      if (!window.JSZip) throw new Error('ZIPライブラリを読み込めません。');
      const zip = new window.JSZip(); files.forEach((file) => zip.file(file.name, file.data));
      const blob = await zip.generateAsync({ type:'blob', compression:'STORE' }); downloadBytes(blob, `qr_codes_${formatTimestamp(new Date())}.zip`, 'application/zip'); setStatus('batch-status', `${files.length}件をZIPで保存しました。`);
    } catch (error) { setStatus('batch-status', error instanceof Error ? error.message : '一括生成に失敗しました。', true); }
    finally { button.disabled = false; }
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
      state.pendingWatermark=generated.qr.createPdfHandoff(data, loaded.metadata.text, loaded.metadata.fileName, loaded.metadata.mimeType); $('mode-watermark').checked=true; setView('pdf-view'); configureWatermarkPanel(); $('pdf-handoff').hidden=false; setStatus('pdf-status','素材をウォーターマークに設定しました。');
    } catch (error) { setStatus('pdf-status', error instanceof Error ? error.message : '素材操作に失敗しました。', true); }
  }

  async function checkUpdates() { const button=$('check-update'); button.disabled=true; try { const result=await desktop.updates.check(); setStatus('qr-status',result.status==='disabled'?'開発モードでは実ネット更新を行いません。':result.status==='none'?'利用可能な更新はありません。':`更新: ${result.status}`); } catch (error) { setStatus('qr-status',error instanceof Error?error.message:'更新確認に失敗しました。',true); } finally { button.disabled=false; } }

  function wireEvents() {
    setupTabs(); $('generate-btn').addEventListener('click',()=>void generateQr()); $('qr-text').addEventListener('keydown',(event)=>{if(event.key==='Enter')void generateQr();}); $('rotate-btn').addEventListener('click',()=>{state.qrAngle=(state.qrAngle+45)%360;$('angle-display').textContent=state.qrAngle;void generateQr();}); $('logo-upload').addEventListener('change',(event)=>void handleLogo(event)); $('no-logo-check').addEventListener('change',()=>{ $('logo-controls').style.opacity=$('no-logo-check').checked?'.45':'1'; $('rotate-btn').disabled=$('no-logo-check').checked; $('logo-upload').disabled=$('no-logo-check').checked; if (state.qr)void generateQr(); }); $('download-btn').addEventListener('click',()=>void saveQr()); $('save-asset-btn').addEventListener('click',()=>void saveQrAsset()); $('use-pdf-btn').addEventListener('click',()=>void useQrInPdf()); $('batch-generate-btn').addEventListener('click',()=>void generateBatchZip()); $('refresh-assets').addEventListener('click',()=>void loadAssets()); $('asset-list').addEventListener('click',(event)=>void assetAction(event)); $('check-update').addEventListener('click',()=>void checkUpdates()); $('release-link').addEventListener('click',async()=>{try{await desktop.updates.openRelease();}catch{setStatus('qr-status','Releaseページを開けません。',true);}});
    $('pdf-file-list').addEventListener('click',(event)=>{const button=event.target.closest('button[data-pdf-action]');if(!button)return;const index=Number(button.dataset.index);if(button.dataset.pdfAction==='pdf-up')movePdfFile(index,-1);else if(button.dataset.pdfAction==='pdf-down')movePdfFile(index,1);else if(button.dataset.pdfAction==='pdf-preview-file'&&state.pdfFiles[index])previewPdf(state.pdfFiles[index].data);});
    $('pdf-file-list').addEventListener('dragstart',(event)=>{const item=event.target.closest('li[data-index]');if(!item)return;state.draggedPdfIndex=Number(item.dataset.index);event.dataTransfer?.setData('text/plain',item.dataset.index);if(event.dataTransfer)event.dataTransfer.effectAllowed='move';});
    $('pdf-file-list').addEventListener('dragover',(event)=>{if(state.draggedPdfIndex!==null)event.preventDefault();});
    $('pdf-file-list').addEventListener('drop',(event)=>{event.preventDefault();const item=event.target.closest('li[data-index]');const from=state.draggedPdfIndex;state.draggedPdfIndex=null;if(!item||from===null)return;const to=Number(item.dataset.index);if(from===to)return;const [file]=state.pdfFiles.splice(from,1);state.pdfFiles.splice(to,0,file);renderPdfFiles();});
    $('pdf-inputs').addEventListener('change',async(event)=>{state.pdfFiles=[];for(const file of event.target.files||[]){state.pdfFiles.push({name:file.name,data:await readFileBytes(file)});}renderPdfFiles();}); $('mode-split').addEventListener('change',()=>{if($('mode-split').checked)$('mode-merge').checked=false;$('split-options').hidden=!$('mode-split').checked;}); $('mode-merge').addEventListener('change',()=>{if($('mode-merge').checked)$('mode-split').checked=false;$('split-options').hidden=!$('mode-split').checked;}); $('mode-watermark').addEventListener('change',configureWatermarkPanel); $('wm-type').addEventListener('change',configureWatermarkPanel); $('wm-img-input').addEventListener('change',async(event)=>{const file=event.target.files?.[0];if(!file)return;try{const raw=await readFileBytes(file);const isSvg=file.type==='image/svg+xml'||/\.svg$/iu.test(file.name);state.watermarkFile={name:file.name,data:isSvg?await svgToPng(new TextDecoder().decode(raw)):raw,mimeType:isSvg?'image/png':file.type};state.pendingWatermark=null;configureWatermarkPanel();}catch(error){setStatus('pdf-status',error instanceof Error?error.message:'画像を読み込めません。',true);}}); $('output-webp-check').addEventListener('change',()=>{$('webp-quality-wrap').hidden=!$('output-webp-check').checked;}); $('pdf-action-btn').addEventListener('click',()=>void processPdf()); $('pdf-preview-btn').addEventListener('click',()=>{if(state.lastPdf)previewPdf(state.lastPdf);}); $('pdf-clear-btn').addEventListener('click',()=>{state.pdfFiles=[];state.lastPdf=null;state.pendingWatermark=null;state.watermarkFile=null;$('pdf-inputs').value='';$('pdf-handoff').hidden=true;renderPdfFiles();setStatus('pdf-status','クリアしました。');});
  }

  wireEvents();
  desktop.app.getVersion().then((version) => { $('app-version').textContent=`v${version}`; }).catch(()=>{});
})();
