// 一次性真机观测探针：用已登录 profile 打开抖音内容管理页，获取账号作品列表数据
// 用法：node scripts/probe-works-list.js <profileDir>
const path = require('node:path');
const { ManagedBrowser } = require('../src/assistant/browser/cdpClient');

const profileDir = process.argv[2] && path.resolve(process.argv[2]);
const manageUrl = 'https://creator.douyin.com/creator-micro/content/manage';
if (!profileDir) {
  console.error('usage: node scripts/probe-works-list.js <profileDir>');
  process.exit(1);
}

function printItems(items) {
  for (const item of items) {
    const m = item.metrics || {};
    const review = item.review?.status;
    const reviewNote = item.review?.details?.[0]?.text ? `（${item.review.details[0].text}）` : '';
    console.log([
      `item_id=${item.id}`,
      `时间=${new Date(Number(item.create_time) * 1000).toLocaleString('zh-CN')}`,
      `标题=${String(item.description || '').slice(0, 24)}`,
      `播放=${m.view_count} 点赞=${m.like_count} 评论=${m.comment_count} 分享=${m.share_count} 收藏=${m.favorite_count}`,
      `完播率=${m.completion_rate}`,
      `审核=${review}${reviewNote} 可见=${item.visibility?.status} 时长=${item.video_info?.duration}ms`
    ].join(' | '));
  }
}

async function main() {
  const browser = new ManagedBrowser({ browserName: 'edge', profileDir, logger: null });
  await browser.launch('about:blank');
  await browser.navigate(manageUrl);

  // 在已登录页面上下文直接请求内容管理列表接口（页面会话鉴权，无需额外签名）
  const raw = await browser.evaluate(`fetch('/web/api/creator/item/list?count=20&fields=visibility%2Cmetrics%2Creview&status_list%5B%5D=102&status_list%5B%5D=143&need_long_article=true', { credentials: 'include' }).then(r => r.text()).catch(e => 'FETCH_ERROR: ' + e.message)`, { awaitPromise: true });
  await browser.close();

  try {
    const json = JSON.parse(raw);
    if (json.BaseResp?.StatusCode !== 0 || !Array.isArray(json.items)) {
      console.log('接口返回非成功响应:', String(raw).slice(0, 300));
      process.exit(2);
    }
    console.log(`共 ${json.items.length} 条，has_more=${json.has_more}\n`);
    printItems(json.items);
  } catch {
    console.log('接口返回非 JSON:', String(raw).slice(0, 300));
    process.exit(2);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
