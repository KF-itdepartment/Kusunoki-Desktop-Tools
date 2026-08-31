'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  SHORTEN_ENDPOINT,
  UrlServiceError,
  shortenUrl,
  validateShortUrl
} = require('../electron/url-service');
const { createUrlShortenHandler } = require('../electron/main');

const longUrl = 'https://kusunokisai.com/?utm_source=twitter&utm_medium=qr&utm_campaign=kusunoki2026';
function response(status, body, contentType = 'application/json; charset=utf-8') {
  return { status, headers: new Headers({ 'content-type': contentType }), text: async () => body };
}
function okResponse(overrides = {}) {
  return response(200, JSON.stringify({ ok: true, shortUrl: 'https://x.gd/abc123', originalUrl: longUrl, analytics: true, filterbots: false, ...overrides }));
}

test('shortener posts only to the fixed Worker endpoint and returns validated shape', async () => {
  let call;
  const result = await shortenUrl({ longUrl, shortid: 'abc123' }, {
    fetchImpl: async (url, init) => {
      call = { url, init };
      return okResponse();
    }
  });
  assert.equal(call.url, SHORTEN_ENDPOINT);
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(JSON.parse(call.init.body), { longUrl, shortid: 'abc123' });
  assert.deepEqual(result, { shortUrl: 'https://x.gd/abc123', originalUrl: longUrl, analytics: true, filterbots: false });
});

test('shortener rejects invalid input and shortid boundaries before fetch', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return okResponse(); };
  for (const shortid of ['abcde', '1234567890123456', 'bad-id']) {
    await assert.rejects(() => shortenUrl({ longUrl, shortid }, { fetchImpl }), (error) => error instanceof UrlServiceError && error.code === 'invalid-input');
  }
  await assert.rejects(() => shortenUrl({ longUrl: 'ftp://example.com', shortid: '' }, { fetchImpl }), /HTTP|HTTPS/iu);
  assert.equal(called, false);
});

test('shortener maps HTTP, timeout, network, content type, JSON, size, and shape failures safely', async () => {
  const cases = [
    [400, response(400, JSON.stringify({ status: 400, message: 'secret body' })), 'http'],
    [401, response(401, JSON.stringify({ status: 401, message: 'secret key' })), 'http'],
    [403, response(403, JSON.stringify({ status: 403, message: 'secret body' })), 'http'],
    [409, response(409, JSON.stringify({ status: 409, message: 'secret body' })), 'http'],
    [429, response(429, JSON.stringify({ status: 429, message: 'secret body' })), 'http'],
    [500, response(500, JSON.stringify({ status: 500, message: 'secret body' })), 'http'],
    [503, response(503, JSON.stringify({ status: 503, message: 'secret body' })), 'http'],
    ['content-type', response(200, '{}', 'text/html'), 'content-type'],
    ['json', response(200, '{bad json'), 'invalid-json'],
    ['shape', response(200, JSON.stringify({ ok: true, shortUrl: 'https://evil.example/abc', originalUrl: longUrl, analytics: true, filterbots: false })), 'invalid-response'],
    ['oversized', response(200, 'x'.repeat(100)), 'too-large']
  ];
  for (const [label, fixture, code] of cases) {
    await assert.rejects(() => shortenUrl({ longUrl }, { fetchImpl: async () => fixture, maxResponseBytes: label === 'oversized' ? 32 : 64 * 1024 }), (error) => {
      assert.ok(error instanceof UrlServiceError, label);
      assert.equal(error.code, code, label);
      assert.doesNotMatch(error.message, /secret|key|body/iu, label);
      return true;
    });
  }
  await assert.rejects(() => shortenUrl({ longUrl }, { timeoutMs: 5, fetchImpl: () => new Promise(() => {}) }), (error) => error.code === 'timeout');
  await assert.rejects(() => shortenUrl({ longUrl }, { fetchImpl: async () => { throw new Error('secret socket details'); } }), (error) => error.code === 'network' && !/secret/iu.test(error.message));
});

test('shortener validates originalUrl and short URL host', async () => {
  assert.equal(validateShortUrl('https://x.gd/abc123'), 'https://x.gd/abc123');
  assert.equal(validateShortUrl('https://sub.x.gd/abc123'), 'https://sub.x.gd/abc123');
  for (const value of ['http://x.gd/abc123', 'https://x.gd.evil/abc123', 'https://x.gd/', 'javascript:alert(1)']) assert.throws(() => validateShortUrl(value), /不正/);
  await assert.rejects(() => shortenUrl({ longUrl }, { fetchImpl: async () => okResponse({ originalUrl: 'https://other.example/' }) }), /一致/);
});

test('IPC shortener returns a safe discriminable error envelope across invoke boundary', async () => {
  const senderFrame = {
    url: pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).toString()
  };
  const handler = createUrlShortenHandler(() => ({
    shorten: async () => { throw Object.assign(new Error('secret internal response'), { code: 'http', status: 409 }); }
  }));
  const result = await handler({ senderFrame }, { longUrl: 'https://example.com/page' });
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'http', status: 409, message: 'その短縮IDは既に使用されています。' }
  });
  assert.doesNotMatch(JSON.stringify(result), /secret|internal|response/iu);
});
