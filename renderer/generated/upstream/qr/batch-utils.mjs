/**
 * Pure helpers used by the browser's batch QR-code flow.
 *
 * Keeping parsing, URL validation, and filename handling here makes the
 * browser workflow easy to test without a DOM (and keeps the rules shared by
 * all callers).
 */

export const MAX_BATCH_ITEMS = 100;
// Windows permits 255 characters in one path component. Leave room for a
// suffix added when names collide and for the .png extension.
export const MAX_FILENAME_LENGTH = 240;

const INVALID_FILENAME_CHARACTERS = /[\p{Cc}<>:"\/\\|?*]/gu;
const TRAILING_DOTS_AND_SPACES = /[. ]+$/u;
const PNG_EXTENSION = /\.png$/iu;

/** Split textarea contents while preserving physical line correspondence. */
export function splitInputLines(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n').split('\n');
}

/**
 * Validate an absolute HTTP(S) URL.
 *
 * The returned object contains a user-facing reason so callers can display a
 * useful row-level error without having to duplicate the validation rules.
 */
export function validateHttpUrl(value) {
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

export function isValidHttpUrl(value) {
  return validateHttpUrl(value).valid;
}

/**
 * Parse the two line-oriented batch inputs.
 *
 * Empty URL/name pairs are ignored. A name without a URL is an error, while a
 * URL without a name is a valid item whose name is derived from the URL later.
 */
export function parseBatchInput(urlText, nameText, options = {}) {
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
export function sanitizePngFileName(value, fallback = 'qr_code') {
  return `${sanitiseStem(value, fallback)}.png`;
}

// Keep the spelling/naming variants convenient for callers and tests.
export const sanitisePngFileName = sanitizePngFileName;
export const sanitizeFileName = sanitizePngFileName;

/**
 * Create safe, case-insensitively unique names in input order.
 *
 * `items` may contain either `{url, name}` objects or plain strings. The
 * returned array contains filenames in the same order as the input.
 */
export function createBatchFileNames(items) {
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

export const makeUniqueFileNames = createBatchFileNames;

/** Add the resolved filename to each parsed item without mutating the input. */
export function assignBatchFileNames(items) {
  const fileNames = createBatchFileNames(items);
  return items.map((item, index) => ({ ...item, fileName: fileNames[index] }));
}
