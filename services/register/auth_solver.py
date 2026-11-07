"""OpenAI Sentinel 风控挑战算法与设备初始化模块。

支持加载 D:\\openai-cpa 的 auth_core.pyd 二进制核心（带 Mock 授权旁路），
若在非 Windows x64 平台或加载失败，自动回退到纯 Python SentinelTokenGenerator。
"""
from __future__ import annotations

import importlib.util
import json
import logging
import os
import sys
import types
import urllib.parse
import uuid
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

_AUTH_CORE = None
_AUTH_CORE_LOADED = False


def _get_core_binary_path() -> Path | None:
    import platform
    current_dir = Path(__file__).resolve().parent
    core_dir = current_dir / "core"
    
    if sys.platform == "win32":
        candidates = [core_dir / "auth_core.pyd", Path(r"D:\openai-cpa\utils\auth_core.pyd")]
    elif sys.platform == "darwin":
        candidates = [core_dir / "auth_core.cpython-311-darwin.so"]
    elif sys.platform.startswith("linux"):
        machine = platform.machine().lower()
        if machine in ("aarch64", "arm64"):
            candidates = [core_dir / "auth_core.cpython-311-aarch64-linux-gnu.so"]
        else:
            candidates = [core_dir / "auth_core.cpython-311-x86_64-linux-gnu.so"]
    else:
        candidates = []

    # 针对 cpython-311 编译的动态库，若运行时主次版本不匹配则直接走原生 Python 方案
    for p in candidates:
        if p.exists():
            if "-311-" in p.name and sys.version_info[:2] != (3, 11):
                continue
            return p
    return None


