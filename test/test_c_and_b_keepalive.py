"""Unit tests for C (Session Keepalive) + B (Disaster Recovery) and Safe Deletion State Machine."""
from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from services.account_service import AccountService
from services.config import config


class FakeStorage:
    def __init__(self):
        self.accounts = []

    def load_accounts(self):
        return list(self.accounts)

    def save_accounts(self, accounts):
        self.accounts = list(accounts)


class CAndBKeepaliveTests(unittest.TestCase):
    def setUp(self):
        self.storage = FakeStorage()
        self.service = AccountService(self.storage)
        self.orig_auto_remove = config.data.get("auto_remove_invalid_accounts")

    def tearDown(self):
        if self.orig_auto_remove is None:
            config.data.pop("auto_remove_invalid_accounts", None)
        else:
            config.data["auto_remove_invalid_accounts"] = self.orig_auto_remove

    def test_safe_state_machine_first_failure_never_deletes(self):
        # 即使开启了 auto_remove_invalid_accounts，首次失败也绝不删除
        config.data["auto_remove_invalid_accounts"] = True
        token = "test_token_1"
        self.service.add_account_items([{
            "access_token": token,
            "email": "test1@example.com",
            "status": "正常",
            "invalid_count": 0,
        }])

        # 首次触发失效
        removed = self.service.remove_invalid_token(token, event="unit_test")
        self.assertFalse(removed, "First failure must NEVER delete the account!")
        acc = self.service.get_account(token)
        self.assertIsNotNone(acc)
        self.assertEqual(acc.get("status"), "异常")
        self.assertEqual(acc.get("invalid_count"), 1)

    def test_safe_state_machine_second_failure_deletes_only_if_configured(self):
        token = "test_token_2"
        self.service.add_account_items([{
            "access_token": token,
            "email": "test2@example.com",
            "status": "异常",
            "invalid_count": 1,
        }])

        # 当 auto_remove 为 False 时，连续失败也不物理删除
        config.data["auto_remove_invalid_accounts"] = False
        removed = self.service.remove_invalid_token(token, event="unit_test_disabled")
        self.assertFalse(removed)
        acc = self.service.get_account(token)
        self.assertIsNotNone(acc)
        self.assertEqual(acc.get("invalid_count"), 2)

        # 当 auto_remove 为 True 时，连续失败 (invalid_count >= 2) 才物理删除
        config.data["auto_remove_invalid_accounts"] = True
        removed = self.service.remove_invalid_token(token, event="unit_test_enabled")
        self.assertTrue(removed, "Second consecutive failure must delete if auto_remove is True")
        acc = self.service.get_account(token)
        self.assertIsNone(acc)

    @patch.object(AccountService, "_login_with_password")
    @patch.object(AccountService, "refresh_web_session")
    def test_recover_account_disaster_prefers_c_then_b(self, mock_refresh_c, mock_login_b):
        token = "test_token_3"
        self.service.add_account_items([{
            "access_token": token,
            "email": "test3@example.com",
            "password": "Password123!",
            "session_token": "valid_session_cookie",
            "status": "异常",
            "invalid_count": 1,
        }])

        # 1. 方案 C 成功时，优先走 C 恢复，不触发 B
        mock_refresh_c.return_value = {"access_token": "new_c_token"}
        recovered = self.service.recover_account_disaster(token)
        self.assertTrue(recovered)
        mock_refresh_c.assert_called_once()
        mock_login_b.assert_not_called()

        # 2. 方案 C 失败时，降级走 B (密码重新登录)
        mock_refresh_c.reset_mock()
        mock_login_b.reset_mock()
        mock_refresh_c.return_value = None
        mock_login_b.return_value = {
            "ok": True,
            "access_token": "new_b_token",
            "refresh_token": "b_refresh",
            "source_type": "password",
        }

        recovered_b = self.service.recover_account_disaster(token)
        self.assertTrue(recovered_b)
        mock_refresh_c.assert_called_once()
        mock_login_b.assert_called_once()


if __name__ == "__main__":
    unittest.main()
