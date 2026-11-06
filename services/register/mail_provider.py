"""邮箱获取与 OpenAI 验证码接收适配器。

支持 DuckMail 临时邮箱与 Cloudflare 自定义域名/IMAP 协议。
"""
from __future__ import annotations

import email
import imaplib
import json
import logging
import random
import re
import string
import threading
import time
import urllib.request
from abc import ABC, abstractmethod
from email.header import decode_header
from html import unescape
from typing import Any, Callable, Optional
from urllib.parse import urlparse

from curl_cffi import requests

logger = logging.getLogger(__name__)


def _extract_otp_code(raw_html: str) -> Optional[str]:
    """从邮件 HTML/文本中提取 6 位 OpenAI 数字验证码。"""
    if not raw_html:
        return None
    # 过滤掉 script 与 style 标签（避免匹配到 js 时间戳或缓存参数如 600000）
    clean = re.sub(r"(?is)<(style|script)[^>]*>.*?</\1>", " ", str(raw_html))
    clean = re.sub(r"<[^>]+>", " ", clean)
    clean = unescape(clean)

    patterns = [
        r"(?i)Your (?:ChatGPT|OpenAI) code is\s*(\d{6})",
        r"(?i)(?:ChatGPT|OpenAI) code is\s*(\d{6})",
        r"(?i)verification code to continue:\s*(\d{6})",
        r"(?i)Subject:.*?(\d{6})",
        r"(?i)enter this code:\s*(\d{6})",
        r"(?i)(?:verification|verify|security|login|sign[- ]?up)\s*code\D{0,35}?(\d{6})\b",
        r"(?i)(?:your code is|code is|code[:：])\D{0,20}?(\d{6})\b",
        r"(?i)验证码\D{0,15}?(\d{6})\b",
        r"\b(\d{6})\b",
    ]
    for p in patterns:
        m = re.search(p, clean)
        if m:
            code = m.group(1)
            # 排除明显的整十万占位或错误时间戳
            if code not in ("000000", "600000", "999999"):
                return code
    return None


class BaseMailProvider(ABC):
    """邮箱适配器基类"""

    @abstractmethod
    def create_email(self) -> tuple[Optional[str], Optional[str]]:
        """分配新邮箱，返回 (email_address, token_or_id)。"""
        raise NotImplementedError

    @abstractmethod
    def get_code(
        self,
        email_addr: str,
        token: Optional[str] = None,
        timeout: int = 120,
        poll_interval: int = 4,
        log_fn: Optional[Callable[[str], None]] = None,
    ) -> Optional[str]:
        """轮询提取 6 位验证码。"""
        raise NotImplementedError


class DuckMailProvider(BaseMailProvider):
    """DuckMail 临时邮箱驱动（兼容 Hydra API）。"""

    def __init__(
        self,
        api_base: str = "https://api.duckmail.com",
        domain: str = "duckmail.com",
        proxy: Optional[str] = None,
    ):
        self.api_base = api_base.rstrip("/")
        self.domain = domain.strip().lstrip("@") or "duckmail.com"
        self.proxy = proxy
        self.proxies = {"http": proxy, "https": proxy} if proxy else None

    def create_email(self) -> tuple[Optional[str], Optional[str]]:
        user = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
        address = f"{user}@{self.domain}"
        password = "".join(random.choices(string.ascii_letters + string.digits, k=14))

        try:
            # 1. 注册账号
            requests.post(
                f"{self.api_base}/accounts",
                json={"address": address, "password": password},
                proxies=self.proxies,
                timeout=15,
                verify=False,
            )
            # 2. 获取鉴权 Token
            tk_res = requests.post(
                f"{self.api_base}/token",
                json={"address": address, "password": password},
                proxies=self.proxies,
                timeout=15,
                verify=False,
            )
            if tk_res.status_code == 200:
                tk = tk_res.json().get("token")
                return address, tk
        except Exception as e:
            logger.warning(f"[DuckMail] Create email failed: {e}")
        return None, None

    def get_code(
        self,
        email_addr: str,
        token: Optional[str] = None,
        timeout: int = 120,
        poll_interval: int = 4,
        log_fn: Optional[Callable[[str], None]] = None,
    ) -> Optional[str]:
        if not token:
            return None

        deadline = time.time() + timeout
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

        while time.time() < deadline:
            try:
                res = requests.get(
                    f"{self.api_base}/messages",
                    headers=headers,
                    params={"page": 1},
                    proxies=self.proxies,
                    timeout=15,
                    verify=False,
                )
                if res.status_code == 200:
                    resp_data = res.json()
                    if isinstance(resp_data, list):
                        messages = resp_data
                    elif isinstance(resp_data, dict):
                        messages = resp_data.get("hydra:member", resp_data.get("messages", []))
                    else:
                        messages = []

                    for m in messages:
                        if not isinstance(m, dict):
                            continue
                        msg_id = m.get("id")
                        if not msg_id:
                            continue
                        detail = requests.get(
                            f"{self.api_base}/messages/{msg_id}",
                            headers=headers,
                            proxies=self.proxies,
                            timeout=15,
                            verify=False,
                        )
                        if detail.status_code == 200:
                            data = detail.json()
                            content = (
                                str(data.get("text") or "")
                                + " "
                                + str(data.get("intro") or "")
                                + " "
                                + str(data.get("html") or "")
                            )
                            code = _extract_otp_code(content)
                            if code:
                                if log_fn:
                                    log_fn(f"成功提取到 OpenAI 验证码: {code}")
                                return code
            except Exception as e:
                logger.warning(f"[DuckMail] Polling error: {e}")

            time.sleep(poll_interval)

        return None


