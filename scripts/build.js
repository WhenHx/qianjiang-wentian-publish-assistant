const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pkg = require('../package.json');

const root = path.resolve(__dirname, '..');
const name = `qianjiang-wentian-publish-assistant-${pkg.version}`;
const target = path.join(root, 'dist', name);
const zip = `${target}.zip`;

function copyFiltered(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (['node_modules', 'dist', 'runtime', '.git'].includes(entry)) continue;
      copyFiltered(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

fs.rmSync(target, { recursive: true, force: true });
fs.rmSync(zip, { force: true });
fs.mkdirSync(target, { recursive: true });
for (const item of ['package.json', 'package-lock.json', 'README.md', 'config', 'src', 'apps', 'assets', 'docs', 'scripts']) {
  const source = path.join(root, item);
  if (fs.existsSync(source)) copyFiltered(source, path.join(target, item));
}
fs.writeFileSync(path.join(target, 'BUILDINFO.json'), JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  built_at: new Date().toISOString(),
  node_version: process.version,
  platform: process.platform,
  arch: process.arch,
  signed: false,
  update: 'not implemented; production updater must verify trusted signature',
  cloud_connection_status: '仅模拟对接'
}, null, 2), 'utf8');
const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath ${JSON.stringify(target)} -DestinationPath ${JSON.stringify(zip)} -Force`], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
console.log(`BUILD_OK ${target}`);
console.log(`PACKAGE_OK ${zip}`);