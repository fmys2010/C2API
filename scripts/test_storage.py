#!/usr/bin/env python3
"""
存储后端测试脚本

用法：
  python scripts/test_storage.py
"""

import sys
from pathlib import Path

# 添加项目根目录到 Python 路径
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.config import DATA_DIR
from services.storage.factory import create_storage_backend


def check_storage() -> bool:
    """测试当前 SQLite 存储后端"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print("=" * 60)
    print("ChatGPT2API SQLite 存储后端测试")
    print("=" * 60)

    try:
        print("\n[1/4] 创建存储后端...")
        storage = create_storage_backend(DATA_DIR)
        print("✅ 存储后端创建成功")

        print("\n[2/4] 获取后端信息...")
        info = storage.get_backend_info()
        print(f"✅ 后端类型: {info.get('type')}")
        print(f"   描述: {info.get('description')}")
        print(f"   数据库路径: {info.get('db_path')}")

        print("\n[3/4] 健康检查...")
        health = storage.health_check()
        print(f"✅ 状态: {health.get('status')}")
        print(f"   账号数: {health.get('account_count')}")
        print(f"   密钥数: {health.get('auth_key_count')}")

        print("\n[4/4] 读写测试...")
        test_accounts = [
            {"access_token": "test-token-1", "name": "测试账号 1"},
            {"access_token": "test-token-2", "name": "测试账号 2"},
        ]
        original_accounts = storage.load_accounts()
        storage.save_accounts(test_accounts)
        loaded = storage.load_accounts()
        assert len(loaded) == 2, f"预期 2 个账号，实际得到 {len(loaded)} 个"
        # 恢复原状
        storage.save_accounts(original_accounts)
        print("✅ 读写测试通过，数据已恢复原状")

        print("\n" + "=" * 60)
        print("🎉 SQLite 存储后端测试全部通过！")
        print("=" * 60)
        return True
    except Exception as e:
        print(f"\n❌ 测试失败: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = check_storage()
    sys.exit(0 if success else 1)
