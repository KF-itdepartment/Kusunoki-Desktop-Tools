// Node-testable copy of the browser batch adapter. The browser implementation
// is generated from vendor/qr-generator/public/batch-utils.mjs and both copies
// intentionally expose the same pure parsing and filename rules.
const MAX_BATCH_ITEMS = 100;
const MAX_FILENAME_LENGTH = 240;
const INVALID_FILENAME_CHARACTERS = /[\p{Cc}<>:"/\\|?*]/gu;
const TRAILING_DOTS_AND_SPACES = /[. ]+$/u;
const PNG_EXTENSION = /\.png$/iu;

function splitInputLines(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n').split('\n');
}

function validateHttpUrl(value) {
  const candidate = String(value ?? '').trim();
  if (!candidate) return { valid: false, reason: 'URLが空です。' };
  try {
    const parsed = new URL(candidate);
    if (!/^https?:\/\//iu.test(candidate)
      || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || !parsed.hostname) throw new Error('invalid-url');
  } catch {
    return { valid: false, reason: 'http:// または https:// で始まる絶対URLを入力してください。' };
  }
  return { valid: true, value: candidate };
}

function isValidHttpUrl(value) {
  return validateHttpUrl(value).valid;
}

function getMaxBatchItems(options) {
  return typeof options === 'number' ? options : options?.maxItems ?? MAX_BATCH_ITEMS;
}

function parseBatchInput(urlText, nameText, options = {}) {
  const maxItems = getMaxBatchItems(options);
  const urlLines = splitInputLines(urlText);
  const nameLines = splitInputLines(nameText);
  const rowCount = Math.max(urlLines.length, nameLines.length);
  const items = [];
  const errors = [];

  for (let index = 0; index < rowCount; index += 1) {
    const line = index + 1;
    const url = (urlLines[index] ?? '').trim();
    const name = (nameLines[index] ?? '').trim();
    if (!url && !name) continue;
    if (!url) {
      errors.push({ line, reason: 'URLが空です。ファイル名だけの行は生成できません。' });
      continue;
    }
    const validation = validateHttpUrl(url);
    if (!validation.valid) {
      errors.push({ line, reason: validation.reason });
      continue;
    }
    items.push({ line, url: validation.value, name });
  }
  if (items.length > maxItems) errors.push({ line: null, reason: `生成できるURLは${maxItems}件までです（${items.length}件入力されています）。` });
  return { valid: errors.length === 0, items, entries: items, errors, count: items.length };
}

function isCsvRecordEmpty(fields) {
  return fields.length <= 2 && fields.every((field) => !field.trim());
}

function equalsAsciiCaseInsensitive(value, expected) {
  return value.length === expected.length
    && value.split('').every((character, index) => {
      const expectedCharacter = expected[index];
      return character === expectedCharacter
        || (character >= 'A' && character <= 'Z' && character.toLowerCase() === expectedCharacter);
    });
}

function isCsvHeader(fields) {
  if (fields.length !== 2) return false;
  const urlHeader = fields[0].trim();
  const nameHeader = fields[1].trim();
  return equalsAsciiCaseInsensitive(urlHeader, 'url')
    && (equalsAsciiCaseInsensitive(nameHeader, 'name') || nameHeader === 'ファイル名');
}

function parseCsvRecords(csvText) {
  const text = String(csvText ?? '').replace(/^\uFEFF+/u, '');
  const records = [];
  const errors = [];
  let fields = [];
  let field = '';
  let state = 'start';
  let line = 1;
  let recordStartLine = 1;
  let index = 0;
  const addField = () => {
    fields.push(field);
    field = '';
    state = 'start';
  };
  const addRecord = () => {
    addField();
    records.push({ line: recordStartLine, fields });
    fields = [];
    recordStartLine = line;
  };
  const consumeNewline = () => {
    if (text[index] === '\r' && text[index + 1] === '\n') index += 2;
    else index += 1;
    line += 1;
    recordStartLine = line;
  };
  const malformed = (reason = 'CSVの形式が正しくありません。') => {
    errors.push({ line: recordStartLine, reason });
    return { records, errors };
  };

  while (index < text.length) {
    const character = text[index];
    if (state === 'quoted') {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
        } else {
          state = 'afterQuote';
          index += 1;
        }
      } else if (character === '\r' || character === '\n') {
        if (character === '\r' && text[index + 1] === '\n') field += '\r\n';
        else field += character;
        if (character === '\r' && text[index + 1] === '\n') index += 2;
        else index += 1;
        line += 1;
      } else {
        field += character;
        index += 1;
      }
      continue;
    }
    if (state === 'afterQuote') {
      if (character === ',') {
        addField();
        index += 1;
        continue;
      }
      if (character === '\r' || character === '\n') {
        addRecord();
        consumeNewline();
        continue;
      }
      return malformed('CSVの引用符の後に不正な文字があります。');
    }
    if (character === ',') {
      addField();
      index += 1;
      continue;
    }
    if (character === '\r' || character === '\n') {
      addRecord();
      consumeNewline();
      continue;
    }
    if (character === '"') {
      if (state !== 'start') return malformed('CSVの引用符はフィールドの先頭で指定してください。');
      state = 'quoted';
      index += 1;
      continue;
    }
    field += character;
    state = 'unquoted';
    index += 1;
  }
  if (state === 'quoted') return malformed('CSVの引用符が正しく閉じられていません。');
  if (fields.length > 0 || field.length > 0 || state !== 'start') addRecord();
  return { records, errors };
}

