"use client";
import { ArrowUp, ChevronDown, ImagePlus, Info, LoaderCircle, Plus, RectangleHorizontal, RectangleVertical, SlidersHorizontal, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type RefObject } from "react";

import { ImageLightbox } from "@/components/image-lightbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ImageModel } from "@/lib/api";
import { cn } from "@/lib/utils";

type ImageComposerProps = {
  prompt: string;
  imageCount: string;
  imageRatio: string;
  imageTier: string;
  imageWidth: string;
  imageHeight: string;
  imageQuality: string;
  imageModel: ImageModel;
  imageModels: ImageModel[];
  availableQuota: string;
  activeTaskCount: number;
  referenceImages: Array<{ name: string; dataUrl: string }>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPromptChange: (value: string) => void;
  onImageCountChange: (value: string) => void;
  onImageRatioChange: (value: string) => void;
  onImageTierChange: (value: string) => void;
  onImageWidthChange: (value: string) => void;
  onImageHeightChange: (value: string) => void;
  onImageQualityChange: (value: string) => void;
  onImageModelChange: (value: ImageModel) => void;
  onSubmit: () => void | Promise<void>;
  onPickReferenceImage: () => void;
  onReferenceImageChange: (files: File[]) => void | Promise<void>;
  onRemoveReferenceImage: (index: number) => void;
};

type SizeMenuPosition = { top?: number; bottom?: number; left: number; maxHeight: number };

const SIZE_MENU_HEIGHT = 580;
const SIZE_MENU_MARGIN = 16;
const SIZE_MENU_GAP = 8;

/** The composer can sit mid-screen on an empty conversation, so the menu opens toward the side with room. */
function getSizeMenuPosition(rect: DOMRect): SizeMenuPosition {
  const menuWidth = Math.min(460, window.innerWidth - SIZE_MENU_MARGIN * 2);
  const left = Math.max(SIZE_MENU_MARGIN, Math.min(rect.left, window.innerWidth - menuWidth - SIZE_MENU_MARGIN));
  const spaceAbove = rect.top - SIZE_MENU_MARGIN - SIZE_MENU_GAP;
  const spaceBelow = window.innerHeight - rect.bottom - SIZE_MENU_MARGIN - SIZE_MENU_GAP;
  if (spaceAbove >= SIZE_MENU_HEIGHT || spaceAbove >= spaceBelow) {
    return { bottom: window.innerHeight - rect.top + SIZE_MENU_GAP, left, maxHeight: spaceAbove };
  }
  return { top: rect.bottom + SIZE_MENU_GAP, left, maxHeight: spaceBelow };
}

const imageFileNamePattern = /\.(avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i;

function isImageFile(file: File) {
  return file.type.startsWith("image/") || (!file.type && imageFileNamePattern.test(file.name));
}

function hasDraggedImages(dataTransfer: DataTransfer) {
  const items = Array.from(dataTransfer.items || []);
  if (items.length > 0) {
    return items.some((item) => item.kind === "file" && (item.type.startsWith("image/") || !item.type));
  }
  return Array.from(dataTransfer.files || []).some(isImageFile);
}

function getDraggedImageFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.files || []).filter(isImageFile);
}

