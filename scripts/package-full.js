const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pkg = require('../package.json');

const root = path.resolve(__dirname, '..');
const name = `qianjiang-wentian-assistant-${pkg.version}`;
const target = path.join(root, 'dist', name);
const zip = `${target}.zip`;

function copyFiltered(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (['node_modules', 'dist', 'runtime', '.git', 'acceptance'].includes(entry)) continue;
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

const appDir = path.join(target, 'app');
for (const item of ['package.json', 'README.md', 'config', 'src', 'apps', 'assets']) {
  const source = path.join(root, item);
  if (fs.existsSync(source)) copyFiltered(source, path.join(appDir, item));
}

fs.mkdirSync(path.join(target, 'runtime'), { recursive: true });
fs.copyFileSync(process.execPath, path.join(target, 'runtime', 'node.exe'));

fs.writeFileSync(path.join(target, '启动模拟云端.cmd'), [
  '@echo off',
  'cd /d %~dp0app',
  '..\\runtime\\node.exe src\\mock-backend\\server.js --config config\\mock-backend.development.json',
  'pause'
].join('\r\n'), 'utf8');

fs.writeFileSync(path.join(target, '启动发布助手.cmd'), [
  '@echo off',
  'cd /d %~dp0app',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps\\desktop-wpf\\Assistant.ps1 -Config config\\assistant.cdp-auto.json',
  'pause'
].join('\r\n'), 'utf8');

fs.writeFileSync(path.join(target, 'install.cmd'), [
  '@echo off',
  'echo 千匠问天发布助手（测试版，未签名）',
  'echo.',
  'echo 本安装脚本将把助手注册为当前用户的开机自启动项。',
  'set /p CONFIRM=确认注册开机自启动？[Y/N] ',
  'if /i "%CONFIRM%"=="Y" (',
  '  powershell.exe -NoProfile -Command "Set-ItemProperty -Path \'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\' -Name \'QianjiangWentianAssistant\' -Value (\'powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File \\\"\' + (Resolve-Path \'app\\apps\\desktop-wpf\\Assistant.ps1\') + \'\\\" -Config \\\"config\\assistant.cdp-auto.json\\\"\')"',
  '  echo 已注册开机自启动。',
  ') else (',
  '  echo 跳过开机自启动。可双击 启动发布助手.cmd 手动运行。',
  ')',
  'pause'
].join('\r\n'), 'utf8');

fs.writeFileSync(path.join(target, 'uninstall.cmd'), [
  '@echo off',
  'powershell.exe -NoProfile -Command "Remove-ItemProperty -Path \'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\' -Name \'QianjiangWentianAssistant\' -ErrorAction SilentlyContinue"',
  'echo 已移除开机自启动项。程序目录可手动删除。',
  'pause'
].join('\r\n'), 'utf8');

fs.writeFileSync(path.join(target, 'README.txt'), [
  '千匠问天发布助手 测试包（未签名）',
  `版本：${pkg.version}`,
  '',
  '运行要求：Windows 10/11 x64，Edge 或 Chrome。无需安装 Node.js（已内置便携运行时）。',
  '',
  '使用：',
  '1. 启动模拟云端.cmd（本地联调环境；接真实问天后不需要）',
  '2. 启动发布助手.cmd（托盘常驻，双击托盘图标查看状态）',
  '3. install.cmd 可选注册开机自启动',
  '',
  '注意：本包未签名，Windows 可能提示 SmartScreen 警告。',
  '模拟模式仅用于联调，不代表真实发布成功。',
  '真实平台操作仅限用户明确授权的测试账号。'
].join('\r\n'), 'utf8');

fs.writeFileSync(path.join(target, 'BUILDINFO.json'), JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  built_at: new Date().toISOString(),
  node_version: process.version,
  bundled_runtime: 'node.exe (portable, unsigned)',
  signed: false,
  cloud_connection_status: '仅模拟对接；问天接口已预留并通过模拟联调'
}, null, 2), 'utf8');

const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath ${JSON.stringify(target)} -DestinationPath ${JSON.stringify(zip)} -Force`], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
console.log(`FULL_PACKAGE_OK ${zip}`);