function parseBatchCsv(csvText, options = {}) {
  const maxItems = getMaxBatchItems(options);
  const parsedCsv = parseCsvRecords(csvText);
  const items = [];
  const errors = [...parsedCsv.errors];
  let headerPending = true;
  for (const record of parsedCsv.records) {
    const { line, fields } = record;
    if (isCsvRecordEmpty(fields)) continue;
    if (headerPending) {
      headerPending = false;
      if (isCsvHeader(fields)) continue;
    }
    if (fields.length > 2) {
      errors.push({ line, reason: 'CSVはURLとファイル名の2列以内で指定してください。' });
      continue;
    }
    const url = (fields[0] ?? '').trim();
    const name = (fields[1] ?? '').trim();
    if (!url) {
      errors.push({ line, reason: 'URLが空です。ファイル名だけの行は生成できません。' });
      continue;
    }
    const validation = validateHttpUrl(url);
    if (!validation.valid) errors.push({ line, reason: validation.reason });
    else items.push({ line, url: validation.value, name });
  }
  if (items.length > maxItems) errors.push({ line: null, reason: `生成できるURLは${maxItems}件までです（${items.length}件入力されています）。` });
  errors.sort((left, right) => {
    if (left.line == null) return right.line == null ? 0 : 1;
    if (right.line == null) return -1;
    return left.line - right.line;
  });
  return { valid: errors.length === 0, items, entries: items, errors, count: items.length };
}

function decodeCsvBytes(bytes) {
  let data;
  try {
    data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  } catch {
    throw new Error('CSVファイルのデータを読み込めません。');
  }
  const decoderConstructor = globalThis.TextDecoder;
  if (typeof decoderConstructor !== 'function') throw new Error('この環境ではCSVの文字コードを判定できません。');
  try {
    return new decoderConstructor('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF+/u, '');
  } catch {
    // Continue with Japanese Windows encoding below.
  }
  try {
    return new decoderConstructor('shift_jis', { fatal: true }).decode(data).replace(/^\uFEFF+/u, '');
  } catch {
    throw new Error('CSVをUTF-8またはShift_JISとして読み込めませんでした。');
  }
}

function stripPngExtension(value) {
  return PNG_EXTENSION.test(value) ? value.slice(0, -4) : value;
}

function stripTrailingDotsAndSpaces(value) {
  return value.replace(TRAILING_DOTS_AND_SPACES, '');
}

function isReservedWindowsName(value) {
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(value);
}

function truncateStem(stem, suffix = '') {
  const available = Math.max(1, MAX_FILENAME_LENGTH - '.png'.length - suffix.length);
  let truncated = '';
  for (const character of stem) {
    if (truncated.length + character.length > available) break;
    truncated += character;
  }
  return stripTrailingDotsAndSpaces(truncated) || 'qr_code';
}

function sanitiseStem(value, fallback = 'qr_code') {
  const raw = String(value ?? '').trim();
  let stem = stripPngExtension(raw.replace(INVALID_FILENAME_CHARACTERS, '_'));
  stem = stripTrailingDotsAndSpaces(stem);
  if (!stem) stem = fallback;
  if (isReservedWindowsName(stem)) stem = `_${stem}`;
  return truncateStem(stem);
}

function sanitizePngFileName(value, fallback = 'qr_code') {
  return `${sanitiseStem(value, fallback)}.png`;
}

const sanitisePngFileName = sanitizePngFileName;
const sanitizeFileName = sanitizePngFileName;

function createBatchFileNames(items) {
  const used = new Set();
  return items.map((item) => {
    const url = typeof item === 'string' ? item : item?.url ?? '';
    const suppliedName = typeof item === 'string' ? '' : item?.name ?? '';
    const desired = sanitizePngFileName(suppliedName || url);
    const desiredStem = desired.slice(0, -'.png'.length);
    let candidate = desired;
    let suffixNumber = 2;
    while (used.has(candidate.toLocaleLowerCase('en-US'))) {
      const suffix = `_${suffixNumber}`;
      candidate = `${truncateStem(desiredStem, suffix)}${suffix}.png`;
      suffixNumber += 1;
    }
    used.add(candidate.toLocaleLowerCase('en-US'));
    return candidate;
  });
}

const makeUniqueFileNames = createBatchFileNames;

function assignBatchFileNames(items) {
  const fileNames = createBatchFileNames(items);
  return items.map((item, index) => ({ ...item, fileName: fileNames[index] }));
}

module.exports = {
  MAX_BATCH_ITEMS,
  MAX_FILENAME_LENGTH,
  splitInputLines,
  validateHttpUrl,
  isValidHttpUrl,
  parseBatchInput,
  parseBatchCsv,
  decodeCsvBytes,
  sanitizePngFileName,
  sanitisePngFileName,
  sanitizeFileName,
  createBatchFileNames,
  makeUniqueFileNames,
  assignBatchFileNames
};
