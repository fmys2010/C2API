"""OpenAI 注册机与智能补货后端 API 路由。"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Optional

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.support import require_admin
from services.register import register_service


class StartRequest(BaseModel):
    mode: Optional[str] = None  # "smart" | "manual"


class ConfigUpdateRequest(BaseModel):
    mode: Optional[str] = None
    target_count: Optional[int] = None
    concurrency: Optional[int] = None
    check_interval_seconds: Optional[int] = None
    mail_mode: Optional[str] = None
    domains: Optional[str] = None
    gmail_address: Optional[str] = None
    gmail_app_password: Optional[str] = None
    imap_host: Optional[str] = None
    imap_port: Optional[int] = None
    imap_username: Optional[str] = None
    imap_password: Optional[str] = None
    imap_domains: Optional[str] = None
    proxies_text: Optional[str] = None


class TestProxyRequest(BaseModel):
    proxy: str


def create_router() -> APIRouter:
    router = APIRouter(prefix="/api/register", tags=["register"])

    @router.get("/status")
    async def get_status(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return register_service.get_status()

    @router.post("/start")
    async def start_registration(req: StartRequest = StartRequest(), authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return register_service.start(req.mode)

    @router.post("/stop")
    async def stop_registration(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return register_service.stop()

    @router.post("/config")
    async def update_config(req: ConfigUpdateRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        data = req.model_dump(exclude_unset=True)
        return register_service.update_config(data)

    @router.get("/logs")
    async def get_logs(limit: int = Query(300, ge=1, le=1000), authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"logs": register_service.get_logs(limit)}

    @router.post("/logs/clear")
    async def clear_logs(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        register_service.clear_logs()
        return {"status": "success"}

    @router.get("/logs/stream")
    async def stream_logs(
        request: Request,
        authorization: str | None = Header(default=None),
        token: Optional[str] = Query(default=None),
    ):
        auth_header = authorization or (f"Bearer {token}" if token else None)
        require_admin(auth_header)

        async def event_generator():
            queue: asyncio.Queue = asyncio.Queue(maxsize=100)
            register_service.register_log_listener(queue)
            try:
                # 首次连接先推一条心跳
                yield f": keep-alive\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        entry = await asyncio.wait_for(queue.get(), timeout=20.0)
                        data = json.dumps(entry, ensure_ascii=False)
                        yield f"data: {data}\n\n"
                    except asyncio.TimeoutError:
                        yield f": keep-alive\n\n"
            finally:
                register_service.unregister_log_listener(queue)

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )



    @router.post("/test_proxy")
    async def test_proxy(req: TestProxyRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        from curl_cffi import requests
        proxy = register_service.proxy_pool.normalize_proxy(req.proxy)
        if not proxy:
            return {"status": "error", "message": "代理格式不正确"}

        start = time.time()
        proxies = {"http": proxy, "https": proxy}
        try:
            def _probe():
                return requests.get(
                    "https://cloudflare.com/cdn-cgi/trace",
                    proxies=proxies,
                    timeout=10,
                    verify=False,
                )

            resp = await asyncio.to_thread(_probe)
            elapsed = round(time.time() - start, 2)
            if resp.status_code == 200:
                loc = "未知"
                for line in resp.text.splitlines():
                    if line.startswith("loc="):
                        loc = line.split("=")[-1]
                return {
                    "status": "success",
                    "latency": elapsed,
                    "location": loc,
                    "message": f"节点连接正常 (地区: {loc}, 延迟: {elapsed}s)",
                }
            return {"status": "error", "message": f"节点返回异常 HTTP {resp.status_code}"}
        except Exception as e:
            return {"status": "error", "message": f"连接失败: {str(e)}"}

    return router
