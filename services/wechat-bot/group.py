"""群聊管理：建群 + 拉人。

基于免费版 wxauto4 的 UIA 层实现，在微信 4.1.13 上实测校准：
- 建群入口：会话页「快捷操作」按钮 → 弹层「发起群聊」→ SessionPickerWindow 选择器
- 选择器：mmui::SessionPickerWindow（标题 微信发起群聊/微信添加群成员），
  搜索 EditControl「搜索」+ 联系人 CheckBoxControl(ClassName 含 SPSelectionContactRow)
  + 「完成」/「取消」按钮，已选数文本「已选择N个联系人」
- 拉人入口：群聊窗口 →「聊天信息」按钮（chat_message_page 内）→ 成员网格
  （ListControl「聊天成员」，成员为 mmui::ChatMemberCell）→ 点击最后一个成员
  后面的空格位打开「微信添加群成员」选择器

注意：MMUI 自绘控件不响应 UIA Invoke，本模块一律用真实鼠标点击（会移动光标）。
命令行手动测试：
  python group.py create 阿闯 訢            # 真建群（成员会收到通知！）
  python group.py create --dry 阿闯 訢      # 只到选择器选中为止，不点完成
  python group.py add 群名 阿闯 訢          # 拉人入群（同样真实生效）
"""
import logging
import sys
import time

logger = logging.getLogger("wechat-llm-bot.group")

MAIN_WINDOW_CLASS = "mmui::MainWindow"
PICKER_CLASS = "mmui::SessionPickerWindow"
CONTACT_ROW_CLASS = "mmui::SPSelectionContactRow"
MEMBER_CELL_CLASS = "mmui::ChatMemberCell"
# 成员网格布局（4.1.13 实测）：列步进 53px，行步进 64px，左右边距 23px
GRID_COL_STEP = 53
GRID_ROW_STEP = 64


def _uia():
    from wxauto4 import uia
    return uia


def _real_click_ctrl(ctrl):
    r = ctrl.BoundingRectangle
    cx, cy = (r.left + r.right) // 2, (r.top + r.bottom) // 2
    uia = _uia()
    uia.SetCursorPos(cx, cy)
    time.sleep(0.2)
    uia.Click(cx, cy)


def _real_click_xy(x, y):
    uia = _uia()
    uia.SetCursorPos(x, y)
    time.sleep(0.2)
    uia.Click(x, y)


