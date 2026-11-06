from __future__ import annotations

from pathlib import Path

from services.storage.base import StorageBackend
from services.storage.sqlite_storage import SQLiteStorageBackend


def create_storage_backend(data_dir: Path) -> StorageBackend:
    """创建 SQLite 存储后端"""
    db_path = data_dir / "accounts.db"
    return SQLiteStorageBackend(db_path)
