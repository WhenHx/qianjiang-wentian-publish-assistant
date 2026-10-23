// 私信/评论入口探针：用平台已登录的浏览器 profile 启动 Edge（CDP），
// 逐个导航候选 URL，截图并提取页面关键文本，判断该平台的网页端私信/评论管理是否可用。
// 只读探测：不点击任何发送类按钮，不输入内容。
// 用法: node scripts/probe-dm-pages.js <platform>
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./cdp-probe-helper');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'acceptance', '探测-私信入口');
const PROFILES = {
  douyin: 'acctprofile_y55i3h78M754CRAK',
  shipinhao: 'acctprofile_kCXgJqS7P2LfT_s2',
  xiaohongshu: 'acctprofile_7zWJ7HaWgNcN1Htc',
};
const CANDIDATES = {
  douyin: [
    'https://www.douyin.com/',
    'https://creator.douyin.com/creator-micro/interactive/comment',
  ],
  shipinhao: [
    'https://channels.weixin.qq.com/platform',
  ],
  xiaohongshu: [
    'https://pro.xiaohongshu.com/',
    'https://creator.xiaohongshu.com/',
  ],
};

const KEYWORDS = ['私信', '消息', '评论', '回复', '聊天'];

function getFreePort() {
  const net = require('node:net');
  return new Promise(resolve => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function findEdge() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Edge');
}

async function main() {
  const platform = process.argv[2];
  if (!CANDIDATES[platform]) {
    console.error('支持的平台:', Object.keys(CANDIDATES).join(', '));
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const profileDir = path.join(ROOT, 'runtime/assistant-data-cdp/profiles', PROFILES[platform]);
  const port = await getFreePort();
  const edge = spawn(findEdge(), [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-popup-blocking',
    'about:blank'
  ], { stdio: 'ignore', windowsHide: false });

  const cleanup = () => { try { edge.kill(); } catch {} };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  try {
    // 等 CDP 就绪
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`);
        ready = true; break;
      } catch { await new Promise(r => setTimeout(r, 500)); }
    }
    if (!ready) throw new Error('CDP 端口未就绪');

    const cdp = await connect(port, 'about:blank').catch(() => connect(port, ''));
    for (const url of CANDIDATES[platform]) {
      console.log(`\n=== 导航: ${url}`);
      await cdp.send('Page.navigate', { url });
      await new Promise(r => setTimeout(r, 8000));
      const info = await cdp.evaluate(`(() => {
        const text = (document.body && document.body.innerText || '').slice(0, 3000);
        const links = [...document.querySelectorAll('a')].map(a => (a.innerText || '').trim() + ' -> ' + a.href)
          .filter(s => ${JSON.stringify(KEYWORDS)}.some(k => s.includes(k))).slice(0, 20);
        const hits = ${JSON.stringify(KEYWORDS)}.map(k => k + ':' + (text.includes(k) ? '有' : '无')).join(' ');
        return { title: document.title, url: location.href, hits, links, textHead: text.slice(0, 600) };
      })()`);
      console.log('标题:', info.title, '| 最终URL:', info.url);
      console.log('关键词:', info.hits);
      if (info.links.length) console.log('相关链接:', info.links);
      console.log('正文片段:', (info.textHead || '').replace(/\s+/g, ' ').slice(0, 300));
      const shot = path.join(OUT, `${platform}-${url.replace(/[^a-z0-9]/gi, '_').slice(0, 60)}.png`);
      await cdp.screenshot(shot);
    }
    cdp.close();
  } finally {
    cleanup();
  }
}

main().catch(e => { console.error('探测失败:', e.message); process.exit(1); });
