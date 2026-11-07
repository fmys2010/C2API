"use client";

import {
  Activity,
  Bot,
  CheckCircle2,
  Cpu,
  Globe,
  ImageIcon,
  LoaderCircle,
  RefreshCw,
  Save,
  Shield,
  ShieldAlert,
  Sparkles,
  Wifi,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { testProxy, type ProxyTestResult } from "@/lib/api";

import { useSettingsStore } from "../store";

export function ConfigCard() {
  const [isTestingProxy, setIsTestingProxy] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<ProxyTestResult | null>(null);
  const [isCustomModel, setIsCustomModel] = useState(false);

  const logLevelOptions = ["debug", "info", "warning", "error"];
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const availableModels = useSettingsStore((state) => state.availableModels);
  const isLoadingModels = useSettingsStore((state) => state.isLoadingModels);
  const fetchAvailableModels = useSettingsStore((state) => state.fetchAvailableModels);

  // Field setters from store
  const setRefreshAccountIntervalMinute = useSettingsStore((state) => state.setRefreshAccountIntervalMinute);
  const setAccountKeepaliveIntervalSeconds = useSettingsStore((state) => state.setAccountKeepaliveIntervalSeconds);
  const setDefaultRegisterPassword = useSettingsStore((state) => state.setDefaultRegisterPassword);
  const setImageRetentionDays = useSettingsStore((state) => state.setImageRetentionDays);
  const setImagePollTimeoutSecs = useSettingsStore((state) => state.setImagePollTimeoutSecs);
  const setImageAccountConcurrency = useSettingsStore((state) => state.setImageAccountConcurrency);
  const setImageSettleEnabled = useSettingsStore((state) => state.setImageSettleEnabled);
  const setImageRemoveConversationAfterResult = useSettingsStore((state) => state.setImageRemoveConversationAfterResult);
  const setImageRemoveConversationAlways = useSettingsStore((state) => state.setImageRemoveConversationAlways);
  const setImageSettleSecs = useSettingsStore((state) => state.setImageSettleSecs);
  const setAutoRemoveInvalidAccounts = useSettingsStore((state) => state.setAutoRemoveInvalidAccounts);
  const setAutoRemoveRateLimitedAccounts = useSettingsStore((state) => state.setAutoRemoveRateLimitedAccounts);
  const setAutoReloginAfterRefresh = useSettingsStore((state) => state.setAutoReloginAfterRefresh);
  const setLogLevel = useSettingsStore((state) => state.setLogLevel);
  const setProxy = useSettingsStore((state) => state.setProxy);
  const setGlobalSystemPrompt = useSettingsStore((state) => state.setGlobalSystemPrompt);
  const setDefaultUpstreamModelName = useSettingsStore((state) => state.setDefaultUpstreamModelName);
  const setDefaultThinkingEffort = useSettingsStore((state) => state.setDefaultThinkingEffort);
  const setSensitiveWordsText = useSettingsStore((state) => state.setSensitiveWordsText);
  const saveConfig = useSettingsStore((state) => state.saveConfig);

  const handleTestProxy = async () => {
    const candidate = String(config?.proxy || "").trim();
    if (!candidate) {
      toast.error("请先填写代理地址");
      return;
    }
    setIsTestingProxy(true);
    setProxyTestResult(null);
    try {
      const data = await testProxy(candidate);
      setProxyTestResult(data.result);
      if (data.result.ok) {
        toast.success(`代理可用（${data.result.latency_ms} ms，HTTP ${data.result.status}）`);
      } else {
        toast.error(`代理不可用：${data.result.error ?? "未知错误"}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "测试代理失败");
    } finally {
      setIsTestingProxy(false);
    }
  };

  if (isLoadingConfig) {
    return (
      <Card className="rounded-2xl border-stone-200/80 bg-white/90 shadow-sm">
        <CardContent className="flex items-center justify-center p-12">
          <LoaderCircle className="size-6 animate-spin text-stone-400" />
        </CardContent>
      </Card>
    );
  }

  const currentModel = String(config?.default_upstream_model_name || "auto");
  // Filter text-generation models for upstream routing (exclude pure image models for chat)
  const candidateModels = Array.from(
    new Set(["auto", ...availableModels.filter((m) => !m.startsWith("gpt-image")), currentModel]),
  ).filter(Boolean);

  return (
    <div className="space-y-6">
      {/* 模块 1：账号巡检与保活策略 */}
      <Card className="rounded-2xl border-stone-200/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-5 p-6">
          <div className="flex items-center justify-between border-b border-stone-100 pb-3">
            <div className="flex items-center gap-2.5 text-base font-semibold text-stone-900">
              <Activity className="size-5 text-emerald-600" />
              账号巡检与保活策略
            </div>
            <span className="text-xs text-stone-500">免手机号原生保活体系</span>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-stone-700">账号巡检刷新间隔（分钟）</label>
              <Input
                value={String(config?.refresh_account_interval_minute || "")}
                onChange={(e) => setRefreshAccountIntervalMinute(e.target.value)}
                placeholder="5"
                className="h-10 rounded-xl border-stone-200 bg-white"
              />
              <p className="text-xs text-stone-500">后台全量探测并核验号池账号状态与额度进展的周期（默认 5 分钟）。</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-stone-700">常驻心跳触达间隔（秒）</label>
              <Input
                value={String(config?.account_keepalive_interval_seconds || "120")}
                onChange={(e) => setAccountKeepaliveIntervalSeconds(e.target.value)}
                placeholder="120"
                className="h-10 rounded-xl border-stone-200 bg-white"
              />
              <p className="text-xs text-stone-500">轻量触达防空闲超时（OpenAI 约 3~5 分钟无活动即吊销，默认 120 秒）。</p>
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <label className="text-sm font-medium text-stone-700">注册初始密码模板（可选）</label>
              <Input
                value={String(config?.default_register_password || "")}
                onChange={(e) => setDefaultRegisterPassword(e.target.value)}
                placeholder="留空则系统自动随机生成强密码 (推荐留空)"
                className="h-10 rounded-xl border-stone-200 bg-white font-mono text-sm"
              />
              <p className="text-xs text-stone-500">注册成功时绑定的账号独立密码；留空时每次注册自动生成高强度随机密码。</p>
            </div>
          </div>

          <div className="rounded-xl border border-stone-100 bg-stone-50/60 p-4 space-y-3">
            <div className="text-xs font-semibold text-stone-600">容灾自愈与防误删开关</div>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="flex items-start gap-2.5 text-xs text-stone-700 cursor-pointer">
                <Checkbox
                  checked={Boolean(config?.auto_relogin_after_refresh)}
                  onCheckedChange={(c) => setAutoReloginAfterRefresh(Boolean(c))}
                  className="mt-0.5"
                />
                <div>
                  <div className="font-medium">自动重新登录自愈</div>
                  <div className="text-stone-500 text-[11px] leading-tight mt-0.5">检测到失效时自动通过 Session 续期恢复</div>
                </div>
              </label>

              <label className="flex items-start gap-2.5 text-xs text-stone-700 cursor-pointer">
                <Checkbox
                  checked={Boolean(config?.auto_remove_rate_limited_accounts)}
                  onCheckedChange={(c) => setAutoRemoveRateLimitedAccounts(Boolean(c))}
                  className="mt-0.5"
                />
                <div>
                  <div className="font-medium">自动移除限流账号</div>
                  <div className="text-stone-500 text-[11px] leading-tight mt-0.5">当账号触发 429 配额用尽时移出池子</div>
                </div>
              </label>

              <label className="flex items-start gap-2.5 text-xs text-stone-700 cursor-pointer">
                <Checkbox
                  checked={Boolean(config?.auto_remove_invalid_accounts)}
                  onCheckedChange={(c) => setAutoRemoveInvalidAccounts(Boolean(c))}
                  className="mt-0.5"
                />
                <div>
                  <div className="font-medium text-rose-600">自动删除异常账号</div>
                  <div className="text-stone-500 text-[11px] leading-tight mt-0.5">连续多次失败才物理清理（建议关闭）</div>
                </div>
              </label>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 模块 2：模型路由与生成偏好 */}
      <Card className="rounded-2xl border-stone-200/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-5 p-6">
          <div className="flex items-center justify-between border-b border-stone-100 pb-3">
            <div className="flex items-center gap-2.5 text-base font-semibold text-stone-900">
              <Bot className="size-5 text-indigo-600" />
              模型路由与生成偏好
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void fetchAvailableModels()}
              disabled={isLoadingModels}
              className="h-7 text-xs text-stone-600 gap-1"
            >
              <RefreshCw className={`size-3.5 ${isLoadingModels ? "animate-spin" : ""}`} />
              刷新可用模型
            </Button>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-stone-700">默认上游模型</label>
                <button
                  type="button"
                  onClick={() => setIsCustomModel(!isCustomModel)}
                  className="text-xs text-indigo-600 hover:underline"
                >
                  {isCustomModel ? "选择已有模型" : "手动输入其他"}
                </button>
              </div>

              {isCustomModel ? (
                <Input
                  value={currentModel}
                  onChange={(e) => setDefaultUpstreamModelName(e.target.value)}
                  placeholder="auto"
                  className="h-10 rounded-xl border-stone-200 bg-white font-mono text-sm"
                />
              ) : (
                <Select
                  value={currentModel}
                  onValueChange={(val) => setDefaultUpstreamModelName(val)}
                >
                  <SelectTrigger className="h-10 rounded-xl border-stone-200 bg-white font-mono text-sm">
                    <SelectValue placeholder="选择上游模型" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidateModels.map((m) => (
                      <SelectItem key={m} value={m} className="font-mono text-xs">
                        {m} {m === "auto" ? "（根据上游自适应）" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs text-stone-500">当客户端请求 auto 或未指定模型时使用的默认上游名称（基于号池实时发现）。</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-stone-700">默认思考强度（Thinking Effort）</label>
              <Select
                value={String(config?.default_thinking_effort || "auto")}
                onValueChange={(value) => setDefaultThinkingEffort(value as any)}
              >
                <SelectTrigger className="h-10 rounded-xl border-stone-200 bg-white font-mono text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">auto（自适应）</SelectItem>
                  <SelectItem value="standard">standard（标准）</SelectItem>
                  <SelectItem value="extended">extended（深度推理）</SelectItem>
                  <SelectItem value="max">max（最高算力）</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-stone-500">针对支持推理强度的模型默认附加的思考预算档位。</p>
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <label className="text-sm font-medium text-stone-700">全局系统提示词（System Prompt）</label>
              <Textarea
                value={String(config?.global_system_prompt || "")}
                onChange={(e) => setGlobalSystemPrompt(e.target.value)}
                placeholder="作为预置系统提示注入到每次会话首部..."
                className="min-h-20 rounded-xl border-stone-200 bg-white text-xs shadow-none"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 模块 3：生图服务参数 */}
      <Card className="rounded-2xl border-stone-200/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-5 p-6">
          <div className="flex items-center justify-between border-b border-stone-100 pb-3">
            <div className="flex items-center gap-2.5 text-base font-semibold text-stone-900">
              <ImageIcon className="size-5 text-sky-600" />
              生图服务参数（Image Generation Engine）
            </div>
            <span className="text-xs text-stone-500">gpt-image-2.x 实测验证</span>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-stone-700">本地图片保留天数</label>
              <Input
                value={String(config?.image_retention_days || "7")}
                onChange={(e) => setImageRetentionDays(e.target.value)}
                placeholder="7"
                className="h-10 rounded-xl border-stone-200 bg-white"
              />
              <p className="text-xs text-stone-500">过期图片将随定时任务自动清理以节省磁盘空间（默认 7 天）。</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-stone-700">单账号生图并发上限</label>
              <Input
                value={String(config?.image_account_concurrency || "1")}
                onChange={(e) => setImageAccountConcurrency(e.target.value)}
                placeholder="1"
                className="h-10 rounded-xl border-stone-200 bg-white"
              />
              <p className="text-xs text-stone-500">同一账号同时进行图片生成任务的最大数（建议设为 1 避免撞车）。</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-stone-700">生图任务轮询超时（秒）</label>
              <Input
                value={String(config?.image_poll_timeout_secs || "120")}
                onChange={(e) => setImagePollTimeoutSecs(e.target.value)}
                placeholder="120"
                className="h-10 rounded-xl border-stone-200 bg-white"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-stone-700">结果沉淀保护等待（秒）</label>
              <Input
                value={String(config?.image_settle_secs || "2.0")}
                onChange={(e) => setImageSettleSecs(e.target.value)}
                placeholder="2.0"
                className="h-10 rounded-xl border-stone-200 bg-white"
              />
            </div>
          </div>

          <div className="rounded-xl border border-stone-100 bg-stone-50/60 p-4 space-y-3">
            <div className="text-xs font-semibold text-stone-600">会话自动清理策略</div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex items-start gap-2.5 text-xs text-stone-700 cursor-pointer">
                <Checkbox
                  checked={Boolean(config?.image_remove_conversation_after_result)}
                  onCheckedChange={(c) => setImageRemoveConversationAfterResult(Boolean(c))}
                  className="mt-0.5"
                />
                <div>
                  <div className="font-medium">生成成功后自动删除上游会话</div>
                  <div className="text-stone-500 text-[11px] mt-0.5">保持官方账号会话列表纯净</div>
                </div>
              </label>

              <label className="flex items-start gap-2.5 text-xs text-stone-700 cursor-pointer">
                <Checkbox
                  checked={Boolean(config?.image_remove_conversation_always)}
                  onCheckedChange={(c) => setImageRemoveConversationAlways(Boolean(c))}
                  className="mt-0.5"
                />
                <div>
                  <div className="font-medium">生图结束无论成败均删除会话</div>
                  <div className="text-stone-500 text-[11px] mt-0.5">即时清除失败或超时的上游痕迹</div>
                </div>
              </label>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 模块 4：网络代理与内容安全 */}
      <Card className="rounded-2xl border-stone-200/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-5 p-6">
          <div className="flex items-center justify-between border-b border-stone-100 pb-3">
            <div className="flex items-center gap-2.5 text-base font-semibold text-stone-900">
              <Shield className="size-5 text-amber-600" />
              网络代理与安全过滤
            </div>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-stone-700">上游网络代理节点</label>
              <div className="flex gap-2">
                <Input
                  value={String(config?.proxy || "")}
                  onChange={(e) => setProxy(e.target.value)}
                  placeholder="http://127.0.0.1:7890 或 socks5://user:pwd@1.2.3.4:1080 (直连/TUN 模式留空)"
                  className="h-10 flex-1 rounded-xl border-stone-200 bg-white font-mono text-sm"
                />
                <Button
                  variant="outline"
                  onClick={() => void handleTestProxy()}
                  disabled={isTestingProxy}
                  className="h-10 rounded-xl px-4 text-xs font-medium"
                >
                  {isTestingProxy ? <LoaderCircle className="size-3.5 animate-spin mr-1" /> : <Wifi className="size-3.5 mr-1" />}
                  测试连通性
                </Button>
              </div>

              {proxyTestResult && (
                <div
                  className={`mt-2 flex items-center gap-2 rounded-lg p-2.5 text-xs ${
                    proxyTestResult.ok
                      ? "border border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border border-rose-200 bg-rose-50 text-rose-800"
                  }`}
                >
                  {proxyTestResult.ok ? <CheckCircle2 className="size-4 shrink-0" /> : <XCircle className="size-4 shrink-0" />}
                  <span>
                    {proxyTestResult.ok
                      ? `代理连通正常：HTTP ${proxyTestResult.status}，延迟 ${proxyTestResult.latency_ms} ms`
                      : `代理连接失败：${proxyTestResult.error ?? "无法访问目标"}`}
                  </span>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-stone-700">本地敏感词过滤清单（每行一个）</label>
              <Textarea
                value={(config?.sensitive_words || []).join("\n")}
                onChange={(e) => setSensitiveWordsText(e.target.value)}
                placeholder="一行一个关键词，客户端请求若命中将被即时拦截"
                className="min-h-24 rounded-xl border-stone-200 bg-white text-xs shadow-none font-mono"
              />
            </div>

            <div className="space-y-2 pt-2">
              <label className="text-sm font-medium text-stone-700">运行日志记录级别</label>
              <div className="flex flex-wrap gap-4">
                {logLevelOptions.map((level) => {
                  const isChecked = (config?.log_levels || []).includes(level);
                  return (
                    <label key={level} className="flex items-center gap-2 text-xs text-stone-700 cursor-pointer">
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={(c) => setLogLevel(level, Boolean(c))}
                      />
                      <span className="font-mono uppercase">{level}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 底部浮动保存按钮 */}
      <div className="flex justify-end pt-2">
        <Button
          onClick={() => void saveConfig()}
          disabled={isSavingConfig}
          className="h-10 rounded-xl px-6 font-medium shadow-sm gap-2"
        >
          {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
          保存所有设置
        </Button>
      </div>
    </div>
  );
}
