#!/usr/bin/env python3
"""
SQLite 存储数据备份与导入脚本

用法：
  python scripts/migrate_storage.py --export backup.json
  python scripts/migrate_storage.py --import backup.json
"""

import argparse
import json
import sys
from pathlib import Path

# 添加项目根目录到 Python 路径
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.config import DATA_DIR
from services.storage.factory import create_storage_backend


def export_to_json(output_file: str):
    """导出 SQLite 数据库中的账号数据到 JSON 文件"""
    print(f"[storage] Exporting data to {output_file}")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    storage = create_storage_backend(DATA_DIR)
    accounts = storage.load_accounts()

    output_path = Path(output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(accounts, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"[storage] Exported {len(accounts)} accounts to {output_file}")


def import_from_json(input_file: str):
    """从 JSON 文件导入账号数据到 SQLite 数据库"""
    print(f"[storage] Importing data from {input_file}")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    input_path = Path(input_file)
    if not input_path.exists():
        print(f"[storage] Error: File not found: {input_file}")
        sys.exit(1)

    try:
        accounts = json.loads(input_path.read_text(encoding="utf-8"))
        if not isinstance(accounts, list):
            print(f"[storage] Error: Invalid JSON format, expected array of accounts")
            sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"[storage] Error: Invalid JSON: {e}")
        sys.exit(1)

    storage = create_storage_backend(DATA_DIR)
    storage.save_accounts(accounts)
    print(f"[storage] Imported {len(accounts)} accounts into SQLite database")


def main():
    parser = argparse.ArgumentParser(
        description="ChatGPT2API SQLite 数据导出与导入工具"
    )
    parser.add_argument(
        "--export",
        dest="export_file",
        metavar="FILE",
        help="导出数据到 JSON 文件",
    )
    parser.add_argument(
        "--import",
        dest="import_file",
        metavar="FILE",
        help="从 JSON 文件导入数据",
    )

    args = parser.parse_args()

    if args.export_file:
        export_to_json(args.export_file)
    elif args.import_file:
        import_from_json(args.import_file)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
