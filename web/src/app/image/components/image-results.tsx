"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Clock3, Download, EyeOff, LoaderCircle, RotateCcw, SlidersHorizontal, Sparkles, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ImageConversation, ImageTurnStatus, StoredImage, StoredReferenceImage } from "@/store/image-conversations";

export type ImageLightboxItem = {
  id: string;
  src: string;
  sizeLabel?: string;
  dimensions?: string;
};

type ImageResultsProps = {
  selectedConversation: ImageConversation | null;
  onOpenLightbox: (images: ImageLightboxItem[], index: number) => void;
  onContinueEdit: (conversationId: string, image: StoredImage | StoredReferenceImage) => void;
  onDeletePrompt: (conversationId: string, turnId: string) => void;
  onDeleteResults: (conversationId: string, turnId: string) => void;
  onReuseTurnConfig: (conversationId: string, turnId: string) => void | Promise<void>;
  onRegenerateTurn: (conversationId: string, turnId: string) => void | Promise<void>;
  onRetryImage: (conversationId: string, turnId: string, imageId: string) => void | Promise<void>;
  onTimeoutRetryContinue: (taskId: string) => void | Promise<void>;
  onDismissErrors: (conversationId: string, turnId: string) => void | Promise<void>;
  formatConversationTime: (value: string) => string;
};

// Blob URL 缓存：避免 base64 超长字符串在 DOM 中，改用短小的 blob: URL
const b64BlobUrlCache = new Map<string, string>();

function getStoredImageSrc(image: StoredImage) {
  if (image.b64_json) {
    let url = b64BlobUrlCache.get(image.b64_json);
    if (!url) {
      const binary = atob(image.b64_json);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/png" });
      url = URL.createObjectURL(blob);
      b64BlobUrlCache.set(image.b64_json, url);
    }
    return url;
  }
  return image.url || "";
}

