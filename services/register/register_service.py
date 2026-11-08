"""注册机全局单例管理服务。

负责配置持久化、代理池管理、手动/智能注册任务调度与实时流式日志广播。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable, Optional

from services.config import DATA_DIR
from services.register.mail_provider import create_mail_provider
from services.register.proxy_pool import ProxyPool
from services.register.registration_worker import register_single_account
from services.register.smart_scheduler import SmartScheduler

logger = logging.getLogger(__name__)

CONFIG_FILE = DATA_DIR / "register_config.json"

DEFAULT_CONFIG = {
    "mode": "manual",  # "smart" | "manual"
    "target_count": 20,
    "concurrency": 1,
    "check_interval_seconds": 60,
    "mail_mode": "gmail",  # "gmail" | "imap"
    "domains": "nomorera2.de",
    "gmail_address": "",
    "gmail_app_password": "",
    "imap_host": "",
    "imap_port": 993,
    "imap_username": "",
    "imap_password": "",
    "imap_domains": "",
    "proxies_text": "",
}


class RegisterService:
    """注册机主控服务"""

    def __init__(self):
        self._lock = threading.Lock()
        self._config = self._load_config()
        self.proxy_pool = ProxyPool(self._config.get("proxies_text", ""))
        self.smart_scheduler = SmartScheduler(self)

        self._logs: deque[dict[str, Any]] = deque(maxlen=500)
        self._log_listeners: list[asyncio.Queue] = []
        self._listeners_lock = threading.Lock()

        # 运行统计
        self._stats = {
            "success": 0,
            "failed": 0,
            "is_403": 0,
            "total_attempts": 0,
            "start_time": 0.0,
        }

        # 手动注册控制
        self._manual_running = False
        self._manual_stop_event = threading.Event()
        self._manual_thread: Optional[threading.Thread] = None

    def _load_config(self) -> dict:
        try:
            if CONFIG_FILE.exists():
                data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
                cfg = dict(DEFAULT_CONFIG)
                cfg.update(data)
                return cfg
        except Exception as e:
            logger.warning(f"[RegisterService] Load config failed: {e}")
        return dict(DEFAULT_CONFIG)

    def _save_config(self) -> None:
        try:
            CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
            CONFIG_FILE.write_text(json.dumps(self._config, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            logger.error(f"[RegisterService] Save config failed: {e}")

    def get_config(self) -> dict:
        with self._lock:
            return dict(self._config)

    def update_config(self, updates: dict) -> dict:
        with self._lock:
            for k, v in updates.items():
                if k in DEFAULT_CONFIG:
                    self._config[k] = v
            self._save_config()
            if "proxies_text" in updates:
                self.proxy_pool.set_proxies_from_text(self._config.get("proxies_text", ""))
        self.log("⚙️ 注册机配置已更新并持久化保存")
        return self.get_config()

    def log(self, text: str, level: str = "INFO") -> None:
        """追加一条带时间戳的终端日志并广播到监听器。"""
        now_str = time.strftime("%H:%M:%S")
        entry = {
            "time": now_str,
            "text": text,
            "level": level,
            "timestamp": time.time(),
        }
        with self._lock:
            self._logs.append(entry)

        # 广播给前端 SSE 监听器
        with self._listeners_lock:
            for q in list(self._log_listeners):
                try:
                    q.put_nowait(entry)
                except Exception:
                    pass

    def get_logs(self, limit: int = 300) -> list[dict]:
        with self._lock:
            items = sorted(self._logs, key=lambda x: x.get("timestamp") or 0)
            return items[-limit:] if len(items) > limit else items

    def clear_logs(self) -> None:
        with self._lock:
            self._logs.clear()
        self.log("🧹 注册机日志已清空")

    def register_log_listener(self, queue: asyncio.Queue) -> None:
        with self._listeners_lock:
            self._log_listeners.append(queue)

    def unregister_log_listener(self, queue: asyncio.Queue) -> None:
        with self._listeners_lock:
            if queue in self._log_listeners:
                self._log_listeners.remove(queue)

    def is_running(self) -> bool:
        return self._manual_running or self.smart_scheduler.is_running()

    def get_status(self) -> dict:
        from services.account_service import account_service
        acc_stats = account_service.get_stats()
        cfg = self.get_config()

        mode = "smart" if self.smart_scheduler.is_running() else ("manual" if self._manual_running else "idle")
        active_workers = (
            self.smart_scheduler.get_active_workers()
            if self.smart_scheduler.is_running()
            else (1 if self._manual_running else 0)
        )

        with self._lock:
            stats_copy = dict(self._stats)

        elapsed = round(time.time() - stats_copy["start_time"], 1) if stats_copy["start_time"] > 0 else 0

        return {
            "is_running": self.is_running(),
            "mode": mode,
            "active_workers": active_workers,
            "stats": stats_copy,
            "elapsed_seconds": elapsed,
            "pool_health": {
                "active": acc_stats.get("active", 0),
                "total": acc_stats.get("total", 0),
                "target": cfg.get("target_count", 20),
            },
            "proxy_stats": self.proxy_pool.get_stats(),
            "config": cfg,
        }

    def start(self, mode: Optional[str] = None) -> dict:
        """根据配置或指定模式启动注册。"""
        if self.is_running():
            return {"status": "warning", "message": "注册机任务正在运行中"}

        cfg = self.get_config()
        run_mode = mode or cfg.get("mode", "smart")

        with self._lock:
            self._stats["start_time"] = time.time()
            self._stats["total_attempts"] = 0
            self._stats["success"] = 0
            self._stats["failed"] = 0
            self._stats["is_403"] = 0

        if run_mode == "smart":
            self.smart_scheduler.start()
            return {"status": "success", "message": "智能补货监控已成功开启"}
        else:
            self._start_manual_run()
            return {"status": "success", "message": "常规批量注册任务已启动"}

    def stop(self) -> dict:
        """停止所有运行中的注册任务。"""
        if not self.is_running():
            return {"status": "info", "message": "当前没有正在运行的注册任务"}

        if self.smart_scheduler.is_running():
            self.smart_scheduler.stop()

        if self._manual_running:
            self._manual_stop_event.set()
            if self._manual_thread and self._manual_thread.is_alive():
                self._manual_thread.join(timeout=2)
            self._manual_running = False
            self.log("🛑 常规批量注册任务已停止")

        return {"status": "success", "message": "注册机任务已停止"}

    def _start_manual_run(self) -> None:
        self._manual_stop_event.clear()
        self._manual_running = True
        self._manual_thread = threading.Thread(target=self._manual_loop, name="ManualRegThread", daemon=True)
        self._manual_thread.start()

    def _manual_loop(self) -> None:
        cfg = self.get_config()
        target = max(1, int(cfg.get("target_count", 10)))
        concurrency = max(1, min(10, int(cfg.get("concurrency", 2))))

        self.log(f"🏁 常规批量模式启动: 目标注册 {target} 个账号，并发线程 {concurrency}")

        with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="ManualReg") as executor:
            completed_count = 0
            while completed_count < target and not self._manual_stop_event.is_set():
                batch_size = min(concurrency, target - completed_count)
                futures = [executor.submit(self.execute_single_registration) for _ in range(batch_size)]

                for fut in as_completed(futures):
                    if self._manual_stop_event.is_set():
                        break
                    try:
                        fut.result()
                    except Exception as e:
                        logger.error(f"[ManualReg] Worker error: {e}")
                    completed_count += 1

        self._manual_running = False
        self.log(f"🎉 常规批量注册任务结束！已完成 {completed_count}/{target} 个目标")

    def execute_single_registration(self) -> dict[str, Any]:
        """执行单次注册任务，自动获取代理并更新统计。"""
        cfg = self.get_config()
        proxy = self.proxy_pool.get_proxy()
        mail_prov = create_mail_provider(cfg, proxy=proxy)

        with self._lock:
            self._stats["total_attempts"] += 1

        res = register_single_account(
            mail_provider=mail_prov,
            proxy=proxy,
            log_fn=lambda msg: self.log(msg),
        )

        with self._lock:
            if res.get("success"):
                self._stats["success"] += 1
                if proxy:
                    self.proxy_pool.mark_success(proxy)
            else:
                self._stats["failed"] += 1
                if res.get("is_403"):
                    self._stats["is_403"] += 1
                if proxy:
                    self.proxy_pool.mark_failure(proxy)

        return res

    def rerun_account_registration(
        self,
        email: str,
        old_access_token: str = "",
        proxy: Optional[str] = None,
        log_fn: Optional[Callable[[str], None]] = None,
    ) -> dict[str, Any]:
        """为异常账号在注册机中重走流程自愈。"""
        cfg = self.get_config()
        # 代理优先级：优先使用注册机代理池，若为空则回退到账号原代理或直连
        selected_proxy = self.proxy_pool.get_proxy() or proxy or None
        mail_prov = create_mail_provider(cfg, proxy=selected_proxy)

        def log_wrapper(msg: str):
            if log_fn:
                log_fn(msg)
            self.log(f"[异常重跑] {msg}")

        res = register_single_account(
            mail_provider=mail_prov,
            proxy=selected_proxy,
            log_fn=log_wrapper,
            target_email=email,
            old_access_token=old_access_token,
        )

        with self._lock:
            if res.get("success"):
                if selected_proxy:
                    self.proxy_pool.mark_success(selected_proxy)
            else:
                if selected_proxy:
                    self.proxy_pool.mark_failure(selected_proxy)

        return res


register_service = RegisterService()
