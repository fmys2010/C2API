"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import {
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleOff,
  Copy,
  Download,
  Link2,
  LoaderCircle,
  LogIn,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteAccounts,
  fetchAccounts,
  fetchModels,
  fetchRefreshProgress,
  fetchReLoginProgress,
  reLoginAccounts,
  refreshAccounts,
  testProxy,
  updateAccount,
  type Account,
  type AccountRefreshResponse,
  type AccountStatus,
  type Model,
  type RefreshProgressResponse,
} from "@/lib/api";
import { PollAbortedError, pollUntilDone } from "@/lib/poll";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { usePersistentState } from "@/lib/use-persistent-state";
import { cn } from "@/lib/utils";

import { AccountImportDialog } from "./components/account-import-dialog";

const accountStatusOptions: { label: string; value: AccountStatus | "all" }[] = [
  { label: "全部状态", value: "all" },
  { label: "正常", value: "正常" },
  { label: "限流", value: "限流" },
  { label: "异常", value: "异常" },
  { label: "禁用", value: "禁用" },
];

const statusMeta: Record<
  AccountStatus,
  {
    icon: typeof CheckCircle2;
    badgeClass: string;
    dotClass: string;
  }
> = {
  正常: {
    icon: CheckCircle2,
    badgeClass: "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:bg-emerald-950/70 dark:text-emerald-400",
    dotClass: "bg-emerald-500 dark:bg-emerald-400",
  },
  限流: {
    icon: CircleAlert,
    badgeClass: "bg-amber-500/10 border-amber-500/30 text-amber-600 dark:bg-amber-950/70 dark:text-amber-400",
    dotClass: "bg-amber-500 dark:bg-amber-400",
  },
  异常: {
    icon: CircleOff,
    badgeClass: "bg-rose-500/10 border-rose-500/30 text-rose-600 dark:bg-rose-950/70 dark:text-rose-400",
    dotClass: "bg-rose-500 dark:bg-rose-400",
  },
  禁用: {
    icon: Ban,
    badgeClass: "bg-muted border-border text-muted-foreground",
    dotClass: "bg-muted-foreground",
  },
};

const metricCards = [
  { key: "total", label: "账户总数", color: "text-foreground", dot: "bg-muted-foreground", icon: UserRound },
  { key: "active", label: "正常可用", color: "text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-500 dark:bg-emerald-400", icon: CheckCircle2 },
  { key: "limited", label: "限流排队", color: "text-amber-600 dark:text-amber-400", dot: "bg-amber-500 dark:bg-amber-400", icon: CircleAlert },
  { key: "abnormal", label: "登录异常", color: "text-rose-600 dark:text-rose-400", dot: "bg-rose-500 dark:bg-rose-400", icon: CircleOff },
  { key: "disabled", label: "手动禁用", color: "text-muted-foreground", dot: "bg-muted-foreground/60", icon: Ban },
  { key: "quota", label: "剩余额度", color: "text-cyan-600 dark:text-cyan-400", dot: "bg-cyan-500 dark:bg-cyan-400", icon: RefreshCw },
] as const;

function formatCompact(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(value);
}

function formatQuota(account: Account) {
  return String(Math.max(0, account.quota));
}

