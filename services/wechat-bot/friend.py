"""好友管理：自动通过申请 + 主动加好友。

基于免费版 wxauto4 的 UIA 层实现，在微信 4.1.13 上实测校准：
- 通讯录列表：ListControl AutomationId='primary_table_.contact_list'
- 「新的朋友」分组项：ListItemControl Name='新的朋友'，点击后内联展开
- 申请条目：ListItemControl ClassName='mmui::ContactsCellNewFriendView'，
  文本为「昵称+验证消息+状态」拼接（如 "阿闯我: 我是小兵二二已添加"），
  已处理的带状态后缀（已添加/已过期），无后缀的视为待处理
- 主动加好友入口：会话页「快捷操作」→「添加朋友」→ mmui::AddFriendWindow 独立窗口，
  搜索框输入（必须用剪贴板粘贴，SendKeys 对 MMUI 输入框无效）→「搜索」按钮；
  无结果时显示「找不到相关账号或内容」

待校准（需要真实场景触发后才能验证，失败均为安全方向：不动作 + 记日志）：
- 通过按钮的确切文案（候选：通过验证/接受/同意）及确认弹窗的「完成」按钮
- 「搜索网络结果」点击后的资料页「添加到通讯录」按钮与申请弹窗
"""
import json
import logging
import time
from pathlib import Path

logger = logging.getLogger("wechat-llm-bot.friend")

STATE_FILE = Path(__file__).parent / "friend_state.json"
MAIN_WINDOW_CLASS = "mmui::MainWindow"
CONTACT_LIST_AID = "primary_table_.contact_list"
NEW_FRIEND_GROUP = "新的朋友"
NEW_FRIEND_CELL_CLASS = "mmui::ContactsCellNewFriendView"
DONE_STATUSES = ("已添加", "已过期", "已忽略")
ACCEPT_BUTTON_NAMES = ("通过验证", "接受", "同意")
CONFIRM_BUTTON_NAMES = ("完成", "确定")


def _uia():
    from wxauto4 import uia
    return uia


