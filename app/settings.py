"""设置项 schema —— 这是全项目的「契约文件」。

所有可配置项都定义在 DEFAULT_SETTINGS 里。面板读它渲染表单，后端读它取默认值。
新增配置项 = 在 DEFAULT_SETTINGS 里加一行 + 在 SECRET_KEYS 里登记（如果是敏感项）。
"""

from __future__ import annotations

import os

# 容器内数据目录（docker-compose 里挂到 /data）
DATA_DIR = os.environ.get("HUB_DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "hub.db")

# 仅用于「首次启动」的引导项，之后由面板接管
BOOTSTRAP_ADMIN_PASSWORD = os.environ.get("HUB_ADMIN_PASSWORD", "admin")

# ---------------------------------------------------------------------------
# 全部可配置项及其默认值（键名即为 API/面板里的字段名，不要随意改名）
# ---------------------------------------------------------------------------
DEFAULT_SETTINGS: dict[str, str] = {
    # --- 面板自身 ---
    "panel.admin_password": BOOTSTRAP_ADMIN_PASSWORD,
    # 公网基址，用于拼回调 URL 和菜单跳转链接。例：https://hub.example.com
    "panel.public_url": "",
    # --- 企业微信自建应用 ---
    "wecom.corp_id": "",
    "wecom.agent_id": "",
    "wecom.secret": "",
    # 「接收消息」回调用的 Token 与 EncodingAESKey（在企微后台开启接收消息时生成）
    "wecom.callback_token": "",
    "wecom.callback_aes_key": "",
    # 企微 API 基址，一般不用改
    "wecom.api_base": "https://qyapi.weixin.qq.com",
    # 可选：企微 API 反向代理基址。企微有「企业可信IP」白名单，
    # 若本机出口 IP 不在白名单，可填一个白名单内机器上的反代，例如 https://wx-proxy.example.com
    "wecom.proxy_url": "",
    # 接收人：企微 userid，多个用英文逗号分隔；@all 表示应用可见范围内全部
    "wecom.touser": "@all",
    "wecom.toparty": "",
    # --- 通知策略 ---
    "notify.enabled": "true",
    # 连续失败几次才告警（防抖）
    "notify.fail_threshold": "2",
    # 同一目标同一问题，多少分钟内不重复推送
    "notify.silence_minutes": "30",
    # 恢复时是否补推一条
    "notify.recovery": "true",
    # --- 外部事件接入 ---
    # 外部 watcher（如 NAS 上的 am-watch.sh）调 POST /api/ingest 上报事件用的密钥。
    # 留空则 /api/ingest 整体禁用。生成示例：openssl rand -hex 24
    "ingest.api_key": "",
    # --- 监控引擎 ---
    # 调度器心跳间隔（秒）
    "monitor.tick_seconds": "30",
    # 探测结果保留天数
    "log.retain_days": "7",
    # --- 「切换」指令目标（企微菜单 / 文本指令，0 Token 本地转发）---
    # 全部留空则对应指令回复「尚未配置」。基址例：http://10.0.0.2:8045
    # 1) 账号池管理接口（GET /api/accounts、POST /api/proxy/preferred-account）
    "switch.am_base": "",
    "switch.am_token": "",
    # 2) 模型网关（GET /api/v1/info、PUT /api/v1/settings/model?scope=user）
    "switch.cb_base": "",
    "switch.cb_token": "",
    # 3) Agent 模型切换接口（POST /api/hermes/switch）
    "switch.hermes_base": "",
}

# 敏感项：面板返回时打码，日志里不打印
SECRET_KEYS: set[str] = {
    "panel.admin_password",
    "wecom.secret",
    "wecom.callback_token",
    "wecom.callback_aes_key",
    "ingest.api_key",
    "switch.am_token",
    "switch.cb_token",
}

# 面板里这些项用密码框渲染
PASSWORD_KEYS: set[str] = {
    "panel.admin_password",
    "wecom.secret",
    "wecom.callback_aes_key",
    "ingest.api_key",
    "switch.am_token",
    "switch.cb_token",
}

MASK = "********"

# 内部键：存在 settings 表里，但**不是**面板设置项，GET /api/settings 不外泄。
# 面板保存的本地菜单（菜单页自己读写），放这里避免污染设置接口。
INTERNAL_SETTING_KEYS: set[str] = {
    "menu.local",
}


def mask_settings(values: dict[str, str]) -> dict[str, str]:
    """返回给前端的设置副本，敏感项打码（已设置的显示 MASK，未设置的保持空）。"""
    out: dict[str, str] = {}
    for k, v in values.items():
        if k in SECRET_KEYS and v:
            out[k] = MASK
        else:
            out[k] = v
    return out


def is_masked(value: str) -> bool:
    return value == MASK
