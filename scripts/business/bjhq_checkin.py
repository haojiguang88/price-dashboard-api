#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""北京环球互动福利站：单账号、本地 Token 签到（任务中心契约版）。

Python 3.9+，仅标准库。凭证只读环境变量 BJHQ_TOKEN、BJHQ_USER_ID。
最后一行 stdout 输出任务中心 JSON；不打印敏感信息。
接口协议参考 smallfawn/QLScriptPublic/wxapp/bjhqbwz.py（2026-11-03）。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from email.utils import formatdate
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


BASE = "https://bmp.app.universalbeijingresort.com"
PREFIX = "/2026_ubr_yunyingqiu"
ACTIVITY = "2026_UBR_YUNYINGQIU"
APP_ID = "wx21f6790118783b83"
# 上游公开记录的客户端请求签名参数；不是账号密钥或微信 appsecret。
CLIENT_SIGNING_KEY = b"aK@AtX5#Ck5x"


class CheckinError(Exception):
    """仅包含可以安全打印的错误信息。"""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def emit(payload: dict[str, Any], exit_code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False), flush=True)
    return exit_code


def signed_headers(payload: bytes, token: str, user_id: Any, date: str | None = None) -> dict[str, str]:
    date = date or formatdate(usegmt=True)
    digest = "SHA-256=" + base64.b64encode(hashlib.sha256(payload).digest()).decode()
    message = f"x-date: {date}\ndigest: {digest}".encode()
    signature = base64.b64encode(
        hmac.new(CLIENT_SIGNING_KEY, message, hashlib.sha1).digest()
    ).decode()
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-date": date,
        "Digest": digest,
        "Authorization": (
            'hmac username="ubr-bmp", algorithm="hmac-sha1", '
            f'headers="x-date digest", signature="{signature}"'
        ),
        "ArrowAuthorization": token,
        "userId": str(user_id),
        "Referer": f"https://servicewechat.com/{APP_ID}/0/page-frame.html",
        "User-Agent": "Mozilla/5.0 MicroMessenger/8.0.49 miniProgram/" + APP_ID,
    }


def require_success(data: Any, stage: str) -> None:
    if not isinstance(data, dict):
        raise CheckinError(f"{stage}返回格式异常，已停止。")
    raw_code = data.get("code", data.get("status"))
    try:
        if isinstance(raw_code, bool):
            raise ValueError
        code = int(raw_code)
    except (TypeError, ValueError):
        raise CheckinError(f"{stage}缺少有效业务状态码，已停止。") from None
    if code in (401, 403):
        raise CheckinError("登录状态失效或访问被拒绝，请在小程序确认登录并更新本地凭证。")
    if code in (60002, 60003):
        raise CheckinError("请先在官方小程序完成活动要求的身份验证。")
    if code != 200:
        message = str(data.get("message") or data.get("msg") or "")
        if "奖池" in message:
            raise CheckinError("请先在小程序内手动选择本期奖池，然后再运行。")
        raise CheckinError(f"{stage}未成功，业务状态码 {code}；请在小程序核对活动状态。")


def entity(data: dict[str, Any]) -> dict[str, Any]:
    inner = data.get("data")
    value = inner.get("entity") if isinstance(inner, dict) else None
    if value is None:
        value = data.get("entity")
    if not isinstance(value, dict):
        raise CheckinError("接口数据结构与预期不符，已停止；需要核对当前活动接口。")
    return value


