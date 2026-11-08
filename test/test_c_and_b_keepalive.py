"""Unit tests for Email OTP Relogin Self-Healing and Safe Deletion State Machine."""
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


class EmailOTPReloginAndDeletionTests(unittest.TestCase):
    def setUp(self):
        self.storage = FakeStorage()
        with patch.object(AccountService, "_start_relogin_worker"):
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

    def test_safe_state_machine_second_failure_deletes_no_email_account_if_configured(self):
        token = "test_token_no_email"
        self.service.add_account_items([{
            "access_token": token,
            "email": "",
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

    @patch.object(AccountService, "login_with_email_otp")
    def test_relogin_twice_failure_physically_deletes(self, mock_login):
        token = "test_token_relogin_fail"
        self.service.add_account_items([{
            "access_token": token,
            "email": "fail@example.com",
            "status": "异常",
            "invalid_count": 1,
        }])
        mock_login.return_value = {"ok": False, "error": "otp_timeout"}

        self.service._execute_relogin_with_retry(token, "fail@example.com")

        self.assertEqual(mock_login.call_count, 2)
        acc = self.service.get_account(token)
        self.assertIsNone(acc, "Account must be deleted after 2 failed relogin attempts")

    @patch.object(AccountService, "fetch_remote_info")
    @patch.object(AccountService, "login_with_email_otp")
    def test_relogin_success_heals_account(self, mock_login, mock_fetch):
        token = "test_token_relogin_succ"
        self.service.add_account_items([{
            "access_token": token,
            "email": "succ@example.com",
            "status": "异常",
            "invalid_count": 1,
            "quota": 0,
        }])
        mock_login.return_value = {
            "ok": True,
            "access_token": "new_healthy_token",
            "session_token": "new_sess",
            "device_id": "dev123",
            "user_agent": "ua123",
        }
        mock_fetch.return_value = None

        self.service._execute_relogin_with_retry(token, "succ@example.com")

        old_acc = self.service.get_account(token)
        new_acc = self.service.get_account("new_healthy_token")
        self.assertIsNotNone(new_acc)
        self.assertEqual(new_acc.get("status"), "正常")
        self.assertEqual(new_acc.get("quota"), 25)
        self.assertEqual(new_acc.get("invalid_count"), 0)


if __name__ == "__main__":
    unittest.main()
