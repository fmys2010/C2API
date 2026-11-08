"""智能补货调度器 (Smart Mode Scheduler)。

实时监控号池中健康状态 (status == '正常') 的账号数量，
当健康数低于设定阈值时，自动调度并发注册任务补充至目标值。
具备连续失败退避与事件唤醒保护机制。
"""
from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import TYPE_CHECKING, Any, Callable, Optional

if TYPE_CHECKING:
    from services.register.register_service import RegisterService

logger = logging.getLogger(__name__)


class SmartScheduler:
    """智能模式常驻调度线程"""

    def __init__(self, service: "RegisterService"):
        self.service = service
        self._stop_event = threading.Event()
        self._wake_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._consecutive_failures = 0
        self._active_workers = 0
        self._workers_lock = threading.Lock()

    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> bool:
        if self.is_running():
            return False
        self._stop_event.clear()
        self._wake_event.clear()
        self._consecutive_failures = 0
        self._thread = threading.Thread(target=self._loop, name="SmartRegScheduler", daemon=True)
        self._thread.start()
        self.service.log("🚀 智能补货监控已启动")
        return True

    def stop(self) -> None:
        self._stop_event.set()
        self._wake_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)
        self._thread = None
        self.service.log("🛑 智能补货监控已停止")

    def wake_up(self) -> None:
        """号池状态变化（如账号被限流或异常）时触发被动唤醒。"""
        if self.is_running():
            self._wake_event.set()

    def _loop(self) -> None:
        from services.account_service import account_service

        while not self._stop_event.is_set():
            cfg = self.service.get_config()
            target_count = max(1, int(cfg.get("target_count", 20)))
            concurrency = max(1, min(10, int(cfg.get("concurrency", 2))))
            check_interval = max(10, int(cfg.get("check_interval_seconds", 60)))

            try:
                stats = account_service.get_stats()
                total_count = stats.get("total", 0)
                deficit = target_count - total_count

                if deficit > 0:
                    self.service.log(
                        f"📊 [智能检测] 号池总数 {total_count}/{target_count} (缺口 {deficit} 个)，启动补货..."
                    )
                    # 批量发起注册补货
                    self._fulfill_deficit(deficit=min(deficit, concurrency * 2), concurrency=concurrency)
                else:
                    self.service.log(
                        f"✅ [智能检测] 号池总数充足 ({total_count}/{target_count})，保持待机监听"
                    )
                    self._consecutive_failures = 0

            except Exception as exc:
                self.service.log(f"⚠️ [智能检测] 轮询检查异常: {exc}")
                logger.error(f"[SmartScheduler] Loop error: {exc}", exc_info=True)

            # 连续失败降频保护
            sleep_time = check_interval
            if self._consecutive_failures >= 3:
                backoff = min(300, 15 * (2 ** (self._consecutive_failures - 3)))
                self.service.log(f"⚠️ 连续注册失败 {self._consecutive_failures} 次，触发风控退避 {backoff} 秒...")
                sleep_time = backoff

            # 等待超时或被唤醒
            self._wake_event.wait(timeout=sleep_time)
            self._wake_event.clear()

    def _fulfill_deficit(self, deficit: int, concurrency: int) -> None:
        """并行分派注册任务补齐缺口。"""
        batch_count = max(1, min(deficit, concurrency))
        with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="RegTask") as executor:
            futures = []
            for _ in range(batch_count):
                if self._stop_event.is_set():
                    break
                with self._workers_lock:
                    self._active_workers += 1
                fut = executor.submit(self._worker_job)
                futures.append(fut)

            for fut in as_completed(futures):
                try:
                    res = fut.result()
                    if res and res.get("success"):
                        self._consecutive_failures = 0
                    else:
                        self._consecutive_failures += 1
                except Exception as e:
                    self._consecutive_failures += 1
                    logger.error(f"[SmartScheduler] Worker exception: {e}")
                finally:
                    with self._workers_lock:
                        self._active_workers = max(0, self._active_workers - 1)

    def _worker_job(self) -> dict[str, Any]:
        """单次注册工作线程。"""
        return self.service.execute_single_registration()

    def get_active_workers(self) -> int:
        with self._workers_lock:
            return self._active_workers