class Client:
    def __init__(self, token: str, user_id: Any):
        self.token = token
        self.user_id = user_id
        self.opener = build_opener(NoRedirect())

    def post(self, suffix: str, body: dict[str, Any], write: bool = False) -> dict[str, Any]:
        payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        request = Request(
            BASE + PREFIX + suffix,
            data=payload,
            headers=signed_headers(payload, self.token, self.user_id),
            method="POST",
        )
        try:
            with self.opener.open(request, timeout=20) as response:
                data = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            if exc.code in (401, 403):
                raise CheckinError("登录状态失效或访问被拒绝，请更新本地凭证并在小程序确认。") from None
            raise CheckinError(f"接口返回 HTTP {exc.code}，已停止；请在小程序核对结果。") from None
        except (URLError, TimeoutError, OSError, ValueError):
            if write:
                raise CheckinError("签到结果未确认，请去小程序查看；本次不会自动重试提交。") from None
            raise CheckinError("查询失败或响应无法解析，未提交签到。") from None
        if not isinstance(data, dict):
            raise CheckinError("接口响应类型异常，请在小程序核对结果。")
        return data


def run(client: Client, check_only: bool = False, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone(timedelta(hours=8)))
    base_body = {"userId": client.user_id, "activityCode": ACTIVITY}
    detail = client.post(
        "/business/activityRecord/detail", {**base_body, "prePrizeIds": []}
    )
    require_success(detail, "活动查询")
    quests = entity(detail).get("questList")
    if not isinstance(quests, list):
        raise CheckinError("活动未返回任务列表，未提交签到。")
    templates = [
        q.get("templateId")
        for q in quests
        if isinstance(q, dict) and q.get("templateCode") == "SIGN_IN"
    ]
    if len(templates) != 1 or templates[0] in (None, ""):
        raise CheckinError("未找到唯一有效的签到任务；活动可能已变更或结束。")
    records = client.post(
        "/business/yunyingqiu/signInRecord", {**base_body, "month": now.strftime("%Y-%m")}
    )
    require_success(records, "签到记录查询")
    days = entity(records).get("signInInfos")
    if not isinstance(days, list):
        raise CheckinError("无法确认今天的签到记录，未提交签到。")
    today = now.strftime("%Y-%m-%d")
    for day in days:
        if not isinstance(day, dict):
            raise CheckinError("签到记录结构异常，未提交签到。")
        if day.get("day") == today:
            state = day.get("signIn")
            if state is True or (type(state) is int and state == 1):
                return {
                    "status": "skipped",
                    "message": "今日已签到，无需重复提交",
                }
            if state is not False and not (type(state) is int and state == 0):
                raise CheckinError("今日签到状态格式异常，未提交签到。")
    if check_only:
        return {
            "status": "success",
            "message": "登录状态和活动查询通过；今日未签到。本次为只查询模式。",
            "updated_count": 0,
        }
    result = client.post(
        "/business/activityRecord/completeQuest",
        {**base_body, "questTemplateId": templates[0]},
        write=True,
    )
    require_success(result, "签到")
    return {
        "status": "success",
        "message": "北京环球签到成功",
        "updated_count": 1,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="只查询登录状态和签到记录")
    args = parser.parse_args(argv)
    token = os.getenv("BJHQ_TOKEN", "").strip()
    user_id = os.getenv("BJHQ_USER_ID", "").strip()
    if not token or not user_id:
        return emit(
            {
                "status": "error",
                "success": False,
                "message": "缺少凭证：请配置 BJHQ_TOKEN 和 BJHQ_USER_ID",
            },
            2,
        )
    if any(c in token + user_id for c in ("\r", "\n")):
        return emit(
            {
                "status": "error",
                "success": False,
                "message": "凭证格式有误，请去掉换行",
            },
            2,
        )
    parsed_user_id: Any = int(user_id) if user_id.isdecimal() else user_id
    try:
        payload = run(Client(token, parsed_user_id), check_only=args.check)
        return emit(payload, 0)
    except CheckinError as exc:
        return emit(
            {
                "status": "error",
                "success": False,
                "message": str(exc),
            },
            1,
        )
    except Exception:
        return emit(
            {
                "status": "error",
                "success": False,
                "message": "出现未预期错误，已停止；请检查本地配置和活动接口",
            },
            1,
        )


if __name__ == "__main__":
    sys.exit(main())