class FriendManager:
    def __init__(self, wx, cfg, llm=None, on_new_friend=None):
        self.wx = wx
        self.cfg = cfg
        self.llm = llm
        self.on_new_friend = on_new_friend
        self.enabled = bool(cfg.get("enabled"))

    # ---------- 内部工具 ----------

    def _main_window(self):
        return _uia().WindowControl(ClassName=MAIN_WINDOW_CLASS, searchDepth=1)

    def _contact_list(self):
        self.wx.SwitchToContact()
        time.sleep(1.2)
        lst = self._main_window().ListControl(AutomationId=CONTACT_LIST_AID, searchDepth=15)
        if not lst.Exists(3):
            raise RuntimeError("找不到通讯录列表控件")
        return lst

    def _new_friend_cells(self):
        lst = self._contact_list()
        cells = [c for c in lst.GetChildren() if getattr(c, "ClassName", "") == NEW_FRIEND_CELL_CLASS]
        if not cells:
            group = lst.ListItemControl(Name=NEW_FRIEND_GROUP, searchDepth=3)
            if group.Exists(2):
                group.Click()
                time.sleep(1.0)
                cells = [c for c in lst.GetChildren() if getattr(c, "ClassName", "") == NEW_FRIEND_CELL_CLASS]
        return cells

    @staticmethod
    def _parse_cell_name(text):
        """从拼接文本提取昵称：在 '我: '/'我是' 或状态后缀前截断。"""
        for sep in ("我: ", "我是"):
            idx = text.find(sep)
            if idx > 0:
                return text[:idx]
        for st in DONE_STATUSES:
            if text.endswith(st):
                return text[: -len(st)]
        return text

    def _load_state(self):
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _save_state(self, state):
        STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    def _daily_count(self):
        state = self._load_state()
        today = time.strftime("%Y-%m-%d")
        return state.get("add_count", 0) if state.get("date") == today else 0

    def _incr_daily_count(self):
        state = self._load_state()
        today = time.strftime("%Y-%m-%d")
        state["date"] = today
        state["add_count"] = (state.get("add_count", 0) if state.get("date") == today or "add_count" in state else 0) + 1
        self._save_state(state)

    def _welcome_text(self, name):
        if self.cfg.get("welcome_use_llm") and self.llm:
            try:
                return self.llm.chat([{"role": "user", "content": f"你刚通过微信好友「{name}」的申请，写一句简短自然的开场白（50 字以内，不要解释你是谁）"}])
            except Exception as e:
                logger.warning("LLM 欢迎语生成失败，退回模板: %s", e)
        return self.cfg.get("welcome_message") or ""

    # ---------- 自动通过 ----------

    def list_pending_requests(self):
        """只读列出待处理的好友申请原文（不改变任何状态）。"""
        if not self.enabled:
            return []
        try:
            cells = self._new_friend_cells()
        except Exception as e:
            logger.warning("读取新的朋友列表失败: %s", e)
            return []
        return [c.Name for c in cells if c.Name and not any(st in c.Name for st in DONE_STATUSES)]

    def _accept_cell(self, cell, remark=None):
        """点击待处理申请并尝试通过。返回 True/False。"""
        cell.Click()
        time.sleep(1.2)
        win = self._main_window()
        accept = None
        for name in ACCEPT_BUTTON_NAMES:
            btn = win.ButtonControl(Name=name, searchDepth=15)
            if btn.Exists(1):
                accept = btn
                break
        if not accept:
            logger.warning("未找到通过按钮（候选 %s），该版本文案待校准，跳过", ACCEPT_BUTTON_NAMES)
            return False
        accept.Click()
        time.sleep(1.2)
        # 确认弹窗：可填备注，点完成/确定
        for name in CONFIRM_BUTTON_NAMES:
            done = win.ButtonControl(Name=name, searchDepth=15)
            if done.Exists(1):
                if remark:
                    try:
                        edit = win.EditControl(searchDepth=15)
                        if edit.Exists(1):
                            edit.Click()
                            edit.SendKeys(remark, interval=0.02)
                    except Exception as e:
                        logger.warning("填写备注失败（不影响通过）: %s", e)
                done.Click()
                return True
        # 没有确认弹窗则视为已通过
        return True

    def sync_new_friends(self):
        """轮询新的朋友列表，自动通过待处理申请。返回本次通过的好友名列表。"""
        if not self.enabled or not self.cfg.get("auto_accept", True):
            return []
        accepted = []
        try:
            cells = self._new_friend_cells()
        except Exception as e:
            logger.warning("读取新的朋友列表失败: %s", e)
            return []
        for cell in cells:
            try:
                text = cell.Name or ""
                if any(st in text for st in DONE_STATUSES):
                    continue
                name = self._parse_cell_name(text)
                remark_tpl = self.cfg.get("accept_remark_template") or ""
                remark = remark_tpl.format(name=name) if remark_tpl else None
                if not self._accept_cell(cell, remark=remark):
                    continue
                logger.info("已通过好友申请: %s", name)
                accepted.append(name)
                welcome = self._welcome_text(name)
                if welcome and name:
                    time.sleep(1)
                    self.wx.ChatWith(name)
                    time.sleep(0.5)
                    self.wx.SendMsg(welcome)
                    logger.info("已发送欢迎语给 %s", name)
                if name and self.on_new_friend:
                    self.on_new_friend(name)
            except Exception as e:
                logger.warning("通过好友申请失败: %s", e)
        return accepted

    # ---------- 主动加好友 ----------

    def add_friend(self, keywords, addmsg=None, remark=None, tags=None):
        """主动加好友（快捷操作 → 添加朋友 → 搜索 → 添加到通讯录），带每日上限。返回 (ok, message)。"""
        if not self.enabled:
            return False, "好友功能未启用"
        if not (keywords or "").strip():
            return False, "关键词为空"
        limit = int(self.cfg.get("daily_add_limit") or 5)
        if self._daily_count() >= limit:
            logger.warning("今日主动加好友已达上限 %d，跳过 %s", limit, keywords)
            return False, f"已达每日上限 {limit}"
        uia = _uia()

        def real_click(ctrl):
            r = ctrl.BoundingRectangle
            uia.SetCursorPos((r.left + r.right) // 2, (r.top + r.bottom) // 2)
            time.sleep(0.2)
            uia.Click((r.left + r.right) // 2, (r.top + r.bottom) // 2)

        w = None
        try:
            self.wx.SwitchToChat()
            time.sleep(1.0)
            win = self._main_window()
            quick = win.ButtonControl(Name="快捷操作", searchDepth=15)
            if not quick.Exists(2):
                return False, "找不到「快捷操作」按钮"
            real_click(quick)
            time.sleep(0.8)
            item = win.ListItemControl(Name="添加朋友", searchDepth=18)
            if not item.Exists(1.5):
                uia.SendKeys("{Esc}")
                return False, "弹层里找不到「添加朋友」"
            real_click(item)
            time.sleep(1.5)
            w = uia.WindowControl(ClassName="mmui::AddFriendWindow", searchDepth=3)
            if not w.Exists(2):
                return False, "「添加朋友」窗口未弹出"
            edit = w.EditControl(Name="搜索", searchDepth=8)
            if not edit.Exists(2):
                return False, "添加朋友窗口里找不到搜索框"
            real_click(edit)
            time.sleep(0.3)
            from wxauto4.utils import SetClipboardText
            SetClipboardText(keywords)
            uia.SendKeys("{Ctrl}a{Delete}{Ctrl}v")
            time.sleep(0.4)
            search_btn = w.ButtonControl(Name="搜索", searchDepth=8)
            if not search_btn.Exists(1.5):
                return False, "找不到「搜索」按钮"
            real_click(search_btn)
            time.sleep(3)
            # 无结果检测
            notfound = w.TextControl(SubName="找不到相关账号", searchDepth=10)
            if notfound.Exists(1):
                return False, f"找不到用户：{keywords}"
            # 结果卡片：点「添加到通讯录」
            add_btn = None
            for name in ("添加到通讯录", "加为朋友", "添加"):
                b = w.ButtonControl(Name=name, searchDepth=12)
                if b.Exists(1):
                    add_btn = b
                    break
            if not add_btn:
                return False, "未找到「添加到通讯录」按钮（已是好友/无权限/文案待校准）"
            real_click(add_btn)
            time.sleep(1.5)
            # 申请弹窗：填验证语（剪贴板粘贴）后发送
            if addmsg:
                try:
                    SetClipboardText(addmsg)
                    uia.SendKeys("{Ctrl}a{Delete}{Ctrl}v")
                    time.sleep(0.3)
                except Exception as e:
                    logger.warning("填写验证语失败（继续发送）: %s", e)
            for name in ("发送", "确定", "完成"):
                send = w.ButtonControl(Name=name, searchDepth=12)
                if send.Exists(1):
                    real_click(send)
                    break
            self._incr_daily_count()
            logger.info("加好友申请已发送: %s", keywords)
            return True, "已发送申请"
        except Exception as e:
            logger.warning("加好友失败 %s: %s", keywords, e)
            return False, str(e)
        finally:
            try:
                if w is not None and w.Exists(0.5):
                    close = w.ButtonControl(Name="关闭", searchDepth=8)
                    if close.Exists(0.5):
                        real_click(close)
            except Exception:
                pass

    def process_add_requests(self, interval_seconds=5):
        """启动时处理配置里的 add_requests 列表（每项: keywords/addmsg/remark/tags）。"""
        if not self.enabled:
            return
        for item in self.cfg.get("add_requests") or []:
            if isinstance(item, str):
                item = {"keywords": item}
            ok, msg = self.add_friend(item.get("keywords"), item.get("addmsg"), item.get("remark"), item.get("tags"))
            logger.info("add_requests 处理: %s -> %s %s", item.get("keywords"), ok, msg)
            if not ok and "上限" in msg:
                break
            time.sleep(interval_seconds)
