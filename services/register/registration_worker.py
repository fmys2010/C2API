"""OpenAI 官网全新架构注册机核心执行器。

基于真实的 ChatGPT Web 官方协议与 AuthCore 原生 Turnstile VM 模拟器，
结合 Gmail IMAP 自动提取与自毁清理，实现全自动化免密注册与 AccessToken 持久化。
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
from services.register.auth_solver import _load_auth_core, generate_sentinel_payload
from services.register.mail_provider import BaseMailProvider

logger = logging.getLogger(__name__)

FIRST_NAMES = [
    "James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph",
    "Thomas", "Charles", "Christopher", "Daniel", "Matthew", "Anthony", "Mark",
    "Donald", "Steven", "Paul", "Andrew", "Joshua", "Kenneth", "Kevin", "Brian",
    "George", "Timothy", "Ronald", "Edward", "Jason", "Jeffrey", "Ryan", "Jacob",
    "Emma", "Olivia", "Ava", "Isabella", "Sophia", "Mia", "Charlotte", "Amelia",
]

LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
    "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
    "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson",
]


def _generate_user_info() -> dict[str, str]:
    name = f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}"
    year = random.randint(datetime.now().year - 40, datetime.now().year - 20)
    month = random.randint(1, 12)
    day = random.randint(1, 28)
    return {"name": name, "birthdate": f"{year}-{month:02d}-{day:02d}"}


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


def register_single_account(
    mail_provider: BaseMailProvider,
    proxy: Optional[str] = None,
    log_fn: Optional[Callable[[str], None]] = None,
    target_email: Optional[str] = None,
    old_access_token: Optional[str] = None,
) -> dict[str, Any]:
    """执行单个 ChatGPT 官方账号的完整注册/重跑自愈流程。"""
    def log(msg: str):
        if log_fn:
            log_fn(msg)
        logger.info(f"[RegisterWorker] {msg}")

    proxies = {"http": proxy, "https": proxy} if proxy else None
    proxy_info = proxy.split("@")[-1] if proxy and "@" in proxy else (proxy or "直连/TUN")

    if target_email:
        email_addr = target_email.strip()
        email_token = email_addr
        masked_email = email_addr[:3] + "***@" + email_addr.split("@")[-1] if "@" in email_addr else email_addr
        log(f"开始异常账号重跑注册流程: {masked_email} (网络环境: {proxy_info})")
    else:
        log(f"开始新账号注册任务 (网络环境: {proxy_info})")

        # 1. 申请注册邮箱
        email_addr, email_token = mail_provider.create_email()
        if not email_addr:
            err = "分配邮箱失败，请检查邮箱服务或域名配置"
            log(f"❌ {err}")
            return {"success": False, "email": "", "error": err}

        masked_email = email_addr[:3] + "***@" + email_addr.split("@")[-1]
        log(f"已申请注册邮箱: {masked_email}")

    # 2. 初始化高仿真 Session 客户端
    session = requests.Session(proxies=proxies, impersonate="chrome")
    session.timeout = 30

    core = _load_auth_core()
    did = str(uuid.uuid4())
    ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    try:
        # 3. 官方 Auth 会话初始化
        log("初始化 ChatGPT 官方认证会话...")
        if core and hasattr(core, "init_auth"):
            try:
                core_did, core_ua = core.init_auth(
                    session=session,
                    email=email_addr,
                    masked_email=masked_email,
                    proxies=proxies,
                    verify=False,
                )
                if core_did:
                    did = core_did
                if core_ua:
                    ua = core_ua
            except Exception as ie:
                logger.warning(f"[RegisterWorker] core.init_auth warning: {ie}")

        log(f"设备指纹就绪 (DID: {did[:8]}...{did[-4:]})")

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

        headers = {
            "user-agent": ua,
            "accept": "application/json",
            "content-type": "application/json",
            "oai-device-id": did,
            "origin": "https://auth.openai.com",
            "referer": "https://auth.openai.com/create-account",
            "openai-sentinel-token": sentinel_payload,
        }
        headers.update(_make_trace_headers())

        signup_resp = session.post(
            "https://auth.openai.com/api/accounts/authorize/continue",
            headers=headers,
            json={"username": {"value": email_addr, "kind": "email"}, "screen_hint": "login_or_signup"},
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

        account_password = ""
        if target_email:
            # 已有账号重跑流程：访问 continue_url 触发验证码派发
            if cont_url:
                try:
                    session.get(
                        cont_url,
                        headers={
                            "user-agent": ua,
                            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                            "referer": "https://auth.openai.com/",
                        },
                        timeout=25,
                        verify=False,
                    )
                except Exception as ce:
                    logger.debug(f"[RegisterWorker] GET continue_url error: {ce}")
            log("已有账号重跑流程：已触发邮箱验证码派发")
        else:
            # 4.1 全新账号注册：提交并绑定独立密码
            from services.config import config
            default_pwd = getattr(config, "default_register_password", "")
            if default_pwd:
                account_password = default_pwd
            else:
                account_password = f"P@ss{secrets.token_urlsafe(12)}"

            log("正在提交账号密码注册并请求派发验证码...")
            sentinel_pwd = generate_sentinel_payload(
                did=did,
                flow="username_password_create",
                proxy=proxy,
                user_agent=ua,
                ctx=reg_ctx,
            )
            pwd_headers = {
                "user-agent": ua,
                "accept": "application/json",
                "content-type": "application/json",
                "oai-device-id": did,
                "origin": "https://auth.openai.com",
                "referer": "https://auth.openai.com/create-account/password",
                "openai-sentinel-token": sentinel_pwd,
            }
            pwd_headers.update(_make_trace_headers())
            pwd_resp = session.post(
                "https://auth.openai.com/api/accounts/user/register",
                headers=pwd_headers,
                json={"username": email_addr, "password": account_password},
                timeout=20,
                verify=False,
            )
            if pwd_resp.status_code == 200:
                cont_send = (pwd_resp.json() if pwd_resp.text else {}).get("continue_url")
                if cont_send:
                    session.get(cont_send, headers=pwd_headers, timeout=20, verify=False)
                log("✅ 独立密码绑定成功，已触发邮箱验证码派发")
            else:
                log(f"⚠️ 密码提交响应 HTTP {pwd_resp.status_code}: {pwd_resp.text[:100]}，继续验证流程")

        # 5. 轮询提取邮件验证码
        log("正在等待邮件到达并提取验证码...")
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

        log(f"提取验证码成功: {otp_code}，提交核验...")

        # 6. 校验邮件验证码
        sentinel_otp = generate_sentinel_payload(
            did=did,
            flow="authorize_continue",
            proxy=proxy,
            user_agent=ua,
            ctx=reg_ctx,
        )
        val_headers = {
            "user-agent": ua,
            "accept": "application/json",
            "content-type": "application/json",
            "oai-device-id": did,
            "origin": "https://auth.openai.com",
            "referer": "https://auth.openai.com/email-verification",
            "openai-sentinel-token": sentinel_otp,
        }
        val_headers.update(_make_trace_headers())

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
        log("✅ 验证码校验通过")

        # 7. 填写个人资料 (About You) - 仅全新注册账号需填写
        if not target_email and ("about-you" in target_continue_url or "create-account" in target_continue_url):
            user_info = _generate_user_info()
            log(f"完善个人信息 (姓名: {user_info['name']}, 生日: {user_info['birthdate']})...")
            sentinel_about = generate_sentinel_payload(
                did=did,
                flow="create_account",
                proxy=proxy,
                user_agent=ua,
                ctx=reg_ctx,
            )
            about_headers = {
                "user-agent": ua,
                "accept": "application/json",
                "content-type": "application/json",
                "oai-device-id": did,
                "origin": "https://auth.openai.com",
                "referer": "https://auth.openai.com/about-you",
                "openai-sentinel-token": sentinel_about,
            }
            about_headers.update(_make_trace_headers())

            about_resp = session.post(
                "https://auth.openai.com/api/accounts/create_account",
                headers=about_headers,
                json=user_info,
                timeout=20,
                verify=False,
            )
            if about_resp.status_code == 200 and about_resp.text:
                target_continue_url = str(about_resp.json().get("continue_url") or target_continue_url)
            log("✅ 个人信息提交成功")

        # 8. 换取 ChatGPT Access Token 与 Web Session Cookie
        log("核验全流程通过，正在提取 API 访问凭据 (Access Token)...")
        access_token = ""
        user_obj: dict[str, Any] = {}

        # 优先跟随 continue_url 完成 Web 端会话流转与 Cookie 种植
        if target_continue_url:
            try:
                c_resp = session.get(target_continue_url, timeout=25, allow_redirects=True, verify=False)
                logger.debug(f"[RegisterWorker] continue_url navigation response: {c_resp.status_code}")
            except Exception as ce:
                logger.debug(f"[RegisterWorker] continue_url navigation error: {ce}")

        # 尝试从 /api/auth/session 提取 AccessToken 与 Session 信息
        try:
            sess_resp = session.get("https://chatgpt.com/api/auth/session", timeout=20, verify=False)
            if sess_resp.status_code == 200 and sess_resp.text:
                sess_data = sess_resp.json()
                access_token = str(sess_data.get("accessToken") or "").strip()
                user_obj = sess_data.get("user") or {}
                if access_token:
                    logger.debug("[RegisterWorker] AccessToken extracted via Web session endpoint")
        except Exception as se:
            logger.debug(f"[RegisterWorker] Web session fallback error: {se}")

        # 若未成功提取，使用 AuthCore 原生数据通道提取 AccessToken
        if not access_token and core and hasattr(core, "image2api_data"):
            try:
                res_data = core.image2api_data(session, target_continue_url, proxies)
                if res_data and isinstance(res_data, str) and len(res_data) > 50:
                    access_token = res_data
            except Exception as ae:
                logger.debug(f"[RegisterWorker] core.image2api_data: {ae}")

        if not access_token:
            err = "未能提取到有效 accessToken"
            log(f"❌ {err}")
            return {"success": False, "email": email_addr, "error": err}

        # 提取 NextAuth 会话 Cookie 用于常驻心跳续期 (方案 C - 免手机号，支持标准与分片 Cookie)
        session_token = ""
        for key in ("__Secure-next-auth.session-token", "__Host-next-auth.session-token"):
            v = session.cookies.get(key)
            if v:
                session_token = v
                break

        if not session_token:
            chunks: list[tuple[int, str]] = []
            for cookie in session.cookies.jar:
                if "next-auth.session-token." in cookie.name:
                    try:
                        idx = int(cookie.name.split(".")[-1])
                        chunks.append((idx, cookie.value))
                    except (ValueError, IndexError):
                        pass
                elif "next-auth.session-token" in cookie.name:
                    session_token = cookie.value
                    break
            if not session_token and chunks:
                chunks.sort(key=lambda x: x[0])
                session_token = "".join(v for _, v in chunks)

        # 9. 存入号池数据库 (SQLite accounts.db)
        if target_email:
            target_token = old_access_token or ""
            if not target_token:
                for a in account_service.list_accounts():
                    if str(a.get("email") or "").strip().lower() == email_addr.lower():
                        target_token = str(a.get("access_token") or "")
                        break
            token_data = {
                "access_token": access_token,
                "session_token": session_token,
            }
            if target_token:
                account_service._apply_refreshed_tokens(target_token, token_data, "register_rerun")
            account_service.update_account(
                access_token,
                {
                    "status": "正常",
                    "invalid_count": 0,
                    "last_invalid_at": None,
                    "device_id": did,
                    "oai-device-id": did,
                    "user-agent": ua,
                    "token_updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                },
                quiet=True,
            )
            try:
                account_service.fetch_remote_info(access_token, "relogin_sync")
            except Exception:
                pass
            account_service._notify_pool_health_change()
            log(f"🎉 异常账号重跑注册成功并自愈恢复！邮箱: {email_addr} (Token: {access_token[:12]}...{access_token[-8:]})")
            return {
                "success": True,
                "email": email_addr,
                "access_token": access_token,
                "session_token": session_token,
                "user": user_obj,
            }

        account_item = {
            "access_token": access_token,
            "refresh_token": "",
            "session_token": session_token,
            "id_token": "",
            "email": email_addr,
            "password": account_password,
            "device_id": did,
            "oai-device-id": did,
            "user-agent": ua,
            "status": "正常",
            "source_type": "web_register",
            "quota": 25,
            "invalid_count": 0,
            "registered_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "token_updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        res = account_service.add_account_items([account_item])
        log(f"🎉 账号注册成功并存入号池！邮箱: {email_addr} (Token: {access_token[:12]}...{access_token[-8:]}, SessionCookie: {'已捕获' if session_token else '未捕获'})")

        # 同步远程账号详情与额度信息
        try:
            account_service.fetch_remote_info(access_token, "register_sync")
            log(f"✅ 账号信息与生图额度已同步: {email_addr}")
        except Exception as se:
            logger.debug(f"[RegisterWorker] Post-register sync warning: {se}")

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
