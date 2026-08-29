'use strict';

// Generated from vendor/qr-generator/public/batch-utils.mjs. Do not edit by hand.
(function exposeGeneratedBatch(global) {
/**
 * Pure helpers used by the browser's batch QR-code flow.
 *
 * Keeping parsing, URL validation, and filename handling here makes the
 * browser workflow easy to test without a DOM (and keeps the rules shared by
 * all callers).
 */

const MAX_BATCH_ITEMS = 100;
// Windows permits 255 characters in one path component. Leave room for a
// suffix added when names collide and for the .png extension.
const MAX_FILENAME_LENGTH = 240;

const INVALID_FILENAME_CHARACTERS = /[\p{Cc}<>:"\/\\|?*]/gu;
const TRAILING_DOTS_AND_SPACES = /[. ]+$/u;
const PNG_EXTENSION = /\.png$/iu;

/** Split textarea contents while preserving physical line correspondence. */
function splitInputLines(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n').split('\n');
}

/**
 * Validate an absolute HTTP(S) URL.
 *
 * The returned object contains a user-facing reason so callers can display a
 * useful row-level error without having to duplicate the validation rules.
 */
function validateHttpUrl(value) {
  const candidate = String(value ?? '').trim();

  if (!candidate) {
    return { valid: false, reason: 'URLが空です。' };
  }

  try {
    const parsed = new URL(candidate);
    if (!/^https?:\/\//iu.test(candidate)
      || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || !parsed.hostname) {
      return {
        valid: false,
        reason: 'http:// または https:// で始まる絶対URLを入力してください。'
      };
    }
  } catch {
    return {
      valid: false,
      reason: 'http:// または https:// で始まる絶対URLを入力してください。'
    };
  }

  return { valid: true, value: candidate };
}

function isValidHttpUrl(value) {
  return validateHttpUrl(value).valid;
}

/**
 * Parse the two line-oriented batch inputs.
 *
 * Empty URL/name pairs are ignored. A name without a URL is an error, while a
 * URL without a name is a valid item whose name is derived from the URL later.
 */
function parseBatchInput(urlText, nameText, options = {}) {
  const maxItems = typeof options === 'number'
    ? options
    : options?.maxItems ?? MAX_BATCH_ITEMS;
  const urlLines = splitInputLines(urlText);
  const nameLines = splitInputLines(nameText);
  const rowCount = Math.max(urlLines.length, nameLines.length);
  const items = [];
  const errors = [];

  for (let index = 0; index < rowCount; index += 1) {
    const line = index + 1;
    const url = (urlLines[index] ?? '').trim();
    const name = (nameLines[index] ?? '').trim();

    if (!url && !name) {
      continue;
    }

    if (!url) {
      errors.push({
        line,
        reason: 'URLが空です。ファイル名だけの行は生成できません。'
      });
      continue;
    }

    const validation = validateHttpUrl(url);
    if (!validation.valid) {
      errors.push({ line, reason: validation.reason });
      continue;
    }

    items.push({ line, url: validation.value, name });
  }

  if (items.length > maxItems) {
    errors.push({
      line: null,
      reason: `生成できるURLは${maxItems}件までです（${items.length}件入力されています）。`
    });
  }

  return {
    valid: errors.length === 0,
    items,
    // `entries` is a descriptive alias for consumers that prefer that term.
    entries: items,
    errors,
    count: items.length
  };
}

function getMaxBatchItems(options) {
  return typeof options === 'number'
    ? options
    : options?.maxItems ?? MAX_BATCH_ITEMS;
}

function isCsvRecordEmpty(fields) {
  return fields.length <= 2 && fields.every((field) => !field.trim());
}

function equalsAsciiCaseInsensitive(value, expected) {
  return value.length === expected.length
    && value.split('').every((character, index) => {
      const expectedCharacter = expected[index];
      return character === expectedCharacter
        || (character >= 'A' && character <= 'Z'
          && character.toLowerCase() === expectedCharacter);
    });
}

function isCsvHeader(fields) {
  if (fields.length !== 2) {
    return false;
  }

  const urlHeader = fields[0].trim();
  const nameHeader = fields[1].trim();
  return equalsAsciiCaseInsensitive(urlHeader, 'url')
    && (equalsAsciiCaseInsensitive(nameHeader, 'name') || nameHeader === 'ファイル名');
}

/**
 * Parse CSV records while retaining the physical line where each record
 * starts. The parser deliberately implements the small RFC 4180 subset used
 * by the batch form instead of depending on a browser or npm CSV package.
 */
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
    if (text[index] === '\r' && text[index + 1] === '\n') {
      index += 2;
    } else {
      index += 1;
    }
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
        if (character === '\r' && text[index + 1] === '\n') {
          field += '\r\n';
        } else {
          field += character;
        }
        if (character === '\r' && text[index + 1] === '\n') {
          index += 2;
        } else {
          index += 1;
        }
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
      if (state !== 'start') {
        return malformed('CSVの引用符はフィールドの先頭で指定してください。');
      }
      state = 'quoted';
      index += 1;
      continue;
    }

    field += character;
    state = 'unquoted';
    index += 1;
  }

  if (state === 'quoted') {
    return malformed('CSVの引用符が正しく閉じられていません。');
  }

  if (fields.length > 0 || field.length > 0 || state !== 'start') {
    addRecord();
  }

  return { records, errors };
}

