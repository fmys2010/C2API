"""多行 HTTP/SOCKS5 代理池管理与轮换调度器。"""
from __future__ import annotations

import re
import threading
import time
from typing import Optional


class ProxyPool:
    """线程安全的代理池，支持 SOCKS5 / HTTP 代理的轮换与失败标记。"""

    def __init__(self, raw_text: str = ""):
        self._lock = threading.Lock()
        self._index = 0
        self._proxies: list[str] = []
        self._failed_counts: dict[str, int] = {}
        self._last_used: dict[str, float] = {}
        if raw_text:
            self.set_proxies_from_text(raw_text)

    @staticmethod
    def normalize_proxy(line: str) -> Optional[str]:
        """将各类格式的代理行统一格式化为 curl_cffi 适用的标准 URL。"""
        p = line.strip()
        if not p or p.startswith("#"):
            return None

        # 匹配 ip:port:user:pass 格式
        parts = p.split(":")
        if len(parts) == 4 and not p.startswith("http") and not p.startswith("socks"):
            ip, port, user, pwd = parts
            return f"http://{user}:{pwd}@{ip}:{port}"

        # 匹配 ip:port 格式
        if len(parts) == 2 and not p.startswith("http") and not p.startswith("socks"):
            ip, port = parts
            if port.isdigit():
                return f"http://{ip}:{port}"

        if not re.match(r"^(https?|socks5h?)://", p, re.IGNORECASE):
            p = f"http://{p}"

        # 优化 socks5 为 socks5h，让远程代理端解析 DNS
        if p.startswith("socks5://"):
            p = p.replace("socks5://", "socks5h://", 1)

        return p

    def set_proxies_from_text(self, text: str) -> int:
        """从多行文本中载入并去重代理列表。"""
        valid = []
        seen = set()
        for line in (text or "").splitlines():
            norm = self.normalize_proxy(line)
            if norm and norm not in seen:
                seen.add(norm)
                valid.append(norm)

        with self._lock:
            self._proxies = valid
            self._index = 0
            self._failed_counts.clear()
        return len(valid)

    def get_proxy(self) -> Optional[str]:
        """按轮询方式获取下一个可用代理。如果代理池为空则返回 None。"""
        with self._lock:
            if not self._proxies:
                return None

            total = len(self._proxies)
            # 优先挑出失败次数小于 3 次的代理
            for _ in range(total):
                proxy = self._proxies[self._index % total]
                self._index = (self._index + 1) % total
                if self._failed_counts.get(proxy, 0) < 3:
                    self._last_used[proxy] = time.time()
                    return proxy

            # 若所有代理均有多次失败，退而求其次选择当前轮询到的代理
            proxy = self._proxies[self._index % total]
            self._index = (self._index + 1) % total
            self._last_used[proxy] = time.time()
            return proxy

    def mark_failure(self, proxy: str) -> None:
        """记录代理失败一次。"""
        if not proxy:
            return
        with self._lock:
            self._failed_counts[proxy] = self._failed_counts.get(proxy, 0) + 1

    def mark_success(self, proxy: str) -> None:
        """注册成功，重置该代理的失败计数。"""
        if not proxy:
            return
        with self._lock:
            self._failed_counts[proxy] = 0

    def get_stats(self) -> dict:
        with self._lock:
            total = len(self._proxies)
            healthy = sum(1 for p in self._proxies if self._failed_counts.get(p, 0) == 0)
            degraded = sum(1 for p in self._proxies if 0 < self._failed_counts.get(p, 0) < 3)
            failed = sum(1 for p in self._proxies if self._failed_counts.get(p, 0) >= 3)
            return {
                "total": total,
                "healthy": healthy,
                "degraded": degraded,
                "failed": failed,
                "list": list(self._proxies),
            }