class GroupManager:
    def __init__(self, wx):
        self.wx = wx

    def _main_window(self):
        return _uia().WindowControl(ClassName=MAIN_WINDOW_CLASS, searchDepth=1)

    # ---------- 选择器 ----------

    def _wait_picker(self, timeout=5):
        uia = _uia()
        deadline = time.time() + timeout
        while time.time() < deadline:
            picker = uia.WindowControl(ClassName=PICKER_CLASS, searchDepth=3)
            if picker.Exists(0.5):
                return picker
            time.sleep(0.3)
        return None

    def _cancel_picker(self, picker):
        try:
            cancel = picker.ButtonControl(Name="取消", searchDepth=10)
            if cancel.Exists(1):
                _real_click_ctrl(cancel)
                time.sleep(0.5)
        except Exception as e:
            logger.warning("取消选择器失败（UIA 读取异常）: %s", e)

    def _select_contacts(self, picker, contacts):
        """在选择器里逐个搜索并勾选联系人，返回成功勾选的数量。"""
        search = picker.EditControl(Name="搜索", searchDepth=10)
        if not search.Exists(2):
            raise RuntimeError("选择器里找不到搜索框")
        ok = 0
        for who in contacts:
            _real_click_ctrl(search)
            time.sleep(0.3)
            search.SendKeys("{Ctrl}a{Delete}", interval=0.02)
            search.SendKeys(who, interval=0.03)
            time.sleep(1.2)
            row = picker.CheckBoxControl(Name=who, searchDepth=10)
            if not row.Exists(1.5):
                # 行可能只显示部分名称，退化到 ListItemControl
                row = picker.CheckBoxControl(SubName=who, searchDepth=10)
            if not row.Exists(1):
                logger.warning("选择器里找不到联系人: %s", who)
                continue
            _real_click_ctrl(row)
            time.sleep(0.5)
            ok += 1
        try:
            _real_click_ctrl(search)
            search.SendKeys("{Ctrl}a{Delete}", interval=0.02)
            time.sleep(0.3)
        except Exception as e:
            logger.warning("清空搜索框失败（不影响已选结果）: %s", e)
        return ok

    def _finish_picker(self, picker, expected, dry_run):
        text = ""

        def find_selected(c, d=0):
            nonlocal text
            if d > 10 or text:
                return
            try:
                nm = c.Name or ""
                if "已选择" in nm:
                    text = nm
                    return
            except Exception:
                return
            try:
                children = list(c.GetChildren())
            except Exception:
                return
            for ch in children[:20]:
                find_selected(ch, d + 1)
        try:
            find_selected(picker)
        except Exception as e:
            logger.warning("读取已选数失败（跳过校验）: %s", e)
        logger.info("选择器状态: %s（预期 %d 人）", text or "未读到已选数", expected)
        if dry_run:
            self._cancel_picker(picker)
            return False, f"dry-run：已勾选，未点完成（{text or '已选数未读到'}）"
        try:
            done = picker.ButtonControl(Name="完成", searchDepth=10)
            done_exists = done.Exists(1.5)
        except Exception as e:
            return False, f"定位「完成」按钮失败（选择器已保留，可手动点完成）: {e}"
        if not done_exists:
            self._cancel_picker(picker)
            return False, "找不到「完成」按钮，已取消"
        _real_click_ctrl(done)
        time.sleep(1.0)
        return True, text or "已点完成"

    # ---------- 建群 ----------

    def create_group(self, contacts, dry_run=False):
        """发起群聊。contacts 为联系人在微信里的准确昵称/备注（至少 2 人）。"""
        if len(contacts or []) < 2:
            return False, "建群至少需要 2 个联系人"
        self.wx.SwitchToChat()
        time.sleep(1.0)
        win = self._main_window()
        btn = win.ButtonControl(Name="快捷操作", searchDepth=15)
        if not btn.Exists(2):
            return False, "找不到「快捷操作」按钮"
        _real_click_ctrl(btn)
        time.sleep(0.8)
        item = win.ListItemControl(Name="发起群聊", searchDepth=18)
        if not item.Exists(1.5):
            _uia().SendKeys("{Esc}")
            return False, "弹层里找不到「发起群聊」"
        _real_click_ctrl(item)
        picker = self._wait_picker()
        if not picker:
            return False, "选择器未弹出"
        try:
            selected = self._select_contacts(picker, contacts)
            if selected < len(contacts):
                self._cancel_picker(picker)
                return False, f"只勾选到 {selected}/{len(contacts)} 个联系人，已取消"
            return self._finish_picker(picker, len(contacts), dry_run)
        except Exception as e:
            self._cancel_picker(picker)
            return False, str(e)

    # ---------- 拉人 ----------

    def _open_member_drawer(self, group):
        self.wx.ChatWith(group)
        time.sleep(1.2)
        win = self._main_window()
        drawer = win.GroupControl(ClassName="mmui::ChatRoomMemberInfoView", searchDepth=18)
        if drawer.Exists(1):
            return win, True
        page = win.GroupControl(AutomationId="chat_message_page", searchDepth=15)
        btn = page.ButtonControl(Name="聊天信息", searchDepth=10)
        if not btn.Exists(2):
            return win, False
        _real_click_ctrl(btn)
        time.sleep(1.5)
        return win, drawer.Exists(1) or win.GroupControl(ClassName="mmui::ChatRoomMemberInfoView", searchDepth=18).Exists(1)

    def add_members(self, group, contacts, dry_run=False):
        """拉人入群。group 为群聊准确名称，contacts 为联系人准确昵称/备注。"""
        if not contacts:
            return False, "联系人列表为空"
        win, ok = self._open_member_drawer(group)
        if not ok:
            return False, f"打不开「{group}」的聊天信息抽屉（确认群名准确且已在会话中）"
        grid = win.ListControl(Name="聊天成员", searchDepth=18)
        if not grid.Exists(2):
            return False, "找不到成员网格"
        # 悬停网格并滚到底，让虚拟化网格渲染尾部（不点击，避免点到成员）
        r = grid.BoundingRectangle
        _uia().SetCursorPos((r.left + r.right) // 2, r.bottom - 10)
        time.sleep(0.3)
        for _ in range(5):
            _uia().WheelDown(3)
            time.sleep(0.4)
        cells = [c for c in grid.GetChildren() if getattr(c, "ClassName", "") == MEMBER_CELL_CLASS]
        if not cells:
            return False, "成员网格里没有读到成员"
        last = cells[-1].BoundingRectangle
        cell_w = last.right - last.left
        cell_h = last.bottom - last.top
        # 下一个空格位：同行下一列，放不下则换行
        slot_left = last.left + GRID_COL_STEP
        slot_top = last.top
        if slot_left + cell_w > r.right:
            slot_left = cells[0].BoundingRectangle.left
            slot_top = last.top + GRID_ROW_STEP
        _real_click_xy(slot_left + cell_w // 2, slot_top + cell_h // 2)
        picker = self._wait_picker()
        if not picker or "添加" not in (picker.Name or ""):
            return False, "点击空格位后未弹出「添加群成员」选择器"
        try:
            selected = self._select_contacts(picker, contacts)
            if selected < len(contacts):
                self._cancel_picker(picker)
                return False, f"只勾选到 {selected}/{len(contacts)} 个联系人，已取消"
            return self._finish_picker(picker, len(contacts), dry_run)
        except Exception as e:
            self._cancel_picker(picker)
            return False, str(e)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = sys.argv[1:]
    dry = "--dry" in args
    args = [a for a in args if a != "--dry"]
    if len(args) < 3 or args[0] not in ("create", "add"):
        print(__doc__)
        sys.exit(1)
    from wxauto4 import WeChat
    wx = WeChat(ads=False)
    mgr = GroupManager(wx)
    if args[0] == "create":
        ok, msg = mgr.create_group(args[1:], dry_run=dry)
    else:
        ok, msg = mgr.add_members(args[1], args[2:], dry_run=dry)
    print("结果:", ok, msg)
    sys.exit(0 if ok else 1)
