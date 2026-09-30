"""企微回调路由：/wecom/callback GET 验证 + POST 消息接收。

不鉴权（企微直接访问），但必须验签 + AES 解密。
"""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Request, Response
from fastapi.responses import PlainTextResponse, Response as FastResponse

from .. import db, monitor, wecom_client

logger = logging.getLogger("argus.callback")

router = APIRouter()


def _callback_params(request: Request) -> tuple[str, str, str, str]:
    """从 query 提取验签四元组。"""
    msg_signature = request.query_params.get("msg_signature", "")
    timestamp = request.query_params.get("timestamp", "")
    nonce = request.query_params.get("nonce", "")
    echostr = request.query_params.get("echostr", "")
    return msg_signature, timestamp, nonce, echostr


def _callback_creds() -> tuple[str, str, str]:
    """(token, aes_key, corp_id)。"""
    token = db.get_setting("wecom.callback_token", "")
    aes_key = db.get_setting("wecom.callback_aes_key", "")
    corp_id = db.get_setting("wecom.corp_id", "")
    return token, aes_key, corp_id


@router.get("/wecom/callback")
async def callback_verify(request: Request) -> PlainTextResponse:
    """URL 验证：校验签名 → AES 解密 echostr → 返回明文 echostr。"""
    msg_signature, timestamp, nonce, echostr = _callback_params(request)
    token, aes_key, corp_id = _callback_creds()

    if not all([token, aes_key, corp_id, msg_signature, timestamp, nonce, echostr]):
        logger.warning("callback GET 缺少参数或企微凭据未配置，返回 400")
        return PlainTextResponse("missing params", status_code=400)

    if not wecom_client.verify_signature(token, timestamp, nonce, echostr, msg_signature):
        return PlainTextResponse("signature mismatch", status_code=403)

    try:
        plain = wecom_client.decrypt(echostr, aes_key, corp_id)
        return PlainTextResponse(plain.decode("utf-8", errors="replace"))
    except Exception:
        return PlainTextResponse("decrypt failed", status_code=500)


@router.post("/wecom/callback")
async def callback_receive(request: Request) -> PlainTextResponse:
    """接收消息/事件：验签 + 解密 + 处理 click 事件，5 秒内返回 success。"""
    msg_signature, timestamp, nonce, _ = _callback_params(request)
    token, aes_key, corp_id = _callback_creds()
    body = await request.body()

    if not all([token, aes_key, corp_id]):
        logger.warning("callback POST 收到请求但企微凭据未配置，静默返回 success")
        return PlainTextResponse("success")

    try:
        parsed = wecom_client.parse_callback_xml(body)
        encrypt = parsed.get("Encrypt", "")
        if not encrypt:
            return PlainTextResponse("success")

        if not wecom_client.verify_signature(token, timestamp, nonce, encrypt, msg_signature):
            return PlainTextResponse("success")

        plain = wecom_client.decrypt(encrypt, aes_key, corp_id)
        msg = wecom_client.parse_callback_xml(plain)
    except Exception:
        # 任何异常都返回 success，避免企微重试
        return PlainTextResponse("success")

    db.add_event("wecom_callback", dict(msg))

    # 纯文本指令（@am / @cb / @hermes）：本地解析，0 Token
    if msg.get("MsgType") == "text":
        from .switcher import handle_text_command
        reply_msg = handle_text_command(str(msg.get("Content") or ""))
        if reply_msg:
            ts = str(int(time.time()))
            nonce_resp = nonce or str(int(time.time()))
            reply_xml = wecom_client.build_encrypted_reply(
                reply_msg, token, ts, nonce_resp, aes_key, corp_id,
            )
            return FastResponse(content=reply_xml, media_type="application/xml")

    # 处理 click 事件
    if msg.get("MsgType") == "event" and msg.get("Event") == "click":
        event_key = msg.get("EventKey", "")
        reply_msg = _handle_click(event_key)
        if reply_msg is None:
            return PlainTextResponse("success")
        # 被动回复确认消息（加密回包）
        ts = str(int(time.time()))
        nonce_resp = nonce or str(int(time.time()))
        reply_xml = wecom_client.build_encrypted_reply(
            reply_msg, token, ts, nonce_resp, aes_key, corp_id,
        )
        return FastResponse(content=reply_xml, media_type="application/xml")

    return PlainTextResponse("success")


def _handle_click(event_key: str) -> str | None:
    """把菜单 click 事件转成一句回复文本。返回 None 表示不回复。"""
    # 切换类菜单：候选清单由本地 HTTP 转发实时生成（见 switcher.py）
    if event_key in ("SWITCH_AM", "SWITCH_CB", "SWITCH_HERMES"):
        from .switcher import (
            handle_switch_am_click,
            handle_switch_cb_click,
            handle_switch_hermes_click,
        )
        return {
            "SWITCH_AM": handle_switch_am_click,
            "SWITCH_CB": handle_switch_cb_click,
            "SWITCH_HERMES": handle_switch_hermes_click,
        }[event_key]()

    if event_key == "SILENCE_1H":
        monitor.silence(60)
        return f"已开启静音 1 小时。当前剩余 {monitor.silence_remaining()} 分钟。"
    if event_key == "UNSILENCE":
        monitor.unsilence()
        return "已解除静音。告警恢复正常推送。"

    # CONTRACT §7.1：ACT:<id> = 执行该目标绑定的 HTTP 动作
    if event_key.startswith("ACT:"):
        raw = event_key[4:].strip()
        if not raw.isdigit():
            return "该按钮已失效，请在面板里重新生成菜单。"
        tid = int(raw)
        target = db.get_target(tid)
        if target is None:
            return "该按钮已失效（目标已删除），请在面板里重新生成菜单。"
        if target.get("action_type") != "http" or not (target.get("action_url") or ""):
            return f"「{target.get('name')}」没有配置 HTTP 动作，请在面板里补上。"
        # 静音只压告警通知，不挡用户主动操作
        silenced = monitor.silence_remaining() > 0
        result = monitor._execute_action(target)
        db.add_event("menu-action", {
            "target_id": tid, "name": target.get("name"),
            "key": event_key, "result": result,
        })
        name = target.get("name") or f"#{tid}"
        if result.get("ok"):
            reply = f"✅ {name} 已执行（{result.get('detail', '')}）"
            if result.get("body"):
                reply += f"\n{result['body']}"
        else:
            reply = f"❌ {name} 执行失败：{result.get('detail', '未知错误')}"
        if silenced:
            reply += "\n（注：当前处于静音期，本操作仍已执行，只是不会推送告警）"
        return reply

    return None
