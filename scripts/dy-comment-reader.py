# 抖音评论 API 读取助手（依赖 DouYin_Spider，配置 DYSPI_DIR 指向其检出目录）
# 输入：stdin 传 cookie 字符串；输出：JSON {works: [{aweme_id, video_url, title, comments: [{nickname, text, cid, create_time}]}]}
# 用法: echo "<cookie>" | python scripts/dy-comment-reader.py
import sys
import os
import json

def main():
    spider_dir = os.environ.get('DYSPI_DIR', '').strip()
    if not spider_dir or not os.path.isdir(spider_dir):
        print(json.dumps({'error': 'DYSPI_DIR 未设置或目录不存在'}))
        sys.exit(2)
    sys.path.insert(0, spider_dir)

    cookie = sys.stdin.read().strip()
    if not cookie:
        print(json.dumps({'error': '缺少 cookie'}))
        sys.exit(2)

    from dy_apis.douyin_api import DouyinAPI
    from builder.auth import DouyinAuth

    auth = DouyinAuth()
    auth.perepare_auth(cookie)

    my_uid = ''
    try:
        my_uid = str(DouyinAPI.get_my_uid(auth))
    except Exception:
        pass

    # 我的主页作品列表
    works = DouyinAPI.get_user_all_work_info(auth, 'https://www.douyin.com/user/self')
    out = []
    for w in works[:20]:
        aweme_id = str(w.get('aweme_id') or w.get('awemeId') or '')
        if not aweme_id:
            continue
        video_url = f'https://www.douyin.com/video/{aweme_id}'
        title = (w.get('desc') or w.get('title') or '')[:60]
        try:
            comments = DouyinAPI.get_work_all_comment(auth, video_url)
        except Exception:
            comments = []
        out.append({
            'aweme_id': aweme_id,
            'video_url': video_url,
            'title': title,
            'comments': [
                {
                    'nickname': (c.get('user') or {}).get('nickname', ''),
                    'uid': str((c.get('user') or {}).get('uid', '')),
                    'text': c.get('text', ''),
                    'cid': c.get('cid', ''),
                    'create_time': c.get('create_time', ''),
                    'ip_label': c.get('ip_label', ''),
                    # 是否已有作者（我）的回复
                    'replied_by_author': any(
                        str((rc.get('user') or {}).get('uid', '')) == my_uid
                        for rc in (c.get('reply_comment') or [])
                    ) if my_uid else False
                }
                for c in comments
            ]
        })
    print(json.dumps({'works': out, 'my_uid': my_uid}, ensure_ascii=False))

main()