function formatRestoreAt(value?: string | null) {
  if (!value) {
    return { absolute: "—", relative: "" };
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { absolute: value, relative: "" };
  }

  const diffMs = Math.max(0, date.getTime() - Date.now());
  const totalHours = Math.ceil(diffMs / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const relative = diffMs > 0 ? `剩余 ${days}d ${hours}h` : "已到恢复时间";

  const pad = (num: number) => String(num).padStart(2, "0");
  const absolute = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

  return { absolute, relative };
}

function formatQuotaSummary(accounts: Account[]) {
  const availableAccounts = accounts.filter((account) => account.status === "正常");
  return formatCompact(availableAccounts.reduce((sum, account) => sum + Math.max(0, account.quota), 0));
}

function maskToken(token?: string) {
  if (!token) return "—";
  if (token.length <= 18) return token;
  return `${token.slice(0, 14)}...${token.slice(-6)}`;
}

function downloadTokens(accounts: Account[]) {
  const content = `${accounts.map((account) => account.access_token).join("\n")}\n`;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `accounts-${Date.now()}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

function displayAccountType(account: Account) {
  return account.type || "Free";
}

function displayAccountSource(account: Account) {
  const source = String(account.source_type || "").trim().toLowerCase();
  if (!source) return "web";
  return source;
}

/**
 * 左侧状态占比圆环图
 */
function AccountDonutRing({
  active = 0,
  limited = 0,
  abnormal = 0,
  disabled = 0,
  total = 0,
}: {
  active: number;
  limited: number;
  abnormal: number;
  disabled: number;
  total: number;
}) {
  const sumStatus = active + limited + abnormal + disabled;
  const safeTotal = sumStatus > 0 ? sumStatus : Math.max(1, total);
  const radius = 48;
  const strokeWidth = 11;
  const circumference = 2 * Math.PI * radius; // ~301.59

  const slices = [
    { label: "正常可用", count: active, color: "#10b981" },
    { label: "限流排队", count: limited, color: "#f59e0b" },
    { label: "登录异常", count: abnormal, color: "#f43f5e" },
    { label: "手动禁用", count: disabled, color: "#71717a" },
  ];

  let accumulated = 0;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative flex size-36 shrink-0 items-center justify-center">
        <svg className="size-full -rotate-90" viewBox="0 0 120 120">
          {/* Background track circle */}
          <circle
            cx="60"
            cy="60"
            r={radius}
            fill="none"
            stroke="rgba(255, 255, 255, 0.05)"
            strokeWidth={strokeWidth}
          />
          {sumStatus > 0 &&
            slices.map((slice, index) => {
              if (slice.count <= 0) return null;
              const strokeDash = (slice.count / safeTotal) * circumference;
              const strokeOffset = accumulated;
              accumulated += strokeDash;
              return (
                <circle
                  key={index}
                  cx="60"
                  cy="60"
                  r={radius}
                  fill="none"
                  stroke={slice.color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={`${strokeDash} ${circumference - strokeDash}`}
                  strokeDashoffset={-strokeOffset}
                  className="transition-all duration-500 ease-out"
                />
              );
            })}
        </svg>
        {/* Center label */}
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-2xl font-bold tracking-tight text-foreground">
            {total}
          </span>
          <span className="text-[9px] text-subtle">
            总数
          </span>
        </div>
      </div>

      {/* Mini donut legend */}
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-emerald-400" />
          <span>正常 {active}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-amber-400" />
          <span>限流 {limited}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-rose-400" />
          <span>异常 {abnormal}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-zinc-500" />
          <span>禁用 {disabled}</span>
        </span>
      </div>
    </div>
  );
}

function AccountsPageContent() {
  const didLoadRef = useRef(false);
  const accountsRequestRef = useRef(0);
  const pollAbortRef = useRef<AbortController | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = usePersistentState("accounts.typeFilter", "all");
  const [statusFilter, setStatusFilter] = usePersistentState<AccountStatus | "all">("accounts.statusFilter", "all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePersistentState("accounts.pageSize", "20");
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [editStatus, setEditStatus] = useState<AccountStatus>("正常");
  const [editProxy, setEditProxy] = useState("");
  const [isUpdating, setIsUpdating] = useState(false);
  const [isTestingProxy, setIsTestingProxy] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRelogining, setIsRelogining] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [refreshingTokens, setRefreshingTokens] = useState<Set<string>>(new Set());

  // 批量刷新进度状态
  const [progress, setProgress] = useState<{
    visible: boolean;
    current: number;
    total: number;
    message: string;
    email: string;
  }>({
    visible: false,
    current: 0,
    total: 0,
    message: "",
    email: "",
  });

  const [refreshSummary, setRefreshSummary] = useState<{
    total: number;
    active: number;
    limited: number;
    abnormal: number;
    disabled: number;
    quota: string;
  } | null>(null);

  // Any newer load or mutation result invalidates list responses still in flight,
  // otherwise a stale GET could bring back rows that were just deleted or edited.
  const applyAccounts = (items: Account[]) => {
    accountsRequestRef.current += 1;
    setAccounts(items);
  };

  const loadAccounts = async () => {
    const requestId = ++accountsRequestRef.current;
    setIsLoading(true);
    try {
      const data = await fetchAccounts();
      if (requestId !== accountsRequestRef.current) return;
      setAccounts(data.items);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.access_token === id)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "获取账户列表失败";
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const loadModels = async () => {
    setIsLoadingModels(true);
    try {
      const data = await fetchModels();
      setAvailableModels(data.data ?? []);
    } catch {
      setAvailableModels([]);
    } finally {
      setIsLoadingModels(false);
    }
  };

  useEffect(() => {
    if (didLoadRef.current) return;
    didLoadRef.current = true;
    void loadAccounts();
    void loadModels();
  }, []);

  // Stop progress polling when leaving the page.
  useEffect(() => {
    const controller = new AbortController();
    pollAbortRef.current = controller;
    return () => controller.abort();
  }, []);

  const accountTypeOptions = useMemo(() => {
    const types = Array.from(
      new Set(
        accounts
          .map((account) => displayAccountType(account))
          .filter(Boolean),
      ),
    );
    return [
      { label: "全部类型", value: "all" },
      ...types.map((type) => ({ label: type, value: type })),
    ];
  }, [accounts]);

  const filteredAccounts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return accounts.filter((account) => {
      const matchesQuery =
        !normalizedQuery ||
        account.access_token.toLowerCase().includes(normalizedQuery) ||
        (account.email ?? "").toLowerCase().includes(normalizedQuery);
      const matchesType = typeFilter === "all" || displayAccountType(account) === typeFilter;
      const matchesStatus = statusFilter === "all" || account.status === statusFilter;
      return matchesQuery && matchesType && matchesStatus;
    });
  }, [accounts, query, statusFilter, typeFilter]);

  const summary = useMemo(() => {
    const total = accounts.length;
    const active = accounts.filter((account) => account.status === "正常").length;
    const limited = accounts.filter((account) => account.status === "限流").length;
    const abnormal = accounts.filter((account) => account.status === "异常").length;
    const disabled = accounts.filter((account) => account.status === "禁用").length;
    return {
      total,
      active,
      limited,
      abnormal,
      disabled,
      quota: formatQuotaSummary(accounts),
    };
  }, [accounts]);

  const selectedTokens = useMemo(() => {
    const selectedSet = new Set(selectedIds);
    return accounts.filter((account) => selectedSet.has(account.access_token)).map((account) => account.access_token);
  }, [accounts, selectedIds]);

  const abnormalTokens = useMemo(() => {
    return accounts.filter((account) => account.status === "异常").map((account) => account.access_token);
  }, [accounts]);

  const pageCount = Math.max(1, Math.ceil(filteredAccounts.length / Number(pageSize)));
  const safePage = Math.min(page, pageCount);
  const startIndex = (safePage - 1) * Number(pageSize);
  const currentRows = filteredAccounts.slice(startIndex, startIndex + Number(pageSize));
  const allCurrentSelected = currentRows.length > 0 && currentRows.every((item) => selectedIds.includes(item.access_token));

  const paginationItems = useMemo(() => {
    const items: (number | "...")[] = [];
    const maxVisible = 5;
    if (pageCount <= maxVisible) {
      for (let i = 1; i <= pageCount; i++) items.push(i);
      return items;
    }
    const leftOffset = Math.floor(maxVisible / 2);
    let start = Math.max(1, safePage - leftOffset);
    let end = Math.min(pageCount, start + maxVisible - 1);
    if (end - start + 1 < maxVisible) start = Math.max(1, end - maxVisible + 1);

    if (start > 1) items.push(1);
    if (start > 2) items.push("...");
    for (let current = start; current <= end; current += 1) items.push(current);
    if (end < pageCount - 1) items.push("...");
    if (end < pageCount) items.push(pageCount);
    return items;
  }, [pageCount, safePage]);

  const handleDeleteTokens = async (tokens: string[]) => {
    if (tokens.length === 0) {
      toast.error("请先选择要删除的账户");
      return;
    }

    setIsDeleting(true);
    try {
      const data = await deleteAccounts(tokens);
      applyAccounts(data.items);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.access_token === id)));
      toast.success(`已删除 ${data.removed ?? 0} 个账户`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除账户失败");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleRefreshAccounts = async (accessTokens: string[]) => {
    if (accessTokens.length === 0) {
      toast.error("没有需要刷新的账户");
      return;
    }

    if (accessTokens.length === 1) {
      setRefreshingTokens((prev) => new Set([...prev, accessTokens[0]]));
      try {
        const { progress_id } = await refreshAccounts(accessTokens);
        await pollUntilDone(
          () => fetchRefreshProgress(progress_id),
          (p) => {
            if (p.done && p.result) {
              applyAccounts(p.result.items);
              setSelectedIds((prev) => prev.filter((id) => p.result!.items.some((item) => item.access_token === id)));
            }
          },
          { signal: pollAbortRef.current?.signal },
        );
      } catch (error) {
        if (error instanceof PollAbortedError) return;
        toast.error(error instanceof Error ? error.message : "刷新账户失败");
      } finally {
        setRefreshingTokens((prev) => {
          const next = new Set(prev);
          next.delete(accessTokens[0]);
          return next;
        });
      }
      return;
    }

    setIsRefreshing(true);
    const selectedTokenSet = new Set(accessTokens);
    const baseAccountsList = accounts.filter((a) => !selectedTokenSet.has(a.access_token));
    const baseActive = baseAccountsList.filter((a) => a.status === "正常").length;
    const baseLimited = baseAccountsList.filter((a) => a.status === "限流").length;
    const baseAbnormal = baseAccountsList.filter((a) => a.status === "异常").length;
    const baseDisabled = baseAccountsList.filter((a) => a.status === "禁用").length;
    const baseNormalAccounts = baseAccountsList.filter((a) => a.status === "正常");
    const baseQuotaNum = baseNormalAccounts.reduce((s, a) => s + Math.max(0, a.quota), 0);

    const total = accessTokens.length;
    setProgress({
      visible: true,
      current: 0,
      total,
      message: "正在刷新账号状态与额度...",
      email: "",
    });

    try {
      const { progress_id } = await refreshAccounts(accessTokens);
      const finished = await pollUntilDone(
        () => fetchRefreshProgress(progress_id),
        (p) => {
          if (p.done) return;
          setProgress((prev) => ({
            ...prev,
            current: p.processed,
          }));
          setRefreshSummary({
            total: accounts.length,
            active: baseActive + (p.status_counts?.["正常"] ?? 0),
            limited: baseLimited + (p.status_counts?.["限流"] ?? 0),
            abnormal: baseAbnormal + (p.status_counts?.["异常"] ?? 0),
            disabled: baseDisabled + (p.status_counts?.["禁用"] ?? 0),
            quota: formatCompact(baseQuotaNum + (p.total_quota ?? 0)),
          });
        },
        { signal: pollAbortRef.current?.signal },
      );
      if (!finished.result) {
        throw new Error("刷新结果为空");
      }
      const data = finished.result;
      setProgress((prev) => ({
        ...prev,
        current: prev.total,
        message: "刷新完成",
      }));
      setRefreshSummary(null);

      applyAccounts(data.items);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.access_token === id)));

      setTimeout(() => setProgress({ visible: false, current: 0, total: 0, message: "", email: "" }), 600);
      toast.success(`账号刷新完成: 正常 ${data.active ?? 0} 个`);
    } catch (error) {
      if (error instanceof PollAbortedError) return;
      setProgress({ visible: false, current: 0, total: 0, message: "", email: "" });
      setRefreshSummary(null);
      toast.error(error instanceof Error ? error.message : "刷新失败");
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleReLogin = async (tokens: string[]) => {
    if (tokens.length === 0) {
      toast.error("请先选择要恢复的账号");
      return;
    }

    setIsRelogining(true);
    const total = tokens.length;
    setProgress({
      visible: true,
      current: 0,
      total,
      message: "正在尝试恢复异常状态...",
      email: "",
    });

    try {
      const { progress_id } = await reLoginAccounts(tokens);
      await pollUntilDone(
        () => fetchReLoginProgress(progress_id),
        (p) => {
          if (p.done) return;
          setProgress((prev) => ({
            ...prev,
            current: p.processed,
            email: p.current_email ?? "",
          }));
        },
        { signal: pollAbortRef.current?.signal },
      );

      const freshData = await fetchAccounts();
      applyAccounts(freshData.items);
      setSelectedIds((prev) => prev.filter((id) => freshData.items.some((item) => item.access_token === id)));
      setProgress({ visible: false, current: 0, total: 0, message: "", email: "" });
      toast.success("账号恢复流程已完成");
    } catch (error) {
      if (error instanceof PollAbortedError) return;
      setProgress({ visible: false, current: 0, total: 0, message: "", email: "" });
      toast.error(error instanceof Error ? error.message : "恢复异常账号失败");
    } finally {
      setIsRelogining(false);
    }
  };

  const openEditDialog = (account: Account) => {
    setEditingAccount(account);
    setEditStatus(account.status);
    setEditProxy(account.proxy ?? "");
  };

  const handleTestAccountProxy = async () => {
    const candidate = editProxy.trim();
    if (!candidate) {
      toast.error("请先填写代理地址");
      return;
    }
    setIsTestingProxy(true);
    try {
      const data = await testProxy(candidate);
      data.result.ok
        ? toast.success(`代理可用: ${data.result.latency_ms} ms (HTTP ${data.result.status})`)
        : toast.error(`代理不可用: ${data.result.error ?? "未知错误"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "测试代理失败");
    } finally {
      setIsTestingProxy(false);
    }
  };

  const handleUpdateAccount = async () => {
    if (!editingAccount) return;

    setIsUpdating(true);
    try {
      const data = await updateAccount(editingAccount.access_token, {
        status: editStatus,
        proxy: editProxy.trim(),
      });
      applyAccounts(data.items);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.access_token === id)));
      setEditingAccount(null);
      toast.success("账号信息已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新账号失败");
    } finally {
      setIsUpdating(false);
    }
  };

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...currentRows.map((item) => item.access_token)])));
      return;
    }
    setSelectedIds((prev) => prev.filter((id) => !currentRows.some((row) => row.access_token === id)));
  };

  return (
    <div className="space-y-3 font-sans">
      {/* 顶部标题与主要操作按钮栏 */}
      <section className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">号池管理</h1>
          <span className="rounded border border-border bg-foreground/[0.04] px-2 py-0.5 text-[11px] text-muted-foreground">
            {filteredAccounts.length} / {accounts.length} 个账号
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-lg border-border bg-foreground/[0.03] px-2.5 text-xs text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
            onClick={() => void loadAccounts()}
            disabled={isLoading || isRefreshing || isDeleting}
          >
            <RefreshCw className={cn("size-3.5", isLoading ? "animate-spin" : "")} />
            刷新
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-lg border-border bg-foreground/[0.03] px-2.5 text-xs text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
            onClick={() => void handleRefreshAccounts(accounts.map((item) => item.access_token))}
            disabled={isLoading || isRefreshing || isDeleting || accounts.length === 0}
          >
            <RefreshCw className={cn("size-3.5", isRefreshing ? "animate-spin text-cyan-400" : "")} />
            全量刷新
          </Button>
          <AccountImportDialog
            disabled={isLoading || isRefreshing || isDeleting}
            onImported={(items) => {
              applyAccounts(items);
              setSelectedIds([]);
              setPage(1);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-lg border-border bg-foreground/[0.03] px-2.5 text-xs text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
            onClick={() => downloadTokens(accounts)}
            disabled={accounts.length === 0}
          >
            <Download className="size-3.5" />
            导出 Token
          </Button>
        </div>
      </section>

      {/* 实时进度条 */}
      {progress.visible && (
        <div className="overflow-hidden rounded-xl border border-border bg-card p-3 shadow-sm ">
          <div className="flex items-center justify-between text-xs ">
            <span className="text-muted-foreground">
              {progress.message}
              {progress.email && <span className="ml-1 text-cyan-400">({progress.email})</span>}
            </span>
            <span className="font-semibold text-emerald-400">
              {progress.current} / {progress.total}
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.08]">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {/* 合并后的号池状态卡片：左侧圆环占比，右侧一列展示所有数量 */}
      <section className="flex flex-col items-center gap-6 rounded-xl border border-border bg-card p-4 shadow-sm md:flex-row md:items-center">
        {/* 左侧圆环 */}
        <div className="flex shrink-0 flex-col items-center">
          <AccountDonutRing
            active={Number((refreshSummary ?? summary).active) || 0}
            limited={Number((refreshSummary ?? summary).limited) || 0}
            abnormal={Number((refreshSummary ?? summary).abnormal) || 0}
            disabled={Number((refreshSummary ?? summary).disabled) || 0}
            total={Number((refreshSummary ?? summary).total) || 0}
          />
        </div>

        <div className="hidden h-32 w-px bg-foreground/[0.08] md:block" />

        {/* 右边展示所有数量 */}
        <div className="grid w-full flex-1 grid-cols-2 gap-2 sm:grid-cols-3">
          {metricCards.map((item) => {
            const value = (refreshSummary ?? summary)[item.key];
            const currentTotal = Number((refreshSummary ?? summary).total) || 0;
            const isPercentRelevant = ["active", "limited", "abnormal", "disabled"].includes(item.key);
            const numVal = typeof value === "number" ? value : 0;
            const pct = currentTotal > 0 && isPercentRelevant ? Math.round((numVal / currentTotal) * 100) : null;

            return (
              <div
                key={item.key}
                className="flex flex-col justify-between rounded-lg border border-border bg-foreground/[0.02] p-2.5 transition hover:border-border"
              >
                <div className="flex items-center justify-between text-muted-foreground">
                  <span className="text-[10px]">{item.label}</span>
                  <div className="flex items-center gap-1">
                    {pct !== null ? (
                      <span className="text-[10px] text-subtle">{pct}%</span>
                    ) : null}
                    <span className={cn("size-1.5 rounded-full", item.dot)} />
                  </div>
                </div>
                <div className={cn("mt-1 text-lg font-bold tracking-tight", item.color)}>
                  {typeof value === "number" ? formatCompact(value) : value}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 可用模型展示条 */}
      <section className="rounded-xl border border-border bg-card px-3 py-2 shadow-sm backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="mr-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>可用模型</span>
            <span className="text-[10px] text-subtle">({availableModels.length})</span>
          </div>
          {availableModels.length > 0 ? (
            availableModels.map((model) => (
              <button
                key={model.id}
                type="button"
                className="inline-flex cursor-pointer items-center rounded border border-border bg-foreground/[0.03] px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition hover:bg-foreground/[0.08] hover:text-foreground"
                onClick={() => {
                  void navigator.clipboard.writeText(model.id);
                  toast.success(`模型名 ${model.id} 已复制`);
                }}
                title={`点击复制 ${model.id}`}
              >
                <img src="/openai.svg" alt="" aria-hidden="true" className="mr-1 size-2.5 shrink-0 opacity-70" />
                {model.id}
              </button>
            ))
          ) : isLoadingModels ? (
            <span className="text-[11px] text-subtle">获取中...</span>
          ) : (
            <span className="text-[11px] text-subtle">暂无可用模型</span>
          )}
        </div>
      </section>

      {/* 搜索过滤与批量操作栏 */}
      <section className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {/* 左侧搜索与筛选 */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-60">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                placeholder="搜索 token 或邮箱..."
                className="h-8 rounded-lg border-border bg-inset pl-8 text-xs text-foreground placeholder-subtle focus:border-cyan-500/50"
              />
            </div>
            <Select
              value={typeFilter}
              onValueChange={(val) => {
                setTypeFilter(val);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-8 w-[120px] rounded-lg border-border bg-inset text-xs text-muted-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-border bg-card text-foreground">
                {accountTypeOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="text-xs ">
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(val) => {
                setStatusFilter(val as AccountStatus | "all");
                setPage(1);
              }}
            >
              <SelectTrigger className="h-8 w-[120px] rounded-lg border-border bg-inset text-xs text-muted-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-border bg-card text-foreground">
                {accountStatusOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="text-xs ">
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 右侧批量快捷操作 */}
          {selectedIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-foreground/[0.03] px-2 py-1">
              <span className="text-[11px] text-muted-foreground mr-1">
                已选 {selectedIds.length} 项:
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 rounded px-2 text-[11px] text-muted-foreground hover:bg-foreground/[0.08]"
                onClick={() => void handleRefreshAccounts(selectedTokens)}
                disabled={isRefreshing}
              >
                <RefreshCw className={cn("mr-1 size-3", isRefreshing ? "animate-spin" : "")} />
                刷新
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 rounded px-2 text-[11px] text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 dark:hover:bg-amber-950/40"
                onClick={() => void handleReLogin(selectedTokens)}
                disabled={isRelogining}
              >
                <LogIn className={cn("mr-1 size-3", isRelogining ? "animate-spin" : "")} />
                恢复
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 rounded px-2 text-[11px] text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 dark:hover:bg-rose-950/40"
                onClick={() => void handleDeleteTokens(selectedTokens)}
                disabled={isDeleting}
              >
                <Trash2 className="mr-1 size-3" />
                删除
              </Button>
            </div>
          )}
        </div>

        {/* 账户数据表格 */}
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm backdrop-blur-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1020px] text-left">
              <thead className="border-b border-border bg-foreground/[0.02] text-[10px] tracking-wider text-muted-foreground uppercase">
                <tr>
                  <th className="w-10 px-3 py-2">
                    <Checkbox
                      checked={allCurrentSelected}
                      onCheckedChange={(checked) => toggleSelectAll(Boolean(checked))}
                    />
                  </th>
                  <th className="w-48 px-3 py-2">Token</th>
                  <th className="w-20 px-3 py-2">类型</th>
                  <th className="w-20 px-3 py-2">来源</th>
                  <th className="w-20 px-3 py-2">状态</th>
                  <th className="w-48 px-3 py-2">账号邮箱</th>
                  <th className="w-32 px-3 py-2">创建时间</th>
                  <th className="w-20 px-3 py-2">额度</th>
                  <th className="w-36 px-3 py-2">恢复时间</th>
                  <th className="w-16 px-3 py-2">在途</th>
                  <th className="w-14 px-3 py-2">成功</th>
                  <th className="w-14 px-3 py-2">失败</th>
                  <th className="w-24 px-3 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-xs">
                {currentRows.map((account) => {
                  const status = statusMeta[account.status];
                  const StatusIcon = status.icon;

                  return (
                    <tr
                      key={account.access_token}
                      className="transition-colors hover:bg-muted/40"
                    >
                      <td className="px-3 py-1.5">
                        <Checkbox
                          checked={selectedIds.includes(account.access_token)}
                          onCheckedChange={(checked) => {
                            setSelectedIds((prev) =>
                              checked
                                ? Array.from(new Set([...prev, account.access_token]))
                                : prev.filter((item) => item !== account.access_token),
                            );
                          }}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-foreground">
                            {maskToken(account.access_token)}
                          </span>
                          <button
                            type="button"
                            className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                            onClick={() => {
                              void navigator.clipboard.writeText(account.access_token);
                              toast.success("Token 已复制");
                            }}
                            title="复制完整 Token"
                          >
                            <Copy className="size-3" />
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {displayAccountType(account)}
                        </span>
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="text-[11px] text-muted-foreground">
                          {displayAccountSource(account)}
                        </span>
                      </td>
                      <td className="px-3 py-1.5">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold",
                            status.badgeClass,
                          )}
                        >
                          <span className={cn("size-1.5 rounded-full", status.dotClass)} />
                          {account.status}
                        </span>
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="max-w-[190px] truncate text-muted-foreground" title={account.email ?? ""}>
                          {account.email ?? "—"}
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground text-[11px]">
                        {(() => {
                          const raw = (account as any).created_at;
                          if (!raw) return "—";
                          try {
                            const d = new Date(raw + "Z");
                            if (isNaN(d.getTime())) return String(raw).slice(0, 10);
                            return d.toLocaleDateString("zh-CN", {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            });
                          } catch {
                            return String(raw).slice(0, 10);
                          }
                        })()}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                          {formatQuota(account)}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-[11px] text-muted-foreground">
                        {(() => {
                          const restore = formatRestoreAt(account.restore_at);
                          return (
                            <div>
                              {restore.relative ? <div className="text-foreground">{restore.relative}</div> : null}
                              <div className="text-muted-foreground text-[10px]">{restore.absolute}</div>
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-1.5">
                        {(() => {
                          const inflight = account.image_inflight ?? 0;
                          return (
                            <span
                              className={inflight > 0 ? "font-semibold text-amber-600 dark:text-amber-400" : "text-muted-foreground"}
                            >
                              {inflight}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-1.5 text-emerald-600 dark:text-emerald-400/90">{account.success}</td>
                      <td className="px-3 py-1.5 text-rose-600 dark:text-rose-400/90">{account.fail}</td>
                      <td className="px-3 py-1.5 text-right">
                        <div className="flex items-center justify-end gap-1 text-muted-foreground">
                          <button
                            type="button"
                            className="rounded p-1 hover:bg-muted hover:text-foreground"
                            onClick={() => openEditDialog(account)}
                            disabled={isUpdating}
                            title="编辑状态/代理"
                          >
                            <Pencil className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            className="rounded p-1 hover:bg-muted hover:text-cyan-600 dark:hover:text-cyan-400"
                            onClick={() => void handleRefreshAccounts([account.access_token])}
                            disabled={isRefreshing || refreshingTokens.has(account.access_token)}
                            title="刷新该账号"
                          >
                            <RefreshCw
                              className={cn(
                                "size-3.5",
                                (isRefreshing || refreshingTokens.has(account.access_token)) && "animate-spin text-cyan-600 dark:text-cyan-400",
                              )}
                            />
                          </button>
                          <button
                            type="button"
                            className="rounded p-1 hover:bg-rose-500/10 dark:hover:bg-rose-950/40 hover:text-rose-600 dark:hover:text-rose-400"
                            onClick={() => void handleDeleteTokens([account.access_token])}
                            disabled={isDeleting}
                            title="删除该账号"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {!isLoading && currentRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center ">
                <Search className="size-6 text-subtle" />
                <p className="text-xs text-muted-foreground">没有符合筛选条件的账户</p>
              </div>
            ) : null}
          </div>

          {/* 表格底部分页栏 */}
          <div className="flex items-center justify-between border-t border-border bg-foreground/[0.01] px-4 py-2 text-xs text-muted-foreground">
            <div className="text-[11px]">
              第 {filteredAccounts.length === 0 ? 0 : startIndex + 1} -{" "}
              {Math.min(startIndex + Number(pageSize), filteredAccounts.length)} 条 / 共{" "}
              {filteredAccounts.length} 条
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[11px] text-subtle">
                {safePage} / {pageCount} 页
              </span>
              <Select
                value={pageSize}
                onValueChange={(val) => {
                  setPageSize(val);
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-7 w-[96px] rounded border-border bg-inset text-[11px] text-muted-foreground">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-border bg-card text-foreground">
                  <SelectItem value="10" className="text-xs ">10 / 页</SelectItem>
                  <SelectItem value="20" className="text-xs ">20 / 页</SelectItem>
                  <SelectItem value="50" className="text-xs ">50 / 页</SelectItem>
                  <SelectItem value="100" className="text-xs ">100 / 页</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon"
                className="size-7 rounded border-border bg-foreground/[0.03] text-muted-foreground hover:bg-foreground/[0.08]"
                disabled={safePage <= 1}
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              >
                <ChevronLeft className="size-3.5" />
              </Button>
              {paginationItems.map((item, index) =>
                item === "..." ? (
                  <span key={`ellipsis-${index}`} className="px-1 text-subtle">
                    ...
                  </span>
                ) : (
                  <Button
                    key={item}
                    variant={item === safePage ? "default" : "outline"}
                    className={cn(
                      "size-7 rounded text-[11px] ",
                      item === safePage
                        ? "bg-foreground/[0.15] text-foreground border border-border"
                        : "border-border bg-foreground/[0.03] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground",
                    )}
                    onClick={() => setPage(item)}
                  >
                    {item}
                  </Button>
                ),
              )}
              <Button
                variant="outline"
                size="icon"
                className="size-7 rounded border-border bg-foreground/[0.03] text-muted-foreground hover:bg-foreground/[0.08]"
                disabled={safePage >= pageCount}
                onClick={() => setPage((prev) => Math.min(pageCount, prev + 1))}
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* 编辑账户对话框 */}
      <Dialog open={Boolean(editingAccount)} onOpenChange={(open) => (!open ? setEditingAccount(null) : null)}>
        <DialogContent showCloseButton={false} className="rounded-xl border border-border bg-card p-5 text-foreground">
          <DialogHeader className="gap-1.5 ">
            <DialogTitle className="text-foreground text-sm">编辑账户配置</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              手动配置该账号的运行状态和专属网络代理。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-xs pt-2">
            <div className="space-y-1.5">
              <label className="text-muted-foreground">运行状态</label>
              <Select value={editStatus} onValueChange={(value) => setEditStatus(value as AccountStatus)}>
                <SelectTrigger className="h-8 rounded-lg border-border bg-inset text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-border bg-card text-foreground">
                  {accountStatusOptions
                    .filter((opt) => opt.value !== "all")
                    .map((opt) => (
                      <SelectItem key={opt.value} value={opt.value} className="text-xs ">
                        {opt.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-muted-foreground">专属代理 (可选)</label>
              <div className="flex gap-2">
                <Input
                  value={editProxy}
                  onChange={(e) => setEditProxy(e.target.value)}
                  placeholder="留空走全局代理，如 http://127.0.0.1:7890"
                  className="h-8 rounded-lg border-border bg-inset text-xs text-foreground"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 rounded-lg border-border bg-foreground/[0.04] text-xs text-muted-foreground hover:bg-foreground/[0.08]"
                  onClick={() => void handleTestAccountProxy()}
                  disabled={isTestingProxy}
                >
                  {isTestingProxy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}
                  测试
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2 pt-3 ">
            <Button
              variant="outline"
              size="sm"
              className="rounded border-border bg-foreground/[0.04] text-xs text-muted-foreground hover:bg-foreground/[0.08]"
              onClick={() => setEditingAccount(null)}
              disabled={isUpdating}
            >
              取消
            </Button>
            <Button
              size="sm"
              className="rounded bg-emerald-600 text-xs text-white hover:bg-emerald-500"
              onClick={() => void handleUpdateAccount()}
              disabled={isUpdating}
            >
              {isUpdating ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function AccountsPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-subtle" />
      </div>
    );
  }

  return <AccountsPageContent />;
}
