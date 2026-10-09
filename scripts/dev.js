const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const children = [];
function start(name, command, args) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', code => console.log(`[dev] ${name} exited code=${code}`));
  children.push(child);
  return child;
}

start('mock-backend', 'node', ['src/mock-backend/server.js', '--config', 'config/mock-backend.development.json']);
start('assistant-core', 'node', ['src/assistant/main.js', '--config', 'config/assistant.development.json']);
setTimeout(() => {
  start('browser-console', 'cmd', ['/c', 'start', '', 'http://127.0.0.1:8780/console']);
  start('desktop-wpf', 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'apps/desktop-wpf/Assistant.ps1']);
}, 1500);

function shutdown() {
  for (const child of children) {
    try { child.kill(); } catch {}
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);