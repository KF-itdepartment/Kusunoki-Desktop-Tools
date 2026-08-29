const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('release workflow preserves 1.0.0 first release and gates tags behind tests', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /refs\/tags\/v\$\{current\}/);
  assert.match(workflow, /npm test[ \t]*\n[ \t]+npm run build/);
  assert.match(workflow, /git tag -a "\$tag"/);
  assert.match(workflow, /git push origin "\$tag"/);
  assert.match(workflow, /\[release-version\]/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /macos-latest/);
  assert.match(workflow, /ubuntu-latest/);
  assert.doesNotMatch(workflow, /npm version patch[\s\S]{0,300}git tag[\s\S]{0,30}npm test/);
});
