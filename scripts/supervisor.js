// 统一监管器：独立拉起各服务进程，崩溃自动重启（各自独立，互不影响）
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');

const SERVICES = [
  {
    name: 'mock-backend',
    command: 'node',
    args: ['src/mock-backend/server.js', '--config', 'config/mock-backend.development.json'],
    enabled: process.env.WITH_MOCK !== '0'
  },
  {
    name: 'assistant-core',
    command: 'node',
    args: ['src/assistant/main.js', '--config', process.env.ASSISTANT_CONFIG || 'config/assistant.cdp-auto.json'],
    enabled: true
  },
  {
    name: 'wechat-bot',
    command: path.join(root, 'services/wechat-bot/.venv/Scripts/python.exe'),
    args: ['bot.py'],
    cwd: path.join(root, 'services/wechat-bot'),
    enabled: process.env.WITH_WECHAT !== '0' && fs.existsSync(path.join(root, 'services/wechat-bot/.venv/Scripts/python.exe')) && fs.existsSync(path.join(root, 'services/wechat-bot/config.json'))
  }
];

const children = new Map();

function startService(svc) {
  const child = spawn(svc.command, svc.args, {
    cwd: svc.cwd || root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.on('data', d => process.stdout.write(`[${svc.name}] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[${svc.name}] ${d}`));
  child.on('exit', code => {
    console.log(`[supervisor] ${svc.name} 退出 code=${code}`);
    children.delete(svc.name);
    if (stopping) return;
    const delay = Math.min((svc._restarts || 0) * 5000 + 3000, 60000);
    svc._restarts = (svc._restarts || 0) + 1;
    console.log(`[supervisor] ${svc.name} ${delay / 1000}s 后自动重启`);
    setTimeout(() => { if (!stopping) startService(svc); }, delay);
  });
  children.set(svc.name, child);
  console.log(`[supervisor] ${svc.name} 已启动 pid=${child.pid}`);
}

let stopping = false;
function shutdown() {
  stopping = true;
  for (const child of children.values()) {
    try { child.kill(); } catch {}
  }
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

for (const svc of SERVICES) {
  if (svc.enabled) startService(svc);
  else console.log(`[supervisor] ${svc.name} 未启用（缺环境或被关闭）`);
}
console.log('[supervisor] 全部服务已拉起，Ctrl+C 统一停止');