const qualityOptions = [
  { value: "auto", label: "自动" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];
const aspectOptions = [
  { ratio: "1:1", tier: "1k", width: "1024", height: "1024", label: "1:1", icon: Square },
  { ratio: "2:3", tier: "1k", width: "1024", height: "1536", label: "2:3", icon: RectangleVertical },
  { ratio: "3:2", tier: "1k", width: "1536", height: "1024", label: "3:2", icon: RectangleHorizontal },
  { ratio: "3:4", tier: "1k", width: "1024", height: "1365", label: "3:4", icon: RectangleVertical },
  { ratio: "4:3", tier: "1k", width: "1365", height: "1024", label: "4:3", icon: RectangleHorizontal },
  { ratio: "9:16", tier: "1k", width: "1088", height: "1920", label: "9:16", icon: RectangleVertical },
  { ratio: "16:9", tier: "1k", width: "1920", height: "1088", label: "16:9", icon: RectangleHorizontal },
  { ratio: "1:1", tier: "2k", width: "2048", height: "2048", label: "1:1(2k)", icon: Square },
  { ratio: "16:9", tier: "2k", width: "2560", height: "1440", label: "16:9(2k)", icon: RectangleHorizontal },
  { ratio: "9:16", tier: "2k", width: "1440", height: "2560", label: "9:16(2k)", icon: RectangleVertical },
  { ratio: "16:9", tier: "4k", width: "3840", height: "2160", label: "16:9(4k)", icon: RectangleHorizontal },
  { ratio: "9:16", tier: "4k", width: "2160", height: "3840", label: "9:16(4k)", icon: RectangleVertical },
  { ratio: "auto", tier: "auto", width: "1024", height: "1024", label: "auto", icon: null },
];
const countOptions = Array.from({ length: 10 }, (_, index) => String(index + 1));

export function ImageComposer({
  prompt,
  imageCount,
  imageRatio,
  imageTier,
  imageWidth,
  imageHeight,
  imageQuality,
  imageModel,
  imageModels,
  availableQuota,
  activeTaskCount,
  referenceImages,
  textareaRef,
  fileInputRef,
  onPromptChange,
  onImageCountChange,
  onImageRatioChange,
  onImageTierChange,
  onImageWidthChange,
  onImageHeightChange,
  onImageQualityChange,
  onImageModelChange,
  onSubmit,
  onPickReferenceImage,
  onReferenceImageChange,
  onRemoveReferenceImage,
}: ImageComposerProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [isSizeMenuOpen, setIsSizeMenuOpen] = useState(false);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [sizeMenuPos, setSizeMenuPos] = useState<SizeMenuPosition>({ left: 0, maxHeight: 480 });
  const sizeMenuRef = useRef<HTMLDivElement>(null);
  const sizeMenuBtnRef = useRef<HTMLButtonElement>(null);
  const lightboxImages = useMemo(
    () => referenceImages.map((image, index) => ({ id: `${image.name}-${index}`, src: image.dataUrl })),
    [referenceImages],
  );
  const modelOptions = useMemo(
    () => imageModels.map((model) => ({ value: model, label: model })),
    [imageModels],
  );
  const qualityLabel = qualityOptions.find((option) => option.value === imageQuality)?.label || "自动";
  const ratioLabel = imageRatio === "auto" ? "auto" : `${imageRatio}(${imageTier})`;
  const imageSizeLabel = `${qualityLabel} · ${ratioLabel} · ${imageCount || 1} 张`;
  const selectedModelLabel = modelOptions.find((option) => option.value === imageModel)?.label || imageModel;
  const isCodexModel = imageModel.toLowerCase().includes("codex");

  useEffect(() => {
    if (!isSizeMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-slot="select-content"], [data-slot="select-trigger"]')
      ) {
        return;
      }
      if (!sizeMenuRef.current?.contains(target as Node)) {
        setIsSizeMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isSizeMenuOpen]);

  const handleTextareaPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    void onReferenceImageChange(imageFiles);
  };

  const handleComposerDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedImages(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsSizeMenuOpen(false);
    setIsDraggingImage(true);
  };

  const handleComposerDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedImages(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDraggingImage(true);
  };

  const handleComposerDragLeave = (event: DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    setIsDraggingImage(false);
  };

  const handleComposerDrop = (event: DragEvent<HTMLDivElement>) => {
    const imageFiles = getDraggedImageFiles(event.dataTransfer);
    if (event.dataTransfer.files.length > 0 || imageFiles.length > 0) {
      event.preventDefault();
      event.stopPropagation();
    }

    setIsDraggingImage(false);
    if (imageFiles.length === 0) {
      return;
    }

    void onReferenceImageChange(imageFiles);
  };

  const chipClass = "h-9 cursor-pointer rounded-full border border-border bg-transparent text-sm text-foreground transition hover:bg-foreground/[0.05]";

  return (
    <div className="shrink-0 px-3 pt-1 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:px-4">
      <div className="mx-auto w-full max-w-3xl">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            void onReferenceImageChange(Array.from(event.target.files || []));
          }}
        />
        <ImageLightbox
          images={lightboxImages}
          currentIndex={lightboxIndex}
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
          onIndexChange={setLightboxIndex}
        />

        <div
          className={cn(
            "relative cursor-text rounded-[26px] border border-border bg-card p-2 shadow-[0_1px_8px_rgba(0,0,0,0.06)] transition-colors focus-within:border-input",
            isDraggingImage && "border-foreground/40",
          )}
          onDragEnter={handleComposerDragEnter}
          onDragOver={handleComposerDragOver}
          onDragLeave={handleComposerDragLeave}
          onDrop={handleComposerDrop}
          onClick={() => {
            textareaRef.current?.focus();
          }}
        >
          {referenceImages.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto p-1 pb-2" onClick={(event) => event.stopPropagation()}>
              {referenceImages.map((image, index) => (
                <div key={`${image.name}-${index}`} className="relative size-14 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setLightboxIndex(index);
                      setLightboxOpen(true);
                    }}
                    className="size-14 overflow-hidden rounded-xl border border-border bg-muted transition hover:opacity-90"
                    aria-label={`预览参考图 ${image.name || index + 1}`}
                  >
                    <img
                      src={image.dataUrl}
                      alt={image.name || `参考图 ${index + 1}`}
                      className="h-full w-full object-cover"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveReferenceImage(index)}
                    className="absolute top-0.5 right-0.5 inline-flex size-5 items-center justify-center rounded-full bg-black/70 text-white transition hover:bg-black"
                    aria-label={`移除参考图 ${image.name || index + 1}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <Textarea
            ref={textareaRef}
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            onPaste={handleTextareaPaste}
            placeholder={referenceImages.length > 0 ? "描述你希望如何修改参考图" : "描述你想生成的画面"}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void onSubmit();
              }
            }}
            className="max-h-52 min-h-11 resize-none border-0 bg-transparent px-2.5 py-2 text-[15px] leading-6 text-foreground shadow-none [field-sizing:content] placeholder:text-subtle focus-visible:ring-0 dark:bg-transparent"
          />

          {isDraggingImage ? (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[26px] bg-card/90 text-sm font-medium text-foreground">
              <span className="flex items-center gap-2">
                <ImagePlus className="size-4" />
                松开以上传参考图
              </span>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-2" onClick={(event) => event.stopPropagation()}>
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <button
                type="button"
                onClick={onPickReferenceImage}
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-foreground transition hover:bg-foreground/[0.06]"
                aria-label={referenceImages.length > 0 ? "添加参考图" : "上传参考图"}
                title={referenceImages.length > 0 ? "添加参考图" : "上传参考图"}
              >
                <Plus className="size-5" />
              </button>
              <button
                ref={sizeMenuBtnRef}
                type="button"
                aria-expanded={isSizeMenuOpen}
                className="inline-flex h-9 min-w-0 items-center gap-1.5 rounded-full px-3 text-[13px] text-muted-foreground transition hover:bg-foreground/[0.06] hover:text-foreground"
                onClick={() => {
                  if (!isSizeMenuOpen && sizeMenuBtnRef.current) {
                    setSizeMenuPos(getSizeMenuPosition(sizeMenuBtnRef.current.getBoundingClientRect()));
                  }
                  setIsSizeMenuOpen((open) => !open);
                }}
              >
                <SlidersHorizontal className="size-4 shrink-0" />
                <span className="truncate">{imageSizeLabel}</span>
                <ChevronDown className={cn("size-3.5 shrink-0 opacity-60 transition", isSizeMenuOpen && "rotate-180")} />
              </button>
              {isSizeMenuOpen ? (
                <div
                  ref={sizeMenuRef}
                  className="fixed z-[80] overflow-y-auto rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-xl"
                  style={{
                    top: sizeMenuPos.top,
                    bottom: sizeMenuPos.bottom,
                    left: sizeMenuPos.left,
                    maxHeight: sizeMenuPos.maxHeight,
                    width: "min(460px, calc(100vw - 2rem))",
                  }}
                >
                  <h3 className="mb-3 text-sm font-semibold">图像设置</h3>
                  <div className="mb-3">
                    <div className="mb-2 text-[13px] font-medium">模型</div>
                    <Select
                      value={imageModel}
                      onValueChange={(value) => {
                        onImageModelChange(value as ImageModel);
                      }}
                    >
                      <SelectTrigger className="h-10 rounded-xl text-sm shadow-none">
                        <span className="truncate">{selectedModelLabel}</span>
                      </SelectTrigger>
                      <SelectContent className="z-[120]">
                        {modelOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="mb-3">
                    <div className="mb-2 text-[13px] font-medium">质量</div>
                    <div className="grid grid-cols-4 gap-2">
                      {qualityOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={cn(chipClass, option.value === imageQuality && "border-foreground font-medium")}
                          onClick={() => onImageQualityChange(option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mb-3">
                    <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium">
                      尺寸 <Info className="size-3.5 text-subtle" />
                    </div>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                      <div className="flex items-center rounded-lg bg-muted px-3 py-1.5 text-sm">
                        <span className="mr-2 text-subtle">W</span>
                        <Input
                          type="number"
                          inputMode="numeric"
                          min="1"
                          aria-label="宽度"
                          value={imageWidth}
                          onChange={(event) => onImageWidthChange(event.target.value)}
                          className="h-7 border-0 bg-transparent px-0 text-sm font-medium shadow-none focus-visible:ring-0 dark:bg-transparent"
                        />
                      </div>
                      <span className="text-subtle">×</span>
                      <div className="flex items-center rounded-lg bg-muted px-3 py-1.5 text-sm">
                        <span className="mr-2 text-subtle">H</span>
                        <Input
                          type="number"
                          inputMode="numeric"
                          min="1"
                          aria-label="高度"
                          value={imageHeight}
                          onChange={(event) => onImageHeightChange(event.target.value)}
                          className="h-7 border-0 bg-transparent px-0 text-sm font-medium shadow-none focus-visible:ring-0 dark:bg-transparent"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="mb-3">
                    <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium">
                      宽高比 <Info className="size-3.5 text-subtle" />
                    </div>
                    <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                      {aspectOptions.map((option) => {
                        const active = option.ratio === imageRatio && option.tier === imageTier && option.width === imageWidth && option.height === imageHeight;
                        const Icon = option.icon;
                        const disabled = !isCodexModel && (option.tier === "2k" || option.tier === "4k");
                        return (
                          <button
                            key={`${option.ratio}-${option.tier}-${option.label}`}
                            type="button"
                            disabled={disabled}
                            className={cn(
                              "flex h-[60px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-border text-[13px] text-foreground transition hover:bg-foreground/[0.05]",
                              active && "border-foreground font-medium",
                              disabled && "cursor-not-allowed opacity-35 hover:bg-transparent",
                            )}
                            onClick={() => {
                              if (disabled) {
                                return;
                              }
                              onImageRatioChange(option.ratio);
                              onImageTierChange(option.tier);
                              onImageWidthChange(option.width);
                              onImageHeightChange(option.height);
                            }}
                          >
                            {Icon ? <Icon className="size-3.5 stroke-[1.8]" /> : null}
                            <span>{option.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="border-t border-border pt-3">
                    <div className="mb-2 text-[13px] font-medium">生成数量</div>
                    <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                      {countOptions.map((option) => (
                        <button
                          key={option}
                          type="button"
                          className={cn(chipClass, imageCount === option && "border-foreground font-medium")}
                          onClick={() => onImageCountChange(option)}
                        >
                          {option} 张
                        </button>
                      ))}
                      <Input
                        type="number"
                        inputMode="numeric"
                        min="1"
                        max="100"
                        step="1"
                        aria-label="自定义生成数量"
                        value={imageCount}
                        onChange={(event) => onImageCountChange(event.target.value)}
                        className="h-9 rounded-full px-3 text-center text-sm font-medium shadow-none focus-visible:ring-0"
                      />
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {activeTaskCount > 0 ? (
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground" title={`${activeTaskCount} 个任务处理中`}>
                <LoaderCircle className="size-3.5 animate-spin" />
                {activeTaskCount}
              </span>
            ) : null}

            <button
              type="button"
              onClick={() => void onSubmit()}
              disabled={!prompt.trim()}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-25"
              aria-label={referenceImages.length > 0 ? "编辑图片" : "生成图片"}
              title={referenceImages.length > 0 ? "编辑图片" : "生成图片"}
            >
              <ArrowUp className="size-4.5" />
            </button>
          </div>
        </div>

        <p className="mt-1.5 text-center text-[11px] text-subtle">剩余额度 {availableQuota} · 支持粘贴或拖入参考图</p>
      </div>
    </div>
  );
}