async function downloadStoredImage(image: StoredImage, index: number) {
  let blob: Blob | null = null;
  try {
    if (image.b64_json) {
      const binary = atob(image.b64_json);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      blob = new Blob([bytes], { type: "image/png" });
    } else if (image.url) {
      // 确保 URL 是绝对路径
      const url = image.url.startsWith("http") ? image.url : `${window.location.origin}${image.url}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      blob = await res.blob();
    } else {
      return;
    }
  } catch (err) {
    console.error("Failed to download image:", err);
    // 如果 fetch 失败，尝试直接在新窗口打开
    if (image.url) {
      window.open(image.url, "_blank");
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `image-${index + 1}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ImageResults({
  selectedConversation,
  onOpenLightbox,
  onContinueEdit,
  onDeletePrompt,
  onDeleteResults,
  onReuseTurnConfig,
  onRegenerateTurn,
  onRetryImage,
  onTimeoutRetryContinue,
  onDismissErrors,
  formatConversationTime,
}: ImageResultsProps) {
  const imageDimensionsRef = useRef<Record<string, string>>({});
  const [currentTime, setCurrentTime] = useState(Date.now());
  
  // 仅在存在 loading 图片时启动定时器，避免空闲时无谓重渲染
  const hasLoadingImages = selectedConversation?.turns.some(
    (turn) => !turn.resultsDeleted && turn.images.some((image) => image.status === "loading"),
  );
  useEffect(() => {
    if (!hasLoadingImages) return;
    const timer = setInterval(() => {
      setCurrentTime(Date.now());
    }, 500);
    return () => clearInterval(timer);
  }, [hasLoadingImages]);

  const updateImageDimensions = (id: string, width: number, height: number) => {
    const dimensions = formatImageDimensions(width, height);
    // 使用 ref 存储，不触发 React 重渲染，消除级联重渲染
    if (imageDimensionsRef.current[id] !== dimensions) {
      imageDimensionsRef.current[id] = dimensions;
    }
  };

  if (!selectedConversation) {
    return (
      <div className="flex flex-col items-center px-4 pb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">今天想画点什么？</h1>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      {selectedConversation.turns.map((turn, turnIndex) => {
        const referenceLightboxImages = turn.referenceImages.map((image, index) => ({
          id: `${turn.id}-reference-${index}`,
          src: image.dataUrl,
        }));
        const successfulTurnImages = turn.images.flatMap((image) => {
          const src = image.status === "success" ? getStoredImageSrc(image) : "";
          return src
            ? [
                {
                  id: image.id,
                  src,
                  sizeLabel: image.b64_json ? formatBase64ImageSize(image.b64_json) : undefined,
                  dimensions: imageDimensionsRef.current[image.id],
                },
              ]
            : [];
        });
        const isSingleImage = turn.images.length === 1;

        return (
          <div key={turn.id} className="flex flex-col gap-4">
            {!turn.resultsDeleted && turn.referenceImages.length > 0 ? (
              <div className="flex flex-wrap justify-end gap-2">
                {turn.referenceImages.map((image, index) => (
                  <div key={`${turn.id}-${image.name}-${index}`} className="group/ref relative size-24 overflow-hidden rounded-2xl bg-muted">
                    <button
                      type="button"
                      onClick={() => onOpenLightbox(referenceLightboxImages, index)}
                      className="block size-full cursor-zoom-in"
                      aria-label={`预览参考图 ${image.name || index + 1}`}
                    >
                      <img src={image.dataUrl} alt={image.name || `参考图 ${index + 1}`} className="size-full object-cover" />
                    </button>
                    <div className={cn(overlayActionsClass, "group-hover/ref:opacity-100 group-focus-within/ref:opacity-100")}>
                      <button
                        type="button"
                        className={overlayButtonClass}
                        onClick={() => onContinueEdit(selectedConversation.id, image)}
                        aria-label="加入编辑"
                        title="加入编辑"
                      >
                        <Sparkles className="size-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {!turn.promptDeleted ? (
              <div className="group/prompt flex flex-col items-end gap-1">
                <div className="max-w-[85%] rounded-3xl bg-secondary px-4 py-2.5 text-[15px] leading-6 break-words whitespace-pre-wrap text-secondary-foreground sm:max-w-[75%]">
                  {turn.prompt}
                </div>
                <div className={cn("flex items-center gap-0.5", hoverRevealClass, "group-hover/prompt:opacity-100 group-focus-within/prompt:opacity-100")}>
                  <span className="mr-1 text-[11px] text-subtle">
                    第 {turnIndex + 1} 轮 · {turn.mode === "edit" ? "编辑图" : "文生图"} · {formatConversationTime(turn.createdAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void onReuseTurnConfig(selectedConversation.id, turn.id)}
                    className={actionIconClass}
                    aria-label="复用配置"
                    title="复用配置"
                  >
                    <SlidersHorizontal className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeletePrompt(selectedConversation.id, turn.id)}
                    className={cn(actionIconClass, "hover:bg-rose-500/10 hover:text-rose-500")}
                    aria-label="删除提示词记录"
                    title="删除提示词记录"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            ) : null}

            {!turn.resultsDeleted ? (
              <div className="group/result flex flex-col gap-2">
                <div className="text-[13px] text-muted-foreground">
                  {turn.count} 张 · {getTurnStatusLabel(turn.status)}
                  {turn.status === "queued" ? " · 等待当前对话中的前序任务完成" : ""}
                </div>

                <div
                  className={cn(
                    "grid items-start gap-2",
                    isSingleImage ? "max-w-[512px] grid-cols-1" : turn.images.length === 2 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3",
                  )}
                >
                  {turn.images.map((image, index) => {
                    const imageSrc = image.status === "success" ? getStoredImageSrc(image) : "";
                    if (image.status === "success" && imageSrc) {
                      const currentIndex = successfulTurnImages.findIndex((item) => item.id === image.id);
                      const sizeLabel = image.b64_json ? formatBase64ImageSize(image.b64_json) : "";
                      const dimensions = imageDimensionsRef.current[image.id];
                      const imageMeta = [
                        `结果 ${index + 1}`,
                        image.durationMs != null ? formatDuration(image.durationMs) : "",
                        sizeLabel,
                        dimensions,
                      ]
                        .filter(Boolean)
                        .join(" · ");

                      return (
                        <div key={image.id} className="min-w-0">
                          <div className="group/image relative overflow-hidden rounded-2xl bg-muted">
                            <LazyImage
                              src={imageSrc}
                              alt={`Generated result ${index + 1}`}
                              className="block w-full cursor-zoom-in"
                              onLoad={(event) => {
                                updateImageDimensions(
                                  image.id,
                                  event.currentTarget.naturalWidth,
                                  event.currentTarget.naturalHeight,
                                );
                              }}
                              onOpen={() => onOpenLightbox(successfulTurnImages, currentIndex)}
                            />
                            <div className={cn(overlayActionsClass, "group-hover/image:opacity-100 group-focus-within/image:opacity-100")}>
                              <button
                                type="button"
                                className={overlayButtonClass}
                                onClick={() => onContinueEdit(selectedConversation.id, image)}
                                aria-label="加入编辑"
                                title="加入编辑"
                              >
                                <Sparkles className="size-3.5" />
                              </button>
                              <button
                                type="button"
                                className={overlayButtonClass}
                                onClick={() => void downloadStoredImage(image, index)}
                                aria-label="下载"
                                title="下载"
                              >
                                <Download className="size-3.5" />
                              </button>
                            </div>
                          </div>
                          <div className="truncate px-1 pt-1 text-[11px] text-subtle" title={imageMeta}>
                            {imageMeta}
                          </div>
                        </div>
                      );
                    }

                    if (image.status === "error") {
                      const isTimeoutError = image.error?.includes("超时") && image.taskId;
                      return (
                        <div key={image.id} className="min-w-0">
                          <div className={cn("overflow-y-auto rounded-2xl border border-destructive/30 bg-destructive/5", getRatioClass(turn.ratio))}>
                            <div className="flex min-h-full flex-col items-center justify-center gap-2 p-3 text-center text-[13px] leading-5 text-destructive">
                              <p className="font-medium">图片 {index + 1}/{turn.images.length}</p>
                              <span className="line-clamp-3">{image.error || "生成失败"}</span>
                              <div className="flex flex-wrap items-center justify-center gap-1.5">
                                {isTimeoutError ? (
                                  <button
                                    type="button"
                                    onClick={() => void onTimeoutRetryContinue(image.taskId!)}
                                    className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-foreground transition hover:bg-muted"
                                  >
                                    继续等待
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => void onRetryImage(selectedConversation.id, turn.id, image.id)}
                                  className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-foreground transition hover:bg-muted"
                                >
                                  重新生成这一张
                                </button>
                              </div>
                            </div>
                          </div>
                          {image.durationMs != null ? (
                            <div className="px-1 pt-1 text-[11px] text-subtle">{formatDuration(image.durationMs)}</div>
                          ) : null}
                        </div>
                      );
                    }

                    const imageTaskStatus = image.taskStatus || (turn.status === "queued" ? "queued" : "running");
                    const imageStatusLabel = imageTaskStatus === "queued" ? "排队中" : getProgressLabel(image.progress);
                    const showElapsed = imageTaskStatus === "running" && image.elapsedSecs != null;
                    const elapsedDisplay = showElapsed
                      ? formatElapsed(
                          image.elapsedUpdatedAt != null
                            ? image.elapsedSecs! + (currentTime - image.elapsedUpdatedAt!) / 1000
                            : image.elapsedSecs!,
                        )
                      : null;
                    return (
                      <div key={image.id} className="min-w-0">
                        <div className={cn("relative flex flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl bg-muted p-3 text-center", getRatioClass(turn.ratio))}>
                          {imageTaskStatus === "queued" ? (
                            <Clock3 className="size-5 text-subtle" />
                          ) : (
                            <LoaderCircle className="size-5 animate-spin text-subtle" />
                          )}
                          <p className="text-[13px] text-muted-foreground">
                            {imageStatusLabel}
                            {turn.images.length > 1 ? ` · ${index + 1}/${turn.images.length}` : ""}
                          </p>
                          {elapsedDisplay != null ? <p className="text-[11px] text-subtle">{elapsedDisplay}</p> : null}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {turn.status === "error" && turn.error ? (
                  <div className="flex items-center justify-between gap-3 rounded-xl bg-amber-500/10 px-3.5 py-2.5 text-[13px] leading-5 text-amber-700 dark:text-amber-300">
                    <span className="min-w-0">{turn.error}</span>
                    <button
                      type="button"
                      onClick={() => void onDismissErrors(selectedConversation.id, turn.id)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium transition hover:bg-amber-500/15"
                    >
                      <EyeOff className="size-3.5" />
                      忽略错误
                    </button>
                  </div>
                ) : null}

                <div className={cn("flex items-center gap-0.5", hoverRevealClass, "group-hover/result:opacity-100 group-focus-within/result:opacity-100")}>
                  <button
                    type="button"
                    onClick={() => void onRegenerateTurn(selectedConversation.id, turn.id)}
                    className={actionIconClass}
                    aria-label="全部重新生成"
                    title="全部重新生成"
                  >
                    <RotateCcw className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteResults(selectedConversation.id, turn.id)}
                    className={cn(actionIconClass, "hover:bg-rose-500/10 hover:text-rose-500")}
                    aria-label="删除生成结果"
                    title="删除生成结果"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// Touch screens have no hover, so these stay visible below the `sm` breakpoint.
const hoverRevealClass = "transition-opacity sm:opacity-0";
const overlayActionsClass = "absolute top-2 right-2 flex items-center gap-1 transition-opacity sm:opacity-0";
const overlayButtonClass =
  "inline-flex size-7 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition hover:bg-black/80";
const actionIconClass =
  "inline-flex size-7 items-center justify-center rounded-lg text-subtle transition hover:bg-foreground/[0.06] hover:text-foreground";

function getRatioClass(ratio: string) {
  const classes: Record<string, string> = {
    "1:1": "aspect-square",
    "16:9": "aspect-video",
    "9:16": "aspect-[9/16]",
    "4:3": "aspect-[4/3]",
    "3:4": "aspect-[3/4]",
    "3:2": "aspect-[3/2]",
    "2:3": "aspect-[2/3]",
  };
  return classes[ratio] || "aspect-square";
}

function getTurnStatusLabel(status: ImageTurnStatus) {
  if (status === "queued") {
    return "排队中";
  }
  if (status === "generating") {
    return "处理中";
  }
  if (status === "success") {
    return "已完成";
  }
  return "失败";
}

const PROGRESS_LABELS: Record<string, string> = {
  getting_account: "确认可用账号",
  uploading: "上传图片",
  bootstrapping: "预热首页",
  getting_token: "获取 token",
  preparing_conversation: "准备会话",
  starting_generation: "启动生成",
  generating: "生成中",
  receiving_image: "接收图片中",
};

function getProgressLabel(progress?: string) {
  if (!progress) {
    return "生成中";
  }
  return PROGRESS_LABELS[progress] || "生成中";
}

function formatElapsed(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const base64SizeCache = new Map<string, string>();
function formatBase64ImageSize(base64: string) {
  let cached = base64SizeCache.get(base64);
  if (cached !== undefined) return cached;
  const normalized = base64.replace(/\s/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);

  if (bytes >= 1024 * 1024) {
    cached = `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  } else if (bytes >= 1024) {
    cached = `${(bytes / 1024).toFixed(1)} KB`;
  } else {
    cached = `${bytes} B`;
  }
  base64SizeCache.set(base64, cached);
  return cached;
}

function formatImageDimensions(width: number, height: number) {
  return `${width} x ${height}`;
}

const LazyImage = memo(function LazyImage({ src, alt, className, onLoad, onOpen }: {
  src: string;
  alt: string;
  className: string;
  onLoad?: (event: React.SyntheticEvent<HTMLImageElement>) => void;
  onOpen?: () => void;
}) {
  const [isVisible, setIsVisible] = useState(false);
  const imgRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = imgRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={imgRef} className="relative">
      {isVisible ? (
        <button
          type="button"
          onClick={onOpen}
          className={className}
        >
          <img
            src={src}
            alt={alt}
            className="block h-auto w-full"
            onLoad={onLoad}
          />
        </button>
      ) : (
        <div className={`min-h-[200px] animate-pulse bg-muted sm:min-h-[280px] ${className}`} />
      )}
    </div>
  );
});
