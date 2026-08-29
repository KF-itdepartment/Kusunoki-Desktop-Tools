const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
