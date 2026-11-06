/**
 * Cloudflare Email Worker - ChatGPT 验证码极速直推
 * 
 * 特性：
 * 1. 0 存储依赖：不使用任何 KV, D1, R2, S3
 * 2. 请求最小化：单封邮件仅发生 1 次 HTTP POST 推送，彻底杜绝高频轮询
 * 3. 毫秒级延迟：邮件到达即刻解析推送，速度 < 300ms
 * 4. 双通道支持：
 *    - 渠道 1：直接 Webhook 推送至服务端 API (带密钥签名)
 *    - 渠道 2：通过免配置的 ntfy.sh 主题广播（专为本地内网/无穿透环境设计）
 */

// 验证码提取正则（按优先级排序，与后端 Python 保持 100% 对齐）
const OTP_PATTERNS = [
  /(?:Your|OpenAI|ChatGPT)\s+(?:code|verification code)\s+is\s*[:：]?\s*([0-9]{6})\b/i,
  /verification code to continue:\s*([0-9]{6})\b/i,
  /Subject:.*?([0-9]{6})\b/i,
  /enter this code:\s*([0-9]{6})\b/i,
  /(?:verification|verify|security|login|sign[- ]?up)\s*code\D{0,35}?([0-9]{6})\b/i,
  /(?:your code is|code is|code[:：])\D{0,20}?([0-9]{6})\b/i,
  /验证码\D{0,15}?([0-9]{6})\b/i,
  /\b([0-9]{6})\b/
];

const IGNORED_CODES = new Set(["000000", "600000", "999999"]);

function extractOtpCode(rawHtml) {
  if (!rawHtml) return null;
  
  // 1. 彻底过滤 script 和 style 标签（避免匹配到 js 时间戳或缓存参数）
  let clean = rawHtml.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // 2. 去除 HTML 标签与实体替换
  clean = clean.replace(/<[^>]+>/g, " ");
  clean = clean.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

  for (const pattern of OTP_PATTERNS) {
    const match = clean.match(pattern);
    if (match && match[1]) {
      const code = match[1];
      if (!IGNORED_CODES.has(code)) {
        return code;
      }
    }
  }
  return null;
}

function decodeMimeText(raw) {
  if (!raw) return "";
  let text = String(raw);

  // 1. 解码 Quoted-Printable 软折行与十六进制字符
  try {
    text = text.replace(/=\r?\n/g, "");
    text = text.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return _;
      }
    });
  } catch (e) {}

  // 2. 解码 Base64 正文块
  try {
    text = text.replace(
      /(?:Content-Transfer-Encoding:\s*base64[\s\S]*?\r?\n\r?\n)([A-Za-z0-9+/=\r\n]{16,})/gi,
      (match, b64) => {
        try {
          const cleanB64 = b64.replace(/\s+/g, "");
          return atob(cleanB64);
        } catch {
          return match;
        }
      }
    );
  } catch (e) {}

  return text;
}

