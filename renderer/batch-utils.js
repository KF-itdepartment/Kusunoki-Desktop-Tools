(function exposeBatchUtils(global) {
  const MAX_BATCH_ITEMS = 100;
  const MAX_FILENAME_LENGTH = 240;
  const invalid = /[\u0000-\u001f<>:"/\\|?*]/gu;

  function splitInputLines(value) { return String(value ?? '').replace(/\r\n?/gu, '\n').split('\n'); }
  function validateHttpUrl(value) {
    const candidate = String(value ?? '').trim();
    if (!candidate) return { valid:false, reason:'URLが空です。' };
    try {
      const url = new URL(candidate);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) throw new Error();
      return { valid:true, value:candidate };
    } catch { return { valid:false, reason:'http:// または https:// で始まる絶対URLを入力してください。' }; }
  }
  function parseBatchInput(urlText, nameText, maxItems = MAX_BATCH_ITEMS) {
    const urls = splitInputLines(urlText); const names = splitInputLines(nameText); const count = Math.max(urls.length, names.length);
    const items = []; const errors = [];
    for (let index=0; index<count; index += 1) {
      const line = index + 1; const url = (urls[index] || '').trim(); const name = (names[index] || '').trim();
      if (!url && !name) continue;
      if (!url) { errors.push({ line, reason:'URLが空です。ファイル名だけの行は生成できません。' }); continue; }
      const check = validateHttpUrl(url); if (!check.valid) { errors.push({ line, reason:check.reason }); continue; }
      items.push({ line, url:check.value, name });
    }
    if (items.length > maxItems) errors.push({ line:null, reason:`生成できるURLは${maxItems}件までです（${items.length}件入力されています）。` });
    return { valid:errors.length === 0, items, entries:items, errors, count:items.length };
  }
  function sanitiseStem(value, fallback='qr_code') {
    let stem = String(value ?? '').trim().replace(invalid, '_').replace(/\.png$/iu, '').replace(/[. ]+$/u, '');
    if (!stem) stem = fallback;
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(stem)) stem = `_${stem}`;
    return truncateStem(stem);
  }
  function truncateStem(stem, suffix='') {
    const max = Math.max(1, MAX_FILENAME_LENGTH - 4 - suffix.length); let output='';
    for (const character of stem) { if (output.length + character.length > max) break; output += character; }
    return output.replace(/[. ]+$/u, '') || 'qr_code';
  }
  function sanitizePngFileName(value, fallback='qr_code') { return `${sanitiseStem(value, fallback)}.png`; }
  function createBatchFileNames(items) {
    const used = new Set();
    return items.map((item) => {
      const url = typeof item === 'string' ? item : item?.url || ''; const supplied = typeof item === 'string' ? '' : item?.name || '';
      const desired = sanitizePngFileName(supplied || url); const stem = desired.slice(0, -4); let candidate=desired; let n=2;
      while (used.has(candidate.toLocaleLowerCase('en-US'))) { const suffix=`_${n}`; candidate=`${truncateStem(stem, suffix)}${suffix}.png`; n += 1; }
      used.add(candidate.toLocaleLowerCase('en-US')); return candidate;
    });
  }
  function assignBatchFileNames(items) { const names=createBatchFileNames(items); return items.map((item,index)=>({...item,fileName:names[index]})); }
  global.BatchUtils = Object.freeze({ MAX_BATCH_ITEMS, MAX_FILENAME_LENGTH, splitInputLines, validateHttpUrl, parseBatchInput, sanitizePngFileName, createBatchFileNames, assignBatchFileNames });
})(window);
