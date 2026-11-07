"""OpenAI 官网全新架构注册机核心执行器。

基于真实的 ChatGPT Web OAuth 注册协议，结合 Sentinel + Turnstile VM 算力挑战与
Gmail IMAP 邮件监听自毁机制，实现全自动化注册并将 Access Token 持久化至号池。
"""
from __future__ import annotations

import json
import logging
import random
import re
import secrets
import string
import time
import urllib.parse
import uuid
from datetime import datetime
from typing import Any, Callable, Optional

from curl_cffi import requests

from services.account_service import account_service
from services.register.auth_solver import generate_sentinel_payload
from services.register.mail_provider import BaseMailProvider

logger = logging.getLogger(__name__)

FIRST_NAMES = [
    "James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph",
    "Thomas", "Charles", "Christopher", "Daniel", "Matthew", "Anthony", "Mark",
    "Donald", "Steven", "Paul", "Andrew", "Joshua", "Kenneth", "Kevin", "Brian",
    "George", "Timothy", "Ronald", "Edward", "Jason", "Jeffrey", "Ryan", "Jacob",
    "Gary", "Nicholas", "Eric", "Jonathan", "Stephen", "Larry", "Justin", "Scott",
    "Emma", "Olivia", "Ava", "Isabella", "Sophia", "Mia", "Charlotte", "Amelia",
    "Harper", "Evelyn", "Abigail", "Emily", "Ella", "Elizabeth", "Camila", "Luna",
]

LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
    "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
    "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson",
    "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker",
    "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill",
    "Flores", "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell",
]


def _generate_user_info() -> dict[str, str]:
    name = f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}"
    year = random.randint(datetime.now().year - 40, datetime.now().year - 20)
    month = random.randint(1, 12)
    day = random.randint(1, 28)
    return {"name": name, "birthdate": f"{year}-{month:02d}-{day:02d}"}


def _trace_headers() -> dict[str, str]:
    trace_id = str(random.getrandbits(64))
    parent_id = str(random.getrandbits(64))
    return {
        "traceparent": f"00-{uuid.uuid4().hex}-{format(int(parent_id), '016x')}-01",
        "tracestate": "dd=s:1;o:rum",
        "x-datadog-origin": "rum",
        "x-datadog-parent-id": parent_id,
        "x-datadog-sampling-priority": "1",
        "x-datadog-trace-id": trace_id,
    }


def _oai_headers(did: str, ua: str, extra: Optional[dict] = None) -> dict[str, str]:
    h = {
        "User-Agent": ua,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "oai-device-id": did,
        "oai-language": "en-US",
        "Origin": "https://auth.openai.com",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
    }
    h.update(_trace_headers())
    if extra:
        h.update(extra)
    return h


