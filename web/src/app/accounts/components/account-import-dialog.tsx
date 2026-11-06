"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { FileText, KeyRound, LoaderCircle, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { createAccounts, type Account } from "@/lib/api";

type AccountImportDialogProps = {
  disabled?: boolean;
  onImported: (items: Account[]) => void;
};

function splitTokens(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsText(file);
  });
}

export function AccountImportDialog({ disabled = false, onImported }: AccountImportDialogProps) {
  const [open, setOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const txtInputRef = useRef<HTMLInputElement>(null);

  const resetState = () => {
    setTokenInput("");
    setIsSubmitting(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetState();
    }
    setOpen(nextOpen);
  };

  const handleTxtSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const content = await readFileAsText(file);
      const tokens = splitTokens(content);
      if (tokens.length === 0) {
        toast.error("TXT 文件中未找到有效 Token");
        return;
      }

      setTokenInput((prev) => {
        const next = [...splitTokens(prev), ...tokens];
        return next.join("\n");
      });
      toast.success(`已从 ${file.name} 导入 ${tokens.length} 个 Token`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取文件失败");
    }
  };

  const handleImportTokens = async () => {
    const tokens = splitTokens(tokenInput);
    if (tokens.length === 0) {
      toast.error("请先输入或粘贴至少一个 Access Token");
      return;
    }

    setIsSubmitting(true);
    try {
      const payloads = tokens.map((token) => ({ access_token: token }));
      const data = await createAccounts(payloads);
      onImported(data.items);
      handleOpenChange(false);
      toast.success(
        `导入完成: 新增 ${data.added ?? 0} 个，跳过 ${data.skipped ?? 0} 个重复项`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入 Token 失败");
    } finally {
      setIsSubmitting(false);
    }
  };

  const tokenCount = splitTokens(tokenInput).length;

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-lg border-white/[0.08] bg-white/[0.03] px-2.5 font-mono text-xs text-zinc-300 hover:bg-white/[0.08] hover:text-white"
            disabled={disabled}
          >
            <Upload className="size-3.5" />
            导入账号
          </Button>
        </DialogTrigger>
        <DialogContent
          showCloseButton={false}
          className="rounded-xl border border-white/[0.1] bg-[#0c0e17] p-5 text-zinc-200 w-[min(92vw,560px)]"
        >
          <DialogHeader className="gap-1.5">
            <div className="flex items-center gap-2 font-mono text-sm text-zinc-100 font-semibold">
              <KeyRound className="size-4 text-emerald-400" />
              <DialogTitle>导入 Access Token</DialogTitle>
            </div>
            <DialogDescription className="font-mono text-xs leading-5 text-zinc-400">
              粘贴 ChatGPT Access Token，一行一个。系统将自动验证、检测配额并获取可用模型。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 pt-2 font-mono text-xs">
            <div className="flex items-center justify-between text-zinc-400 text-[11px]">
              <span>Token 列表:</span>
              <span className="text-emerald-400">已识别 {tokenCount} 个</span>
            </div>

            <Textarea
              placeholder="eyJhbGciOiJSUzI1NiIsInR5cCI6..."
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              className="min-h-48 resize-none rounded-lg border-white/[0.08] bg-[#050609] p-3 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:border-emerald-500/50"
            />

            <div className="flex items-center justify-between rounded-lg border border-dashed border-white/[0.1] bg-white/[0.02] p-3">
              <div className="space-y-0.5">
                <div className="text-xs font-medium text-zinc-300">从 .txt 文本读取</div>
                <div className="text-[10px] text-zinc-500">支持文件内一行一个 Access Token</div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 rounded border-white/[0.1] bg-white/[0.04] text-xs font-mono text-zinc-300 hover:bg-white/[0.08]"
                onClick={() => txtInputRef.current?.click()}
                disabled={isSubmitting}
              >
                <FileText className="mr-1 size-3" />
                选择 TXT
              </Button>
            </div>

            <input
              ref={txtInputRef}
              type="file"
              accept=".txt,text/plain"
              className="hidden"
              onChange={(e) => void handleTxtSelected(e)}
            />
          </div>

          <DialogFooter className="gap-2 pt-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded border-white/[0.1] bg-white/[0.04] font-mono text-xs text-zinc-300 hover:bg-white/[0.08]"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              className="rounded bg-emerald-600 font-mono text-xs text-white hover:bg-emerald-500"
              onClick={() => void handleImportTokens()}
              disabled={isSubmitting || tokenCount === 0}
            >
              {isSubmitting ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : null}
              确认导入 ({tokenCount})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
