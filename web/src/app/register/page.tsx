"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Globe,
  Mail,
  Play,
  RefreshCw,
  Save,
  Sliders,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  const circumference = 2 * Math.PI * radius;
  const activeStroke = Math.min(circumference, (active / safeTarget) * circumference);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative flex size-32 shrink-0 items-center justify-center">
        <svg className="size-full -rotate-90" viewBox="0 0 120 120">
          <circle
            cx="60"
            cy="60"
            r={radius}
            fill="none"
            stroke="rgba(255, 255, 255, 0.05)"
            strokeWidth={strokeWidth}
          />
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
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-xl font-bold tracking-tight text-foreground">
            {healthPercent}%
          </span>
          <span className="text-[10px] text-muted-foreground">
            号池达成
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-emerald-400" />
          <span>可用 {active}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-cyan-400" />
          <span>目标 {target}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className={cn("size-1.5 rounded-full", deficit > 0 ? "bg-amber-400" : "bg-muted-foreground")} />
          <span>缺口 {deficit}</span>
        </span>
      </div>
    </div>
  );
}

function mergeAndSortLogs(
  existing: RegisterLogItem[],
  incoming: RegisterLogItem[]
): RegisterLogItem[] {
  const map = new Map<string, RegisterLogItem>();
  for (const item of existing) {
    const key = `${item.timestamp || 0}_${item.time || ""}_${item.text}`;
    map.set(key, item);
  }
  for (const item of incoming) {
    const key = `${item.timestamp || 0}_${item.time || ""}_${item.text}`;
    map.set(key, item);
  }
  const all = Array.from(map.values());
  all.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return all.length > 500 ? all.slice(-500) : all;
}