/**
 * Parse URL,filename CSV input. The returned shape intentionally mirrors
 * parseBatchInput so the generation flow can use either input mode.
 */
function parseBatchCsv(csvText, options = {}) {
  const maxItems = getMaxBatchItems(options);
  const parsedCsv = parseCsvRecords(csvText);
  const items = [];
  const errors = [...parsedCsv.errors];
  let headerPending = true;

  for (const record of parsedCsv.records) {
    const { line, fields } = record;

    if (isCsvRecordEmpty(fields)) {
      continue;
    }

    if (headerPending) {
      headerPending = false;
      if (isCsvHeader(fields)) {
        continue;
      }
    }

    if (fields.length > 2) {
      errors.push({
        line,
        reason: 'CSVはURLとファイル名の2列以内で指定してください。'
      });
      continue;
    }

    const url = (fields[0] ?? '').trim();
    const name = (fields[1] ?? '').trim();

    if (!url) {
      errors.push({
        line,
        reason: 'URLが空です。ファイル名だけの行は生成できません。'
      });
      continue;
    }

    const validation = validateHttpUrl(url);
    if (!validation.valid) {
      errors.push({ line, reason: validation.reason });
      continue;
    }

    items.push({ line, url: validation.value, name });
  }

  if (items.length > maxItems) {
    errors.push({
      line: null,
      reason: `生成できるURLは${maxItems}件までです（${items.length}件入力されています）。`
    });
  }

  errors.sort((left, right) => {
    if (left.line == null) return right.line == null ? 0 : 1;
    if (right.line == null) return -1;
    return left.line - right.line;
  });

  return {
    valid: errors.length === 0,
    items,
    entries: items,
    errors,
    count: items.length
  };
}

/** Decode a CSV file as UTF-8, falling back to Shift_JIS for Japanese files. */
function decodeCsvBytes(bytes) {
  let data;
  try {
    data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  } catch {
    throw new Error('CSVファイルのデータを読み込めません。');
  }

  const decoderConstructor = globalThis.TextDecoder;
  if (typeof decoderConstructor !== 'function') {
    throw new Error('この環境ではCSVの文字コードを判定できません。');
  }

  try {
    const text = new decoderConstructor('utf-8', { fatal: true }).decode(data);
    return text.replace(/^\uFEFF+/u, '');
  } catch {
    // Continue with the Japanese Windows encoding below.
  }

  try {
    const text = new decoderConstructor('shift_jis', { fatal: true }).decode(data);
    return text.replace(/^\uFEFF+/u, '');
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
    // Windows' path-component limit is measured in UTF-16 code units. Do
    // not split a surrogate pair when applying that limit.
    if (truncated.length + character.length > available) break;
    truncated += character;
  }
  truncated = stripTrailingDotsAndSpaces(truncated);
  return truncated || 'qr_code';
}

function sanitiseStem(value, fallback = 'qr_code') {
  const raw = String(value ?? '').trim();
  let stem = stripPngExtension(raw.replace(INVALID_FILENAME_CHARACTERS, '_'));
  stem = stripTrailingDotsAndSpaces(stem);

  if (!stem) {
    stem = fallback;
  }

  // Device names are not valid Windows filenames even when they have an
  // extension. Prefixing them keeps the resulting ZIP entries portable.
  if (isReservedWindowsName(stem)) {
    stem = `_${stem}`;
  }

  return truncateStem(stem);
}

/**
 * Convert a user-provided value to one safe, canonical PNG filename.
 * `.PNG`, `.Png`, etc. are recognised and normalised to one `.png` suffix.
 */
function sanitizePngFileName(value, fallback = 'qr_code') {
  return `${sanitiseStem(value, fallback)}.png`;
}

// Keep the spelling/naming variants convenient for callers and tests.
const sanitisePngFileName = sanitizePngFileName;
const sanitizeFileName = sanitizePngFileName;

/**
 * Create safe, case-insensitively unique names in input order.
 *
 * `items` may contain either `{url, name}` objects or plain strings. The
 * returned array contains filenames in the same order as the input.
 */
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

/** Add the resolved filename to each parsed item without mutating the input. */
function assignBatchFileNames(items) {
  const fileNames = createBatchFileNames(items);
  return items.map((item, index) => ({ ...item, fileName: fileNames[index] }));
}

  global.BatchUtils = Object.freeze({
    MAX_BATCH_ITEMS,
    MAX_FILENAME_LENGTH,
    splitInputLines,
    validateHttpUrl,
    isValidHttpUrl,
    parseBatchInput,
    sanitizePngFileName,
    sanitisePngFileName,
    sanitizeFileName,
    createBatchFileNames,
    makeUniqueFileNames,
    assignBatchFileNames
  });
})(window);
