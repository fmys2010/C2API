"use client";

import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Bot,
  Check,
  CheckCircle2,
  Copy,
  CornerDownRight,
  Globe,
  Inbox,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
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

/**
 * 注册机号池健康圆环组件，与 Accounts 页面设计规范统一
 */
function RegisterHealthDonutRing({
  active = 0,
  target = 20,
}: {
  active: number;
  target: number;
}) {
  const safeTarget = Math.max(1, target);
  const healthPercent = Math.min(100, Math.round((active / safeTarget) * 100));
  const deficit = Math.max(0, target - active);

  const radius = 44;
  const strokeWidth = 9;
  const circumference = 2 * Math.PI * radius; // ~276.46
  const activeStroke = Math.min(circumference, (active / safeTarget) * circumference);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative flex size-32 shrink-0 items-center justify-center">
        <svg className="size-full -rotate-90" viewBox="0 0 120 120">
          {/* 背景底轨 */}
          <circle
            cx="60"
            cy="60"
            r={radius}
            fill="none"
            stroke="rgba(255, 255, 255, 0.05)"
            strokeWidth={strokeWidth}
          />
          {/* 健康活跃进度 */}
          <circle
            cx="60"
            cy="60"
            r={radius}
            fill="none"
            stroke="#10b981"
            strokeWidth={strokeWidth}
            strokeDasharray={`${activeStroke} ${circumference - activeStroke}`}
            strokeLinecap="round"
            className="transition-all duration-500 ease-out"
          />
        </svg>
        {/* 中心指标 */}
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="font-mono text-xl font-bold tracking-tight text-white">
            {healthPercent}%
          </span>
          <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">
            号池健康
          </span>
        </div>
      </div>

      {/* 底部微型图例 */}
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-zinc-400">
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-emerald-400" />
          <span>可用 {active}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-cyan-400" />
          <span>目标 {target}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className={cn("size-1.5 rounded-full", deficit > 0 ? "bg-amber-400" : "bg-zinc-600")} />
          <span>缺口 {deficit}</span>
        </span>
      </div>
    </div>
  );
}

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
  const actionLoadingRef = useRef(false);
  actionLoadingRef.current = actionLoading;
  const initialLoadedRef = useRef(false);
  const pollReqIdRef = useRef(0);

  // 加载状态 (通过 reqId 防乱序竞态，仅在首次或显式要求时同步服务端 config，避免覆写用户未保存的输入)
  const loadStatus = async (syncConfig = false) => {
    const reqId = ++pollReqIdRef.current;
    try {
      const res = await fetchRegisterStatus();
      if (reqId !== pollReqIdRef.current) return;
      setStatus(res);
      if (syncConfig || !initialLoadedRef.current) {
        setConfig(res.config);
        initialLoadedRef.current = true;
      }
    } catch (e: any) {
      console.error("Failed to load register status:", e);
    } finally {
      setLoading(false);
    }
  };

  // 加载初始日志（合并去重，防止覆盖已通过 SSE 到达的最新条目）
  const loadLogs = async () => {
    try {
      const res = await fetchRegisterLogs(300);
      const fetched = res.logs || [];
      setLogs((prev) => {
        if (prev.length === 0) return fetched;
        const prevKeys = new Set(prev.map((l) => `${l.timestamp || 0}_${l.time}_${l.text}`));
        const missingFromPrev = fetched.filter(
          (l) => !prevKeys.has(`${l.timestamp || 0}_${l.time}_${l.text}`)
        );
        const combined = [...missingFromPrev, ...prev];
        return combined.length > 500 ? combined.slice(-500) : combined;
      });
    } catch (e) {
      console.error("Failed to load register logs:", e);
    }
  };

  useEffect(() => {
    if (isAuthPending || !session) return;
    loadStatus(true);
    loadLogs();

    // 状态轮询 (每 3 秒)，在操作中暂停轮询，防止状态被旧请求覆盖
    const interval = setInterval(() => {
      if (!actionLoadingRef.current) {
        loadStatus(false);
      }
    }, 3000);

    // 建立 SSE 流式日志连接 (携带 query token 以通过管理员身份验证)
    const token = typeof window !== "undefined" ? localStorage.getItem("chatgpt2api_auth_key") || "" : "";
    const sseUrl = token
      ? `/api/register/logs/stream?token=${encodeURIComponent(token)}`
      : `/api/register/logs/stream`;

    let fallbackTimer: NodeJS.Timeout | null = null;

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
        if (!fallbackTimer) {
          fallbackTimer = setInterval(() => {
            void loadLogs();
          }, 4000);
        }
      };
    } catch (e) {
      console.error("SSE setup error:", e);
      fallbackTimer = setInterval(() => {
        void loadLogs();
      }, 4000);
    }

    return () => {
      clearInterval(interval);
      if (fallbackTimer) clearInterval(fallbackTimer);
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
      await loadStatus(false);
    } catch (e: any) {
      toast.error(e.message || "保存配置失败");
    } finally {
      setActionLoading(false);
    }
  };

  const handleStart = async (runMode?: "smart" | "manual") => {
    const targetMode = runMode || config.mode;
    setActionLoading(true);
    // 乐观更新运行状态和模式，杜绝按钮与状态卡片闪烁回滚
    setStatus((prev) =>
      prev
        ? {
            ...prev,
            is_running: true,
            mode: targetMode,
          }
        : null
    );
    setConfig((prev) => ({ ...prev, mode: targetMode }));
    if (!config.proxies_text.trim()) {
      toast.info("未配置代理列表，将以直连网络模式执行注册任务");
    }

    try {
      // 启动前先保存最新配置（确保 mode 与启动动作一致）
      const configToSave = { ...config, mode: targetMode };
      const savedConfig = await updateRegisterConfig(configToSave);
      setConfig(savedConfig);

      const res = await startRegister(targetMode);
      toast.success(res.message || "任务已启动");
      await loadStatus(false);
    } catch (e: any) {
      toast.error(e.message || "启动失败");
      await loadStatus(false);
    } finally {
      setActionLoading(false);
    }
  };

  const handleStop = async () => {
    setActionLoading(true);
    // 乐观更新停止
    setStatus((prev) =>
      prev
        ? {
            ...prev,
            is_running: false,
            mode: "idle",
            active_workers: 0,
          }
        : null
    );

    try {
      const res = await stopRegister();
      toast.info(res.message || "任务已停止");
      await loadStatus(false);
    } catch (e: any) {
      toast.error(e.message || "停止失败");
      await loadStatus(false);
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
    const fromList =
      config.proxies_text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#")) || "";
    const proxy = testProxyInput.trim() || fromList;
    if (!proxy) {
      toast.error("请输入或在列表中配置待测试的代理 URL");
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
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="flex items-center gap-2 font-mono text-xs text-zinc-400">
          <LoaderCircle className="size-5 animate-spin text-emerald-400" />
          <span>正在加载注册机配置与运行状态...</span>
        </div>
      </div>
    );
  }

  // 健康槽位计算
  const activeCount = status?.pool_health?.active ?? 0;
  const targetCount = status?.pool_health?.target || config.target_count || 20;

  const isRunning = status?.is_running ?? false;
  const currentMode = status?.mode ?? "idle";

  const isDirty = Boolean(
    status?.config &&
      JSON.stringify(status.config) !== JSON.stringify(config)
  );

  return (
    <div className="space-y-3 font-sans">
      {/* 顶部标题与主要操作按钮栏 (与其他管理页面保持统一) */}
      <section className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="font-mono text-base font-bold tracking-tight text-white">OpenAI 注册机</h1>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[11px]",
              isRunning
                ? currentMode === "smart"
                  ? "border-emerald-500/30 bg-emerald-950/70 text-emerald-400"
                  : "border-cyan-500/30 bg-cyan-950/70 text-cyan-400"
                : "border-white/[0.08] bg-white/[0.04] text-zinc-400"
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
          <span className="hidden md:inline font-mono text-[11px] text-zinc-500">
            自动算力挑战 · 接码解析 · 直存号池 SQLite
          </span>
        </div>

        {/* 顶部动作按钮组 */}
        <div className="flex flex-wrap items-center gap-1.5">
          {!isRunning ? (
            <>
              <Button
                size="sm"
                onClick={() => handleStart("smart")}
                disabled={actionLoading}
                className="h-8 rounded-lg bg-emerald-600 px-3 font-mono text-xs text-white hover:bg-emerald-500 transition-colors"
              >
                <Zap className="size-3.5 mr-1" />
                启动智能模式
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleStart("manual")}
                disabled={actionLoading}
                className="h-8 rounded-lg border-white/[0.08] bg-white/[0.03] px-2.5 font-mono text-xs text-zinc-300 hover:bg-white/[0.08] hover:text-white"
              >
                <Play className="size-3.5 mr-1 text-cyan-400" />
                常规批量
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={handleStop}
              disabled={actionLoading}
              className="h-8 rounded-lg border-rose-500/25 bg-rose-950/30 px-2.5 font-mono text-xs text-rose-300 hover:bg-rose-900/50"
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
            className={cn(
              "h-8 rounded-lg px-2.5 font-mono text-xs transition-colors",
              isDirty
                ? "border-emerald-500/40 bg-emerald-950/50 text-emerald-300 hover:bg-emerald-900/60"
                : "border-white/[0.08] bg-white/[0.03] text-zinc-300 hover:bg-white/[0.08] hover:text-white"
            )}
          >
            <Save className={cn("size-3.5 mr-1", isDirty ? "text-emerald-400" : "text-zinc-400")} />
            {isDirty ? "保存更改 *" : "保存配置"}
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => void loadStatus(false)}
            disabled={loading || actionLoading}
            className="h-8 rounded-lg border-white/[0.08] bg-white/[0.03] px-2.5 font-mono text-xs text-zinc-300 hover:bg-white/[0.08] hover:text-white"
          >
            <RefreshCw className={cn("size-3.5", loading ? "animate-spin" : "")} />
            刷新
          </Button>
        </div>
      </section>

      {/* 状态与健康指标总览卡片 (与 Accounts 页面 DonutRing + Metrics 风格一致) */}
      <section className="flex flex-col items-center gap-6 rounded-xl border border-white/[0.08] bg-[#0c0e17]/80 p-4 shadow-sm backdrop-blur-md md:flex-row md:items-center">
        {/* 左侧圆环指标 */}
        <div className="flex shrink-0 flex-col items-center">
          <RegisterHealthDonutRing
            active={activeCount}
            target={targetCount}
          />
        </div>

        <div className="hidden h-28 w-px bg-white/[0.08] md:block" />

        {/* 右侧数量卡片网格 */}
        <div className="grid w-full flex-1 grid-cols-2 gap-2 sm:grid-cols-5">
          <div className="flex flex-col justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 transition hover:border-white/[0.12]">
            <div className="flex items-center justify-between text-zinc-400">
              <span className="font-mono text-[10px] uppercase tracking-wider">累计尝试</span>
              <span className="size-1.5 rounded-full bg-zinc-400" />
            </div>
            <div className="mt-1 font-mono text-lg font-bold tracking-tight text-zinc-100">
              {status?.stats?.total_attempts ?? 0}
            </div>
          </div>
          <div className="flex flex-col justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 transition hover:border-white/[0.12]">
            <div className="flex items-center justify-between text-zinc-400">
              <span className="font-mono text-[10px] uppercase tracking-wider">成功入库</span>
              <span className="size-1.5 rounded-full bg-emerald-400" />
            </div>
            <div className="mt-1 font-mono text-lg font-bold tracking-tight text-emerald-400">
              {status?.stats?.success ?? 0}
            </div>
          </div>
          <div className="flex flex-col justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 transition hover:border-white/[0.12]">
            <div className="flex items-center justify-between text-zinc-400">
              <span className="font-mono text-[10px] uppercase tracking-wider">注册失败</span>
              <span className="size-1.5 rounded-full bg-rose-400" />
            </div>
            <div className="mt-1 font-mono text-lg font-bold tracking-tight text-rose-400">
              {status?.stats?.failed ?? 0}
            </div>
          </div>
          <div className="flex flex-col justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 transition hover:border-white/[0.12]">
            <div className="flex items-center justify-between text-zinc-400">
              <span className="font-mono text-[10px] uppercase tracking-wider">403 拦截</span>
              <span className="size-1.5 rounded-full bg-amber-400" />
            </div>
            <div className="mt-1 font-mono text-lg font-bold tracking-tight text-amber-400">
              {status?.stats?.is_403 ?? 0}
            </div>
          </div>
          <div className="flex flex-col justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 transition hover:border-white/[0.12]">
            <div className="flex items-center justify-between text-zinc-400">
              <span className="font-mono text-[10px] uppercase tracking-wider">活跃线程</span>
              <span className="size-1.5 rounded-full bg-cyan-400 animate-pulse" />
            </div>
            <div className="mt-1 font-mono text-lg font-bold tracking-tight text-cyan-300">
              {status?.active_workers ?? 0} <span className="text-zinc-500 text-xs font-normal">/ {config.concurrency}</span>
            </div>
          </div>
        </div>
      </section>

      {/* 控制台主区域：左侧配置参数 + 右侧流式日志终端 */}
      <section className="grid grid-cols-1 gap-3 lg:grid-cols-12 items-start">
        {/* 左侧配置栏 (5 列) */}
        <div className="lg:col-span-5 space-y-3">
          {/* 1. 运行模式与参数设置 */}
          <div className="rounded-xl border border-white/[0.08] bg-[#0c0e17]/80 p-4 shadow-sm backdrop-blur-md space-y-3.5">
            <div className="flex items-center justify-between border-b border-white/[0.06] pb-2.5">
              <div className="flex items-center gap-2 font-mono text-xs font-semibold text-zinc-200">
                <Activity className="size-3.5 text-emerald-400" />
                <span>调度与模式参数</span>
              </div>
            </div>

            {/* Mode Switcher */}
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] p-1 font-mono text-xs">
              <button
                type="button"
                onClick={() => setConfig({ ...config, mode: "smart" })}
                className={cn(
                  "flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md transition text-xs",
                  config.mode === "smart"
                    ? "bg-emerald-950/70 text-emerald-300 border border-emerald-500/30 font-medium"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
                )}
              >
                <Zap className="size-3.5" />
                智能补货模式
              </button>
              <button
                type="button"
                onClick={() => setConfig({ ...config, mode: "manual" })}
                className={cn(
                  "flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md transition text-xs",
                  config.mode === "manual"
                    ? "bg-cyan-950/70 text-cyan-300 border border-cyan-500/30 font-medium"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
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
                  className="h-8 rounded-lg border-white/[0.08] bg-black/40 text-xs font-mono text-zinc-200"
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
                  className="h-8 rounded-lg border-white/[0.08] bg-black/40 text-xs font-mono text-zinc-200"
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
                  className="h-8 rounded-lg border-white/[0.08] bg-black/40 text-xs font-mono text-zinc-200"
                />
                <span className="text-[10px] text-zinc-500 block leading-tight">
                  后台定时巡检号池；账号被限流或异常时也会即刻被动触发自动补货。
                </span>
              </div>
            )}
          </div>

          {/* 2. 邮箱接码源配置 */}
          <div className="rounded-xl border border-white/[0.08] bg-[#0c0e17]/80 p-4 shadow-sm backdrop-blur-md space-y-3.5">
            <div className="flex items-center justify-between border-b border-white/[0.06] pb-2.5">
              <div className="flex items-center gap-2 font-mono text-xs font-semibold text-zinc-200">
                <Inbox className="size-3.5 text-cyan-400" />
                <span>邮箱接码源设置</span>
              </div>
            </div>

            {/* Mail Provider Switcher */}
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] p-1 font-mono text-xs">
              <button
                type="button"
                onClick={() => setConfig({ ...config, mail_mode: "cf_worker" })}
                className={cn(
                  "py-1.5 px-2 rounded-md transition text-xs text-center",
                  config.mail_mode === "cf_worker"
                    ? "bg-emerald-950/70 text-emerald-300 border border-emerald-500/30 font-medium"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
                )}
              >
                ⚡ CF Worker
              </button>
              <button
                type="button"
                onClick={() => setConfig({ ...config, mail_mode: "duckmail" })}
                className={cn(
                  "py-1.5 px-2 rounded-md transition text-xs text-center",
                  config.mail_mode === "duckmail"
                    ? "bg-white/[0.08] text-white border border-white/[0.12] font-medium"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
                )}
              >
                DuckMail 临时
              </button>
              <button
                type="button"
                onClick={() => setConfig({ ...config, mail_mode: "imap" })}
                className={cn(
                  "py-1.5 px-2 rounded-md transition text-xs text-center",
                  config.mail_mode === "imap"
                    ? "bg-white/[0.08] text-white border border-white/[0.12] font-medium"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
                )}
              >
                IMAP 收信
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
                    className="h-8 rounded-lg border-white/[0.08] bg-black/40 text-xs font-mono text-zinc-200"
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
                      className="h-8 rounded-lg border-white/[0.08] bg-black/40 text-xs font-mono text-zinc-200"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[11px] text-zinc-400">备选免穿透 Topic (ntfy.sh)</Label>
                    <Input
                      value={config.cf_worker_ntfy_topic || ""}
                      onChange={(e) => setConfig({ ...config, cf_worker_ntfy_topic: e.target.value })}
                      placeholder="如 cf-otp-secret-9988 (可选)"
                      className="h-8 rounded-lg border-white/[0.08] bg-black/40 text-xs font-mono text-zinc-200"
                    />
                  </div>
                </div>
                <div className="space-y-1 rounded-lg border border-emerald-500/20 bg-emerald-950/20 p-2.5 text-[11px] font-mono">
                  <div className="font-semibold text-emerald-400">⚡ 0 存储、0 轮询极致秒推</div>
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
                    className="h-8 rounded-lg border-white/[0.08] bg-black/40 text-xs font-mono text-zinc-200"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] text-zinc-400">邮箱后缀域名</Label>
                  <Input
                    value={config.duckmail_domain}
                    onChange={(e) => setConfig({ ...config, duckmail_domain: e.target.value })}
                    placeholder="duckmail.com"
                    className="h-8 rounded-lg border-white/[0.08] bg-black/40 text-xs font-mono text-zinc-200"
                  />
                </div>
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-950/20 p-2.5 text-[11px] text-emerald-400/90 font-mono">
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
                      className="h-8 rounded-lg border-white/[0.08] bg-black/40 text-xs font-mono text-zinc-200"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[11px] text-zinc-400">端口</Label>
                    <Input
                      type="number"
                      value={config.imap_port}
                      onChange={(e) => setConfig({ ...config, imap_port: parseInt(e.target.value) || 993 })}
                      className="h-8 rounded-lg border-white/[0.08] bg-black/40 text-xs font-mono text-zinc-200"
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
                      className="h-8 rounded-lg border-white/[0.08] bg-black/40 text-xs font-mono text-zinc-200"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[11px] text-zinc-400">密码 / 授权码</Label>
                    <Input
                      type="password"
                      value={config.imap_password}
                      onChange={(e) => setConfig({ ...config, imap_password: e.target.value })}
                      placeholder="••••••••"
                      className="h-8 rounded-lg border-white/[0.08] bg-black/40 text-xs font-mono text-zinc-200"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] text-zinc-400">发信捕获域名池 (逗号隔开)</Label>
                  <Input
                    value={config.imap_domains}
                    onChange={(e) => setConfig({ ...config, imap_domains: e.target.value })}
                    placeholder="mydomain1.com, mydomain2.com"
                    className="h-8 rounded-lg border-white/[0.08] bg-black/40 text-xs font-mono text-zinc-200"
                  />
                </div>
                <div className="rounded-lg border border-cyan-500/20 bg-cyan-950/20 p-2.5 text-[11px] text-cyan-400/90 font-mono">
                  💡 适用于 Cloudflare Email Routing Catch-All 转发至专属收件箱大批量造号。
                </div>
              </div>
            )}
          </div>

          {/* 3. 代理池管理 */}
          <div className="rounded-xl border border-white/[0.08] bg-[#0c0e17]/80 p-4 shadow-sm backdrop-blur-md space-y-3.5">
            <div className="flex items-center justify-between border-b border-white/[0.06] pb-2.5">
              <div className="flex items-center gap-2 font-mono text-xs font-semibold text-zinc-200">
                <Globe className="size-3.5 text-cyan-400" />
                <span>代理池网络管理</span>
              </div>
              {(status?.proxy_stats?.total ?? 0) === 0 ? (
                <span className="text-[11px] font-mono text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                  0 个节点 (直连模式)
                </span>
              ) : (
                <span className="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  {status?.proxy_stats?.healthy ?? 0}/{status?.proxy_stats?.total} 个可用节点
                </span>
              )}
            </div>

            <div className="space-y-2 font-mono">
              <div className="flex items-center justify-between">
                <Label className="text-[11px] text-zinc-400">多行代理列表 (每次注册任务自动轮换)</Label>
                <button
                  type="button"
                  onClick={() => {
                    const current = config.proxies_text.trim();
                    if (!current.includes("127.0.0.1:7890")) {
                      const next = current ? `${current}\nhttp://127.0.0.1:7890` : "http://127.0.0.1:7890";
                      setConfig({ ...config, proxies_text: next });
                      toast.info("已填入本机 Clash 代理 (127.0.0.1:7890)");
                    }
                  }}
                  className="text-[10px] text-zinc-400 hover:text-emerald-400 transition-colors cursor-pointer"
                >
                  + 填入本机 127.0.0.1:7890
                </button>
              </div>
              <Textarea
                rows={4}
                value={config.proxies_text}
                onChange={(e) => setConfig({ ...config, proxies_text: e.target.value })}
                placeholder={"# 每行填写一个代理节点 (支持 HTTP/SOCKS5)，例如：\n# http://127.0.0.1:7890\n# socks5://127.0.0.1:1080\n# http://username:password@ip:port"}
                className="rounded-lg border-white/[0.08] bg-black/40 text-xs font-mono text-zinc-200 resize-y"
              />
              <span className="text-[10px] text-zinc-500 block leading-tight">
                支持 http:// 与 socks5://；如为空则使用服务器网络直连（海外 VPS 直连可用，国内环境建议配置代理）。
              </span>
            </div>

            {/* Quick Proxy Test */}
            <div className="pt-2 border-t border-white/[0.06] space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  value={testProxyInput}
                  onChange={(e) => setTestProxyInput(e.target.value)}
                  placeholder="输入代理节点测试连接..."
                  className="h-8 rounded-lg border-white/[0.08] bg-black/40 text-xs font-mono text-zinc-200"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleTestProxy}
                  disabled={testingProxy}
                  className="h-8 rounded-lg border-white/[0.08] bg-white/[0.03] px-2.5 font-mono text-xs text-zinc-300 hover:bg-white/[0.08] hover:text-white"
                >
                  {testingProxy ? (
                    <LoaderCircle className="size-3.5 animate-spin mr-1" />
                  ) : (
                    <RefreshCw className="size-3.5 mr-1" />
                  )}
                  测试
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* 右侧终端日志 (7 列，与系统终端 logs 页面风格完全同步) */}
        <div className="lg:col-span-7">
          <div className="flex h-[760px] flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#07080c] shadow-2xl backdrop-blur-md">
            {/* 1. Terminal Titlebar */}
            <div className="flex shrink-0 items-center justify-between border-b border-white/[0.08] bg-[#0c0e16] px-3.5 py-2">
              {/* 左侧控制按钮与标题 */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-[#ff5f56]/90 transition hover:opacity-80" />
                  <span className="size-2.5 rounded-full bg-[#ffbd2e]/90 transition hover:opacity-80" />
                  <span className="size-2.5 rounded-full bg-[#27c93f]/90 transition hover:opacity-80" />
                </div>
                <div className="h-3.5 w-px bg-white/[0.1]" />
                <div className="flex items-center gap-2 font-mono text-xs text-zinc-300">
                  <Terminal className="size-3.5 text-emerald-400" />
                  <span className="font-semibold text-zinc-100">register</span>
                  <span className="text-zinc-600">:</span>
                  <span className="text-cyan-400">~/stream.log</span>
                  <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-mono text-emerald-400 border border-emerald-500/20">
                    LIVE STREAM
                  </span>
                </div>
              </div>

              {/* 右侧动作控制 */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setAutoScroll(!autoScroll)}
                  className={cn(
                    "flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[11px] transition-colors",
                    autoScroll
                      ? "bg-cyan-950/80 text-cyan-300 border border-cyan-500/30"
                      : "bg-white/[0.04] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.08]"
                  )}
                  title="有新日志时自动滚屏至最新"
                >
                  <CornerDownRight className="size-3" />
                  <span className="hidden sm:inline">滚屏: {autoScroll ? "开" : "关"}</span>
                </button>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCopyLogs}
                  className="h-7 rounded-lg border-white/[0.08] bg-white/[0.03] px-2 font-mono text-xs text-zinc-300 hover:bg-white/[0.08] hover:text-white"
                  title="复制全部终端日志"
                >
                  {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleClearLogs}
                  className="h-7 rounded-lg border-white/[0.08] bg-white/[0.03] px-2 font-mono text-xs text-zinc-400 hover:border-rose-500/30 hover:bg-rose-950/30 hover:text-rose-300"
                  title="清空当前日志终端"
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            </div>

            {/* 2. Terminal Screen */}
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

            {/* 3. Terminal Footer */}
            <div className="flex shrink-0 items-center justify-between border-t border-white/[0.08] bg-[#0c0e16] px-3.5 py-1.5 font-mono text-[10.5px] text-zinc-500">
              <span>Total Logs: {logs.length} lines</span>
              <span>Python 3.12 · curl_cffi Chrome · Sentinel PoW</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
