const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('release workflow preserves 1.0.0 first release and gates tags behind tests', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /refs\/tags\/\$\{tag\}/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run pack/);
  assert.match(workflow, /needs\.prepare\.outputs\.sha/);
  assert.match(workflow, /git tag -a "\$\{tag\}" "\$\{RELEASE_SHA\}"/);
  assert.match(workflow, /git push origin "\$\{tag\}"/);
  assert.match(workflow, /\[release-version\]/);
  assert.match(workflow, /\[skip ci\]/);
  assert.match(workflow, /npm version "\$\{\{ needs\.prepare\.outputs\.version \}\}" --no-git-tag-version --allow-same-version/u);
  assert.match(workflow, /npm version "\$\{RELEASE_VERSION\}" --no-git-tag-version --allow-same-version/u);
  assert.match(workflow, /candidate="\$\{current\}"/u);
  assert.match(workflow, /skip: \$\{\{ steps\.version\.outputs\.skip \}\}/u);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /macos-latest/);
  assert.match(workflow, /ubuntu-latest/);
  const publishIndex = workflow.indexOf('\n  publish:');
  const tagIndex = workflow.indexOf('git tag -a');
  assert.ok(publishIndex >= 0 && tagIndex > publishIndex, 'release tag must be created only in publish');
  const prepareSection = workflow.slice(0, workflow.indexOf('\n  build:'));
  assert.doesNotMatch(prepareSection, /git tag|git commit|git push/u);
  assert.match(workflow, /build:\n    needs: prepare\n    if: \$\{\{ needs\.prepare\.outputs\.skip != 'true' \}\}/u);
  assert.match(workflow, /publish:\n    needs: \[prepare, build\]\n    if: \$\{\{ needs\.prepare\.outputs\.skip != 'true' \}\}/u);
  assert.match(workflow, /head_subject[\s\S]{0,500}\[release-version\][\s\S]{0,500}skip=true/u);
  assert.match(workflow, /git diff --quiet -- package\.json package-lock\.json/u);
  assert.match(workflow, /git push origin HEAD:main/u);
  assert.match(workflow, /Ensure main did not advance during the build gate/u);
  assert.doesNotMatch(workflow, /npm version patch[\s\S]{0,300}git tag[\s\S]{0,30}npm test/);
  assert.doesNotMatch(workflow, /submodules:\s*recursive/u);
});

test('macOS release packages both explicit architectures and validates safe updater metadata', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const macStart = workflow.indexOf('      - name: Package macOS x64 and arm64 DMG');
  const linuxStart = workflow.indexOf('      - name: Package Linux x64 AppImage');
  assert.ok(macStart >= 0 && linuxStart > macStart, 'macOS packaging step must precede Linux packaging');
  assert.equal(packageJson.build.mac.artifactName, '${productName}-${version}-${arch}.${ext}');
  assert.deepEqual(packageJson.build.mac.target[0].arch.slice().sort(), ['arm64', 'x64']);
  const macSection = workflow.slice(macStart, linuxStart);
  assert.match(macSection, /npm run pack -- --publish never --mac dmg --x64 --arm64/u);
  assert.match(macSection, /Verify macOS architecture-specific DMGs and metadata/u);
  assert.match(macSection, /x64_dmgs=\(dist\/\*-x64\.dmg\)/u);
  assert.match(macSection, /arm64_dmgs=\(dist\/\*-arm64\.dmg\)/u);
  assert.match(macSection, /test "\$\{#x64_dmgs\[@\]\}" -eq 1/u);
  assert.match(macSection, /test "\$\{#arm64_dmgs\[@\]\}" -eq 1/u);
  assert.match(macSection, /test -s dist\/latest-mac\.yml/u);
  assert.match(macSection, /metadata_matches=0/u);
  assert.match(macSection, /for dmg in "\$\{x64_dmgs\[0\]\}" "\$\{arm64_dmgs\[0\]\}"/u);
  assert.match(macSection, /grep -F -q -- "\$\(basename "\$\{dmg\}"\)" dist\/latest-mac\.yml/u);
  assert.match(macSection, /test "\$\{metadata_matches\}" -ge 1/u);
  assert.match(workflow, /files:\s+release-assets\/\*\*/u);
});

test('public CI and release use committed generated artifacts without private submodules', () => {
  const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const release = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.doesNotMatch(ci, /submodules:/u);
  assert.doesNotMatch(release, /submodules:/u);
  assert.match(ci, /KUSUNOKI_STAGE_FALLBACK/);
});

test('Linux Electron smoke keeps the Chromium sandbox enabled', () => {
  const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /Configure Chromium sandbox helper \(Linux\)/u);
  assert.match(ci, /if: runner\.os == 'Linux'/u);
  assert.match(ci, /sandbox_path="node_modules\/electron\/dist\/chrome-sandbox"/u);
  assert.match(ci, /sudo chown root:root "\$sandbox_path"/u);
  assert.match(ci, /sudo chmod 4755 "\$sandbox_path"/u);
  assert.match(ci, /stat -c '%u:%g'/u);
  assert.match(ci, /stat -c '%a'/u);
  assert.doesNotMatch(ci, /--no-sandbox/u);
});

test('upstream sync gates private checkout on read-only UPSTREAM_TOKEN', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'sync-upstreams.yml'), 'utf8');
  assert.match(workflow, /UPSTREAM_TOKEN/);
  assert.match(workflow, /private upstream sync disabled/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /repository: KF-itdepartment\/QR-Generator/);
  assert.match(workflow, /repository: KF-itdepartment\/pdf-editor/);
  assert.match(workflow, /token: \$\{\{ secrets\.UPSTREAM_TOKEN \}\}/);
  assert.match(workflow, /git add \.gitmodules vendor\/qr-generator vendor\/pdf-editor renderer\/generated renderer\/vendor\/MANIFEST\.json/);
  assert.doesNotMatch(workflow, /submodules:\s*recursive/u);
});
