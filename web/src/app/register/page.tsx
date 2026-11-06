"use client";

import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  Copy,
  Check,
  Flame,
  Globe,
  Inbox,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  clearRegisterLogs,
  fetchRegisterLogs,
  fetchRegisterStatus,
  startRegister,
  stopRegister,
  testRegisterProxy,
  updateRegisterConfig,
  type RegisterConfig,
  type RegisterLogItem,
  type RegisterStatusResponse,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

export default function RegisterPage() {
  const { session, isPending: isAuthPending } = useAuthGuard();

  const [status, setStatus] = useState<RegisterStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [config, setConfig] = useState<RegisterConfig>({
    mode: "smart",
    target_count: 20,
    concurrency: 2,
    check_interval_seconds: 60,
    mail_mode: "cf_worker",
    cf_worker_domains: "",
    cf_worker_webhook_secret: "",
    cf_worker_ntfy_topic: "",
    duckmail_api_url: "https://api.duckmail.com",
    duckmail_domain: "duckmail.com",
    imap_host: "",
    imap_port: 993,
    imap_username: "",
    imap_password: "",
    imap_domains: "",
    proxies_text: "",
  });

  const [logs, setLogs] = useState<RegisterLogItem[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [testingProxy, setTestingProxy] = useState(false);
  const [testProxyInput, setTestProxyInput] = useState("");
  const [copied, setCopied] = useState(false);

  const terminalRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);

  // 加载状态
  const loadStatus = async () => {
    try {
      const res = await fetchRegisterStatus();
      setStatus(res);
      setConfig(res.config);
    } catch (e: any) {
      console.error("Failed to load register status:", e);
    } finally {
      setLoading(false);
    }
  };

  // 加载初始日志
  const loadLogs = async () => {
    try {
      const res = await fetchRegisterLogs(300);
      setLogs(res.logs || []);
    } catch (e) {
      console.error("Failed to load register logs:", e);
    }
  };

  useEffect(() => {
    if (isAuthPending || !session) return;
    loadStatus();
    loadLogs();

    // 状态轮询 (每 3 秒)
    const interval = setInterval(loadStatus, 3000);

    // 建立 SSE 流式日志连接
    const token = typeof window !== "undefined" ? localStorage.getItem("chatgpt2api_auth_key") || "" : "";
    const sseUrl = `/api/register/logs/stream`;

    try {
      const evtSource = new EventSource(sseUrl);
      sseRef.current = evtSource;

      evtSource.onmessage = (event) => {
        try {
          if (!event.data || event.data.startsWith(":")) return;
          const newEntry: RegisterLogItem = JSON.parse(event.data);
          setLogs((prev) => {
            const next = [...prev, newEntry];
            return next.length > 500 ? next.slice(-500) : next;
          });
        } catch (err) {
          // ignore parsing error for comments/heartbeats
        }
      };

      evtSource.onerror = () => {
        // SSE 断线时退回到轻度轮询
      };
    } catch (e) {
      console.error("SSE setup error:", e);
    }

    return () => {
      clearInterval(interval);
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
    };
  }, [isAuthPending, session]);

  // 自动滚屏
  useEffect(() => {
    if (autoScroll && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleSaveConfig = async () => {
    setActionLoading(true);
    try {
      const updated = await updateRegisterConfig(config);
      setConfig(updated);
      toast.success("配置已保存生效");
      await loadStatus();
    } catch (e: any) {
      toast.error(e.message || "保存配置失败");
    } finally {
      setActionLoading(false);
    }
  };

  const handleStart = async (runMode?: "smart" | "manual") => {
    setActionLoading(true);
    try {
      // 启动前先保存最新配置
      await updateRegisterConfig(config);
      const res = await startRegister(runMode || config.mode);
      toast.success(res.message || "任务已启动");
      await loadStatus();
    } catch (e: any) {
      toast.error(e.message || "启动失败");
    } finally {
      setActionLoading(false);
    }
  };

  const handleStop = async () => {
    setActionLoading(true);
    try {
      const res = await stopRegister();
      toast.info(res.message || "任务已停止");
      await loadStatus();
    } catch (e: any) {
      toast.error(e.message || "停止失败");
    } finally {
      setActionLoading(false);
    }
  };

  const handleClearLogs = async () => {
    try {
      await clearRegisterLogs();
      setLogs([]);
      toast.success("日志已清空");
    } catch (e: any) {
      toast.error(e.message || "清空日志失败");
    }
  };

  const handleCopyLogs = () => {
    const text = logs.map((l) => `[${l.time}] ${l.text}`).join("\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success("日志已复制到剪贴板");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleTestProxy = async () => {
    const proxy = testProxyInput.trim() || (config.proxies_text.split("\n")[0] || "").trim();
    if (!proxy) {
      toast.error("请输入待测试的代理 URL");
      return;
    }
    setTestingProxy(true);
    try {
      const res = await testRegisterProxy(proxy);
      if (res.status === "success") {
        toast.success(res.message);
      } else {
        toast.error(res.message || "代理测活失败");
      }
    } catch (e: any) {
      toast.error(e.message || "测活请求异常");
    } finally {
      setTestingProxy(false);
    }
  };

  if (isAuthPending || loading) {
    return (
      <div className="flex h-[calc(100vh-3.5rem)] items-center justify-center bg-[#08090d]">
        <div className="flex items-center gap-2 font-mono text-xs text-zinc-400">
          <Loader2 className="size-4 animate-spin text-emerald-400" />
          <span>INITIALIZING REGISTRATION ENGINE...</span>
        </div>
      </div>
    );
  }

  // 环形健康进度计算
  const activeCount = status?.pool_health?.active ?? 0;
  const targetCount = config.target_count || 20;
  const healthPercent = Math.min(100, Math.round((activeCount / Math.max(1, targetCount)) * 100));

  const radius = 28;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (healthPercent / 100) * circumference;

  const isRunning = status?.is_running ?? false;
  const currentMode = status?.mode ?? "idle";

  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-[#08090d] text-zinc-200">
      <div className="mx-auto max-w-[1680px] p-4 sm:p-6 space-y-4">
        {/* Top Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-white/[0.08] pb-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.15)]">
              <Bot className="size-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight text-white font-mono">OpenAI 注册机</h1>
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-mono border",
                    isRunning
                      ? currentMode === "smart"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                        : "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
                      : "border-zinc-700 bg-zinc-800/40 text-zinc-400"
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      isRunning
                        ? currentMode === "smart"
                          ? "bg-emerald-400 animate-pulse"
                          : "bg-cyan-400 animate-pulse"
                        : "bg-zinc-500"
                    )}
                  />
                  {isRunning ? (currentMode === "smart" ? "智能监控补货中" : "常规批量运行中") : "待机中"}
                </span>
              </div>
              <p className="text-xs text-zinc-400 font-mono">
                自动完成 Sentinel 算力挑战、接码验证与 Token 提取，无缝直存 SQLite 账号库
              </p>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="flex items-center gap-2">
            {!isRunning ? (
              <>
                <Button
                  size="sm"
                  onClick={() => handleStart("smart")}
                  disabled={actionLoading}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-xs h-8 px-3 border border-emerald-400/30 shadow-[0_0_12px_rgba(16,185,129,0.25)]"
                >
                  <Zap className="size-3.5 mr-1 text-emerald-200" />
                  启动智能模式
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleStart("manual")}
                  disabled={actionLoading}
                  className="border-white/[0.12] bg-white/[0.04] hover:bg-white/[0.08] text-zinc-200 font-mono text-xs h-8 px-3"
                >
                  <Play className="size-3.5 mr-1 text-cyan-400" />
                  常规批量
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                onClick={handleStop}
                disabled={actionLoading}
                className="bg-rose-950/80 hover:bg-rose-900 border border-rose-500/40 text-rose-300 font-mono text-xs h-8 px-3"
              >
                <Square className="size-3.5 mr-1" />
                停止任务
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={handleSaveConfig}
              disabled={actionLoading}
              className="border-white/[0.1] bg-white/[0.02] hover:bg-white/[0.06] text-zinc-300 font-mono text-xs h-8 px-3"
            >
              <Save className="size-3.5 mr-1 text-zinc-400" />
              保存配置
            </Button>
          </div>
        </div>

        {/* Metric Cards Bar */}
        <div className="rounded-xl border border-white/[0.08] bg-[#0c0e14] p-4 shadow-sm">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:items-center">
            {/* Left: Health Ring */}
            <div className="flex items-center gap-4 lg:col-span-4 border-b lg:border-b-0 lg:border-r border-white/[0.06] pb-3 lg:pb-0 lg:pr-4">
              <div className="relative flex size-20 shrink-0 items-center justify-center">
                <svg className="size-20 -rotate-90">
                  <circle
                    cx="40"
                    cy="40"
                    r={radius}
                    className="stroke-zinc-800/80"
                    strokeWidth="6"
                    fill="transparent"
                  />
                  <circle
                    cx="40"
                    cy="40"
                    r={radius}
                    className="stroke-emerald-400 transition-all duration-500 ease-out"
                    strokeWidth="6"
                    strokeDasharray={circumference}
                    strokeDashoffset={strokeDashoffset}
                    strokeLinecap="round"
                    fill="transparent"
                  />
                </svg>
                <div className="absolute flex flex-col items-center justify-center text-center">
                  <span className="font-mono text-xs font-bold text-white">{healthPercent}%</span>
                  <span className="text-[9px] font-mono text-zinc-500">HEALTH</span>
                </div>
              </div>
              <div className="space-y-1 font-mono">
                <div className="text-xs text-zinc-400 flex items-center gap-1.5">
                  <ShieldCheck className="size-3.5 text-emerald-400" />
                  <span>号池健康槽位</span>
                </div>
                <div className="text-lg font-bold text-white">
                  <span className="text-emerald-400">{activeCount}</span>
                  <span className="text-zinc-500 text-sm"> / {targetCount} 目标</span>
                </div>
                <div className="text-[11px] text-zinc-500">
                  {activeCount >= targetCount ? "健康充足，待机保活中" : `当前缺口 ${targetCount - activeCount} 个，智能自动补货`}
                </div>
              </div>
            </div>

            {/* Right: Metrics Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 lg:col-span-8">
              <div className="rounded-lg border border-white/[0.04] bg-white/[0.015] p-2.5 font-mono">
                <div className="text-[11px] text-zinc-500">累计尝试</div>
                <div className="mt-1 text-base font-bold text-white">{status?.stats?.total_attempts ?? 0}</div>
                <div className="text-[10px] text-zinc-600">ATTEMPTS</div>
              </div>
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.03] p-2.5 font-mono">
                <div className="text-[11px] text-emerald-400/80">成功入库</div>
                <div className="mt-1 text-base font-bold text-emerald-400">{status?.stats?.success ?? 0}</div>
                <div className="text-[10px] text-emerald-500/60">SAVED TO DB</div>
              </div>
              <div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.03] p-2.5 font-mono">
                <div className="text-[11px] text-rose-400/80">注册失败</div>
                <div className="mt-1 text-base font-bold text-rose-400">{status?.stats?.failed ?? 0}</div>
                <div className="text-[10px] text-rose-500/60">FAILED</div>
              </div>
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.03] p-2.5 font-mono">
                <div className="text-[11px] text-amber-400/80">403 拦截</div>
                <div className="mt-1 text-base font-bold text-amber-400">{status?.stats?.is_403 ?? 0}</div>
                <div className="text-[10px] text-amber-500/60">IP BLOCKED</div>
              </div>
              <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.03] p-2.5 font-mono">
                <div className="text-[11px] text-cyan-400/80">并发活跃数</div>
                <div className="mt-1 text-base font-bold text-cyan-300">
                  {status?.active_workers ?? 0} <span className="text-zinc-600 text-xs">/ {config.concurrency}</span>
                </div>
                <div className="text-[10px] text-cyan-500/60">WORKERS</div>
              </div>
            </div>
          </div>
        </div>

        {/* Main Content Area: Split 2-Column Console */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 items-start">
          {/* Left Column: Settings Drawer / Panel (5 cols) */}
          <div className="lg:col-span-5 space-y-4">
            {/* 1. 运行模式设置 */}
            <div className="rounded-xl border border-white/[0.08] bg-[#0c0e14] p-4 space-y-4">
              <div className="flex items-center justify-between border-b border-white/[0.06] pb-2.5">
                <div className="flex items-center gap-2 font-mono text-xs font-semibold text-white">
                  <Activity className="size-4 text-emerald-400" />
                  <span>调度与模式参数</span>
                </div>
              </div>

              {/* Mode Switcher */}
              <div className="grid grid-cols-2 gap-2 p-1 rounded-lg bg-black/40 border border-white/[0.04]">
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, mode: "smart" })}
                  className={cn(
                    "flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md text-xs font-mono transition",
                    config.mode === "smart"
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold shadow-sm"
                      : "text-zinc-400 hover:text-white"
                  )}
                >
                  <Zap className="size-3.5" />
                  智能补货模式
                </button>
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, mode: "manual" })}
                  className={cn(
                    "flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md text-xs font-mono transition",
                    config.mode === "manual"
                      ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold shadow-sm"
                      : "text-zinc-400 hover:text-white"
                  )}
                >
                  <Play className="size-3.5" />
                  常规批量模式
                </button>
              </div>

              {/* Parameter Inputs */}
              <div className="grid grid-cols-2 gap-3 font-mono">
                <div className="space-y-1.5">
                  <Label className="text-[11px] text-zinc-400">
                    {config.mode === "smart" ? "健康目标数量" : "目标注册数量"}
                  </Label>
                  <Input
                    type="number"
                    min={1}
                    max={500}
                    value={config.target_count}
                    onChange={(e) => setConfig({ ...config, target_count: parseInt(e.target.value) || 1 })}
                    className="h-8 bg-black/50 border-white/[0.08] text-xs font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] text-zinc-400">并发线程数 (1-10)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={config.concurrency}
                    onChange={(e) => setConfig({ ...config, concurrency: parseInt(e.target.value) || 1 })}
                    className="h-8 bg-black/50 border-white/[0.08] text-xs font-mono"
                  />
                </div>
              </div>

              {config.mode === "smart" && (
                <div className="space-y-1.5 font-mono">
                  <Label className="text-[11px] text-zinc-400">智能巡检间隔 (秒)</Label>
                  <Input
                    type="number"
                    min={10}
                    max={3600}
                    value={config.check_interval_seconds}
                    onChange={(e) => setConfig({ ...config, check_interval_seconds: parseInt(e.target.value) || 60 })}
                    className="h-8 bg-black/50 border-white/[0.08] text-xs font-mono"
                  />
                  <span className="text-[10px] text-zinc-500">
                    后台定时巡检号池；同时在账号被限流/异常时也会即刻被动触发补货。
                  </span>
                </div>
              )}
            </div>

            {/* 2. 邮箱接码源配置 */}
            <div className="rounded-xl border border-white/[0.08] bg-[#0c0e14] p-4 space-y-4">
              <div className="flex items-center justify-between border-b border-white/[0.06] pb-2.5">
                <div className="flex items-center gap-2 font-mono text-xs font-semibold text-white">
                  <Inbox className="size-4 text-cyan-400" />
                  <span>邮箱接码源设置</span>
                </div>
              </div>

              {/* Mail Provider Switcher */}
              <div className="grid grid-cols-3 gap-1.5 p-1 rounded-lg bg-black/40 border border-white/[0.04] font-mono">
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, mail_mode: "cf_worker" })}
                  className={cn(
                    "py-1.5 px-2 rounded-md text-xs transition text-center",
                    config.mail_mode === "cf_worker"
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold shadow-sm"
                      : "text-zinc-400 hover:text-white"
                  )}
                >
                  ⚡ CF Worker 直推
                </button>
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, mail_mode: "duckmail" })}
                  className={cn(
                    "py-1.5 px-2 rounded-md text-xs transition text-center",
                    config.mail_mode === "duckmail"
                      ? "bg-white/[0.1] text-white border border-white/20 font-bold"
                      : "text-zinc-400 hover:text-white"
                  )}
                >
                  DuckMail 临时
                </button>
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, mail_mode: "imap" })}
                  className={cn(
                    "py-1.5 px-2 rounded-md text-xs transition text-center",
                    config.mail_mode === "imap"
                      ? "bg-white/[0.1] text-white border border-white/20 font-bold"
                      : "text-zinc-400 hover:text-white"
                  )}
                >
                  Cloudflare / IMAP
                </button>
              </div>

              {/* CF Worker Config */}
              {config.mail_mode === "cf_worker" ? (
                <div className="space-y-3 font-mono">
                  <div className="space-y-1.5">
                    <Label className="text-[11px] text-zinc-400">捕获域名列表 (逗号隔开，需托管在 Cloudflare)</Label>
                    <Input
                      value={config.cf_worker_domains || ""}
                      onChange={(e) => setConfig({ ...config, cf_worker_domains: e.target.value })}
                      placeholder="mycustomdomain.com, example.org"
                      className="h-8 bg-black/50 border-white/[0.08] text-xs font-mono"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label className="text-[11px] text-zinc-400">Webhook Secret 密钥 (防伪造)</Label>
                      <Input
                        type="password"
                        value={config.cf_worker_webhook_secret || ""}
                        onChange={(e) => setConfig({ ...config, cf_worker_webhook_secret: e.target.value })}
                        placeholder="自定义密钥 (可选)"
                        className="h-8 bg-black/50 border-white/[0.08] text-xs font-mono"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] text-zinc-400">备选免穿透 Topic (ntfy.sh)</Label>
                      <Input
                        value={config.cf_worker_ntfy_topic || ""}
                        onChange={(e) => setConfig({ ...config, cf_worker_ntfy_topic: e.target.value })}
                        placeholder="如 cf-otp-secret-9988 (可选)"
                        className="h-8 bg-black/50 border-white/[0.08] text-xs font-mono"
                      />
                    </div>
                  </div>
                  <div className="space-y-1 rounded border border-emerald-500/20 bg-emerald-500/5 p-2.5 text-[11px] font-mono">
                    <div className="font-semibold text-emerald-400">⚡ 0 存储、0 轮询极致推送</div>
                    <div className="text-zinc-400 text-[10px]">
                      Webhook 地址: <code className="text-zinc-200 bg-black/50 px-1 py-0.5 rounded">/api/register/webhook/cf-worker</code>
                    </div>
                    <div className="text-zinc-500 text-[10px]">
                      在 Cloudflare Email Routing 设置 Catch-All 发往 Worker，Worker 单次 POST 推送唤醒注册。
                    </div>
                  </div>
                </div>
              ) : config.mail_mode === "duckmail" ? (
                /* DuckMail Config */
                <div className="space-y-3 font-mono">
                  <div className="space-y-1.5">
                    <Label className="text-[11px] text-zinc-400">DuckMail API 地址</Label>
                    <Input
                      value={config.duckmail_api_url}
                      onChange={(e) => setConfig({ ...config, duckmail_api_url: e.target.value })}
                      placeholder="https://api.duckmail.com"
                      className="h-8 bg-black/50 border-white/[0.08] text-xs font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[11px] text-zinc-400">邮箱后缀域名</Label>
                    <Input
                      value={config.duckmail_domain}
                      onChange={(e) => setConfig({ ...config, duckmail_domain: e.target.value })}
                      placeholder="duckmail.com"
                      className="h-8 bg-black/50 border-white/[0.08] text-xs font-mono"
                    />
                  </div>
                  <div className="rounded border border-emerald-500/20 bg-emerald-500/5 p-2 text-[11px] text-emerald-400/90 font-mono">
                    💡 免配置公共临时邮箱，全自动生成邮箱并实时拉取 6 位验证码。
                  </div>
                </div>
              ) : (
                /* Cloudflare IMAP Config */
                <div className="space-y-3 font-mono">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2 space-y-1.5">
                      <Label className="text-[11px] text-zinc-400">IMAP 服务器</Label>
                      <Input
                        value={config.imap_host}
                        onChange={(e) => setConfig({ ...config, imap_host: e.target.value })}
                        placeholder="imap.mail.me.com"
                        className="h-8 bg-black/50 border-white/[0.08] text-xs font-mono"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] text-zinc-400">端口</Label>
                      <Input
                        type="number"
                        value={config.imap_port}
                        onChange={(e) => setConfig({ ...config, imap_port: parseInt(e.target.value) || 993 })}
                        className="h-8 bg-black/50 border-white/[0.08] text-xs font-mono"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label className="text-[11px] text-zinc-400">邮箱账号</Label>
                      <Input
                        value={config.imap_username}
                        onChange={(e) => setConfig({ ...config, imap_username: e.target.value })}
                        placeholder="user@example.com"
                        className="h-8 bg-black/50 border-white/[0.08] text-xs font-mono"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] text-zinc-400">密码 / 授权码</Label>
                      <Input
                        type="password"
                        value={config.imap_password}
                        onChange={(e) => setConfig({ ...config, imap_password: e.target.value })}
                        placeholder="••••••••"
                        className="h-8 bg-black/50 border-white/[0.08] text-xs font-mono"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[11px] text-zinc-400">发信捕获域名池 (逗号隔开)</Label>
                    <Input
                      value={config.imap_domains}
                      onChange={(e) => setConfig({ ...config, imap_domains: e.target.value })}
                      placeholder="mydomain1.com, mydomain2.com"
                      className="h-8 bg-black/50 border-white/[0.08] text-xs font-mono"
                    />
                  </div>
                  <div className="rounded border border-cyan-500/20 bg-cyan-500/5 p-2 text-[11px] text-cyan-400/90 font-mono">
                    💡 适用于 Cloudflare Email Routing Catch-All 转发至专属收件箱大批量造号。
                  </div>
                </div>
              )}
            </div>

            {/* 3. 代理池管理 */}
            <div className="rounded-xl border border-white/[0.08] bg-[#0c0e14] p-4 space-y-4">
              <div className="flex items-center justify-between border-b border-white/[0.06] pb-2.5">
                <div className="flex items-center gap-2 font-mono text-xs font-semibold text-white">
                  <Globe className="size-4 text-cyan-400" />
                  <span>代理池网络管理</span>
                </div>
                <span className="text-[11px] font-mono text-zinc-500">
                  {status?.proxy_stats?.total ?? 0} 个节点配置
                </span>
              </div>

              <div className="space-y-2 font-mono">
                <Label className="text-[11px] text-zinc-400">多行代理列表 (每次注册任务自动轮换)</Label>
                <Textarea
                  rows={4}
                  value={config.proxies_text}
                  onChange={(e) => setConfig({ ...config, proxies_text: e.target.value })}
                  placeholder={"http://127.0.0.1:7890\nsocks5://user:pass@host:1080\nhttp://ip:port"}
                  className="bg-black/50 border-white/[0.08] text-xs font-mono resize-y"
                />
                <span className="text-[10px] text-zinc-500">
                  支持 http:// 与 socks5://；如为空则使用服务器网络直连。
                </span>
              </div>

              {/* Quick Proxy Test */}
              <div className="pt-2 border-t border-white/[0.04] space-y-2">
                <div className="flex items-center gap-2">
                  <Input
                    value={testProxyInput}
                    onChange={(e) => setTestProxyInput(e.target.value)}
                    placeholder="输入代理节点测试连接..."
                    className="h-7 text-xs font-mono bg-black/40 border-white/[0.06]"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleTestProxy}
                    disabled={testingProxy}
                    className="h-7 px-2.5 text-xs font-mono border-white/[0.1] bg-white/[0.03] text-zinc-300"
                  >
                    {testingProxy ? <Loader2 className="size-3 animate-spin mr-1" /> : <RefreshCw className="size-3 mr-1" />}
                    测试
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Streaming Terminal Log (7 cols) */}
          <div className="lg:col-span-7">
            <div className="rounded-xl border border-white/[0.08] bg-[#0c0e14] shadow-sm flex flex-col h-[750px]">
              {/* Terminal Header */}
              <div className="flex items-center justify-between border-b border-white/[0.08] px-4 py-2.5 bg-black/40 rounded-t-xl">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 mr-2">
                    <span className="size-2.5 rounded-full bg-rose-500/80" />
                    <span className="size-2.5 rounded-full bg-amber-500/80" />
                    <span className="size-2.5 rounded-full bg-emerald-500/80" />
                  </div>
                  <Terminal className="size-3.5 text-zinc-400" />
                  <span className="font-mono text-xs font-bold text-white tracking-wider">REGISTRATION TERMINAL</span>
                  <span className="inline-flex items-center gap-1 text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                    <span className="size-1 rounded-full bg-emerald-400 animate-pulse" />
                    STREAM
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setAutoScroll(!autoScroll)}
                    className={cn(
                      "text-[10px] font-mono px-2 py-0.5 rounded border transition",
                      autoScroll
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                        : "border-zinc-700 bg-zinc-800 text-zinc-400"
                    )}
                  >
                    滚屏: {autoScroll ? "开" : "关"}
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleCopyLogs}
                    className="h-6 px-2 text-zinc-400 hover:text-white text-xs font-mono"
                  >
                    {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleClearLogs}
                    className="h-6 px-2 text-zinc-400 hover:text-rose-400 text-xs font-mono"
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </div>

              {/* Terminal Screen */}
              <div
                ref={terminalRef}
                className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-1 bg-[#06070a] select-text"
                style={{ scrollBehavior: autoScroll ? "smooth" : "auto" }}
              >
                {logs.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-zinc-600 gap-2 font-mono">
                    <Terminal className="size-8 opacity-30" />
                    <span>终端已就绪，启动任务后将在此实时输出注册链路日志...</span>
                  </div>
                ) : (
                  logs.map((log, idx) => {
                    const isError = log.text.includes("❌") || log.text.includes("💥") || log.level === "ERROR";
                    const isSuccess = log.text.includes("🎉") || log.text.includes("✅") || log.text.includes("SUCCESS");
                    const isWarn = log.text.includes("⚠️") || log.text.includes("403");

                    return (
                      <div
                        key={idx}
                        className={cn(
                          "leading-relaxed flex items-start gap-2 py-0.5",
                          isError && "text-rose-400 bg-rose-500/[0.04] px-1 rounded",
                          isSuccess && "text-emerald-300 bg-emerald-500/[0.04] px-1 rounded font-semibold",
                          isWarn && "text-amber-300 bg-amber-500/[0.03] px-1 rounded",
                          !isError && !isSuccess && !isWarn && "text-zinc-300"
                        )}
                      >
                        <span className="text-zinc-600 shrink-0 select-none">[{log.time}]</span>
                        <span className="break-all">{log.text}</span>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Terminal Footer Info */}
              <div className="border-t border-white/[0.06] bg-black/40 px-4 py-2 flex items-center justify-between text-[11px] font-mono text-zinc-500 rounded-b-xl">
                <span>Total Logs: {logs.length} lines</span>
                <span>Python 3.12 · curl_cffi Chrome · Sentinel PoW</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