class CloudflareImapMailProvider(BaseMailProvider):
    """Cloudflare 自定义域名 Email Routing + IMAP 协议邮箱驱动。"""

    def __init__(
        self,
        host: str,
        port: int = 993,
        username: str = "",
        password: str = "",
        domains: str = "",
        proxy: Optional[str] = None,
    ):
        self.host = host.strip()
        self.port = int(port or 993)
        self.username = username.strip()
        self.password = password.strip()
        self.domains = [d.strip().lstrip("@") for d in domains.split(",") if d.strip()]
        self.proxy = proxy

    def create_email(self) -> tuple[Optional[str], Optional[str]]:
        if not self.domains:
            return None, None
        domain = random.choice(self.domains)
        prefix = "".join(random.choices(string.ascii_lowercase + string.digits, k=9))
        email_addr = f"{prefix}@{domain}"
        return email_addr, email_addr

    def _connect_imap(self) -> imaplib.IMAP4_SSL:
        # 支持 SOCKS5 代理直连
        if self.proxy and ("socks5://" in self.proxy or "socks5h://" in self.proxy):
            import socks
            p = urlparse(self.proxy.replace("socks5h://", "socks5://"))
            socks.set_default_proxy(
                socks.SOCKS5,
                p.hostname,
                p.port,
                username=p.username,
                password=p.password,
            )
            socks.wrap_module(imaplib)

        client = imaplib.IMAP4_SSL(self.host, self.port)
        client.login(self.username, self.password)
        return client

    def get_code(
        self,
        email_addr: str,
        token: Optional[str] = None,
        timeout: int = 120,
        poll_interval: int = 4,
        log_fn: Optional[Callable[[str], None]] = None,
    ) -> Optional[str]:
        deadline = time.time() + timeout
        user_part = email_addr.split("@")[0].lower() if "@" in email_addr else email_addr.lower()

        while time.time() < deadline:
            client = None
            try:
                client = self._connect_imap()
                client.select("INBOX")
                status, data = client.search(None, "UNSEEN")
                if status == "OK" and data and data[0]:
                    msg_nums = data[0].split()
                    # 从最新的一封往前检查
                    for num in reversed(msg_nums[-10:]):
                        _, msg_data = client.fetch(num, "(RFC822)")
                        if not msg_data or not msg_data[0]:
                            continue
                        raw_email = msg_data[0][1]
                        msg = email.message_from_bytes(raw_email)
                        to_header = str(msg.get("To", "")).lower()
                        delivered_to = str(msg.get("Delivered-To", "")).lower()
                        x_forwarded_to = str(msg.get("X-Forwarded-To", "")).lower()

                        # 检查目标邮箱匹配
                        is_target = (
                            email_addr.lower() in to_header
                            or email_addr.lower() in delivered_to
                            or email_addr.lower() in x_forwarded_to
                            or user_part in to_header
                        )

                        # 如果是 Catch-All，可能所有邮件在一个收件箱中
                        if is_target or len(self.domains) == 1:
                            # 提取正文
                            body_text = ""
                            if msg.is_multipart():
                                for part in msg.walk():
                                    ctype = part.get_content_type()
                                    if ctype in ("text/plain", "text/html"):
                                        try:
                                            body_text += part.get_payload(decode=True).decode("utf-8", errors="ignore") + " "
                                        except Exception:
                                            pass
                            else:
                                try:
                                    body_text = msg.get_payload(decode=True).decode("utf-8", errors="ignore")
                                except Exception:
                                    pass

                            code = _extract_otp_code(body_text)
                            if code:
                                if log_fn:
                                    log_fn(f"[IMAP] 成功提取到匹配 {email_addr} 的验证码: {code}")
                                return code
            except Exception as e:
                logger.debug(f"[IMAP] Polling error: {e}")
            finally:
                if client:
                    try:
                        client.close()
                        client.logout()
                    except Exception:
                        pass

            time.sleep(poll_interval)

        return None


