"""管理指令：在指定管理会话（默认文件传输助手）里发消息直接触发操作。

支持的指令（空格分隔）：
  帮助                     指令列表
  建群 联系人1 联系人2 …    发起群聊（至少 2 人，真实生效）
  拉人 群名 联系人1 …       拉人入群（群名为第一个参数，真实生效）
  加好友 微信号 [验证语]    发送好友申请（受每日上限约束）
  好友申请                  查看当前待处理的好友申请（只读）

无法识别的内容返回 None，交由 LLM 正常回复。
"""
import logging

logger = logging.getLogger("wechat-llm-bot.commands")

HELP = (
    "可用指令：\n"
    "建群 联系人1 联系人2 …\n"
    "拉人 群名 联系人1 …\n"
    "加好友 微信号 [验证语]\n"
    "好友申请（查看待处理）\n"
    "帮助"
)


def try_handle(text, *, friend_mgr=None, group_mgr=None):
    """识别并执行管理指令。返回回复文本；不是指令返回 None。"""
    parts = (text or "").split()
    if not parts:
        return None
    cmd, args = parts[0], parts[1:]

    if cmd in ("帮助", "help", "?"):
        return HELP

    if cmd == "建群":
        if not group_mgr:
            return "群聊功能未启用"
        if len(args) < 2:
            return "建群至少需要 2 个联系人，格式：建群 联系人1 联系人2 …"
        ok, msg = group_mgr.create_group(args)
        return f"建群{'成功' if ok else '失败'}：{msg}"

    if cmd == "拉人":
        if not group_mgr:
            return "群聊功能未启用"
        if len(args) < 2:
            return "格式：拉人 群名 联系人1 联系人2 …（群名需与会话列表一致）"
        ok, msg = group_mgr.add_members(args[0], args[1:])
        return f"拉人{'成功' if ok else '失败'}：{msg}"

    if cmd == "加好友":
        if not friend_mgr:
            return "好友功能未启用"
        if not args:
            return "格式：加好友 微信号 [验证语]"
        ok, msg = friend_mgr.add_friend(args[0], addmsg=" ".join(args[1:]) or None)
        return f"加好友{'成功' if ok else '失败'}：{msg}"

    if cmd == "好友申请":
        if not friend_mgr:
            return "好友功能未启用"
        pending = friend_mgr.list_pending_requests()
        if not pending:
            return "当前没有待处理的好友申请"
        return "待处理好友申请：\n" + "\n".join(f"- {p}" for p in pending)

    return None
