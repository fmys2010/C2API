"""邮箱获取与 OpenAI 验证码接收适配器。

支持 Gmail (应用专用密码 + Cloudflare Catch-All 转发) 与通用 IMAP 协议。
收到验证码邮件提取完成后自动标记删除，杜绝收件箱堆积。
"""
from __future__ import annotations

import email
import imaplib
import logging
import random
import re
import string
import time
from abc import ABC, abstractmethod
from html import unescape
from typing import Callable, Optional
from urllib.parse import urlparse

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
        r">\s*(\d{6})\s*<",
        r"(?i)Your (?:ChatGPT|OpenAI) verification code is\s*(\d{6})",
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
            # 排除常见的整十万占位或错误时间戳
            if code not in ("000000", "600000", "999999"):
                return code
    return None


def _extract_email_body_text(msg: email.message.Message) -> str:
    """提取邮件的纯文本或 HTML 正文字符串。"""
    body_text = ""
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            if ctype in ("text/plain", "text/html"):
                try:
                    payload = part.get_payload(decode=True)
                    if payload:
                        charset = part.get_content_charset() or "utf-8"
                        body_text += payload.decode(charset, errors="ignore") + " "
                except Exception:
                    pass
    else:
        try:
            payload = msg.get_payload(decode=True)
            if payload:
                charset = msg.get_content_charset() or "utf-8"
                body_text = payload.decode(charset, errors="ignore")
        except Exception:
            pass
    return body_text


def _is_recipient_match(msg: email.message.Message, email_addr: str) -> bool:
    """严格校对收件人地址，防止在共享收件箱中误取他人或旧验证码。"""
    clean_target = email_addr.strip().lower()
    user_part = clean_target.split("@")[0] if "@" in clean_target else clean_target

    # 1. 检查标准化邮件标头（涵盖 Cloudflare 转发及 Gmail 各种透传头）
    headers_to_check = [
        str(msg.get("To", "")).lower(),
        str(msg.get("Delivered-To", "")).lower(),
        str(msg.get("X-Forwarded-To", "")).lower(),
        str(msg.get("Envelope-To", "")).lower(),
        str(msg.get("X-Original-To", "")).lower(),
        str(msg.get("Received", "")).lower(),
    ]
    for h in headers_to_check:
        if clean_target in h:
            return True

    # 2. 检查 Subject 标头
    subject = str(msg.get("Subject", "")).lower()
    if clean_target in subject:
        return True

    # 3. 检查正文（OpenAI 邮件通常包含目标邮箱名）
    body = _extract_email_body_text(msg).lower()
    if clean_target in body:
        return True

    # 4. 若为唯一随机前缀（>=6 字符），前缀在投递标头中命中时确认匹配
    if len(user_part) >= 6 and user_part in "\n".join(headers_to_check):
        return True

    return False


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


class GmailMailProvider(BaseMailProvider):
    """Gmail (应用专用密码) + Cloudflare Email Routing Catch-All 邮箱驱动。

    特性：
    1. 自定义域名批量生成：在已托管到 CF 的自定义域名池生成随机邮箱前缀。
    2. Cloudflare Catch-All 自动转发至用户 Gmail 收件箱。
    3. 直连 imap.gmail.com:993 (SSL)，间隔多轮安全检索。
    4. 严格收件人匹配核验，提取 6 位验证码。
    5. 自动清理：验证码提取成功后，立即在 Gmail 中标记已删除并 EXPUNGE。
    """

    def __init__(
        self,
        gmail_address: str = "",
        gmail_app_password: str = "",
        domains: str = "",
        proxy: Optional[str] = None,
    ):
        self.gmail_address = gmail_address.strip()
        # 自动过滤 Google 生成应用密码时携带的空格 (如 abcd efgh ijkl mnop)
        self.gmail_app_password = re.sub(r"\s+", "", gmail_app_password.strip())
        raw_domains = re.split(r"[,;\n\s]+", str(domains or ""))
        self.domains = [d.strip().lstrip("@") for d in raw_domains if d.strip()]
        self.proxy = proxy

    def create_email(self) -> tuple[Optional[str], Optional[str]]:
        if not self.domains:
            # 若未配置自定义域名，但提供了 Gmail，退回为 plus 别名 (username+tag@gmail.com)
            if self.gmail_address and "@" in self.gmail_address:
                user, dom = self.gmail_address.split("@", 1)
                tag = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
                alias = f"{user}+{tag}@{dom}"
                return alias, alias
            return None, None
        domain = random.choice(self.domains)
        prefix = "".join(random.choices(string.ascii_lowercase + string.digits, k=9))
        email_addr = f"{prefix}@{domain}"
        return email_addr, email_addr

    def _connect_imap(self) -> imaplib.IMAP4_SSL:
        if self.proxy and ("socks5://" in self.proxy or "socks5h://" in self.proxy):
            try:
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
            except Exception as pe:
                logger.warning(f"[Gmail-IMAP] Proxy wrap error: {pe}")

        client = imaplib.IMAP4_SSL("imap.gmail.com", 993)
        client.login(self.gmail_address, self.gmail_app_password)
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
        if log_fn:
            log_fn(f"[Gmail-IMAP] 监听收件箱 (账号: {self.gmail_address}, 目标: {email_addr})...")

        while time.time() < deadline:
            client = None
            try:
                client = self._connect_imap()
                client.select("INBOX")
                status, data = client.search(None, "ALL")
                if status == "OK" and data and data[0]:
                    msg_nums = data[0].split()
                    for num in reversed(msg_nums[-15:]):
                        _, msg_data = client.fetch(num, "(RFC822)")
                        if not msg_data or not msg_data[0] or not isinstance(msg_data[0], tuple):
                            continue
                        raw_email = msg_data[0][1]
                        msg = email.message_from_bytes(raw_email)

                        # 严格校对收件人
                        if _is_recipient_match(msg, email_addr):
                            body_text = _extract_email_body_text(msg)
                            code = _extract_otp_code(body_text) or _extract_otp_code(str(msg.get("Subject", "")))
                            if code:
                                if log_fn:
                                    log_fn(f"[Gmail-IMAP] 收到并核验目标验证码: {email_addr} -> {code}")
                                # 提取成功后自动删除邮件，保持收件箱干净
                                try:
                                    # Gmail 专有扩展：移至废纸篓（彻底解决 Gmail Auto-Expunge 设置导致的收件箱残留）
                                    client.store(num, "+X-GM-LABELS", "\\Trash")
                                    client.store(num, "+FLAGS", "\\Deleted")
                                    client.expunge()
                                    if log_fn:
                                        log_fn(f"[Gmail-IMAP] 已自动移至废纸篓并删除邮件")
                                except Exception as de:
                                    logger.debug(f"[Gmail-IMAP] 删除邮件提示: {de}")
                                return code
            except Exception as e:
                logger.debug(f"[Gmail-IMAP] 轮询异常 (重试中): {e}")
            finally:
                if client:
                    try:
                        client.close()
                        client.logout()
                    except Exception:
                        pass

            time.sleep(poll_interval)

        if log_fn:
            log_fn(f"[Gmail-IMAP] 等待验证码超时（未收到匹配 {email_addr} 的邮件）")
        return None


