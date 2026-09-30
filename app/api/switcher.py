"""外部服务「切换」指令 —— 0 Token 本地转发。

三条链路：

1. AM 中转池账号切换   → ``POST {switch.am_base}/api/proxy/preferred-account``
2. CodeBuddy 模型切换  → ``PUT  {switch.cb_base}/api/v1/settings/model?scope=user``
3. Hermes 模型切换     → ``POST {switch.hermes_base}/api/hermes/switch``

设计约束（见 docs/CONTRACT.md §0）：**不写死任何部署方的域名/IP/端口/令牌**。
目标地址与令牌一律从 ``settings`` 表读取，键名见下方 ``KEY_*`` 常量，
未配置时返回一句提示而不是抛异常。

两类入口共用本模块：

- 企微菜单 ``click`` 事件 → ``handle_switch_*_click()``，返回候选清单
- 纯文本指令（``@am`` / ``@cb`` / ``@hermes``）→ ``handle_text_command()``，执行切换
"""

from __future__ import annotations

import json
import urllib.request

from .. import db

# settings 表里的键名（在 app/settings.py 的 DEFAULT_SETTINGS 里登记）
KEY_AM_BASE = "switch.am_base"
KEY_AM_TOKEN = "switch.am_token"
KEY_CB_BASE = "switch.cb_base"
KEY_CB_TOKEN = "switch.cb_token"
KEY_HERMES_BASE = "switch.hermes_base"

UNSET_HINT = "⚠️ 该切换目标尚未配置，请到面板「切换指令」里填写基址与令牌。"


def _base(key: str) -> str:
    """取基址（去掉结尾的 /；空串表示未配置）。"""
    return (db.get_setting(key, "") or "").strip().rstrip("/")


def _token(key: str) -> str:
    return (db.get_setting(key, "") or "").strip()


def _http_req(url, method="GET", body=None, headers=None, timeout=6):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode('utf-8', errors='replace')
            try:
                return r.status, json.loads(raw) if raw else {}
            except Exception:
                return r.status, raw
    except Exception as e:
        return 500, str(e)


# ---------------------------------------------------------------------------
# 1. AM 账号切换
# ---------------------------------------------------------------------------

def handle_switch_am_click() -> str:
    base = _base(KEY_AM_BASE)
    if not base:
        return UNSET_HINT
    auth = {"Authorization": f"Bearer {_token(KEY_AM_TOKEN)}"}

    s, b = _http_req(f"{base}/api/accounts", headers=auth)
    if s != 200 or not isinstance(b, dict):
        return f"❌ 获取 AM 账号池失败: {b}"
    accs = b.get("accounts", [])

    # 获取当前锁定账号
    s_pref, b_pref = _http_req(f"{base}/api/proxy/preferred-account", headers=auth)
    pref_id = (b_pref.get("data") or {}).get("accountId") if (s_pref == 200 and isinstance(b_pref, dict)) else None

    lines = ["【AM 中转池账号管理】", "当前号池全部账号如下（实时同步）：", ""]
    auto_tag = " (当前锁定 🎯)" if not pref_id else " ⭐(默认推荐)"
    lines.append(f"0. ♻️ 自动轮换{auto_tag}")

    first_healthy_marked = False
    for i, a in enumerate(accs, 1):
        aid = a.get("id")
        email = a.get("email") or a.get("name") or f"账号{i}"
        user_alias = email.split("@")[0]
        is_bad = a.get("disabled") or a.get("proxy_disabled") or a.get("validation_blocked")

        status_tag = ""
        if aid == pref_id:
            status_tag = " [当前锁定 🎯]"
        elif is_bad:
            status_tag = " ⚠️(风控/需验证)"
        else:
            if pref_id and not first_healthy_marked:
                status_tag = " ⭐(推荐)"
                first_healthy_marked = True
            else:
                status_tag = " ✅正常"

        lines.append(f"{i}. 👤 {user_alias} ({email}){status_tag}")

    lines.append("")
    lines.append("👉 切换指令：在此窗口直接回复：")
    lines.append("   @am 0  -> 切回【自动轮换】")
    lines.append("   @am <编号> -> 锁定指定账号（如 @am 1）")
    lines.append("💡 后台动态增减账号后，点菜单自动跟随增减。")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 2. CB 模型切换
