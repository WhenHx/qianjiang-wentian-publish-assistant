// 监视三个平台 CDP 端口的登录状态：URL 离开登录页即判定已登录
// 用法: node scripts/watch-login.js
const PORTS = { 9301: '抖音', 9302: '视频号', 9303: '小红书' };
const loggedIn = {};

async function check(port) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ac.signal })).json();
    const page = targets.find(x => x.type === 'page');
    return page ? page.url : null;
  } catch { return null; } finally { clearTimeout(t); }
}

const isLogin = url => /login|passport|sso/i.test(url);

console.log('开始监视登录状态（每 10 秒检查一次）...');
const timer = setInterval(async () => {
  for (const [port, name] of Object.entries(PORTS)) {
    if (loggedIn[port]) continue;
    const url = await check(port);
    if (url === null) { continue; }
    if (!isLogin(url)) {
      loggedIn[port] = true;
      console.log(`[${name}] 已登录！当前页面: ${url.slice(0, 80)}`);
    }
  }
  if (Object.keys(loggedIn).length === 3) {
    console.log('三个平台全部登录完成');
    clearInterval(timer);
    process.exit(0);
  }
}, 10000);

setTimeout(() => { console.log('监视超时（30 分钟），退出'); process.exit(0); }, 30 * 60 * 1000);