class InboxesMailProvider(BaseMailProvider):
    """Inboxes.com 公共免配置临时邮箱驱动。"""

    def __init__(self, proxy: Optional[str] = None):
        self.proxy = proxy
        self.proxies = {"http": proxy, "https": proxy} if proxy else None
        self.base_url = "https://inboxes.com/api/v2"
        self.session = requests.Session(impersonate="chrome120")
        if self.proxies:
            self.session.proxies = self.proxies
        self.headers = {
            "accept": "application/json, text/plain, */*",
            "origin": "https://inboxes.com",
            "referer": "https://inboxes.com/",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }

    def create_email(self) -> tuple[Optional[str], Optional[str]]:
        try:
            res = self.session.post(f"{self.base_url}/inbox", headers=self.headers, json={}, timeout=15)
            if res.status_code == 200:
                data = res.json()
                email_addr = data.get("inbox")
                user_id = self.session.cookies.get_dict().get("user_id", "")
                if email_addr and user_id:
                    return email_addr, user_id
        except Exception as e:
            logger.warning(f"[Inboxes] Create email failed: {e}")
        return None, None

    def get_code(
        self,
        email_addr: str,
        token: Optional[str] = None,
        timeout: int = 120,
        poll_interval: int = 4,
        log_fn: Optional[Callable[[str], None]] = None,
    ) -> Optional[str]:
        deadline = time.time() + timeout
        user_id = token or self.session.cookies.get_dict().get("user_id", "")
        cookies = {"user_id": user_id} if user_id else None

        while time.time() < deadline:
            try:
                res = self.session.get(
                    f"{self.base_url}/inbox/{email_addr}",
                    headers=self.headers,
                    cookies=cookies,
                    timeout=15,
                )
                if res.status_code == 200:
                    msgs = res.json().get("msgs", [])
                    for m in msgs:
                        uid = m.get("uid")
                        if uid:
                            read_res = self.session.get(
                                f"https://inboxes.com/read/{uid}",
                                headers=self.headers,
                                cookies=cookies,
                                timeout=15,
                            )
                            if read_res.status_code == 200:
                                code = _extract_otp_code(read_res.text)
                                if code:
                                    if log_fn:
                                        log_fn(f"[Inboxes] 成功提取到 OpenAI 验证码: {code}")
                                    return code
            except Exception as e:
                logger.debug(f"[Inboxes] Polling error: {e}")

            time.sleep(poll_interval)

        return None