# ---------------------------------------------------------------------------

CB_MODELS = [
    ("gemini-pro-agent", "Gemini Pro Agent", "全能主力·带强推理 ⭐"),
    ("gemini-3.8-flash-high", "Gemini 3.8 Flash High", "日常高频·极速均衡"),
    ("gemini-3.1-pro-low", "Gemini 3.1 Pro Low", "低并发备用通道"),
    ("gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", "极限轻量"),
    ("claude-opus-4-6-thinking", "Claude Opus 4.6 Thinking", "深度长推理"),
    ("claude-sonnet-4-6", "Claude Sonnet 4.6", "综合代码能力"),
]


def handle_switch_cb_click() -> str:
    base = _base(KEY_CB_BASE)
    curr = ""
    if base:
        s, b = _http_req(f"{base}/api/v1/info",
                         headers={"Authorization": f"Bearer {_token(KEY_CB_TOKEN)}",
                                  "X-CodeBuddy-Request": "1"})
        curr = (b.get("model") or "") if (s == 200 and isinstance(b, dict)) else ""

    lines = ["【CodeBuddy 模型切换】", "可选模型如下（实时状态）：", ""]
    for i, (mid, name, desc) in enumerate(CB_MODELS):
        tag = " [当前在用 🎯]" if mid == curr else ""
        lines.append(f"{i}. 🧠 {name}{tag}\n   └ {desc} [`{mid}`]")

    lines.append("")
    lines.append("👉 切换指令：在此窗口直接回复：")
    lines.append("   @cb 0  -> 切 Gemini Pro Agent")
    lines.append("   @cb <编号> -> 切对应编号模型")
    if not base:
        lines.append(UNSET_HINT)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 3. Hermes 模型切换
# ---------------------------------------------------------------------------

HERMES_MODELS = [
    ("gemini-pro-agent", "Gemini Pro Agent", "AM中转池直连主力 ⭐"),
    ("gemini-3.8-flash-high", "Gemini 3.8 Flash High", "中转池极速响应"),
    ("gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", "中转池轻量通道"),
    ("claude-sonnet-4-6-thinking", "Claude Sonnet 4.6 Thinking", "高难逻辑与长链推理"),
    ("gpt-4o", "GPT-4o", "OpenAI 旗舰"),
    ("claude-opus-4-6-thinking", "Claude Opus 4.6 Thinking", "最强深度思考"),
]


def handle_switch_hermes_click() -> str:
    lines = ["【Hermes 模型切换】", "可选模型清单（直连 AM 池）：", ""]
    for i, (mid, name, desc) in enumerate(HERMES_MODELS):
        lines.append(f"{i}. 🤖 {name}\n   └ {desc} [`{mid}`]")

    lines.append("")
    lines.append("👉 切换指令：在此窗口直接回复：")
    lines.append("   @hermes 0  -> 切 Gemini Pro Agent")
    lines.append("   @hermes <编号> -> 切对应编号模型")
    lines.append("💡 选定后后台自动重写 config.yaml 并平滑重启 gateway 服务。")
    if not _base(KEY_HERMES_BASE):
        lines.append(UNSET_HINT)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 4. 纯文本交互指令解析
# ---------------------------------------------------------------------------

