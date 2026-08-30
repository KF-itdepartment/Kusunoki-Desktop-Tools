const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ONLINE_API_URL,
  OnlineQrError,
  buildOnlineRequestUrl,
  generateQr,
  generateQrByMode,
  generateQrOnline,
  parseDataUri
} = require('../electron/qr-service');

const onePixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('QR SVG is generated locally with high correction and optional logo', async () => {
  const result = await generateQr({ text: 'https://example.com', noLogo: true }, process.cwd());
  assert.equal(result.mimeType, 'image/svg+xml');
  assert.match(result.svg, /<svg/i);
  assert.match(result.svg, /viewBox=/i);
  const withLogo = await generateQr({ text: 'hello', logoDataUrl: onePixel, angle: 45 }, process.cwd());
  assert.match(withLogo.svg, /<image href="data:image\/png;base64,/i);
  assert.match(withLogo.svg, /rotate\(45\)/i);
  const customDefault = await generateQr({ text: 'hello', logoDataUrl: onePixel }, process.cwd());
  assert.match(customDefault.svg, /rotate\(0\)/i);
});

test('QR input and logo data URLs are validated', async () => {
  await assert.rejects(() => generateQr({ text: '' }, process.cwd()), /入力/);
  await assert.rejects(() => generateQr({ text: 'x', logoDataUrl: 'https://example.com/logo.png' }, process.cwd()), /data URL/);
  assert.match(parseDataUri(onePixel), /^data:image\/png;base64,/);
  assert.throws(() => parseDataUri('data:text/html;base64,AAAA'), /画像/);
});

test('default QR logo falls back to the committed generated upstream copy', async () => {
  const root = path.join(__dirname, '..');
  const logo = fs.readFileSync(path.join(root, 'renderer', 'generated', 'upstream', 'qr', 'logo.png'));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kusunoki-logo-fallback-'));
  const generatedLogo = path.join(fixture, 'renderer', 'generated', 'upstream', 'qr', 'logo.png');
  fs.mkdirSync(path.dirname(generatedLogo), { recursive: true });
  fs.copyFileSync(path.join(root, 'renderer', 'generated', 'upstream', 'qr', 'logo.png'), generatedLogo);
  try {
    const result = await generateQr({ text: 'default-logo-check' }, fixture);
    const match = /<image href="data:image\/png;base64,([^"]+)"/iu.exec(result.svg);
    assert.ok(match, 'default SVG should contain an embedded logo image');
    assert.deepEqual(Buffer.from(match[1], 'base64'), logo);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function svgResponse(svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>', contentType = 'image/svg+xml') {
  return {
    status: 200,
    headers: new Headers({ 'content-type': contentType }),
    text: async () => svg
  };
}

test('online QR uses the fixed API and normalises a valid SVG response', async () => {
  let request;
  const result = await generateQrOnline({ text: 'https://example.com/a?x=1', noLogo: true, angle: 45 }, process.cwd(), {
    fetchImpl: async (url, init) => {
      request = { url, init };
      return svgResponse();
    }
  });
  assert.equal(result.mimeType, 'image/svg+xml');
  assert.equal(result.text, 'https://example.com/a?x=1');
  assert.equal(result.svg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.ok(request.url.startsWith(ONLINE_API_URL));
  assert.match(request.url, /[?&]text=https%3A%2F%2Fexample\.com%2Fa%3Fx%3D1/u);
  assert.match(request.url, /[?&]noLogo=true/u);
  assert.equal(request.init.headers.Accept, 'image/svg+xml');
  assert.equal(buildOnlineRequestUrl({ text: 'x' }).origin, new URL(ONLINE_API_URL).origin);
});

test('online QR rejects network, HTTP, content-type, empty, oversized, and broken responses safely', async () => {
  const cases = [
    { name: 'network', fetchImpl: async () => { throw new Error('secret socket details'); }, code: 'network' },
    { name: 'http', fetchImpl: async () => ({ status: 503, headers: new Headers({ 'content-type': 'text/plain' }), text: async () => 'secret body' }), code: 'http' },
    { name: 'content-type', fetchImpl: async () => svgResponse('<svg></svg>', 'text/html'), code: 'content-type' },
    { name: 'empty', fetchImpl: async () => svgResponse(''), code: 'empty' },
    { name: 'broken svg', fetchImpl: async () => svgResponse('<svg>'), code: 'invalid-svg' },
    { name: 'oversized', fetchImpl: async () => svgResponse(`<svg>${'x'.repeat(2 * 1024 * 1024)}</svg>`), code: 'too-large' }
  ];
  for (const entry of cases) {
    await assert.rejects(
      () => generateQrOnline({ text: 'x' }, process.cwd(), { fetchImpl: entry.fetchImpl }),
      (error) => {
        assert.ok(error instanceof OnlineQrError);
        assert.equal(error.code, entry.code);
        assert.doesNotMatch(error.message, /secret/u);
        return true;
      },
      entry.name
    );
  }
});

test('online timeout is bounded and offline mode never invokes fetch', async () => {
  await assert.rejects(
    () => generateQrOnline({ text: 'x' }, process.cwd(), { timeoutMs: 5, fetchImpl: () => new Promise(() => {}) }),
    (error) => error instanceof OnlineQrError && error.code === 'timeout'
  );
  let called = false;
  const result = await generateQrByMode({ text: 'offline-check', mode: 'offline', noLogo: true }, process.cwd(), {
    fetchImpl: async () => { called = true; return svgResponse(); }
  });
  assert.equal(called, false);
  assert.match(result.svg, /<svg/iu);
  await assert.rejects(() => generateQrByMode({ text: 'x', mode: 'invalid' }, process.cwd()), /モード/u);
});
