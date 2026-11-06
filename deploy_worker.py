import json
import os
import sys
import urllib.error
import urllib.request
import uuid

# 从环境变量或命令行参数获取 Cloudflare 凭证
token = os.getenv("CF_API_TOKEN") or (sys.argv[1] if len(sys.argv) > 1 else "")
account_id = os.getenv("CF_ACCOUNT_ID") or (sys.argv[2] if len(sys.argv) > 2 else "")
ntfy_topic = os.getenv("NTFY_TOPIC", "1145141919810")
webhook_secret = os.getenv("WEBHOOK_SECRET", "1145141919810")
forward_to = os.getenv("FORWARD_TO", "")

if not token or not account_id:
    print("使用方法: python deploy_worker.py <CF_API_TOKEN> <CF_ACCOUNT_ID>")
    print("或者设置环境变量: export CF_API_TOKEN=... CF_ACCOUNT_ID=...")
    sys.exit(1)

proxy_url = os.getenv("HTTP_PROXY") or os.getenv("http_proxy")
opener = urllib.request.build_opener(urllib.request.ProxyHandler({'http': proxy_url, 'https': proxy_url})) if proxy_url else urllib.request.build_opener()

boundary = "----Boundary" + uuid.uuid4().hex
bindings = [
    {"name": "NTFY_TOPIC", "type": "plain_text", "text": ntfy_topic},
    {"name": "WEBHOOK_SECRET", "type": "plain_text", "text": webhook_secret},
]
if forward_to:
    bindings.append({"name": "FORWARD_TO", "type": "plain_text", "text": forward_to})

metadata = {
    "main_module": "worker.js",
    "compatibility_date": "2024-11-01",
    "bindings": bindings,
}

worker_file = os.path.join(os.path.dirname(__file__), "cloudflare-mail-worker", "src", "index.js")
with open(worker_file, "r", encoding="utf-8") as f:
    js_code = f.read()

parts = [
    f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"; filename="metadata.json"\r\nContent-Type: application/json\r\n\r\n{json.dumps(metadata)}\r\n'.encode("utf-8"),
    f'--{boundary}\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\nContent-Type: application/javascript+module\r\n\r\n{js_code}\r\n'.encode("utf-8"),
    f"--{boundary}--\r\n".encode("utf-8")
]
payload = b"".join(parts)

req = urllib.request.Request(
    f"https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/chatgpt2api-mail-worker",
    data=payload,
    headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    },
    method="PUT",
)

try:
    with opener.open(req, timeout=20) as resp:
        print("Deploy status:", resp.status)
        print(resp.read().decode())
except urllib.error.HTTPError as e:
    print("Deploy failed:", e.code, e.read().decode())
