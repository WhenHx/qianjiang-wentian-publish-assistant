// 抖音评论 API 读取：从已登录 CDP 浏览器导出 cookie，调 DouYin_Spider 的 web API 读取全部作品评论。
// 依赖：外部 Python 环境 + DouYin_Spider 检出（config.interaction.dyspider 配置路径），见 scripts/dy-comment-reader.py。
// 该路径仅做"读"；写（回复）仍走视频页 UI（已真机验证）。
const { spawn } = require('node:child_process');
const path = require('node:path');

const READER_SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'dy-comment-reader.py');

async function exportDouyinCookie(page) {
  await page.send('Network.enable').catch(() => {});
  const r = await page.send('Network.getAllCookies');
  const cookies = (r.cookies || []).filter(c => (c.domain || '').includes('douyin'));
  if (!cookies.length) throw new Error('未能从浏览器导出抖音 cookie（登录态可能失效）');
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

function runReader(pythonPath, spiderDir, cookie) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [READER_SCRIPT], {
      env: { ...process.env, DYSPI_DIR: spiderDir, PYTHONIOENCODING: 'utf-8' },
      timeout: 180000
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`评论读取脚本退出码 ${code}: ${stderr.slice(0, 200)}`));
      try {
        const data = JSON.parse(stdout);
        if (data.error) return reject(new Error(data.error));
        resolve(data.works || []);
      } catch (e) {
        reject(new Error(`评论读取输出解析失败: ${e.message}`));
      }
    });
    child.stdin.write(cookie);
    child.stdin.end();
  });
}

// 返回 { works: [{ awemeId, videoUrl, title, comments: [...] }], myUid }
async function readDouyinComments({ page, spiderDir, pythonPath }) {
  const cookie = await exportDouyinCookie(page);
  const data = await runReader(pythonPath, spiderDir, cookie);
  return { works: data.works || [], myUid: data.my_uid || '' };
}

module.exports = { readDouyinComments, exportDouyinCookie };
