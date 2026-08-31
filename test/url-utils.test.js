'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const utils = require('../renderer/url-utils.js');

test('UTM builder preserves query/hash and replaces existing UTM values', () => {
  const result = utils.buildUtmUrl('https://example.com/path?a=1&utm_source=old&utm_medium=old&utm_campaign=old#section', {
    source: 'twitter',
    medium: 'qr',
    campaign: 'kusunoki2026'
  });
  const parsed = new URL(result);
  assert.equal(parsed.searchParams.get('a'), '1');
  assert.equal(parsed.searchParams.get('utm_source'), 'twitter');
  assert.equal(parsed.searchParams.get('utm_medium'), 'qr');
  assert.equal(parsed.searchParams.get('utm_campaign'), 'kusunoki2026');
  assert.equal(parsed.hash, '#section');
});

test('UTM builder uses generated upstream labels and requires custom other values', () => {
  const configSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'generated', 'upstream', 'url', 'config.js'), 'utf8');
  const context = { window: {} };
  vm.runInNewContext(configSource, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.KusunokiUrlConfig.sourceOptions)), utils.sourceOptions);
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.KusunokiUrlConfig.mediumOptions)), utils.mediumOptions);
  assert.throws(() => utils.buildUtmUrl('https://example.com', { source: 'other', medium: 'qr', campaign: 'x' }), /手入力/);
  assert.throws(() => utils.buildUtmUrl('https://example.com', { source: 'twitter', medium: 'other', campaign: 'x' }), /手入力/);
  assert.match(utils.buildUtmUrl('https://example.com', { source: 'other', sourceCustom: 'event', medium: 'other', mediumCustom: 'offline', campaign: 'x' }), /utm_source=event/);
});

test('UTM input and shortid validation enforce HTTP(S), defaults, and boundaries', () => {
  assert.deepEqual(utils.DEFAULTS, { baseUrl: 'https://kusunokisai.com', source: 'twitter', medium: 'qr', campaign: 'kusunoki2026' });
  assert.equal(utils.validateShortid('abcdef'), 'abcdef');
  assert.equal(utils.validateShortid('123456789012345'), '123456789012345');
  assert.equal(utils.validateShortid(''), '');
  for (const value of ['abcde', '1234567890123456', 'abc-def', '日本語']) assert.throws(() => utils.validateShortid(value), /shortid/iu);
  for (const value of ['ftp://example.com', 'javascript:alert(1)', 'not a url']) assert.throws(() => utils.buildUtmUrl(value, { source: 'twitter', medium: 'qr', campaign: 'x' }), /HTTP|HTTPS|URL/iu);
});