def register_single_account(
    mail_provider: BaseMailProvider,
    proxy: Optional[str] = None,
    log_fn: Optional[Callable[[str], None]] = None,
) -> dict[str, Any]:
    """执行单个 ChatGPT 官方账号的完整注册流程。"""
    def log(msg: str):
        if log_fn:
            log_fn(msg)
        logger.info(f"[RegisterWorker] {msg}")

    proxies = {"http": proxy, "https": proxy} if proxy else None
    proxy_info = proxy.split("@")[-1] if proxy and "@" in proxy else (proxy or "直连/TUN")

    log(f"开始新账号注册任务 (网络环境: {proxy_info})")

    # 1. 申请注册邮箱
    email_addr, email_token = mail_provider.create_email()
    if not email_addr:
        err = "分配邮箱失败，请检查邮箱服务或域名配置"
        log(f"❌ {err}")
        return {"success": False, "email": "", "error": err}

    masked_email = email_addr[:3] + "***@" + email_addr.split("@")[-1]
    log(f"已申请注册邮箱: {masked_email}")

    # 2. 初始化高仿真 Chrome 客户端
    session = requests.Session(proxies=proxies, impersonate="chrome")
    session.headers.update({"Connection": "close"})
    session.timeout = 30
    ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    try:
        # 3. 官方 NextAuth 握手端点初始化
        log("初始化 ChatGPT 官方认证会话...")
        csrf_resp = session.get("https://chatgpt.com/api/auth/csrf", timeout=20, verify=False)
        if csrf_resp.status_code != 200:
            err = f"获取 CSRF Token 失败 (HTTP {csrf_resp.status_code})"
            log(f"❌ {err}")
            return {"success": False, "email": email_addr, "error": err}

        csrf_token = csrf_resp.json().get("csrfToken")
        signin_data = {
            "callbackUrl": "https://chatgpt.com/",
            "csrfToken": csrf_token,
            "json": "true",
        }
        # 注意：官网真实参数仅需 screen_hint=signup，严禁带 prompt=create
        signin_resp = session.post(
            "https://chatgpt.com/api/auth/signin/openai?screen_hint=signup",
            data=signin_data,
            timeout=20,
            verify=False,
        )
        if signin_resp.status_code != 200:
            err = f"NextAuth 握手失败 (HTTP {signin_resp.status_code})"
            log(f"❌ {err}")
            return {"success": False, "email": email_addr, "error": err}

        auth_url = signin_resp.json().get("url", "")
        if not auth_url:
            err = "未能从 NextAuth 获取官方授权登录 URL"
            log(f"❌ {err}")
            return {"success": False, "email": email_addr, "error": err}

        # 访问授权页面获取 auth.openai.com 会话 Cookie 及 Device ID
        auth_page_resp = session.get(auth_url, timeout=20, allow_redirects=True, verify=False)
        did = str(session.cookies.get("oai-did") or uuid.uuid4())
        log(f"设备指纹就绪 (DID: {did[:8]}...{did[-4:]})")

        # 检查是否成功建立有效的 OpenAI 认证会话凭证
        has_auth_session = any("auth-session" in c.name for c in session.cookies.jar)
        if not has_auth_session:
            err = "初始化认证会话失败：未获取到 auth-session Cookie (IP 被阻断)"
            log(f"❌ {err}")
            return {"success": False, "email": email_addr, "error": err, "is_403": True}

        # 4. 计算包含 Turnstile VM 凭据的 Sentinel Token 并提交邮箱
        log("正在计算 Sentinel + Turnstile 算力挑战 (flow: authorize_continue)...")
        reg_ctx: dict[str, Any] = {}
        sentinel_payload = generate_sentinel_payload(
            did=did,
            flow="authorize_continue",
            proxy=proxy,
            user_agent=ua,
            ctx=reg_ctx,
        )

        headers = _oai_headers(did, ua, {
            "Referer": "https://auth.openai.com/create-account",
            "Content-Type": "application/json",
            "openai-sentinel-token": sentinel_payload,
            "OpenAI-Sentinel-Token": sentinel_payload,
        })

        signup_resp = session.post(
            "https://auth.openai.com/api/accounts/authorize/continue",
            headers=headers,
            json={"username": {"value": email_addr, "kind": "email"}, "screen_hint": "signup"},
            timeout=25,
            verify=False,
        )

        if signup_resp.status_code == 403:
            err = "OpenAI 触发 403 风控拦截 (节点受限)"
            log(f"⚠️ {err}")
            return {"success": False, "email": email_addr, "error": err, "is_403": True}

        if signup_resp.status_code != 200:
            err = f"提交账号失败 HTTP {signup_resp.status_code}: {signup_resp.text[:120]}"
            log(f"❌ {err}")
            return {"success": False, "email": email_addr, "error": err}

        signup_data = signup_resp.json() if signup_resp.text else {}
        page_type = str((signup_data.get("page") or {}).get("type") or "")
        cont_url = str(signup_data.get("continue_url") or "")
        log(f"账号提交成功，会话流转至: {page_type or cont_url}")
        log("✅ 验证码邮件已派发至收件箱")

        # 5. 轮询提取邮件验证码
        log("正在监听邮箱接收验证码...")
        otp_code = mail_provider.get_code(
            email_addr,
            token=email_token,
            timeout=120,
            poll_interval=4,
            log_fn=log,
        )

        if not otp_code:
            err = "获取邮箱验证码超时（未收到邮件或解析失败）"
            log(f"❌ {err}")
            return {"success": False, "email": email_addr, "error": err}

        log(f"收到验证码: {otp_code}，提交核验...")

        # 6. 校验邮件验证码
        sentinel_otp = generate_sentinel_payload(
            did=did,
            flow="email_otp_validate",
            proxy=proxy,
            user_agent=ua,
            ctx=reg_ctx,
        )
        val_headers = _oai_headers(did, ua, {
            "Referer": "https://auth.openai.com/email-verification",
            "Content-Type": "application/json",
            "openai-sentinel-token": sentinel_otp,
            "OpenAI-Sentinel-Token": sentinel_otp,
        })

        val_resp = session.post(
            "https://auth.openai.com/api/accounts/email-otp/validate",
            headers=val_headers,
            json={"code": otp_code},
            timeout=20,
            verify=False,
        )

        if val_resp.status_code != 200:
            err = f"验证码校验未通过 HTTP {val_resp.status_code}: {val_resp.text[:100]}"
            log(f"❌ {err}")
            return {"success": False, "email": email_addr, "error": err}

        val_data = val_resp.json() if val_resp.text else {}
        target_continue_url = str(val_data.get("continue_url") or "")

        # 7. 填写个人资料 (About You)
        if "about-you" in target_continue_url or "create-account" in target_continue_url:
            user_info = _generate_user_info()
            log(f"填写用户信息 (姓名: {user_info['name']}, 生日: {user_info['birthdate']})...")
            sentinel_about = generate_sentinel_payload(
                did=did,
                flow="oauth_create_account",
                proxy=proxy,
                user_agent=ua,
                ctx=reg_ctx,
            )
            about_headers = _oai_headers(did, ua, {
                "Referer": "https://auth.openai.com/about-you",
                "Content-Type": "application/json",
                "OpenAI-Sentinel-Token": sentinel_about,
                "openai-sentinel-token": sentinel_about,
            })
            about_resp = session.post(
                "https://auth.openai.com/api/accounts/create_account",
                headers=about_headers,
                json=user_info,
                timeout=20,
                verify=False,
            )
            if about_resp.status_code == 200 and about_resp.text:
                target_continue_url = str(about_resp.json().get("continue_url") or target_continue_url)

        # 8. 跟踪回调授权链提取 ChatGPT Access Token
        log("核验通过，跟踪授权回调换取 API 访问凭据...")
        session.get(target_continue_url, timeout=25, allow_redirects=True, verify=False)

        # 提取 Web Session Token
        sess_resp = session.get("https://chatgpt.com/api/auth/session", timeout=20, verify=False)
        access_token = ""
        user_obj: dict[str, Any] = {}
        if sess_resp.status_code == 200:
            sess_data = sess_resp.json()
            access_token = str(sess_data.get("accessToken") or "").strip()
            user_obj = sess_data.get("user") or {}

        if not access_token:
            err = "未能从 Web 会话提取有效 accessToken"
            log(f"❌ {err}")
            return {"success": False, "email": email_addr, "error": err}

        # 9. 存入号池数据库 (SQLite accounts.db)
        account_item = {
            "access_token": access_token,
            "refresh_token": "",
            "id_token": "",
            "email": email_addr,
            "password": "Passwordless_Web",
            "device_id": did,
            "status": "正常",
            "source_type": "web_register",
            "registered_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "token_updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        res = account_service.add_account_items([account_item])
        log(f"🎉 注册成功并存入号池！账号: {email_addr} (Token: {access_token[:10]}...{access_token[-6:]})")

        return {
            "success": True,
            "email": email_addr,
            "access_token": access_token,
            "user": user_obj,
            "db_result": res,
        }

    except Exception as exc:
        err = f"注册过程异常: {exc}"
        log(f"💥 {err}")
        logger.error(f"[RegisterWorker] Exception: {exc}", exc_info=True)
        return {"success": False, "email": email_addr, "error": err}
    finally:
        try:
            session.close()
        except Exception:
            pass