export default function RegisterPage() {
  const { session, isPending: isAuthPending } = useAuthGuard();

  const [status, setStatus] = useState<RegisterStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [showGmailPassword, setShowGmailPassword] = useState(false);
  const [showImapPassword, setShowImapPassword] = useState(false);

  const [config, setConfig] = useState<RegisterConfig>({
    mode: "smart",
    target_count: 20,
    concurrency: 2,
    check_interval_seconds: 60,
    mail_mode: "gmail",
    domains: "",
    gmail_address: "",
    gmail_app_password: "",
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
  const [testProxyResult, setTestProxyResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const terminalRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);
  const actionLoadingRef = useRef(false);
  actionLoadingRef.current = actionLoading;
  const initialLoadedRef = useRef(false);
  const pollReqIdRef = useRef(0);

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

  const loadLogs = async () => {
    try {
      const res = await fetchRegisterLogs(300);
      const fetched = res.logs || [];
      setLogs((prev) => mergeAndSortLogs(prev, fetched));
    } catch (e) {
      console.error("Failed to load register logs:", e);
    }
  };

  useEffect(() => {
    if (isAuthPending || !session) return;
    void loadStatus(true);
    void loadLogs();

    const interval = setInterval(() => {
      if (!actionLoadingRef.current) {
        void loadStatus(false);
      }
    }, 3000);

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
          setLogs((prev) => mergeAndSortLogs(prev, [newEntry]));
        } catch {
          // ignore heartbeats/comments
        }
      };

      evtSource.onerror = () => {
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

    try {
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
    const candidate = testProxyInput.trim() || config.proxies_text.split("\n")[0]?.trim();
    if (!candidate) {
      toast.error("请先输入或配置代理地址");
      return;
    }
    setTestingProxy(true);
    setTestProxyResult(null);
    try {
      const res = await testRegisterProxy(candidate);
      setTestProxyResult({
        ok: res.ok,
        message: res.ok ? `连通正常 (${res.latency_ms}ms)` : `连接失败: ${res.error || "超时"}`,
      });
      if (res.ok) {
        toast.success(`代理节点可用 (${res.latency_ms}ms)`);
      } else {
        toast.error(`代理连接失败: ${res.error || "超时"}`);
      }
    } catch (e: any) {
      setTestProxyResult({ ok: false, message: e.message || "测试出错" });
      toast.error(e.message || "代理测试出错");
    } finally {
      setTestingProxy(false);
    }
  };

  const metricCards = useMemo(() => {
    const stats = status?.stats;
    return [
      {
        label: "累计尝试",
        value: stats?.total_attempts ?? 0,
        color: "text-foreground",
        dot: "bg-muted-foreground",
      },
      {
        label: "成功入库",
        value: stats?.success ?? 0,
        color: "text-emerald-400",
        dot: "bg-emerald-400",
      },
      {
        label: "注册失败",
        value: stats?.failed ?? 0,
        color: (stats?.failed ?? 0) > 0 ? "text-rose-400" : "text-muted-foreground",
        dot: "bg-rose-400",
      },
      {
        label: "403 拦截",
        value: stats?.is_403 ?? 0,
        color: (stats?.is_403 ?? 0) > 0 ? "text-amber-400" : "text-muted-foreground",
        dot: "bg-amber-400",
      },
      {
        label: "活跃线程",
        value: `${status?.active_workers ?? 0} / ${config.concurrency}`,
        color: "text-foreground",
        dot: "bg-cyan-400",
      },
    ];
  }, [status, config.concurrency]);

  return (
    <div className="space-y-3 font-sans">
      {/* 顶部标题与主要操作 */}
      <section className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">账号注册机</h1>
          {status?.is_running ? (
            <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-950/70 px-2 py-0.5 text-[11px] text-emerald-400">
              <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
              运行中 ({status.mode === "smart" ? "智能补货" : "批量模式"})
            </span>
          ) : (
            <span className="flex items-center gap-1.5 rounded-full border border-border bg-foreground/[0.04] px-2 py-0.5 text-[11px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-muted-foreground" />
              待机中
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-lg border-border bg-foreground/[0.03] px-2.5 text-xs text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
            onClick={() => void loadStatus(true)}
            disabled={loading || actionLoading}
          >
            <RefreshCw className={cn("size-3.5", loading ? "animate-spin" : "")} />
            刷新
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-lg border-border bg-foreground/[0.03] px-2.5 text-xs text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
            onClick={handleSaveConfig}
            disabled={actionLoading}
          >
            <Save className="size-3.5" />
            保存配置
          </Button>
          {status?.is_running ? (
            <Button
              variant="destructive"
              size="sm"
              className="h-8 rounded-lg px-3 text-xs"
              onClick={handleStop}
              disabled={actionLoading}
            >
              <Square className="size-3.5 fill-current" />
              停止运行
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                className="h-8 rounded-lg px-3 text-xs"
                onClick={() => void handleStart("smart")}
                disabled={actionLoading}
              >
                <Play className="size-3.5 fill-current" />
                启动智能模式
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-lg border-border bg-foreground/[0.03] px-3 text-xs text-foreground hover:bg-foreground/[0.08]"
                onClick={() => void handleStart("manual")}
                disabled={actionLoading}
              >
                <Play className="size-3.5" />
                启动批量模式
              </Button>
            </>
          )}
        </div>
      </section>

      {/* 运行指标概览卡片 */}
      <section className="flex flex-col items-center gap-6 rounded-xl border border-border bg-card p-4 shadow-sm md:flex-row md:items-center">
        <div className="flex shrink-0 flex-col items-center">
          <RegisterHealthDonutRing
            active={status?.pool_health?.active ?? 0}
            target={config.target_count || 20}
          />
        </div>

        <div className="hidden h-28 w-px bg-foreground/[0.08] md:block" />

        <div className="grid w-full flex-1 grid-cols-2 gap-2 sm:grid-cols-5">
          {metricCards.map((item) => (
            <div
              key={item.label}
              className="flex flex-col justify-between rounded-lg border border-border bg-foreground/[0.02] p-2.5 transition hover:border-border"
            >
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-[11px]">{item.label}</span>
                <span className={cn("size-1.5 rounded-full", item.dot)} />
              </div>
              <div className={cn("mt-1 text-lg font-bold tracking-tight", item.color)}>
                {item.value}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 核心配置与日志控制台 */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        {/* 左侧配置栏 (5 列) */}
        <div className="space-y-3 lg:col-span-5">
          {/* 调度参数 */}
          <Card>
            <CardHeader className="py-3 px-4">
              <div className="flex items-center gap-2">
                <Sliders className="size-4 text-muted-foreground" />
                <CardTitle>调度参数</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 px-4 pb-4">
              <div className="space-y-1.5">
                <Label className="text-xs">运行模式</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={config.mode === "smart" ? "default" : "outline"}
                    className="h-8 text-xs"
                    onClick={() => setConfig((prev) => ({ ...prev, mode: "smart" }))}
                  >
                    智能补货模式
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={config.mode === "manual" ? "default" : "outline"}
                    className="h-8 text-xs"
                    onClick={() => setConfig((prev) => ({ ...prev, mode: "manual" }))}
                  >
                    常规批量模式
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="target_count" className="text-xs">目标数量</Label>
                  <Input
                    id="target_count"
                    type="number"
                    min={1}
                    max={1000}
                    className="h-8 text-xs"
                    value={config.target_count}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        target_count: Math.max(1, parseInt(e.target.value) || 1),
                      }))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="concurrency" className="text-xs">并发线程数</Label>
                  <Input
                    id="concurrency"
                    type="number"
                    min={1}
                    max={10}
                    className="h-8 text-xs"
                    value={config.concurrency}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        concurrency: Math.max(1, Math.min(10, parseInt(e.target.value) || 1)),
                      }))
                    }
                  />
                </div>
              </div>

              {config.mode === "smart" && (
                <div className="space-y-1.5">
                  <Label htmlFor="check_interval" className="text-xs">巡检间隔 (秒)</Label>
                  <Input
                    id="check_interval"
                    type="number"
                    min={10}
                    max={3600}
                    className="h-8 text-xs"
                    value={config.check_interval_seconds}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        check_interval_seconds: Math.max(10, parseInt(e.target.value) || 60),
                      }))
                    }
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* 邮箱接码设置 */}
          <Card>
            <CardHeader className="py-3 px-4">
              <div className="flex items-center gap-2">
                <Mail className="size-4 text-muted-foreground" />
                <CardTitle>邮箱接码设置</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 px-4 pb-4">
              <Tabs
                value={config.mail_mode}
                onValueChange={(val) =>
                  setConfig((prev) => ({ ...prev, mail_mode: val as "gmail" | "imap" }))
                }
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="gmail" className="text-xs">Gmail 应用密码</TabsTrigger>
                  <TabsTrigger value="imap" className="text-xs">自建 IMAP</TabsTrigger>
                </TabsList>

                <TabsContent value="gmail" className="mt-3 space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="gmail_domains" className="text-xs">托管域名列表</Label>
                    <Input
                      id="gmail_domains"
                      placeholder="nomorera2.de, domain.com"
                      className="h-8 text-xs"
                      value={config.domains}
                      onChange={(e) => setConfig((prev) => ({ ...prev, domains: e.target.value }))}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="gmail_address" className="text-xs">Gmail 账号</Label>
                    <Input
                      id="gmail_address"
                      type="email"
                      placeholder="username@gmail.com"
                      className="h-8 text-xs"
                      value={config.gmail_address || ""}
                      onChange={(e) =>
                        setConfig((prev) => ({ ...prev, gmail_address: e.target.value }))
                      }
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="gmail_app_password" className="text-xs">应用专用密码</Label>
                    <div className="relative">
                      <Input
                        id="gmail_app_password"
                        type={showGmailPassword ? "text" : "password"}
                        placeholder="16 位应用密码"
                        className="h-8 pr-8 text-xs font-mono"
                        value={config.gmail_app_password || ""}
                        onChange={(e) =>
                          setConfig((prev) => ({ ...prev, gmail_app_password: e.target.value }))
                        }
                      />
                      <button
                        type="button"
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowGmailPassword((prev) => !prev)}
                      >
                        {showGmailPassword ? (
                          <EyeOff className="size-3.5" />
                        ) : (
                          <Eye className="size-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="imap" className="mt-3 space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="imap_domains" className="text-xs">托管域名列表</Label>
                    <Input
                      id="imap_domains"
                      placeholder="example.com"
                      className="h-8 text-xs"
                      value={config.imap_domains}
                      onChange={(e) =>
                        setConfig((prev) => ({ ...prev, imap_domains: e.target.value }))
                      }
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2 space-y-1.5">
                      <Label htmlFor="imap_host" className="text-xs">IMAP 主机</Label>
                      <Input
                        id="imap_host"
                        placeholder="imap.example.com"
                        className="h-8 text-xs"
                        value={config.imap_host}
                        onChange={(e) =>
                          setConfig((prev) => ({ ...prev, imap_host: e.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="imap_port" className="text-xs">端口</Label>
                      <Input
                        id="imap_port"
                        type="number"
                        placeholder="993"
                        className="h-8 text-xs"
                        value={config.imap_port}
                        onChange={(e) =>
                          setConfig((prev) => ({
                            ...prev,
                            imap_port: parseInt(e.target.value) || 993,
                          }))
                        }
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="imap_username" className="text-xs">用户名</Label>
                      <Input
                        id="imap_username"
                        placeholder="user@example.com"
                        className="h-8 text-xs"
                        value={config.imap_username}
                        onChange={(e) =>
                          setConfig((prev) => ({ ...prev, imap_username: e.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="imap_password" className="text-xs">密码</Label>
                      <div className="relative">
                        <Input
                          id="imap_password"
                          type={showImapPassword ? "text" : "password"}
                          placeholder="******"
                          className="h-8 pr-8 text-xs"
                          value={config.imap_password}
                          onChange={(e) =>
                            setConfig((prev) => ({ ...prev, imap_password: e.target.value }))
                          }
                        />
                        <button
                          type="button"
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          onClick={() => setShowImapPassword((prev) => !prev)}
                        >
                          {showImapPassword ? (
                            <EyeOff className="size-3.5" />
                          ) : (
                            <Eye className="size-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>

          {/* 代理网络配置 */}
          <Card>
            <CardHeader className="py-3 px-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Globe className="size-4 text-muted-foreground" />
                  <CardTitle>代理网络</CardTitle>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={handleTestProxy}
                  disabled={testingProxy}
                >
                  <RefreshCw className={cn("size-3 mr-1", testingProxy ? "animate-spin" : "")} />
                  测试节点
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2.5 px-4 pb-4">
              <Textarea
                rows={4}
                placeholder="http://127.0.0.1:7890&#10;socks5://user:pass@1.2.3.4:1080"
                className="font-mono text-xs leading-relaxed"
                value={config.proxies_text}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, proxies_text: e.target.value }))
                }
              />
              <div className="flex items-center gap-2">
                <Input
                  placeholder="测试指定节点 (空则测试首行)"
                  className="h-7 text-xs font-mono"
                  value={testProxyInput}
                  onChange={(e) => setTestProxyInput(e.target.value)}
                />
              </div>
              {testProxyResult && (
                <div
                  className={cn(
                    "rounded border px-2.5 py-1 text-xs",
                    testProxyResult.ok
                      ? "border-emerald-500/30 bg-emerald-950/40 text-emerald-400"
                      : "border-rose-500/30 bg-rose-950/40 text-rose-400"
                  )}
                >
                  {testProxyResult.message}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* 右侧日志终端 (7 列) */}
        <div className="flex flex-col lg:col-span-7">
          <Card className="flex flex-1 flex-col overflow-hidden">
            <CardHeader className="py-3 px-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Terminal className="size-4 text-muted-foreground" />
                  <CardTitle>运行日志</CardTitle>
                  <span className="rounded border border-border bg-foreground/[0.04] px-1.5 py-0.2 text-[10px] text-muted-foreground">
                    {logs.length} 条
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => setAutoScroll((prev) => !prev)}
                  >
                    滚屏: {autoScroll ? "开" : "关"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={handleCopyLogs}
                    disabled={logs.length === 0}
                  >
                    {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
                    复制
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={handleClearLogs}
                    disabled={logs.length === 0}
                  >
                    <Trash2 className="size-3" />
                    清空
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col p-4 pt-0">
              <div
                ref={terminalRef}
                className="h-[580px] w-full overflow-y-auto rounded-lg border border-border bg-foreground/[0.02] p-3 font-mono text-xs leading-relaxed space-y-1"
              >
                {logs.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
                    暂无运行日志
                  </div>
                ) : (
                  logs.map((log, index) => {
                    const text = log.text;
                    const isError =
                      text.includes("[ERROR]") ||
                      text.includes("[FAIL]") ||
                      text.includes("超时") ||
                      text.includes("失败");
                    const isSuccess =
                      text.includes("[SUCCESS]") ||
                      text.includes("[OK]") ||
                      text.includes("成功") ||
                      text.includes("入库");
                    const isWarning =
                      text.includes("[WARN]") ||
                      text.includes("拦截") ||
                      text.includes("403");
                    const isMail =
                      text.includes("[Gmail]") ||
                      text.includes("[IMAP]") ||
                      text.includes("验证码");

                    let colorClass = "text-muted-foreground";
                    if (isError) colorClass = "text-rose-400";
                    else if (isSuccess) colorClass = "text-emerald-400";
                    else if (isWarning) colorClass = "text-amber-400";
                    else if (isMail) colorClass = "text-cyan-400";

                    return (
                      <div
                        key={`${log.timestamp || 0}_${index}`}
                        className="break-all whitespace-pre-wrap"
                      >
                        <span className="select-none text-zinc-500 mr-2">
                          [{log.time}]
                        </span>
                        <span className={colorClass}>{text}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
