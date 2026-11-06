"""测试 Cloudflare Email Worker 直推邮件接收适配器与 Webhook 接口。"""
import threading
import time
import pytest
from fastapi.testclient import TestClient

from api.app import create_app
from services.register.mail_provider import CloudflareWorkerMailProvider, _extract_otp_code
from services.register import register_service

app = create_app()


def test_cf_worker_create_email():
    provider = CloudflareWorkerMailProvider(domains="chatgpt-auto.xyz, ai-nodes.net")
    email, token = provider.create_email()
    assert email is not None
    assert "@" in email
    domain = email.split("@")[-1]
    assert domain in ["chatgpt-auto.xyz", "ai-nodes.net"]


def test_cf_worker_instant_resolution():
    provider = CloudflareWorkerMailProvider(domains="test.com")
    target_email = "test_user_8899@test.com"

    # 启动后台线程模拟 Worker 毫秒级 Webhook 推送
    def simulate_worker_push():
        time.sleep(0.1)  # 100ms 后推送
        CloudflareWorkerMailProvider.resolve_code(target_email, "876543")

    t = threading.Thread(target=simulate_worker_push)
    t.start()

    start_t = time.time()
    code = provider.get_code(target_email, timeout=5)
    elapsed = time.time() - start_t
    t.join()

    assert code == "876543"
    assert elapsed < 1.0, f"应该毫秒级唤醒，实际耗时: {elapsed}s"


def test_cf_worker_pre_received_code():
    provider = CloudflareWorkerMailProvider(domains="test.com")
    target_email = "early_bird@test.com"

    # 先推入验证码
    CloudflareWorkerMailProvider.resolve_code(target_email, "654321")

    # 随后调用 get_code 应当直接命中返回
    code = provider.get_code(target_email, timeout=2)
    assert code == "654321"


def test_cf_worker_timeout():
    provider = CloudflareWorkerMailProvider(domains="test.com")
    code = provider.get_code("non_existent@test.com", timeout=1)
    assert code is None


def test_cf_worker_webhook_endpoint():
    client = TestClient(app)

    # 1. 配置 secret
    register_service.update_config({"cf_worker_webhook_secret": "my-secret-key-123"})

    target_email = "webhook_test@domain.com"
    expected_code = "987123"

    # 异步等待
    result_holder = []
    def wait_code():
        prov = CloudflareWorkerMailProvider(domains="domain.com")
        res = prov.get_code(target_email, timeout=5)
        result_holder.append(res)

    t = threading.Thread(target=wait_code)
    t.start()

    time.sleep(0.05)

    # 2. 模拟缺少密钥调用 -> 403
    bad_resp = client.post(
        "/api/register/webhook/cf-worker",
        json={"email": target_email, "code": expected_code},
        headers={"X-Webhook-Secret": "wrong-secret"}
    )
    assert bad_resp.status_code == 403

    # 3. 正常调用
    good_resp = client.post(
        "/api/register/webhook/cf-worker",
        json={"email": target_email, "code": expected_code},
        headers={"X-Webhook-Secret": "my-secret-key-123"}
    )
    assert good_resp.status_code == 200
    assert good_resp.json()["status"] == "success"
    assert good_resp.json()["resolved"] is True

    t.join(timeout=2)
    assert len(result_holder) == 1
    assert result_holder[0] == expected_code


def test_extract_otp_code_edge_cases():
    # 测试真实邮件格式与防误判
    raw_sample = """
    <html>
      <head>
        <style>.code { font-size: 24px; }</style>
        <script>var cacheTime = 600000;</script>
      </head>
      <body>
        <p>Your ChatGPT code is 439201</p>
        <p>Please enter this within 10 minutes.</p>
      </body>
    </html>
    """
    code = _extract_otp_code(raw_sample)
    assert code == "439201"
