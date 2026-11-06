"""注册机与智能补货模块单元测试。"""
from __future__ import annotations

import unittest

from services.register.auth_solver import generate_sentinel_payload, init_auth_session
from services.register.mail_provider import DuckMailProvider, _extract_otp_code, create_mail_provider
from services.register.proxy_pool import ProxyPool
from services.register.register_service import register_service


class RegistrationEngineTests(unittest.TestCase):
    def test_auth_solver_payload_generation(self):
        token = generate_sentinel_payload(did="test-device-id", flow="authorize_continue")
        self.assertIsInstance(token, str)
        self.assertGreater(len(token), 30)
        self.assertIn('"id":"test-device-id"', token)

    def test_proxy_pool_normalization_and_rotation(self):
        text = """
        127.0.0.1:7890
        socks5://user:pass@1.1.1.1:1080
        http://node.example.com:8080
        # 这是注释
        """
        pool = ProxyPool(text)
        self.assertEqual(len(pool._proxies), 3)

        p1 = pool.get_proxy()
        p2 = pool.get_proxy()
        p3 = pool.get_proxy()
        p4 = pool.get_proxy()

        self.assertEqual(p1, "http://127.0.0.1:7890")
        self.assertEqual(p2, "socks5h://user:pass@1.1.1.1:1080")
        self.assertEqual(p3, "http://node.example.com:8080")
        self.assertEqual(p4, "http://127.0.0.1:7890")

        # 测试失败标记
        pool.mark_failure(p1)
        pool.mark_failure(p1)
        pool.mark_failure(p1)
        stats = pool.get_stats()
        self.assertEqual(stats["failed"], 1)

    def test_extract_otp_code(self):
        self.assertEqual(_extract_otp_code("Your OpenAI verification code is 839201."), "839201")
        self.assertEqual(_extract_otp_code("验证码：492019，10分钟内有效。"), "492019")
        self.assertEqual(_extract_otp_code("<h1>Code: 123456</h1>"), "123456")
        self.assertIsNone(_extract_otp_code("No numbers here"))

    def test_mail_provider_factory(self):
        duck = create_mail_provider({"mail_mode": "duckmail", "duckmail_domain": "test.com"})
        self.assertIsInstance(duck, DuckMailProvider)

    def test_register_service_lifecycle(self):
        status = register_service.get_status()
        self.assertIn("is_running", status)
        self.assertIn("pool_health", status)
        self.assertIn("stats", status)

        # 测试日志
        register_service.log("Unit test log entry", level="INFO")
        logs = register_service.get_logs(limit=10)
        self.assertTrue(any("Unit test log entry" in l["text"] for l in logs))

        # 测试配置读写
        updated = register_service.update_config({"target_count": 25, "concurrency": 4})
        self.assertEqual(updated["target_count"], 25)
        self.assertEqual(updated["concurrency"], 4)

        # 还原
        register_service.update_config({"target_count": 20, "concurrency": 2})


if __name__ == "__main__":
    unittest.main()