class GenericImapMailProvider(BaseMailProvider):
    """通用自定义 IMAP 协议邮箱驱动。"""

    def __init__(
        self,
        host: str = "",
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
        raw_domains = re.split(r"[,;\n\s]+", str(domains or ""))
        self.domains = [d.strip().lstrip("@") for d in raw_domains if d.strip()]
        self.proxy = proxy

    def create_email(self) -> tuple[Optional[str], Optional[str]]:
        if not self.domains:
            if self.username and "@" in self.username:
                return self.username, self.username
            return None, None
        domain = random.choice(self.domains)
        prefix = "".join(random.choices(string.ascii_lowercase + string.digits, k=9))
        email_addr = f"{prefix}@{domain}"
        return email_addr, email_addr

    def _connect_imap(self) -> imaplib.IMAP4_SSL:
        if self.proxy and ("socks5://" in self.proxy or "socks5h://" in self.proxy):
            try:
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
            except Exception as pe:
                logger.warning(f"[IMAP] Proxy wrap error: {pe}")

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
        if log_fn:
            log_fn(f"[IMAP] 监听收件箱 (服务器: {self.host}:{self.port}, 目标: {email_addr})...")

        while time.time() < deadline:
            client = None
            try:
                client = self._connect_imap()
                client.select("INBOX")
                status, data = client.search(None, "ALL")
                if status == "OK" and data and data[0]:
                    msg_nums = data[0].split()
                    for num in reversed(msg_nums[-15:]):
                        _, msg_data = client.fetch(num, "(RFC822)")
                        if not msg_data or not msg_data[0] or not isinstance(msg_data[0], tuple):
                            continue
                        raw_email = msg_data[0][1]
                        msg = email.message_from_bytes(raw_email)

                        if _is_recipient_match(msg, email_addr):
                            body_text = _extract_email_body_text(msg)
                            code = _extract_otp_code(body_text) or _extract_otp_code(str(msg.get("Subject", "")))
                            if code:
                                if log_fn:
                                    log_fn(f"[IMAP] 收到并核验目标验证码: {email_addr} -> {code}")
                                try:
                                    client.store(num, "+FLAGS", "\\Deleted")
                                    client.expunge()
                                    if log_fn:
                                        log_fn(f"[IMAP] 已自动删除已处理邮件")
                                except Exception as de:
                                    logger.debug(f"[IMAP] 删除邮件提示: {de}")
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

        if log_fn:
            log_fn(f"[IMAP] 等待验证码超时（未收到匹配 {email_addr} 的邮件）")
        return None


# 向后兼容别名
CloudflareImapMailProvider = GenericImapMailProvider


def create_mail_provider(config: dict, proxy: Optional[str] = None) -> BaseMailProvider:
    """根据配置创建对应的邮箱驱动实例。"""
    mode = str(config.get("mail_mode", "gmail")).lower()
    if mode == "imap":
        return GenericImapMailProvider(
            host=config.get("imap_host", ""),
            port=int(config.get("imap_port", 993) or 993),
            username=config.get("imap_username", ""),
            password=config.get("imap_password", ""),
            domains=config.get("imap_domains", "") or config.get("domains", "") or config.get("cf_worker_domains", ""),
            proxy=proxy,
        )
    # 默认使用 Gmail (应用专用密码)
    return GmailMailProvider(
        gmail_address=config.get("gmail_address", ""),
        gmail_app_password=config.get("gmail_app_password", ""),
        domains=config.get("domains", "") or config.get("cf_worker_domains", ""),
        proxy=proxy,
    )
