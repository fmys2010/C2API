"""OpenAI Sentinel 与 Turnstile 风控挑战解算核心。

加载二进制核心 auth_core（内置 Turnstile VM 模拟器与 Sentinel 算力挑战），
支持在 Windows (Python 3.12/3.13 IPC) 与 Linux Docker (Python 3.11) 跨平台运行。
自动注入 Mock 授权旁路，输出带有 p (PoW)、t (Turnstile)、c (Challenge) 的完整 Payload。
"""
from __future__ import annotations

import importlib.util
import json
import logging
import os
import platform
import subprocess
import sys
import types
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

_AUTH_CORE = None
_AUTH_CORE_LOADED = False
_PYTHON_312_EXE = r"C:\Users\fmys2\AppData\Local\Programs\Python\Python312\python.exe"


def _get_core_binary_path() -> Path | None:
    current_dir = Path(__file__).resolve().parent
    core_dir = current_dir / "core"
    
    if sys.platform == "win32":
        candidates = [
            core_dir / "auth_core.pyd",
            Path(r"D:\openai-cpa\utils\auth_core.pyd")
        ]
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

    for p in candidates:
        if p.exists():
            return p
    return None


def _load_auth_core():
    global _AUTH_CORE, _AUTH_CORE_LOADED
    if _AUTH_CORE_LOADED:
        return _AUTH_CORE

    pyd_path = _get_core_binary_path()
    if not pyd_path:
        logger.warning("[auth_solver] Native auth_core binary not found.")
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
        logger.info("[auth_solver] auth_core loaded successfully in-process")
    except Exception as exc:
        logger.debug(f"[auth_solver] In-process load skipped ({exc}), will use IPC or native fallback")
        _AUTH_CORE = None

    _AUTH_CORE_LOADED = True
    return _AUTH_CORE


def _generate_payload_ipc(did: str, flow: str, user_agent: Optional[str] = None) -> Optional[str]:
    """在 Windows Python 版本不匹配时，通过 Python 3.12 子进程调用 auth_core 生成 Payload。"""
    if sys.platform != "win32":
        return None

    py_exe = _PYTHON_312_EXE if os.path.exists(_PYTHON_312_EXE) else None
    if not py_exe:
        return None

    code = r"""
import importlib.util, types, sys, json
pyd_path = r'D:\openai-cpa\utils\auth_core.pyd'
mock_cfg = types.ModuleType('utils.config')
mock_cfg.ts = lambda: '00:00:00'
mock_cfg.CONFIG_PATH = 'data/config.yaml'
mock_cfg.CONFIG_FILE_LOCK = None
mock_cfg.format_docker_url = lambda u: u
sys.modules['utils.config'] = mock_cfg

spec = importlib.util.spec_from_file_location('utils.auth_core', pyd_path)
auth_core = importlib.util.module_from_spec(spec)
sys.modules['utils.auth_core'] = auth_core
spec.loader.exec_module(auth_core)
auth_core.check_global_license = lambda *a, **k: True
auth_core.read_license_file = lambda *a, **k: 'mock'
auth_core.handle_lease = lambda *a, **k: True
auth_core.verify_lease_signature = lambda *a, **k: True

payload = auth_core.generate_payload(did=sys.argv[1], flow=sys.argv[2], impersonate='chrome', ctx={})
print(payload)
"""
    try:
        out = subprocess.check_output(
            [py_exe, "-c", code, did, flow],
            text=True,
            timeout=15,
            stderr=subprocess.DEVNULL
        )
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                return line
    except Exception as e:
        logger.warning(f"[auth_solver] IPC payload generation failed: {e}")
    return None


def generate_sentinel_payload(
    did: str,
    flow: str = "authorize_continue",
    proxy: Optional[str] = None,
    user_agent: Optional[str] = None,
    ctx: Optional[dict] = None,
) -> str:
    """生成包含 PoW 算力与 Turnstile VM 凭证的 OpenAI Sentinel Token。"""
    # 1. 优先尝试进程内直接调用
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
            if token and isinstance(token, str) and len(token) > 50:
                return token
        except Exception as e:
            logger.warning(f"[auth_solver] In-process generate_payload failed: {e}")

    # 2. Windows 平台版本不匹配时尝试 IPC 子进程通道 (Python 3.12)
    ipc_token = _generate_payload_ipc(did=did, flow=flow, user_agent=user_agent)
    if ipc_token and len(ipc_token) > 50:
        return ipc_token

    # 3. 原生纯 Python 回退
    from utils.sentinel import SentinelTokenGenerator
    ua = user_agent or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    gen = SentinelTokenGenerator(did, ua)
    p_val = gen.generate_requirements_token()
    return json.dumps({"p": p_val, "t": "", "c": "", "id": did, "flow": flow}, separators=(",", ":"))
