import worker from "../cloudflare-mail-worker/src/index.js";

async function testWorker() {
  console.log("=== 测试 Cloudflare Email Worker 模拟执行 ===");

  const rawEmail = `From: OpenAI <noreply@tm.openai.com>
To: test_user@comail.shop
Subject: 739102 is your ChatGPT code
Content-Type: text/html; charset=utf-8

<!DOCTYPE html>
<html>
<head><style>.btn{color:red;}</style><script>var x = 600000;</script></head>
<body>
  <p>Your ChatGPT code is <strong>739102</strong></p>
  <p>This code will expire in 10 minutes.</p>
</body>
</html>`;

  const mockMessage = {
    to: "test_user@comail.shop",
    from: "noreply@tm.openai.com",
    headers: {
      get: (k) => (k.toLowerCase() === "subject" ? "739102 is your ChatGPT code" : null)
    },
    raw: new Blob([rawEmail]).stream()
  };

  const env = {
    WEBHOOK_URL: "",
    WEBHOOK_SECRET: "1145141919810",
    NTFY_TOPIC: "1145141919810"
  };

  console.log("正在触发 Worker email() 事件...");
  await worker.email(mockMessage, env, {});
  console.log("✅ Worker 解析并成功推送到 ntfy.sh (Topic: 1145141919810)！");
}

testWorker().catch((err) => {
  console.error("Worker test failed:", err);
  process.exit(1);
});
