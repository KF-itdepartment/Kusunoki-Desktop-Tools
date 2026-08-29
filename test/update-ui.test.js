const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpdateViewModel, normalizePercent, normalizeStatus, STATUS } = require('../renderer/update-ui');

const context = { currentVersion: '1.0.0', latestVersion: '1.1.0' };

test('update UI maps every state to stable Japanese copy', () => {
  const checking = createUpdateViewModel({ status: 'checking' }, context);
  assert.equal(checking.description, '新しいバージョンがあるか確認しています');
  assert.equal(createUpdateViewModel({ status: 'none' }, context).description, 'このアプリは最新版です');
  assert.equal(createUpdateViewModel({ status: 'disabled' }, context).description, 'この開発版では更新できません。インストール済みの配布版で確認してください');
  assert.equal(createUpdateViewModel({ status: 'downloading', percent: 38 }, context).description, 'ダウンロードしています。そのままお待ちください');
  assert.equal(createUpdateViewModel({ status: 'installing' }, context).description, '更新を準備しています。アプリは自動で再起動します');
  assert.equal(createUpdateViewModel({ status: 'error', error: 'raw detail' }, context).description, '更新できませんでした。インターネット接続を確認して、もう一度お試しください');
});

test('available automatic and manual states expose the intended actions', () => {
  const automatic = createUpdateViewModel({ status: 'available', version: '1.1.0', mode: 'automatic' }, context);
  assert.equal(automatic.currentVersion, '1.0.0');
  assert.equal(automatic.latestVersion, '1.1.0');
  assert.deepEqual(automatic.primary, { label: '今すぐ更新', action: 'install' });
  assert.deepEqual(automatic.secondary, { label: 'あとで', action: 'close' });

  const manual = createUpdateViewModel({ status: 'available', version: '1.1.0', mode: 'manual' }, context);
  assert.deepEqual(manual.primary, { label: 'ダウンロードページを開く', action: 'install' });
  assert.deepEqual(manual.secondary, { label: 'あとで', action: 'close' });
});

test('error state exposes retry and fixed installer fallback without raw details', () => {
  const model = createUpdateViewModel({ status: 'error', mode: 'automatic', message: 'secret error', error: new Error('secret error') }, context);
  assert.deepEqual(model.primary, { label: 'もう一度確認', action: 'check' });
  assert.deepEqual(model.fallback, { label: 'インストーラーをダウンロード', action: 'open-installer' });
  assert.equal(JSON.stringify(model).includes('secret error'), false);
  assert.equal(JSON.stringify(model).includes('error'), true); // the internal state is retained only as a routing key
});

test('manual error keeps the release fallback and never offers Windows Setup', () => {
  const model = createUpdateViewModel({ status: 'error', mode: 'manual' }, context);
  assert.deepEqual(model.fallback, { label: 'Releaseページを開く', action: 'open-release' });
  assert.equal(model.fallback.action, 'open-release');
});

test('busy states disable closing and progress is normalized', () => {
  assert.equal(createUpdateViewModel({ status: 'downloading', percent: -20 }, context).canClose, false);
  const installing = createUpdateViewModel({ status: 'installing', percent: 12 }, context);
  assert.equal(installing.canClose, false);
  assert.equal(installing.percent, 100);
  assert.equal(normalizePercent(-1), 0);
  assert.equal(normalizePercent(101), 100);
  assert.equal(normalizePercent('48.5'), 48.5);
  assert.equal(normalizeStatus('progress'), STATUS.DOWNLOADING);
  assert.equal(normalizeStatus('unknown-internal-error'), STATUS.ERROR);
});