export default {
  /**
   * Cloudflare Email Routing 邮件到达触发器
   */
  async email(message, env, ctx) {
    const toAddress = message.to;
    const fromAddress = message.from;
    const subject = message.headers.get("subject") || "";

    console.log(`[EmailWorker] 收到新邮件: ${fromAddress} -> ${toAddress}, 标题: ${subject}`);

    try {
      // 1. 流式读取邮件原始内容
      const rawText = await new Response(message.raw).text();

      // 2. 多重解码：优先从标题或解码后的内容中提取
      const decodedMime = decodeMimeText(rawText);
      const combinedText = `${subject}\n${rawText}\n${decodedMime}`;
      const code = extractOtpCode(combinedText);

      const ntfyTopic = (env.NTFY_TOPIC || "1145141919810").trim();
      const webhookUrl = (env.WEBHOOK_URL || "").trim();
      const webhookSecret = (env.WEBHOOK_SECRET || "1145141919810").trim();
      const forwardTo = (env.FORWARD_TO || "ad.min@fmys.dev").trim();

      if (!code) {
        console.warn(`[EmailWorker] 未能在发给 ${toAddress} 的邮件中提取到 6 位验证码`);
        // 保证日常邮件或非验证码邮件正常转发至主邮箱
        if (forwardTo && typeof message.forward === "function") {
          await message.forward(forwardTo).catch(err => {
            console.warn(`[EmailWorker] 转发失败: ${err.message}`);
          });
        }
        // 发送诊断告警，避免静默丢弃
        if (ntfyTopic) {
          await fetch(`https://ntfy.sh/${ntfyTopic}`, {
            method: "POST",
            headers: { "Title": "OpenAI OTP Extraction Warning", "Tags": "warning" },
            body: JSON.stringify({
              error: "no_code_extracted",
              email: toAddress,
              subject: subject,
              from: fromAddress,
              snippet: rawText.slice(0, 300)
            })
          }).catch(() => {});
        }
        return;
      }

      console.log(`[EmailWorker] 成功提取到验证码: [${code}] (邮箱: ${toAddress})`);

      const payload = {
        email: toAddress,
        code: code,
        subject: subject,
        from: fromAddress,
        timestamp: Date.now()
      };

      const tasks = [];

      // 0. 转发副本至主邮箱（保证用户不漏信）
      if (forwardTo && typeof message.forward === "function") {
        tasks.push(
          message.forward(forwardTo).then(() => {
            console.log(`[EmailWorker] 成功转发副本至: ${forwardTo}`);
          }).catch(err => {
            console.warn(`[EmailWorker] 转发副本提示: ${err.message}`);
          })
        );
      }

      // 1. 直推至后端 Webhook (如果配置了 WEBHOOK_URL)
      if (webhookUrl) {
        const headers = { "Content-Type": "application/json" };
        if (webhookSecret) {
          headers["X-Webhook-Secret"] = webhookSecret;
        }

        tasks.push(
          fetch(webhookUrl, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(payload)
          }).then(res => {
            console.log(`[EmailWorker] Webhook 推送响应: HTTP ${res.status}`);
          }).catch(err => {
            console.error(`[EmailWorker] Webhook 推送失败: ${err.message}`);
          })
        );
      }

      // 2. 推送至 ntfy.sh (广播通道，缺省默认 1145141919810)
      if (ntfyTopic) {
        tasks.push(
          fetch(`https://ntfy.sh/${ntfyTopic}`, {
            method: "POST",
            headers: {
              "Title": "OpenAI Verification Code",
              "Tags": "key,lock"
            },
            body: JSON.stringify(payload)
          }).then(res => {
            console.log(`[EmailWorker] ntfy.sh 广播响应: HTTP ${res.status}`);
          }).catch(err => {
            console.error(`[EmailWorker] ntfy.sh 广播失败: ${err.message}`);
          })
        );
      }

      // 并行等待所有单次推送完成
      if (tasks.length > 0) {
        await Promise.all(tasks);
      }
    } catch (err) {
      console.error(`[EmailWorker] 处理邮件异常: ${err.message}`);
    }
  },

  /**
   * HTTP 访问触发器 (用于健康检查与模拟测试)
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. 模拟推送测试接口：POST /test-push
    if (request.method === "POST" && url.pathname === "/test-push") {
      try {
        const body = await request.json();
        const testEmail = body.email || "test@example.com";
        const testCode = body.code || "123456";

        const payload = {
          email: testEmail,
          code: testCode,
          subject: "Test OpenAI Verification Code",
          from: "noreply@tm.openai.com",
          timestamp: Date.now()
        };

        const results = {};

        if (env.WEBHOOK_URL) {
          try {
            const res = await fetch(env.WEBHOOK_URL, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(env.WEBHOOK_SECRET ? { "X-Webhook-Secret": env.WEBHOOK_SECRET } : {})
              },
              body: JSON.stringify(payload)
            });
            results.webhook = { status: res.status, text: await res.text() };
          } catch (e) {
            results.webhook = { error: e.message };
          }
        }

        if (env.NTFY_TOPIC) {
          try {
            const res = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
              method: "POST",
              headers: { "Title": "OpenAI Verification Code", "Tags": "key,lock" },
              body: JSON.stringify(payload)
            });
            results.ntfy = { status: res.status, text: await res.text() };
          } catch (e) {
            results.ntfy = { error: e.message };
          }
        }

        return new Response(JSON.stringify({ status: "tested", payload, results }, null, 2), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400 });
      }
    }

    // 2. 默认健康检查状态
    return new Response(
      JSON.stringify(
        {
          status: "running",
          service: "chatgpt2api-mail-worker",
          config: {
            webhook_configured: Boolean(env.WEBHOOK_URL && env.WEBHOOK_URL.trim()),
            ntfy_configured: Boolean(env.NTFY_TOPIC && env.NTFY_TOPIC.trim()),
            secret_configured: Boolean(env.WEBHOOK_SECRET && env.WEBHOOK_SECRET.trim())
          },
          tips: "绑定 Cloudflare Email Routing Catch-All 即可接收 OpenAI 邮件"
        },
        null,
        2
      ),
      {
        headers: { "Content-Type": "application/json; charset=utf-8" }
      }
    );
  }
};
