"""OpenAI 网页版完整注册链路执行器。

负责通过 curl_cffi 模拟 Chrome 浏览器，
配合 Sentinel 算力挑战与接码模块完成全自动化注册并直接持久化至号池。
"""
from __future__ import annotations

import base64
import hashlib
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
from services.register.auth_solver import (
    generate_sentinel_payload,
    init_auth_session,
    extract_session_token,
    generate_codex_identity,
)
from services.register.mail_provider import BaseMailProvider

logger = logging.getLogger(__name__)

CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
DEFAULT_REDIRECT_URI = "http://localhost:1455/auth/callback"
DEFAULT_SCOPE = "openid profile email offline_access"

FIRST_NAMES = [
    "James", "Mary", "Robert", "Patricia", "John", "Jennifer", "Michael", "Linda",
    "David", "Elizabeth", "William", "Barbara", "Richard", "Susan", "Joseph", "Jessica",
    "Thomas", "Sarah", "Charles", "Karen", "Christopher", "Nancy", "Daniel", "Lisa",
    "Matthew", "Betty", "Anthony", "Margaret", "Mark", "Sandra", "Donald", "Ashley",
    "Steven", "Kimberly", "Paul", "Emily", "Andrew", "Donna", "Joshua", "Michelle",
]

LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
    "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
    "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson",
    "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker",
]


def _b64url_no_pad(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _sha256_b64url_no_pad(s: str) -> str:
    return _b64url_no_pad(hashlib.sha256(s.encode("ascii")).digest())


def _generate_password(length: int = 18) -> str:
    upper = random.choices(string.ascii_uppercase, k=2)
    lower = random.choices(string.ascii_lowercase, k=2)
    digits = random.choices(string.digits, k=2)
    specials = random.choices("!@#$%&*", k=2)
    pool = string.ascii_letters + string.digits + "!@#$%&*"
    rest = random.choices(pool, k=length - 8)
    chars = upper + lower + digits + specials + rest
    random.shuffle(chars)
    return "".join(chars)


def _generate_user_info() -> dict:
    name = f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}"
    year = random.randint(datetime.now().year - 42, datetime.now().year - 20)
    month = random.randint(1, 12)
    day = random.randint(1, 28)
    return {"name": name, "birthdate": f"{year}-{month:02d}-{day:02d}"}


def _parse_callback_url(callback_url: str) -> dict[str, str]:
    candidate = callback_url.strip()
    if not candidate:
        return {"code": "", "state": "", "error": ""}
    parsed = urllib.parse.urlparse(candidate)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    fragment = urllib.parse.parse_qs(parsed.fragment, keep_blank_values=True)
    for k, v in fragment.items():
        if k not in query or not query[k]:
            query[k] = v

    def get1(k: str) -> str:
        vals = query.get(k, [""])
        return (vals[0] or "").strip()

    code = get1("code")
    state = get1("state")
    error = get1("error")
    if code and not state and "#" in code:
        code, state = code.split("#", 1)
    return {"code": code, "state": state, "error": error}


def _make_trace_headers() -> dict[str, str]:
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


def _oai_headers(did: str, ua: str, extra: Optional[dict] = None) -> dict:
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
    h.update(_make_trace_headers())
    if extra:
        h.update(extra)
    return h