class CloudflareWorkerMailProvider(BaseMailProvider):
    """Cloudflare Email Worker 直推接码适配器（0 存储、0 轮询）。

    特性：
    1. 零存储依赖：不使用任何 CF KV, D1, R2 或外部数据库。
    2. 请求最小化：单封邮件仅触发 1 次 HTTP POST 推送，彻底消除客户端高频轮询开销。
    3. 毫秒级响应：基于 Python 线程 Event 挂起，Worker Webhook 推送瞬间即可被唤醒返回。
    4. 兼具无穿透备用通道：支持直接 Webhook 或通过轻量 ntfy.sh SSE 广播接收。
    """

    _pending_events: dict[str, threading.Event] = {}
    _received_codes: dict[str, str] = {}
    _lock = threading.Lock()
    _active_topics: set[str] = set()

    def __init__(
        self,
        domains: str = "",
        webhook_secret: str = "",
        ntfy_topic: str = "",
        proxy: Optional[str] = None,
    ):
        raw_domains = re.split(r"[,;\n\s]+", str(domains or ""))
        self.domains = [d.strip().lstrip("@") for d in raw_domains if d.strip()]
        self.webhook_secret = (webhook_secret or "").strip()
        self.ntfy_topic = (ntfy_topic or "").strip()
        self.proxy = proxy

        if self.ntfy_topic:
            self._ensure_ntfy_listener(self.ntfy_topic)

    @classmethod
    def resolve_code(cls, email_addr: str, code: str) -> bool:
        """接收到 Webhook 或广播推送时触发，瞬间唤醒等待线程。"""
        if not email_addr or not code:
            return False
        clean_email = email_addr.strip().lower()
        clean_code = str(code).strip()
        with cls._lock:
            cls._received_codes[clean_email] = clean_code
            evt = cls._pending_events.get(clean_email)
            if evt:
                evt.set()
                return True
        return False

    @classmethod
    def _ensure_ntfy_listener(cls, topic: str):
        with cls._lock:
            if topic in cls._active_topics:
                return
            cls._active_topics.add(topic)
            t = threading.Thread(
                target=cls._run_ntfy_listener,
                args=(topic,),
                daemon=True,
                name=f"CFWorker-Ntfy-{topic}",
            )
            t.start()

    @classmethod
    def _run_ntfy_listener(cls, topic: str):
        url = f"https://ntfy.sh/{topic}/sse?since=2m"
        logger.info(f"[CF-Worker] 启动 ntfy 消息总线长连接监听: {url}")
        while True:
            try:
                req = urllib.request.Request(
                    url,
                    headers={"User-Agent": "chatgpt2api-cfworker-listener/1.0"},
                )
                with urllib.request.urlopen(req, timeout=60) as resp:
                    for line in resp:
                        if not line:
                            continue
                        line_str = line.decode("utf-8", errors="ignore").strip()
                        if line_str.startswith("data:"):
                            raw_data = line_str[5:].strip()
                            try:
                                obj = json.loads(raw_data)
                                if obj.get("event") == "message":
                                    msg = obj.get("message", "")
                                    target_email = ""
                                    otp = ""
                                    try:
                                        msg_data = json.loads(msg)
                                        target_email = msg_data.get("email", "")
                                        otp = msg_data.get("code", "")
                                    except Exception:
                                        target_email = obj.get("title") or ""
                                        otp = _extract_otp_code(msg) or ""
                                    if target_email and otp:
                                        logger.info(f"[CF-Worker/ntfy] 收到广播验证码: {target_email} -> {otp}")
                                        cls.resolve_code(target_email, otp)
                            except Exception as ex:
                                logger.debug(f"[CF-Worker/ntfy] 忽略非目标消息: {ex}")
            except Exception as e:
                logger.debug(f"[CF-Worker/ntfy] 监听重连: {e}")
                time.sleep(3)

    def create_email(self) -> tuple[Optional[str], Optional[str]]:
        if not self.domains:
            logger.error("[CF-Worker] 未配置有效自定义域名，请在设置中填写已托管在 Cloudflare 的域名")
            return None, None

        chosen_domain = random.choice(self.domains)
        user = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
        email_addr = f"{user}@{chosen_domain}"
        return email_addr, None

    def get_code(
        self,
        email_addr: str,
        token: Optional[str] = None,
        timeout: int = 120,
        poll_interval: int = 2,
        log_fn: Optional[Callable[[str], None]] = None,
    ) -> Optional[str]:
        clean_email = email_addr.strip().lower()
        evt = threading.Event()

        with self._lock:
            # 若在发信瞬间已极速收到推送
            if clean_email in self._received_codes:
                code = self._received_codes.pop(clean_email)
                if log_fn:
                    log_fn(f"[CF-Worker] 验证码已提前到达并提取: {code}")
                return code
            self._pending_events[clean_email] = evt

        if log_fn:
            log_fn(f"[CF-Worker] 正在等待 Cloudflare Worker Webhook 毫秒直推 (超时上限: {timeout}s)...")

        # 挂起当前线程等待唤醒（零请求、零轮询开销）
        got = evt.wait(timeout=timeout)

        with self._lock:
            self._pending_events.pop(clean_email, None)
            code = self._received_codes.pop(clean_email, None)

        if got and code:
            if log_fn:
                log_fn(f"[CF-Worker] ⚡ 成功捕获验证码: {code}")
            return code

        if log_fn:
            log_fn(f"[CF-Worker] 等待验证码超时（未收到 Worker 推送）")
        return None


def create_mail_provider(config: dict, proxy: Optional[str] = None) -> BaseMailProvider:
    """根据配置创建对应的邮箱驱动实例。"""
    mode = str(config.get("mail_mode", "cf_worker")).lower()
    if mode in ("cf_worker", "cloudflare_worker", "worker"):
        return CloudflareWorkerMailProvider(
            domains=config.get("cf_worker_domains", ""),
            webhook_secret=config.get("cf_worker_webhook_secret", ""),
            ntfy_topic=config.get("cf_worker_ntfy_topic", ""),
            proxy=proxy,
        )
    if mode == "imap":
        return CloudflareImapMailProvider(
            host=config.get("imap_host", ""),
            port=int(config.get("imap_port", 993) or 993),
            username=config.get("imap_username", ""),
            password=config.get("imap_password", ""),
            domains=config.get("imap_domains", ""),
            proxy=proxy,
        )
    if mode == "duckmail":
        return DuckMailProvider(
            api_base=config.get("duckmail_api_url", "https://api.duckmail.com"),
            domain=config.get("duckmail_domain", "duckmail.com"),
            proxy=proxy,
        )
    # 默认使用高可用的 Inboxes.com 免配置邮箱
    return InboxesMailProvider(proxy=proxy)
