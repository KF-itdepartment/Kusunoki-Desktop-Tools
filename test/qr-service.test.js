const test = require('node:test');
const assert = require('node:assert/strict');
const { generateQr, parseDataUri } = require('../electron/qr-service');

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
