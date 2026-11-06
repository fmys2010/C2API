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
import uuid
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

_AUTH_CORE = None
_AUTH_CORE_LOADED = False


def _get_core_pyd_path() -> Path | None:
    current_dir = Path(__file__).resolve().parent
    local_pyd = current_dir / "core" / "auth_core.pyd"
    if local_pyd.exists():
        return local_pyd
    cpa_pyd = Path(r"D:\openai-cpa\utils\auth_core.pyd")
    if cpa_pyd.exists():
        return cpa_pyd
    return None


def _load_auth_core():
    global _AUTH_CORE, _AUTH_CORE_LOADED
    if _AUTH_CORE_LOADED:
        return _AUTH_CORE

    pyd_path = _get_core_pyd_path()
    if not pyd_path:
        logger.warning("[auth_solver] auth_core.pyd not found, will use Python fallback")
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
            raise RuntimeError("Cannot create spec for auth_core")
        module = importlib.util.module_from_spec(spec)
        sys.modules["utils.auth_core"] = module
        spec.loader.exec_module(module)

        # 3. 注入 Mock 授权绕过函数
        module.check_global_license = lambda *a, **k: True
        module.read_license_file = lambda *a, **k: "mock-license-approved"
        module.handle_lease = lambda *a, **k: True
        module.verify_lease_signature = lambda *a, **k: True

        _AUTH_CORE = module
        logger.info("[auth_solver] auth_core.pyd loaded successfully with license bypass mock")
    except Exception as exc:
        logger.error(f"[auth_solver] Failed to load auth_core.pyd: {exc}", exc_info=True)
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
    """初始化认证会话，返回 (device_id, user_agent)。"""
    core = _load_auth_core()
    masked_email = email[:2] + "***@" + email.split("@")[-1] if "@" in email else email
    proxies = {"http": proxy, "https": proxy} if proxy else None

    if core and hasattr(core, "init_auth"):
        try:
            did, ua = core.init_auth(
                session=session,
                email=email,
                masked_email=masked_email,
                proxies=proxies,
                verify=verify,
            )
            if did and ua:
                return str(did), str(ua)
        except Exception as e:
            logger.warning(f"[auth_solver] auth_core.init_auth failed: {e}, using local fallback")

    did = str(uuid.uuid4())
    ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
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