def register_single_account(
    mail_provider: BaseMailProvider,
    proxy: Optional[str] = None,
    log_fn: Optional[Callable[[str], None]] = None,
) -> dict[str, Any]:
    """执行单个账号的完整注册流程。

    返回结果字典: {"success": bool, "email": str, "access_token": str, "error": str}
    """
    def log(msg: str):
        if log_fn:
            log_fn(msg)
        logger.info(f"[RegisterWorker] {msg}")

    proxies = {"http": proxy, "https": proxy} if proxy else None
    proxy_info = proxy.split("@")[-1] if proxy and "@" in proxy else (proxy or "直连")

    log(f"开始新账号注册任务 (代理节点: {proxy_info})")

    # 1. 获取新邮箱
    email_addr, email_token = mail_provider.create_email()
    if not email_addr:
        err = "分配邮箱失败，请检查邮箱服务配置或网络连接"
        log(f"❌ {err}")
        return {"success": False, "email": "", "error": err}

    masked_email = email_addr[:3] + "***@" + email_addr.split("@")[-1]
    password = _generate_password()
    log(f"已申请注册邮箱: {masked_email}")

    # 2. 初始化 HTTP 客户端 Session (Chrome 浏览器指纹)
    session = requests.Session(proxies=proxies, impersonate="chrome")
    session.headers.update({"Connection": "close"})
    session.timeout = 30

    try:
        # 3. 初始化设备与认证会话状态 (获取 did, ua 以及 NextAuth state / csrf cookies)
        did, ua = init_auth_session(session, email_addr, proxy=proxy)
        reg_ctx: dict[str, Any] = {}
        log(f"设备指纹就绪 (DID: {did[:8]}...{did[-4:]})")

        # 检查是否成功建立有效的 OpenAI 认证会话凭证，避免无凭证发起提交导致 HTTP 409 (invalid_state)
        has_auth_session = any("auth-session" in c.name for c in session.cookies.jar)
        if not has_auth_session:
            err = "初始化认证会话失败：未获取到 OpenAI 认证 Session Cookie (直连受限或代理节点被 Cloudflare 403 拦截)"
            log(f"❌ {err}")
            return {"success": False, "email": email_addr, "error": err, "is_403": True}

        # 4. 生成并访问 OAuth PKCE 挑战端点，建立官方认证会话
        state = secrets.token_urlsafe(16)
        code_verifier = secrets.token_urlsafe(64)
        code_challenge = _sha256_b64url_no_pad(code_verifier)
        oauth_params = {
            "client_id": CLIENT_ID,
            "response_type": "code",
            "redirect_uri": DEFAULT_REDIRECT_URI,
            "scope": DEFAULT_SCOPE,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "screen_hint": "signup",
            "prompt": "create",
        }
        oauth_auth_url = f"https://auth.openai.com/oauth/authorize?{urllib.parse.urlencode(oauth_params)}"
        session.get(oauth_auth_url, proxies=proxies, timeout=20, allow_redirects=True, verify=False)
        cookie_did = session.cookies.get("oai-did")
        if cookie_did:
            did = str(cookie_did)

        # 5. 计算 Sentinel 算力挑战并提交账号进入注册流
        log(f"正在计算 Sentinel 算力挑战 (flow: authorize_continue)...")
        sentinel_payload = generate_sentinel_payload(
            did=did, flow="authorize_continue", proxy=proxy, user_agent=ua, ctx=reg_ctx
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
            proxies=proxies,
            timeout=25,
            verify=False,
        )

        if signup_resp.status_code == 403:
            err = "OpenAI 触发 403 风控拦截 (IP/节点受限)"
            log(f"⚠️ {err}")
            return {"success": False, "email": email_addr, "error": err, "is_403": True}

        if signup_resp.status_code == 409:
            err = f"OpenAI 认证会话失效 (HTTP 409: {signup_resp.text[:100]})"
            log(f"❌ {err}")
            return {"success": False, "email": email_addr, "error": err, "is_403": True}

        if signup_resp.status_code != 200:
            err = f"提交账号失败 HTTP {signup_resp.status_code}: {signup_resp.text[:100]}"
            log(f"❌ {err}")
            return {"success": False, "email": email_addr, "error": err}

        signup_data = signup_resp.json() if signup_resp.text else {}
        cont_url = str(signup_data.get("continue_url") or "")
        page_type = str((signup_data.get("page") or {}).get("type") or "")
        log(f"账号提交成功，会话流转至: {page_type or cont_url}")

        # 6. 触发向邮箱发送 6 位验证码 (优先走现代化 passwordless 无密码直通验证流)
        sentinel_otp_send = generate_sentinel_payload(
            did=did, flow="passwordless_signup", proxy=proxy, user_agent=ua, ctx=reg_ctx
        )
        send_headers = _oai_headers(did, ua, {
            "Referer": cont_url or "https://auth.openai.com/create-account/password",
            "Content-Type": "application/json",
            "openai-sentinel-token": sentinel_otp_send,
            "OpenAI-Sentinel-Token": sentinel_otp_send,
        })

        log(f"触发向邮箱派发 6 位验证码...")
        send_resp = session.post(
            "https://auth.openai.com/api/accounts/passwordless/send-otp",
            headers=send_headers,
            json={},
            proxies=proxies,
            timeout=20,
            verify=False,
        )

        if send_resp.status_code == 200:
            log(f"✅ 验证码邮件已成功派发 (passwordless)")
        else:
            log(f"⚠️ passwordless/send-otp 返回 HTTP {send_resp.status_code}，尝试备用重发端点...")
            resend_resp = session.post(
                "https://auth.openai.com/api/accounts/email-otp/resend",
                headers=send_headers,
                json={},
                proxies=proxies,
                timeout=20,
                verify=False,
            )
            if resend_resp.status_code == 200:
                log(f"✅ 备用重发成功 (email-otp/resend)")
            else:
                session.post(
                    "https://auth.openai.com/api/accounts/email-otp/send",
                    headers=send_headers,
                    json={},
                    proxies=proxies,
                    timeout=20,
                    verify=False,
                )

        # 8. 轮询提取邮件验证码
        log(f"正在等待邮件到达并提取验证码...")
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

        # 9. 验证邮件验证码
        sentinel_otp = generate_sentinel_payload(
            did=did, flow="email_otp_validate", proxy=proxy, user_agent=ua, ctx=reg_ctx
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
            proxies=proxies,
            timeout=20,
            verify=False,
        )

        if val_resp.status_code != 200:
            err = f"验证码校验未通过 HTTP {val_resp.status_code}: {val_resp.text[:100]}"
            log(f"❌ {err}")
            return {"success": False, "email": email_addr, "error": err}

        val_data = val_resp.json() if val_resp.text else {}
        cont_url = str(val_data.get("continue_url") or "")

        # 10. 填写个人资料 (About You)，若需要
        target_continue_url = cont_url
        if "about-you" in cont_url or "create-account" in cont_url:
            user_info = _generate_user_info()
            log(f"填写用户信息 (姓名: {user_info['name']}, 生日: {user_info['birthdate']})...")
            sentinel_about = generate_sentinel_payload(
                did=did, flow="oauth_create_account", proxy=proxy, user_agent=ua, ctx=reg_ctx
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
                proxies=proxies,
                timeout=20,
                verify=False,
            )
            log(f"create_account 响应 HTTP {about_resp.status_code}: {about_resp.text[:200]}")
            if about_resp.status_code == 200 and about_resp.text:
                target_continue_url = str(about_resp.json().get("continue_url") or target_continue_url)
                log(f"更新 target_continue_url: {target_continue_url}")

        # 11. 提取 API 凭据 (优先从回调 URL 提取 OAuth 授权码换取 Token)
        log(f"注册核验通过，提取 API 访问凭据...")
        access_token = ""
        refresh_token = ""
        id_token = ""

        # 策略 1: 检查 target_continue_url 是否已直接携带授权码回调
        cb_res = _parse_callback_url(target_continue_url)
        code = cb_res.get("code")

        # 策略 2: 若未直接携带，若为绝对 URL 则追踪重定向提取
        if not code and target_continue_url.startswith("http"):
            try:
                red_resp = session.get(target_continue_url, proxies=proxies, timeout=20, allow_redirects=True, verify=False)
                cb_res = _parse_callback_url(red_resp.url or "")
                code = cb_res.get("code")
            except Exception as e:
                logger.debug(f"跟踪 target_continue_url 失败: {e}")

        # 策略 3: 若仍未拿到 code，重入 OAuth 授权流换取
        if not code:
            log(f"尝试通过 OAuth 授权流换取授权码...")
            try:
                auth_resp = session.get(oauth_auth_url, proxies=proxies, timeout=25, allow_redirects=True, verify=False)
                current_url = auth_resp.url or ""
                cb_res = _parse_callback_url(current_url)

                if not cb_res["code"] and "consent" in current_url:
                    consent_resp = session.post(
                        "https://auth.openai.com/api/accounts/sign-in-with-chatgpt/codex/consent",
                        headers=_oai_headers(did, ua, {"Referer": current_url, "Content-Type": "application/json"}),
                        json={},
                        proxies=proxies,
                        timeout=20,
                        verify=False,
                    )
                    if consent_resp.status_code == 200 and consent_resp.text:
                        next_u = consent_resp.json().get("continue_url", "")
                        if next_u:
                            final_r = session.get(next_u, proxies=proxies, timeout=20, allow_redirects=True, verify=False)
                            cb_res = _parse_callback_url(final_r.url or "")

                code = cb_res.get("code")
            except Exception as e:
                logger.warning(f"OAuth PKCE 异常: {e}")

        if code:
            log(f"成功获取 OAuth 授权码 (code: {code[:10]}...)，正在换取 Access Token...")
            try:
                token_resp = requests.post(
                    "https://auth.openai.com/oauth/token",
                    data={
                        "grant_type": "authorization_code",
                        "client_id": CLIENT_ID,
                        "code": code,
                        "redirect_uri": DEFAULT_REDIRECT_URI,
                        "code_verifier": code_verifier,
                    },
                    headers={
                        "Content-Type": "application/x-www-form-urlencoded",
                        "User-Agent": ua,
                    },
                    proxies=proxies,
                    timeout=25,
                    verify=False,
                )
                if token_resp.status_code == 200:
                    token_data = token_resp.json()
                    access_token = str(token_data.get("access_token") or "").strip()
                    refresh_token = str(token_data.get("refresh_token") or "").strip()
                    id_token = str(token_data.get("id_token") or "").strip()
                    log(f"✅ 成功换取 API Access Token (长度: {len(access_token)}) 与 Refresh Token")
                else:
                    log(f"⚠️ /oauth/token 换取失败 HTTP {token_resp.status_code}: {token_resp.text[:100]}")
            except Exception as e:
                logger.warning(f"/oauth/token 请求异常: {e}")

        # 策略 4: 备用尝试从 Web Session 提取
        if not access_token and target_continue_url:
            sess_token = extract_session_token(session, target_continue_url, proxy=proxy)
            if sess_token:
                log(f"成功从 Web 会话提取 Access Token (长度: {len(sess_token)})")
                access_token = sess_token

        if not access_token:
            err = f"未能提取到有效 access_token (target_url: {target_continue_url[:80]})"
            log(f"❌ {err}")
            return {"success": False, "email": email_addr, "error": err}

        # 13. 存入号池数据库 (SQLite accounts.db)
        account_item = {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "id_token": id_token,
            "email": email_addr,
            "password": password,
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
            "refresh_token": refresh_token,
            "password": password,
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
