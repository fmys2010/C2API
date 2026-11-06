from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from sqlalchemy import Column, Integer, String, Text, create_engine, event, text
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.pool import NullPool

from services.storage.base import StorageBackend

Base = declarative_base()


class AccountModel(Base):
    """账号数据模型"""
    __tablename__ = "accounts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    access_token = Column(String(2048), unique=True, nullable=False, index=True)
    data = Column(Text, nullable=False)


class AuthKeyModel(Base):
    """鉴权密钥数据模型"""
    __tablename__ = "auth_keys"

    id = Column(Integer, primary_key=True, autoincrement=True)
    key_id = Column(String(255), unique=True, nullable=False, index=True)
    data = Column(Text, nullable=False)


class SQLiteStorageBackend(StorageBackend):
    """纯 SQLite 本地数据库存储后端"""

    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.database_url = f"sqlite:///{self.db_path.resolve()}"

        self.engine = create_engine(
            self.database_url,
            poolclass=NullPool,
            connect_args={"check_same_thread": False, "timeout": 30},
        )

        @event.listens_for(self.engine, "connect")
        def set_sqlite_pragma(dbapi_connection, connection_record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.close()

        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

        self._migrate_legacy_json_if_needed()

    def close(self) -> None:
        """释放数据库连接资源"""
        if hasattr(self, "engine") and self.engine:
            self.engine.dispose()

    def __del__(self) -> None:
        self.close()

    def _migrate_legacy_json_if_needed(self) -> None:
        """如果 SQLite 为空且存在遗留 JSON 文件，则自动导入数据"""
        try:
            with self.Session() as session:
                has_accounts = session.query(AccountModel).first() is not None
                has_keys = session.query(AuthKeyModel).first() is not None

            if not has_accounts:
                legacy_accounts_file = self.db_path.parent / "accounts.json"
                if legacy_accounts_file.exists():
                    raw = json.loads(legacy_accounts_file.read_text(encoding="utf-8"))
                    accounts = raw if isinstance(raw, list) else (list(raw.values()) if isinstance(raw, dict) else [])
                    if accounts:
                        self.save_accounts(accounts)
                        print(f"[storage] Migrated {len(accounts)} accounts from {legacy_accounts_file}")

            if not has_keys:
                legacy_keys_file = self.db_path.parent / "auth_keys.json"
                if legacy_keys_file.exists():
                    raw = json.loads(legacy_keys_file.read_text(encoding="utf-8"))
                    keys = raw if isinstance(raw, list) else (list(raw.values()) if isinstance(raw, dict) else [])
                    if keys:
                        self.save_auth_keys(keys)
                        print(f"[storage] Migrated {len(keys)} auth keys from {legacy_keys_file}")
        except Exception as exc:
            print(f"[storage] Legacy JSON migration skipped: {exc}")

    def load_accounts(self) -> list[dict[str, Any]]:
        with self.Session() as session:
            accounts = []
            for row in session.query(AccountModel).all():
                try:
                    data = json.loads(row.data)
                    if isinstance(data, dict):
                        accounts.append(data)
                except json.JSONDecodeError:
                    continue
            return accounts

    def save_accounts(self, accounts: list[dict[str, Any]]) -> None:
        self._save_rows(AccountModel, accounts, "access_token")

    def load_auth_keys(self) -> list[dict[str, Any]]:
        return self._load_rows(AuthKeyModel)

    def save_auth_keys(self, auth_keys: list[dict[str, Any]]) -> None:
        self._save_rows(AuthKeyModel, auth_keys, "id", "key_id")

    def _load_rows(self, model: type[AccountModel] | type[AuthKeyModel]) -> list[dict[str, Any]]:
        with self.Session() as session:
            items = []
            for row in session.query(model).all():
                try:
                    item_data = json.loads(row.data)
                    if isinstance(item_data, dict):
                        items.append(item_data)
                except json.JSONDecodeError:
                    continue
            return items

    def _save_rows(
        self,
        model: type[AccountModel] | type[AuthKeyModel],
        items: list[dict[str, Any]],
        source_key: str,
        target_key: str | None = None,
    ) -> None:
        with self.Session() as session:
            try:
                key_column = target_key or source_key
                existing_rows = {
                    str(getattr(row, key_column)): row
                    for row in session.query(model).all()
                }
                incoming_keys: set[str] = set()

                for item in items:
                    if not isinstance(item, dict):
                        continue
                    key_value = str(item.get(source_key) or "").strip()
                    if not key_value:
                        continue
                    if key_value in incoming_keys:
                        raise ValueError(f"Duplicate {source_key} in storage snapshot")

                    incoming_keys.add(key_value)
                    serialized_data = json.dumps(item, ensure_ascii=False)
                    existing_row = existing_rows.get(key_value)
                    if existing_row is None:
                        session.add(
                            model(
                                **{key_column: key_value},
                                data=serialized_data,
                            )
                        )
                    elif existing_row.data != serialized_data:
                        existing_row.data = serialized_data

                for key_value, row in existing_rows.items():
                    if key_value not in incoming_keys:
                        session.delete(row)

                session.commit()
            except Exception:
                session.rollback()
                raise

    def health_check(self) -> dict[str, Any]:
        try:
            with self.Session() as session:
                session.execute(text("SELECT 1"))
                count = session.query(AccountModel).count()
                auth_key_count = session.query(AuthKeyModel).count()
                return {
                    "status": "healthy",
                    "backend": "sqlite",
                    "db_path": str(self.db_path),
                    "account_count": count,
                    "auth_key_count": auth_key_count,
                }
        except Exception as e:
            return {
                "status": "unhealthy",
                "backend": "sqlite",
                "error": str(e),
            }

    def get_backend_info(self) -> dict[str, Any]:
        return {
            "type": "database",
            "db_type": "sqlite",
            "description": "本地 SQLite 数据库存储",
            "db_path": str(self.db_path),
        }
