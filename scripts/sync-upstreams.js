const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const entries = [
  ['vendor/qr-generator', 'https://github.com/KF-itdepartment/QR-Generator.git'],
  ['vendor/pdf-editor', 'https://github.com/KF-itdepartment/pdf-editor.git']
];

for (const [relative, url] of entries) {
  const directory = path.join(root, relative);
  if (!fs.existsSync(path.join(directory, '.git'))) {
    console.warn(`${relative}: submodule is not checked out; run git submodule update --init`);
    continue;
  }
  console.log(`${relative}: ${url}`);
  try {
    execFileSync('git', ['-C', directory, 'fetch', '--quiet', 'origin', 'main'], { stdio: 'inherit' });
    execFileSync('git', ['-C', directory, 'status', '--short', '--branch'], { stdio: 'inherit' });
  } catch (error) {
    console.warn(`${relative}: unable to contact upstream; leaving the pinned checkout unchanged.`);
  }
}
