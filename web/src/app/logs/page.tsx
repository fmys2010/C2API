"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Check,
  CornerDownRight,
  ExternalLink,
  ImageIcon,
  LoaderCircle,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { deleteSystemLogs, fetchSystemLogs, type SystemLog } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { usePersistentState } from "@/lib/use-persistent-state";
import { cn } from "@/lib/utils";

const LogType = {
  All: "",
  Call: "call",
  Account: "account",
} as const;

function getStatus(item: SystemLog | null | undefined): "success" | "failed" | "unknown" {
  if (!item || !item.detail) return "unknown";
  const status = item.detail.status;
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  if (item.detail.error) return "failed";
  return "unknown";
}

function getDuration(item: SystemLog | null | undefined): string {
  if (!item || !item.detail) return "";
  const value = item.detail.duration_ms;
  if (typeof value === "number") {
    return `${(value / 1000).toFixed(2)}s`;
  }
  return "";
}

function getUrls(item: SystemLog | null | undefined): string[] {
  const urls = item?.detail?.urls;
  return Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string") : [];
}

function TerminalLogsContent() {
  const [items, setItems] = useState<SystemLog[]>([]);
  const [filterType, setFilterType] = usePersistentState<string>("logs.filterType", LogType.All);
  const [searchQuery, setSearchQuery] = useState("");
  const [autoScroll, setAutoScroll] = usePersistentState("logs.autoScroll", true);
  const [autoRefresh, setAutoRefresh] = usePersistentState("logs.autoRefresh", false);
  const [isLoading, setIsLoading] = useState(true);
  const [detailLog, setDetailLog] = useState<SystemLog | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isCopiedAll, setIsCopiedAll] = useState(false);

  // 删除对话框
  const [deletingLogs, setDeletingLogs] = useState<SystemLog[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);

  // 图片预览
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  const terminalViewportRef = useRef<HTMLDivElement>(null);
  const logsRequestRef = useRef(0);

  const loadLogs = async (silent = false) => {
    const requestId = ++logsRequestRef.current;
    if (!silent) setIsLoading(true);
    try {
      const data = await fetchSystemLogs({
        type: filterType || undefined,
        limit: 300,
      });
      // Drop responses overtaken by a newer request, a filter change or a delete.
      if (requestId !== logsRequestRef.current) return;
      setItems(data.items || []);
    } catch (error) {
      if (!silent) {
        toast.error(error instanceof Error ? error.message : "获取系统日志失败");
      }
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadLogs();
  }, [filterType]);

  // 自动刷新定时器
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      void loadLogs(true);
    }, 4000);
    return () => clearInterval(timer);
  }, [autoRefresh, filterType]);

  // 自动滚屏到底部
  useEffect(() => {
    if (autoScroll && terminalViewportRef.current) {
      terminalViewportRef.current.scrollTop = terminalViewportRef.current.scrollHeight;
    }
  }, [items, autoScroll]);

  const filteredItems = useMemo(() => {
    let result = items;
    if (filterType) {
      result = result.filter((item) => item.type === filterType);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter((item) => {
        const text = `${item.time} ${item.type} ${item.summary || ""} ${item.detail?.endpoint || ""} ${item.detail?.model || ""} ${item.detail?.key_name || ""} ${item.detail?.error || ""} ${JSON.stringify(item.detail || {})}`.toLowerCase();
        return text.includes(q);
      });
    }
    return result;
  }, [items, filterType, searchQuery]);

  const stats = useMemo(() => {
    let successCount = 0;
    let failCount = 0;
    let callCount = 0;
    let accountCount = 0;
    for (const item of items) {
      if (item.type === "call") callCount++;
      if (item.type === "account") accountCount++;
      const st = getStatus(item);
      if (st === "success") successCount++;
      if (st === "failed") failCount++;
    }
    return {
      total: items.length,
      successCount,
      failCount,
      callCount,
      accountCount,
    };
  }, [items]);

  const handleCopyRaw = (item: SystemLog) => {
    navigator.clipboard.writeText(JSON.stringify(item, null, 2));
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(null), 1500);
    toast.success("已复制该条日志 JSON");
  };

  const handleCopyAll = () => {
    const text = filteredItems.map((item) => `[${item.time}] [${item.type.toUpperCase()}] ${item.summary || ""} | ${JSON.stringify(item.detail || {})}`).join("\n");
    navigator.clipboard.writeText(text);
    setIsCopiedAll(true);
    setTimeout(() => setIsCopiedAll(false), 1500);
    toast.success(`已复制 ${filteredItems.length} 条终端日志文本`);
  };

  const confirmDelete = async () => {
    if (!deletingLogs.length) return;
    setIsDeleting(true);
    try {
      const ids = deletingLogs.map((item) => item.id);
      await deleteSystemLogs(ids);
      logsRequestRef.current += 1;
      toast.success(`成功删除 ${ids.length} 条日志`);
      setItems((prev) => prev.filter((item) => !ids.includes(item.id)));
      if (detailLog && ids.includes(detailLog.id)) {
        setDetailLog(null);
      }
      setDeletingLogs([]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除日志失败");
    } finally {
      setIsDeleting(false);
    }
  };

  const detailUrls = getUrls(detailLog);
  const detailImages = detailUrls.map((url, index) => ({ id: `${index}`, src: url }));

  return (
    <section className="mx-auto flex h-[calc(100dvh-var(--shell-offset))] w-full flex-col">
      {/* 日志面板 */}
      <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-inset shadow-sm ">
        {/* 1. Terminal Titlebar */}
        <div className="flex shrink-0 items-center justify-between border-b border-border bg-card px-3.5 py-2">
          <div className="flex items-baseline gap-2">
            <h1 className="font-sans text-xl font-semibold tracking-tight text-foreground">系统日志</h1>
            <span className="font-sans text-xs text-subtle">最新 300 条</span>
          </div>

          {/* 右侧动作控制 */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] transition-colors",
                autoRefresh
                  ? "bg-emerald-950/80 text-emerald-300 border border-emerald-500/30"
                  : "bg-foreground/[0.04] text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08]"
              )}
              title="每4秒自动抓取最新日志"
            >
              <span className={cn("size-1.5 rounded-full", autoRefresh ? "animate-pulse bg-emerald-400" : "bg-zinc-600")} />
              <span className="hidden sm:inline">自动刷新</span>
            </button>

            <button
              type="button"
              onClick={() => setAutoScroll(!autoScroll)}
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[11px] transition-colors",
                autoScroll
                  ? "bg-cyan-950/80 text-cyan-300 border border-cyan-500/30"
                  : "bg-foreground/[0.04] text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08]"
              )}
              title="有新日志时自动滚屏至最新"
            >
              <CornerDownRight className="size-3" />
              <span className="hidden sm:inline">自动滚屏</span>
            </button>

            <button
              type="button"
              onClick={handleCopyAll}
              className="flex items-center gap-1 rounded-md bg-foreground/[0.04] px-2 py-1 font-mono text-[11px] text-muted-foreground transition hover:bg-foreground/[0.08]"
              title="复制当前过滤的全部日志"
            >
              {isCopiedAll ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
              <span className="hidden sm:inline">复制</span>
            </button>

            <button
              type="button"
              onClick={() => void loadLogs()}
              disabled={isLoading}
              className="flex items-center gap-1 rounded-md bg-foreground/[0.04] px-2 py-1 font-mono text-[11px] text-muted-foreground transition hover:bg-foreground/[0.08] disabled:opacity-50"
              title="立即刷新"
            >
              <RefreshCw className={cn("size-3", isLoading && "animate-spin text-cyan-400")} />
              <span className="hidden sm:inline">刷新</span>
            </button>

            {items.length > 0 ? (
              <button
                type="button"
                onClick={() => setDeletingLogs(items)}
                className="flex items-center gap-1 rounded-md bg-rose-950/40 px-2 py-1 font-mono text-[11px] text-rose-300 border border-rose-500/25 transition hover:bg-rose-900/50"
                title="清空当前所有日志"
              >
                <Trash2 className="size-3" />
                <span className="hidden sm:inline">清空</span>
              </button>
            ) : null}
          </div>
        </div>

        {/* 2. Terminal Toolbar */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-inset px-3.5 py-1.5 font-mono text-xs">
          {/* 类型过滤标签 */}
          <div className="flex items-center gap-1">
            <span className="mr-1 hidden font-mono text-[11px] text-subtle sm:inline">筛选</span>
            {[
              { key: LogType.All, label: "全部" },
              { key: LogType.Call, label: "调用" },
              { key: LogType.Account, label: "账号" },
            ].map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setFilterType(tab.key)}
                className={cn(
                  "rounded px-2 py-0.5 font-mono text-[11px] transition",
                  filterType === tab.key
                    ? "bg-foreground/[0.1] font-semibold text-foreground border border-border"
                    : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* 搜索框与统计 */}
          <div className="flex flex-1 sm:flex-initial items-center gap-2.5 justify-end">
            <div className="relative flex items-center w-full sm:w-60">
              <Search className="pointer-events-none absolute left-2 size-3 text-subtle" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="grep 搜索日志..."
                className="w-full rounded border border-border bg-inset py-0.5 pl-7 pr-6 font-mono text-[11px] text-foreground placeholder-subtle outline-none transition focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/30"
              />
              {searchQuery ? (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-1.5 text-subtle hover:text-muted-foreground"
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </div>

            <div className="hidden lg:flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
              <span className="text-emerald-400 font-semibold">✓ {stats.successCount}</span>
              <span className="text-rose-400 font-semibold">✗ {stats.failCount}</span>
              <span className="text-subtle">|</span>
              <span className="text-cyan-400">{filteredItems.length}/{stats.total}</span>
            </div>
          </div>
        </div>

        {/* 3. Terminal Body */}
        <div
          ref={terminalViewportRef}
          className="flex-1 overflow-y-auto p-2.5 font-mono text-[11.5px] leading-5 text-muted-foreground selection:bg-cyan-900 selection:text-cyan-100"
        >
          {isLoading && items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-subtle font-mono text-xs">
              <LoaderCircle className="size-5 animate-spin text-cyan-400" />
              <span>正在加载日志…</span>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-subtle font-mono text-xs">
              <Terminal className="size-7 text-subtle" />
              <span>没有匹配的日志</span>
              {searchQuery ? (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="text-xs text-cyan-400 hover:underline"
                >
                  清除搜索条件
                </button>
              ) : null}
            </div>
          ) : (
            <div className="space-y-0.5">
              {filteredItems.map((item, index) => {
                const status = getStatus(item);
                const duration = getDuration(item);
                const endpoint = item.detail?.endpoint || "";
                const model = item.detail?.model || "";
                const keyName = item.detail?.key_name || item.detail?.role || "";
                const error = item.detail?.error || "";
                const isSelected = detailLog?.id === item.id;

                return (
                  <div
                    key={item.id}
                    onClick={() => setDetailLog(item)}
                    className={cn(
                      "group flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded px-1.5 py-0.5 transition-colors cursor-pointer font-mono",
                      isSelected
                        ? "bg-cyan-950/40 ring-1 ring-cyan-500/40 text-white"
                        : "hover:bg-foreground/[0.04]"
                    )}
                  >
                    {/* 行号 */}
                    <span className="w-7 shrink-0 text-right text-[10px] text-subtle select-none">
                      {index + 1}
                    </span>

                    {/* 时间戳 */}
                    <span className="text-subtle select-none text-[11px]">{item.time}</span>

                    {/* 类型 Tag */}
                    <span
                      className={cn(
                        "rounded px-1 text-[10px] font-semibold uppercase",
                        item.type === "call" ? "bg-cyan-950/70 text-cyan-300 border border-cyan-500/20" : "bg-purple-950/70 text-purple-300 border border-purple-500/20"
                      )}
                    >
                      {item.type}
                    </span>

                    {/* 端点 / 类别 */}
                    {endpoint ? (
                      <span className="font-semibold text-sky-400">{endpoint}</span>
                    ) : null}

                    {/* 状态 */}
                    {status === "success" ? (
                      <span className="flex items-center gap-0.5 text-emerald-400 font-semibold text-[11px]">
                        <CheckCircle2 className="size-2.5" />
                        <span>成功</span>
                      </span>
                    ) : status === "failed" ? (
                      <span className="flex items-center gap-0.5 text-rose-400 font-semibold text-[11px]">
                        <AlertCircle className="size-2.5" />
                        <span>失败</span>
                      </span>
                    ) : null}

                    {/* 耗时 */}
                    {duration ? (
                      <span className="text-amber-400/90 text-[10px]">({duration})</span>
                    ) : null}

                    {/* 模型 */}
                    {model ? (
                      <span className="rounded bg-foreground/[0.06] px-1 text-[10px] text-violet-300 border border-border">
                        {model}
                      </span>
                    ) : null}

                    {/* 密钥/调用方 */}
                    {keyName ? (
                      <span className="text-subtle text-[10px]">[{keyName}]</span>
                    ) : null}

                    {/* 摘要说明 / 错误 */}
                    <span className={cn("flex-1 truncate", error ? "text-rose-400" : "text-muted-foreground")}>
                      {error ? `Err: ${error}` : (item.summary || "-")}
                    </span>

                    {/* 悬浮操作图标 */}
                    <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1.5 ml-auto text-subtle select-none">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopyRaw(item);
                        }}
                        className="p-0.5 hover:text-cyan-400"
                        title="复制 JSON"
                      >
                        {copiedId === item.id ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeletingLogs([item]);
                        }}
                        className="p-0.5 hover:text-rose-400"
                        title="删除该条"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 4. Terminal Status Bar */}
        <div className="flex shrink-0 items-center justify-between border-t border-border bg-card px-3.5 py-1 font-mono text-[11px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline">
              共 <strong className="font-normal text-foreground">{items.length}</strong> 条
            </span>
          </div>

          <div className="flex items-center gap-3">
            {detailLog ? (
              <span className="truncate max-w-xs sm:max-w-md text-cyan-400">
                当前：{detailLog.time} · {detailLog.summary || detailLog.type}
              </span>
            ) : (
              <span className="text-subtle">点击任意记录行打开检查器</span>
            )}
          </div>
        </div>
      </div>

      {/* 5. 详细日志 Inspector 对话框 - 安全防护 */}
      <Dialog open={!!detailLog} onOpenChange={(open) => !open && setDetailLog(null)}>
        {detailLog ? (
          <DialogContent className="flex h-[min(88vh,840px)] w-[min(94vw,940px)] flex-col overflow-hidden rounded-xl border border-border bg-inset p-0 text-foreground">
            <DialogHeader className="shrink-0 border-b border-border bg-card px-5 py-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-mono text-sm">
                  <Terminal className="size-4 text-cyan-400" />
                  <DialogTitle className="font-semibold text-foreground">Log Inspector</DialogTitle>
                  <span className="text-xs text-subtle">[{detailLog.time}]</span>
                </div>
                <div className="mr-6 flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 rounded border-border bg-foreground/[0.05] text-xs font-mono text-foreground hover:bg-foreground/[0.1] hover:text-foreground"
                    onClick={() => handleCopyRaw(detailLog)}
                  >
                    <Copy className="mr-1 size-3" />
                    复制 JSON
                  </Button>
                </div>
              </div>
            </DialogHeader>

            <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4 font-mono text-xs">
              {/* 核心信息卡片 */}
              <div className="grid gap-2 rounded-lg border border-border bg-foreground/[0.02] p-3 md:grid-cols-2">
                <div className="flex justify-between gap-3">
                  <span className="text-subtle">类型:</span>
                  <span className="font-semibold text-cyan-300">{detailLog.type}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-subtle">时间:</span>
                  <span className="text-foreground">{detailLog.time}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-subtle">摘要:</span>
                  <span className="break-all text-foreground">{detailLog.summary || "-"}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-subtle">状态:</span>
                  <span
                    className={cn(
                      "font-semibold",
                      getStatus(detailLog) === "success"
                        ? "text-emerald-400"
                        : "text-rose-400"
                    )}
                  >
                    {getStatus(detailLog).toUpperCase()}
                  </span>
                </div>
                {detailLog.detail?.endpoint ? (
                  <div className="flex justify-between gap-3">
                    <span className="text-subtle">接口端点:</span>
                    <span className="break-all text-sky-300">{String(detailLog.detail.endpoint)}</span>
                  </div>
                ) : null}
                {detailLog.detail?.model ? (
                  <div className="flex justify-between gap-3">
                    <span className="text-subtle">模型:</span>
                    <span className="text-violet-300">{String(detailLog.detail.model)}</span>
                  </div>
                ) : null}
                {detailLog.detail?.duration_ms !== undefined ? (
                  <div className="flex justify-between gap-3">
                    <span className="text-subtle">耗时:</span>
                    <span className="text-amber-300">{detailLog.detail.duration_ms} ms</span>
                  </div>
                ) : null}
                {detailLog.detail?.key_name ? (
                  <div className="flex justify-between gap-3">
                    <span className="text-subtle">鉴权身份:</span>
                    <span className="text-muted-foreground">{String(detailLog.detail.key_name)}</span>
                  </div>
                ) : null}
              </div>

              {/* 关联图片展示 */}
              {detailUrls.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ImageIcon className="size-3.5 text-cyan-400" />
                    <span>生成图片 ({detailUrls.length} 张):</span>
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-2 md:grid-cols-3">
                    {detailUrls.map((url, index) => (
                      <button
                        key={url}
                        type="button"
                        className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-card"
                        onClick={() => {
                          setLightboxIndex(index);
                          setLightboxOpen(true);
                        }}
                      >
                        <img src={url} alt="" className="h-full w-full object-cover transition group-hover:scale-105" />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition group-hover:opacity-100">
                          <ExternalLink className="size-4 text-foreground" />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* 详细完整 JSON Payload */}
              <div className="space-y-1.5">
                <span className="text-[11px] text-subtle">原始数据</span>
                <pre className="max-h-[48vh] overflow-auto rounded-lg border border-border bg-inset p-3 text-[11px] leading-5 text-emerald-400/90 selection:bg-muted">
                  {JSON.stringify(detailLog.detail || {}, null, 2)}
                </pre>
              </div>
            </div>

            <DialogFooter className="shrink-0 border-t border-border bg-card px-5 py-2.5">
              <Button
                variant="ghost"
                size="sm"
                className="rounded text-rose-400 hover:bg-rose-950/40 hover:text-rose-300 text-xs font-mono"
                onClick={() => {
                  setDeletingLogs([detailLog]);
                }}
              >
                <Trash2 className="mr-1 size-3.5" />
                删除该条
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="rounded border-border bg-foreground/[0.05] text-xs font-mono text-muted-foreground hover:bg-foreground/[0.1] hover:text-foreground"
                onClick={() => setDetailLog(null)}
              >
                关闭
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>

      {/* 6. 图片放大灯箱 */}
      <ImageLightbox
        images={detailImages}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setLightboxIndex}
      />

      {/* 7. 删除确认对话框 */}
      <Dialog open={deletingLogs.length > 0} onOpenChange={(open) => !open && setDeletingLogs([])}>
        <DialogContent showCloseButton={false} className="rounded-xl border border-border bg-card p-5 text-foreground">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="font-mono text-foreground">
              {deletingLogs.length === 1 ? "删除单条日志" : `清空 ${deletingLogs.length} 条日志`}
            </DialogTitle>
            <DialogDescription className="font-mono text-xs leading-5 text-muted-foreground">
              确认从数据库永久删除选中的 {deletingLogs.length} 条日志吗？删除后不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              className="rounded border-border bg-foreground/[0.05] font-mono text-xs text-muted-foreground hover:bg-foreground/[0.1]"
              onClick={() => setDeletingLogs([])}
              disabled={isDeleting}
            >
              取消
            </Button>
            <Button
              size="sm"
              className="rounded bg-rose-600 font-mono text-xs text-white hover:bg-rose-700"
              onClick={() => void confirmDelete()}
              disabled={isDeleting}
            >
              {isDeleting ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : null}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default function LogsPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-subtle" />
      </div>
    );
  }

  return <TerminalLogsContent />;
}
