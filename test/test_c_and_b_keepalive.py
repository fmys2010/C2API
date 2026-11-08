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

    def test_safe_state_machine_no_email_account_kept_abnormal_unless_forced(self):
        token = "test_token_no_email"
        self.service.add_account_items([{
            "access_token": token,
            "email": "",
            "status": "异常",
            "invalid_count": 1,
        }])

        # 未强制删除时，纯 Token 账号永久保留异常供查阅
        config.data["auto_remove_invalid_accounts"] = True
        removed = self.service.remove_invalid_token(token, event="unit_test_keep")
        self.assertFalse(removed)
        acc = self.service.get_account(token)
        self.assertIsNotNone(acc)
        self.assertEqual(acc.get("status"), "异常")

        # force_delete 时才物理清理
        removed_forced = self.service.remove_invalid_token(token, event="unit_test_force", force_delete=True)
        self.assertTrue(removed_forced)
        acc_after = self.service.get_account(token)
        self.assertIsNone(acc_after)

    @patch("services.register.register_service.register_service.rerun_account_registration")
    def test_relogin_twice_failure_physically_deletes(self, mock_rerun):
        config.data["auto_remove_invalid_accounts"] = True
        token = "test_token_relogin_fail"
        self.service.add_account_items([{
            "access_token": token,
            "email": "fail@example.com",
            "status": "异常",
            "invalid_count": 1,
            "quota": 0,
        }])
        mock_rerun.return_value = {"success": False, "error": "otp_timeout"}

        self.service._execute_relogin_with_retry(token, "fail@example.com")

        self.assertEqual(mock_rerun.call_count, 2)
        acc = self.service.get_account(token)
        self.assertIsNone(acc, "Account must be deleted after 2 failed relogin attempts")

    @patch("services.register.register_service.register_service.rerun_account_registration")
    def test_relogin_success_heals_account(self, mock_rerun):
        token = "test_token_relogin_succ"
        self.service.add_account_items([{
            "access_token": token,
            "email": "succ@example.com",
            "status": "异常",
            "invalid_count": 1,
            "quota": 0,
        }])
        def fake_rerun(email, old_access_token="", proxy=None, log_fn=None):
            # 模拟注册机更新成功
            self.service._apply_refreshed_tokens(old_access_token, {"access_token": "new_healthy_token", "session_token": "sess123"}, "register_rerun")
            self.service.update_account("new_healthy_token", {"status": "正常", "invalid_count": 0, "quota": 25})
            return {"success": True, "access_token": "new_healthy_token", "email": email}

        mock_rerun.side_effect = fake_rerun

        self.service._execute_relogin_with_retry(token, "succ@example.com")

        new_acc = self.service.get_account("new_healthy_token")
        self.assertIsNotNone(new_acc)
        self.assertEqual(new_acc.get("status"), "正常")
        self.assertEqual(new_acc.get("quota"), 25)
        self.assertEqual(new_acc.get("invalid_count"), 0)

    def test_429_auto_removes_rate_limited_account(self):
        # 默认 auto_remove_rate_limited_accounts 为 True
        config.data["auto_remove_rate_limited_accounts"] = True
        token = "test_token_429"
        self.service.add_account_items([{
            "access_token": token,
            "email": "rate@example.com",
            "status": "正常",
            "quota": 10,
        }])

        # 当触发 429 或限流时，update_account status='限流' 立即物理删除
        res = self.service.update_account(token, {"status": "限流", "quota": 0})
        self.assertIsNone(res)
        acc = self.service.get_account(token)
        self.assertIsNone(acc, "429 account must be purged immediately when auto_remove is True")


if __name__ == "__main__":
    unittest.main()