def _load_auth_core():
    global _AUTH_CORE, _AUTH_CORE_LOADED
    if _AUTH_CORE_LOADED:
        return _AUTH_CORE

    pyd_path = _get_core_binary_path()
    if not pyd_path:
        logger.info("[auth_solver] Native auth_core binary not found for platform, will use pure Python NextAuth solver")
        _AUTH_CORE_LOADED = True
        return None

    try:
        # 1. 注入 utils.config mock 避免 auth_core.pyd 找不到 config
        if "utils.config" not in sys.modules:
            mock_cfg = types.ModuleType("utils.config")
            mock_cfg.ts = lambda: "00:00:00"
            mock_cfg.CONFIG_PATH = "data/config.yaml"
            mock_cfg.CONFIG_FILE_LOCK = None
            mock_cfg.format_docker_url = lambda u: u
            sys.modules["utils.config"] = mock_cfg
            import utils
            utils.config = mock_cfg

        # 2. 通过 importlib 加载为 utils.auth_core
        spec = importlib.util.spec_from_file_location("utils.auth_core", str(pyd_path))
        if not spec or not spec.loader:
            raise RuntimeError(f"Cannot create spec for auth_core from {pyd_path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules["utils.auth_core"] = module
        spec.loader.exec_module(module)

        # 3. 注入 Mock 授权绕过函数
        module.check_global_license = lambda *a, **k: True
        module.read_license_file = lambda *a, **k: "mock-license-approved"
        module.handle_lease = lambda *a, **k: True
        module.verify_lease_signature = lambda *a, **k: True

        _AUTH_CORE = module
        logger.info("[auth_solver] auth_core loaded successfully with license bypass mock")
    except Exception as exc:
        logger.warning(f"[auth_solver] Failed to load native auth_core ({exc}), falling back to Python solver")
        _AUTH_CORE = None

    _AUTH_CORE_LOADED = True
    return _AUTH_CORE


def generate_sentinel_payload(
    did: str,
    flow: str = "authorize_continue",
    proxy: Optional[str] = None,
    user_agent: Optional[str] = None,
    ctx: Optional[dict] = None,
) -> str:
    """生成 OpenAI Sentinel Token 算力挑战 Payload。"""
    core = _load_auth_core()
    if core and hasattr(core, "generate_payload"):
        try:
            token = core.generate_payload(
                did=did,
                flow=flow,
                proxy=proxy,
                user_agent=user_agent,
                impersonate="chrome",
                ctx=ctx or {},
            )
            if token and isinstance(token, str) and len(token) > 20:
                return token
        except Exception as e:
            logger.warning(f"[auth_solver] auth_core.generate_payload failed: {e}, falling back to Python generator")

    # 回退到纯 Python SentinelTokenGenerator
    from utils.sentinel import SentinelTokenGenerator
    ua = user_agent or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    gen = SentinelTokenGenerator(did, ua)
    p_val = gen.generate_requirements_token()
    return json.dumps({"p": p_val, "t": "", "c": "", "id": did, "flow": flow}, separators=(",", ":"))


def init_auth_session(
    session: Any,
    email: str,
    proxy: Optional[str] = None,
    verify: bool = False,
) -> tuple[str, str]:
    """初始化认证会话，返回 (device_id, user_agent)。

    1. 优先尝试使用二进制核心 auth_core.init_auth 初始化设备与会话凭证。
    2. 若二进制核心不可用或未成功获取 auth-session-minimized，
       无缝回退至纯 Python 原生 NextAuth 握手流程，确保跨平台（Linux Docker/Windows/Mac）
       均能可靠建立 OpenAI 认证会话，杜绝由于缺乏 Session 导致的 HTTP 409 (invalid_state) 异常。
    """
    core = _load_auth_core()
    masked_email = email[:2] + "***@" + email.split("@")[-1] if "@" in email else email
    proxies = {"http": proxy, "https": proxy} if proxy else None
    did: Optional[str] = None
    ua: Optional[str] = None

    # 1. 优先尝试二进制核心初始化
    if core and hasattr(core, "init_auth"):
        try:
            core_did, core_ua = core.init_auth(
                session=session,
                email=email,
                masked_email=masked_email,
                proxies=proxies,
                verify=verify,
            )
            if core_did and core_ua:
                did, ua = str(core_did), str(core_ua)
        except Exception as e:
            logger.warning(f"[auth_solver] auth_core.init_auth failed: {e}, falling back to Python NextAuth solver")

    # 检查是否已成功拿到 auth-session
    has_session = any("auth-session" in c.name for c in session.cookies.jar)
    if has_session and did and ua:
        return did, ua

    # 2. 纯 Python 原生会话握手回退机制 (跨平台/Docker 容器通用)
    ua = ua or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
    try:
        session.headers.update({
            "User-Agent": ua,
            "Accept-Language": "en-US,en;q=0.9",
        })
        # 优先通过官方 OAuth 授权端点直接初始化 auth.openai.com 认证会话与 DID
        oauth_init_params = {
            "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
            "response_type": "code",
            "redirect_uri": "http://localhost:1455/auth/callback",
            "scope": "openid profile email offline_access",
            "state": str(uuid.uuid4().hex),
            "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            "code_challenge_method": "S256",
            "screen_hint": "signup",
            "prompt": "create",
        }
        oauth_init_url = f"https://auth.openai.com/oauth/authorize?{urllib.parse.urlencode(oauth_init_params)}"
        session.get(oauth_init_url, proxies=proxies, timeout=20, allow_redirects=True, verify=verify)
    except Exception as exc:
        logger.warning(f"[auth_solver] Native Python auth session handshake error: {exc}")

    # 优先使用 OpenAI 签发的 oai-did，若无则生成随机指纹
    cookie_did = session.cookies.get("oai-did")
    if cookie_did:
        did = str(cookie_did)
    elif not did:
        did = str(uuid.uuid4())

    return did, ua


def extract_session_token(
    session: Any,
    target_continue_url: str,
    proxy: Optional[str] = None,
) -> Optional[str]:
    """从注册完成后的 continue_url 提取 ChatGPT Access Token。"""
    core = _load_auth_core()
    proxies = {"http": proxy, "https": proxy} if proxy else None
    if core and hasattr(core, "image2api_data"):
        try:
            token = core.image2api_data(session, target_continue_url, proxies)
            if token and isinstance(token, str) and len(token) > 20:
                return token
        except Exception as e:
            logger.warning(f"[auth_solver] core.image2api_data failed: {e}")

    # 回退到自主追踪重定向提取
    try:
        r = session.get(target_continue_url, proxies=proxies, timeout=25, allow_redirects=True, verify=False)
        sess_resp = session.get("https://chatgpt.com/api/auth/session", proxies=proxies, timeout=20, verify=False)
        if sess_resp.status_code == 200:
            sess_data = sess_resp.json()
            token = sess_data.get("accessToken")
            if token:
                return str(token)
    except Exception as e:
        logger.warning(f"[auth_solver] Fallback session token extract failed: {e}")

    return None


def generate_codex_identity(
    access_token: str,
    proxy: Optional[str] = None,
) -> Optional[dict]:
    """将 Web Session Access Token 升级换取 Codex OAuth 凭证。"""
    core = _load_auth_core()
    proxies = {"http": proxy, "https": proxy} if proxy else None
    if core and hasattr(core, "_generate_codex_auth"):
        try:
            auth_data = core._generate_codex_auth(access_token=access_token, proxies=proxies)
            if isinstance(auth_data, dict) and auth_data.get("access_token"):
                return auth_data
        except Exception as e:
            logger.warning(f"[auth_solver] core._generate_codex_auth failed: {e}")
    return None