def handle_text_command(text: str) -> str | None:
    """解析 @am / @cb / @hermes 指令。返回 None 表示不是本模块的指令。"""
    t = (text or "").strip()
    if not t:
        return None

    # 1. AM 指令
    if t.startswith("@am") or t.startswith("/am"):
        base = _base(KEY_AM_BASE)
        if not base:
            return UNSET_HINT
        auth = {"Authorization": f"Bearer {_token(KEY_AM_TOKEN)}"}
        parts = t.replace("/am", "@am").split()
        if len(parts) < 2:
            return "⚠️ 请提供账号编号，例如：@am 0 或 @am 1\n可点底部【切换AM账号】菜单先查看列表。"
        arg = parts[1].strip()
        if arg in ("0", "自动", "自动轮换", "auto"):
            s, b = _http_req(f"{base}/api/proxy/preferred-account", "POST",
                             {"accountId": None}, auth)
            return "✅ AM 中转池已切回【自动轮换】模式！" if s in (200, 201, 204) else f"❌ 切换失败: {b}"
        if arg.isdigit():
            idx = int(arg)
            s, b = _http_req(f"{base}/api/accounts", headers=auth)
            if s != 200 or not isinstance(b, dict):
                return f"❌ 获取账号列表失败: {b}"
            accs = b.get("accounts", [])
            if 1 <= idx <= len(accs):
                target = accs[idx - 1]
                aid = target.get("id")
                email = target.get("email") or target.get("name") or f"账号{idx}"
                s_set, b_set = _http_req(f"{base}/api/proxy/preferred-account", "POST",
                                         {"accountId": aid}, auth)
                if s_set in (200, 201, 204):
                    return f"✅ AM 已成功锁定账号：\n👤 {email} (编号 {idx})"
                return f"❌ 切换失败: {b_set}"
            return f"❌ 编号越界，当前有效编号为 0 ~ {len(accs)}"
        return "⚠️ 未知参数，请回复数字编号（如 @am 0 或 @am 1）"

    # 2. CB 指令
    if t.startswith("@cb") or t.startswith("/cb"):
        base = _base(KEY_CB_BASE)
        if not base:
            return UNSET_HINT
        parts = t.replace("/cb", "@cb").split()
        if len(parts) < 2 or not parts[1].strip().isdigit():
            return f"⚠️ 请提供模型序号（0 ~ {len(CB_MODELS) - 1}），例如：@cb 0"
        idx = int(parts[1].strip())
        if 0 <= idx < len(CB_MODELS):
            mid, name, _ = CB_MODELS[idx]
            s, b = _http_req(f"{base}/api/v1/settings/model?scope=user", "PUT",
                             {"value": mid},
                             {"Authorization": f"Bearer {_token(KEY_CB_TOKEN)}",
                              "X-CodeBuddy-Request": "1"})
            return f"✅ CodeBuddy 模型已成功切换为：\n🧠 {name} (`{mid}`)"
        return f"❌ 序号超出范围，当前有效序号为 0 ~ {len(CB_MODELS) - 1}"

    # 3. Hermes 指令
    if t.startswith("@hermes") or t.startswith("/hermes"):
        base = _base(KEY_HERMES_BASE)
        if not base:
            return UNSET_HINT
        parts = t.replace("/hermes", "@hermes").split()
        if len(parts) < 2 or not parts[1].strip().isdigit():
            return f"⚠️ 请提供模型序号（0 ~ {len(HERMES_MODELS) - 1}），例如：@hermes 0"
        idx = int(parts[1].strip())
        if 0 <= idx < len(HERMES_MODELS):
            mid, name, _ = HERMES_MODELS[idx]
            s, b = _http_req(f"{base}/api/hermes/switch", "POST", {"model": mid})
            if s == 200 and isinstance(b, dict) and b.get("ok"):
                return f"✅ Hermes 模型已成功切换！\n🤖 {name} (`{mid}`)\n后台网关已自动平滑重载生效。"
            return f"❌ Hermes 下发失败: {b}"
        return f"❌ 序号超出范围，当前有效序号为 0 ~ {len(HERMES_MODELS) - 1}"

    return None
