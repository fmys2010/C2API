from __future__ import annotations

from pathlib import Path
from threading import Event, Thread

from fastapi import HTTPException, Request

from services.account_service import account_service
from services.auth_service import auth_service
from services.config import config

BASE_DIR = Path(__file__).resolve().parents[1]
WEB_DIST_DIR = BASE_DIR / "web_dist"


def extract_bearer_token(authorization: str | None) -> str:
    scheme, _, value = str(authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return ""
    return value.strip()


def _legacy_admin_identity(token: str) -> dict[str, object] | None:
    auth_key = str(config.auth_key or "").strip()
    if auth_key and token == auth_key:
        return {"id": "admin", "name": "管理员", "role": "admin"}
    return None


def require_identity(authorization: str | None) -> dict[str, object]:
    token = extract_bearer_token(authorization)
    identity = _legacy_admin_identity(token) or auth_service.authenticate(token)
    if identity is None:
        raise HTTPException(status_code=401, detail={"error": "密钥无效或已失效，请重新登录"})
    return identity


def require_auth_key(authorization: str | None) -> None:
    require_identity(authorization)


def require_admin(authorization: str | None) -> dict[str, object]:
    identity = require_identity(authorization)
    if identity.get("role") != "admin":
        raise HTTPException(status_code=403, detail={"error": "需要管理员权限才能执行这个操作"})
    return identity


def resolve_image_base_url(request: Request) -> str:
    return config.base_url or f"{request.url.scheme}://{request.headers.get('host', request.url.netloc)}"


def raise_image_quota_error(exc: Exception) -> None:
    message = str(exc)
    if "no available image quota" in message.lower():
        raise HTTPException(status_code=429, detail={"error": "no available image quota"}) from exc
    raise HTTPException(status_code=502, detail={"error": message}) from exc


def sanitize_cpa_pool(pool: dict | None) -> dict | None:
    if not isinstance(pool, dict):
        return None
    return {key: value for key, value in pool.items() if key != "secret_key"}


def sanitize_cpa_pools(pools: list[dict]) -> list[dict]:
    return [sanitized for pool in pools if (sanitized := sanitize_cpa_pool(pool)) is not None]


def sanitize_sub2api_server(server: dict | None) -> dict | None:
    if not isinstance(server, dict):
        return None
    sanitized = {key: value for key, value in server.items() if key not in {"password", "api_key"}}
    sanitized["has_api_key"] = bool(str(server.get("api_key") or "").strip())
    return sanitized


def sanitize_sub2api_servers(servers: list[dict]) -> list[dict]:
    return [sanitized for server in servers if (sanitized := sanitize_sub2api_server(server)) is not None]


def start_limited_account_watcher(stop_event: Event) -> Thread:
    def worker() -> None:
        import time
        last_patrol_time = 0.0

        while not stop_event.is_set():
            try:
                now = time.time()
                patrol_interval_seconds = max(60, config.refresh_account_interval_minute * 60)

                # 定期全量巡检（默认 5 分钟一次，巡检限流、过期、异常状态，并自动触发邮箱验证码重登自愈）
                if now - last_patrol_time >= patrol_interval_seconds:
                    last_patrol_time = now
                    normal_tokens = account_service.list_normal_tokens()
                    limited_tokens = account_service.list_limited_tokens()
                    expiring_tokens = account_service.list_expiring_access_tokens()
                    invalid_tokens = account_service.list_invalid_tokens()
                    keepalive_tokens = account_service.list_refresh_token_keepalive_tokens()
                    # 巡检时，只要账号进入异常状态，自动根据邮箱接收验证码重新登录自愈（重登失败2次后物理删除）
                    if invalid_tokens:
                        for token in invalid_tokens:
                            account = account_service.get_account(token)
                            if account:
                                email = str(account.get("email") or "").strip()
                                if email:
                                    account_service.enqueue_relogin(token, email, account.get("proxy"))
                                else:
                                    if config.auto_remove_invalid_accounts and int(account.get("quota") or 0) <= 0:
                                        account_service.delete_accounts([token])

                    tokens = list(dict.fromkeys([*limited_tokens, *normal_tokens, *expiring_tokens]))
                    expiring_token_set = set(expiring_tokens)
                    keepalive_tokens = [token for token in keepalive_tokens if token not in expiring_token_set]
                    if tokens or invalid_tokens:
                        print(
                            "[account-watcher] patrolling "
                            f"{len(limited_tokens)} limited accounts, "
                            f"{len(normal_tokens)} normal accounts, "
                            f"{len(invalid_tokens)} invalid accounts, "
                            f"{len(expiring_tokens)} expiring access tokens"
                        )
                        if tokens:
                            account_service.refresh_accounts(tokens)
                    if keepalive_tokens:
                        print(f"[account-watcher] keepalive {len(keepalive_tokens)} refresh tokens")
                        result = account_service.keepalive_refresh_tokens(keepalive_tokens)
                        if result.get("errors"):
                            print(f"[account-watcher] keepalive errors: {result['errors']}")
            except Exception as exc:
                print(f"[account-watcher] fail {exc}")

            stop_event.wait(10)

    thread = Thread(target=worker, name="account-watcher", daemon=True)
    thread.start()
    return thread


def resolve_web_asset(requested_path: str) -> Path | None:
    if not WEB_DIST_DIR.exists():
        return None
    clean_path = requested_path.strip("/")
    base_dir = WEB_DIST_DIR.resolve()
    candidates = [base_dir / "index.html"] if not clean_path else [
        base_dir / Path(clean_path),
        base_dir / clean_path / "index.html",
        base_dir / f"{clean_path}.html",
    ]
    for candidate in candidates:
        try:
            candidate.resolve().relative_to(base_dir)
        except ValueError:
            continue
        if candidate.is_file():
            return candidate
    return None
